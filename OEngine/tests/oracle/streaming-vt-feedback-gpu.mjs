import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { VirtualTextureFeedback } from "../../.test-dist/gpu/VirtualTextureFeedback.js";
import { VIRTUAL_TEXTURE_FEEDBACK_WGSL } from "../../.test-dist/shaders/virtual_texture.js";
const check = (value, message) => {
  if (!value) throw new Error(message);
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

export async function runStreamingVtFeedbackGpuOracle(device) {
  const graphics = new GraphicsContext(device),
    observations = [],
    errors = [];
  const feedback = new VirtualTextureFeedback(
    device,
    (value) => observations.push(value),
    (error) => errors.push(String(error))
  );
  try {
    await feedback.ready;
    const module = device.createShaderModule({
      label: "VT independent feedback pressure",
      code: `${VIRTUAL_TEXTURE_FEEDBACK_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= atomicLoad(&native_vt_feedback[1u]) { return; }
  native_vt_record(id.x, 1u); native_vt_record(id.x, 1u);
  if id.x % 2u == 0u { native_vt_record(id.x, 2u); native_vt_record(id.x, 2u); }
}`
    });
    const empty = device.createBindGroupLayout({ entries: [] });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }]
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, empty, layout] }),
      compute: { module, entryPoint: "main" }
    });
    const encode = (command, buffer, pages) => {
      const pass = command.gpu_encoder.beginComputePass();
      pass.setPipeline(pipeline);
      const emptyGroup = device.createBindGroup({ layout: empty, entries: [] });
      pass.setBindGroup(0, emptyGroup);
      pass.setBindGroup(1, emptyGroup);
      pass.setBindGroup(
        2,
        device.createBindGroup({ layout, entries: [{ binding: 1, resource: { buffer } }] })
      );
      pass.dispatchWorkgroups(Math.ceil(pages / 64));
      pass.end();
      feedback.end(command);
    };
    const drain = async (condition) => {
      for (let i = 0; i < 200 && !condition(); i++) await tick();
      check(
        condition(),
        JSON.stringify({ observations: observations.length, errors, state: feedback.evidence() })
      );
      check(errors.length === 0, errors.join("\n"));
    };
    const snapshot = Object.freeze({ epoch: "overflow-full-generation" });
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    encode(command, feedback.begin(command, 10, 7, snapshot, 65537), 65537);
    command.finish();
    await command.gpuDone;
    await drain(() => feedback.evidence().overflows === 1);
    check(observations.length === 0, "overflow cannot publish a partial settled observation");
    // Recovery is encoded on a subsequent normal transaction, with no private
    // feedback submit. Its identity remains the original frame/view/snapshot.
    const recovery = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    feedback.begin(recovery, 11, 8, Object.freeze({ epoch: "next" }), 1);
    feedback.end(recovery);
    recovery.finish();
    await recovery.gpuDone;
    await drain(() => feedback.evidence().recoveries === 1);
    const result = observations.find((value) => value.frame === 10);
    check(
      result?.snapshot === snapshot && result.view === 7,
      "overflow snapshot identity survives delayed recovery"
    );
    check(result.wanted.length === 65537 && result.used.length === 32769, "lossless wanted and used domains");
    check(
      new Set(result.wanted).size === 65537 && result.wanted[65536] === 65536,
      "duplicate queries do not lose or append duplicate pages"
    );
    check(
      result.used.every((id) => id % 2 === 0),
      "wanted plus used survives queue union deduplication"
    );

    // Three submitted/mapping slots held by a delayed completion future. The
    // fourth frame must disable feedback and mark freshness, then slots recover.
    await drain(() => feedback.evidence().outstanding === 0);
    const pending = [];
    for (let index = 0; index < 3; index++) {
      const frame = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      let complete;
      const held = new Promise((resolve) => {
        complete = resolve;
      });
      const delayed = new Proxy(frame, {
        get(target, key) {
          if (key === "gpuDone") return held;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      const buffer = feedback.begin(delayed, 20 + index, 9, snapshot, 17);
      encode(delayed, buffer, 17);
      frame.finish();
      pending.push({ frame, complete });
    }
    const gap = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    check(
      feedback.begin(gap, 23, 9, snapshot, 17) === feedback.disabled,
      "full ring returns disabled buffer"
    );
    check(feedback.evidence().lastGapFrame === 23, "full ring invalidates current-view freshness");
    check(feedback.evidence().oldestOutstandingAgeFrames === 3, "oldest held readback age is explicit");
    gap.abort();
    for (const value of pending) {
      await value.frame.gpuDone;
      value.complete();
    }
    await drain(() => feedback.evidence().outstanding === 0);
    check(feedback.evidence().oldestOutstandingAgeFrames === 0, "drained ring has no outstanding age");
    const small = observations.filter((value) => value.frame >= 20);
    check(
      small.length === 3 && small.every((value) => value.wanted.length === 17 && value.used.length === 9),
      "all ring observations retain actual demand and both query flags"
    );
    return {
      ok: true,
      overflowWanted: result.wanted.length,
      overflowUsed: result.used.length,
      ringObservations: small.length,
      ...feedback.evidence()
    };
  } finally {
    feedback.destroy();
    graphics.destroy();
  }
}
