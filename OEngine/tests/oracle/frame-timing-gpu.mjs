import { GPUFrameTimingRing } from "../../.test-dist/framegraph/GPUFrameTiming.js";
import { GPUTimer } from "../../.test-dist/framegraph/GPUTimer.js";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
export async function runFrameTimingGpuOracle(device) {
  const module = device.createShaderModule({
    code: "@group(0) @binding(0) var<storage,read_write> value:array<u32>; @compute @workgroup_size(1) fn main(){value[0]+=1u;}",
  });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const buffer = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  });
  const ring = new GPUFrameTimingRing(device, 3, 64),
    reports = [];
  try {
    for (const mode of ["production", "coarse", "stage", "full", "legacy-full"]) {
      device.queue.writeBuffer(buffer, 0, new Uint32Array([0]));
      const encoder = device.createCommandEncoder(),
        session = mode === "legacy-full" ? null : ring.acquire(mode);
      const legacy = mode === "legacy-full" ? new GPUTimer(device) : null;
      const start = performance.now();
      session?.begin(encoder);
      for (let i = 0; i < 8; i++) {
        session?.enterStage(encoder, i < 4 ? "Surface" : "Post");
        if (i === 4) encoder.copyBufferToBuffer(buffer, 0, output, 0, 4); // pass-external copy inside the measured span
        const writes = session?.writes("kernel" + i, "compute") ?? legacy?.getComputeWrites("kernel" + i);
        const pass = encoder.beginComputePass({
          label: "kernel" + i,
          ...(writes ? { timestampWrites: writes } : {}),
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
      }
      session?.resolve(encoder);
      legacy?.resolve(encoder);
      encoder.copyBufferToBuffer(buffer, 0, output, 0, 4);
      const cpuEncodeMs = performance.now() - start;
      device.queue.submit([encoder.finish()]);
      const results = session
        ? await session.download()
        : legacy
          ? (await legacy.download_results(), legacy.results_to_console_table())
          : [];
      await output.mapAsync(GPUMapMode.READ);
      const value = new Uint32Array(output.getMappedRange())[0];
      output.unmap();
      check(value === 8, `${mode}: actual producer/consumer result ${value} != 8`);
      const evidence = session?.evidence() ?? {
        mode,
        queries: mode === "legacy-full" ? 16 : 0,
        markerPasses: 0,
        resolveCommands: legacy ? 1 : 0,
        copyCommands: legacy ? 1 : 0,
        readbackBytes: legacy ? 128 : 0,
      };
      check(
        evidence.queries === { production: 0, coarse: 2, stage: 6, full: 22, "legacy-full": 16 }[mode],
        `${mode}: query count`,
      );
      if (session) {
        const span = results.find((r) => r.scope === "span");
        check(span && span.end >= span.start, `${mode}: missing/invalid span`);
        for (const r of results)
          check(r.start >= span.start && r.end <= span.end, `${mode}: interval outside same-command span`);
      }
      reports.push({
        mode,
        cpuEncodeMs,
        evidence,
        intervals: results.map((r) => ({
          label: r.label,
          scope: r.scope ?? "pass",
          durationMs: r.duration_ms,
        })),
        value,
      });
      legacy?.destroy();
    }
    const stable = ring.evidence();
    check(stable.slots === 1, "completed slots should be reused across modes");
    return {
      passed: true,
      scope:
        "actual production timer components; eight dependent GPU writes and exact readback, not full renderer performance",
      reports,
      ring: stable,
    };
  } finally {
    ring.destroy();
    buffer.destroy();
    output.destroy();
  }
}
