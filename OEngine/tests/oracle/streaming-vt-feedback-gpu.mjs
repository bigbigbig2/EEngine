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
    (error) => errors.push(String(error)),
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
}
@compute @workgroup_size(64)
fn hotspot(@builtin(global_invocation_id) id: vec3u) {
  let page = id.x % 17u;
  native_vt_record(page, 1u);
  native_vt_record((page + 7u) % 17u, 2u);
}
@compute @workgroup_size(64)
fn collision(@builtin(global_invocation_id) id: vec3u) {
  // 0,128,257,385 share the production mailbox bucket; identities differ.
  let pages = array<u32, 4>(0u, 128u, 257u, 385u);
  let page = pages[id.x % 4u];
  native_vt_record(0x80000000u, 1u);
  native_vt_record(page, 1u);
  native_vt_record(page, 2u);
  native_vt_record(0xffffffffu, 1u);
}`,
    });
    const empty = device.createBindGroupLayout({ entries: [] });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }],
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, empty, layout] }),
      compute: { module, entryPoint: "main" },
    });
    const hotspot = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, empty, layout] }),
      compute: { module, entryPoint: "hotspot" },
    });
    const collision = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, empty, layout] }),
      compute: { module, entryPoint: "collision" },
    });
    const encode = (command, buffer, pages, selected = pipeline) => {
      const pass = command.gpu_encoder.beginComputePass();
      pass.setPipeline(selected);
      const emptyGroup = device.createBindGroup({ layout: empty, entries: [] });
      pass.setBindGroup(0, emptyGroup);
      pass.setBindGroup(1, emptyGroup);
      pass.setBindGroup(
        2,
        device.createBindGroup({ layout, entries: [{ binding: 1, resource: { buffer } }] }),
      );
      pass.dispatchWorkgroups(Math.ceil(pages / 64));
      pass.end();
      feedback.end(command);
    };
    const drain = async (condition) => {
      for (let i = 0; i < 200 && !condition(); i++) await tick();
      check(
        condition(),
        JSON.stringify({ observations: observations.length, errors, state: feedback.evidence() }),
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
      "overflow snapshot identity survives delayed recovery",
    );
    check(result.wanted.length === 65537 && result.used.length === 32769, "lossless wanted and used domains");
    check(
      new Set(result.wanted).size === 65537 && result.wanted[65536] === 65536,
      "duplicate queries do not lose or append duplicate pages",
    );
    check(
      result.used.every((id) => id % 2 === 0),
      "wanted plus used survives queue union deduplication",
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
        },
      });
      const buffer = feedback.begin(delayed, 20 + index, 9, snapshot, 17);
      encode(delayed, buffer, 17);
      frame.finish();
      pending.push({ frame, complete });
    }
    const gap = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    check(
      feedback.begin(gap, 23, 9, snapshot, 17) === feedback.disabled,
      "full ring returns disabled buffer",
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
      "all ring observations retain actual demand and both query flags",
    );
    const hot = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    encode(hot, feedback.begin(hot, 30, 10, snapshot, 17), 1_048_576, hotspot);
    hot.finish();
    await hot.gpuDone;
    await drain(() => observations.some((value) => value.frame === 30));
    const hotResult = observations.find((value) => value.frame === 30);
    check(
      hotResult.wanted.length === 17 && hotResult.used.length === 17,
      "million-way contention preserves both kinds and every bit of the shared word",
    );
    const colliding = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    encode(colliding, feedback.begin(colliding, 31, 10, snapshot, 386), 65536, collision);
    colliding.finish();
    await colliding.gpuDone;
    await drain(() => observations.some((value) => value.frame === 31));
    const collisionResult = observations.find((value) => value.frame === 31);
    check(
      ["wanted", "used"].every(
        (kind) => JSON.stringify([...collisionResult[kind]].sort((a, b) => a - b)) === "[0,128,257,385]",
      ),
      "mailbox collisions and invalid page IDs preserve the complete valid identity domain",
    );
    return {
      ok: true,
      overflowWanted: result.wanted.length,
      overflowUsed: result.used.length,
      ringObservations: small.length,
      ...feedback.evidence(),
    };
  } finally {
    feedback.destroy();
    graphics.destroy();
  }
}
