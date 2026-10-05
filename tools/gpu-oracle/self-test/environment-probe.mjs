// Minimal real-GPU smoke test for the oracle harness itself.
//
// One compute dispatch writes four known values through a storage buffer, the
// harness reads them back with mapAsync and compares against the CPU
// expectation. It isolates "is a real GPU reachable and did real GPU work
// complete" from any oracle's own logic, so a new machine or CI runner can be
// checked with one command before trusting oracle results.

import assert from "node:assert/strict";

const PROBE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> probe_values: array<u32>;

@compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 4u) { return; }
  probe_values[id.x] = id.x * id.x + 42u;
}
`;

const EXPECTED = [42, 43, 46, 51];

/** @param {GPUDevice} device */
export async function runEnvironmentProbe(device) {
  const storage = device.createBuffer({
    size: EXPECTED.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: EXPECTED.length * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({ code: PROBE_WGSL });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: storage } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, readback.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Uint32Array(readback.getMappedRange().slice(0)));
    readback.unmap();
    assert.deepEqual(values, EXPECTED, `compute probe readback ${JSON.stringify(values)}`);
    return { computeRoundTrip: values, dispatches: 1, expected: EXPECTED };
  } finally {
    storage.destroy();
    readback.destroy();
  }
}
