import assert from "node:assert/strict";
import { PhysicalEnvironmentRuntime } from "../../.test-dist/render/environment/PhysicalEnvironmentRuntime.js";

// Actual producer and every specular mip/diffuse texel. Readback is test-only;
// the production owner still records into its caller's single frame encoder.
export async function runPhysicalSkyMotionGpuOracle(device) {
  const physical = new PhysicalEnvironmentRuntime(device);
  const pixels = 21845 + 32 * 32;
  const bytes = pixels * 16;
  const output = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const readback = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const queries = device.createQuerySet({ type: "timestamp", count: 512 });
  const resolved = device.createBuffer({
    size: 4096,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
  });
  const times = device.createBuffer({ size: 4096, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const consumer = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      entryPoint: "main",
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var specular: texture_2d<f32>;
@group(0) @binding(1) var diffuse: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 22869u) { return; }
  var index = id.x;
  if (index >= 21845u) {
    index -= 21845u;
    output[id.x] = textureLoad(diffuse, vec2i(i32(index % 32u), i32(index / 32u)), 0);
    return;
  }
  for (var mip = 0u; mip < 8u; mip++) {
    let side = 128u >> mip;
    if (index < side * side) {
      output[id.x] = textureLoad(specular, vec2i(i32(index % side), i32(index / side)), i32(mip));
      return;
    }
    index -= side * side;
  }
}`
      })
    }
  });
  const snapshot = {
    worldToUnit: 0.001,
    lutGeneration: 1,
    sunDirectionWorld: [0, 1, 0],
    sunIrradiance: [1.474, 1.8504, 1.91198],
    skyLuminanceScale: 1,
    lightingDiagnostic: "all",
    aerialPerspectiveEnabled: true,
    shadowLength: [0, 0]
  };
  const fields = new Map();
  const samples = [];
  let comparedBytes = 0;
  try {
    const positions = [
      [0, 0, 0],
      [25, 0, 0],
      [0, 25, 0]
    ];
    for (const index of [0, 1, 0, 1, 0, 1, 2, 0, 1, 2, 0, 1]) {
      const encoder = device.createCommandEncoder();
      const labels = [];
      const observed = {
        beginComputePass(descriptor) {
          const slot = labels.length;
          assert.ok(slot < 256, "producer exceeded query capacity");
          labels.push(descriptor.label);
          return encoder.beginComputePass({
            ...descriptor,
            timestampWrites: {
              querySet: queries,
              beginningOfPassWriteIndex: slot * 2,
              endOfPassWriteIndex: slot * 2 + 1
            }
          });
        }
      };
      const begin = performance.now();
      const generation = physical.record(observed, snapshot, positions[index]);
      const cpuMs = performance.now() - begin;
      assert.notEqual(generation, null);
      const views = physical.ibl.views;
      const pass = encoder.beginComputePass();
      pass.setPipeline(consumer);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: consumer.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: views.specular },
            { binding: 1, resource: views.diffuse },
            { binding: 2, resource: { buffer: output } }
          ]
        })
      );
      pass.dispatchWorkgroups(Math.ceil(pixels / 64));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
      if (labels.length) {
        encoder.resolveQuerySet(queries, 0, labels.length * 2, resolved, 0);
        encoder.copyBufferToBuffer(resolved, 0, times, 0, labels.length * 16);
      }
      device.queue.submit([encoder.finish()]);
      const done = device.queue.onSubmittedWorkDone();
      physical.commit(generation, done);
      await done;
      await readback.mapAsync(GPUMapMode.READ);
      const field = new Uint32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      if (fields.has(index)) {
        assert.equal(labels.length, 0, `probe ${index}: cached revisit re-encoded GPU work`);
        assert.deepEqual(field, fields.get(index), `probe ${index}: complete field changed on revisit`);
        comparedBytes += bytes;
      } else {
        fields.set(index, field);
      }
      let gpuMs = 0;
      if (labels.length) {
        await times.mapAsync(GPUMapMode.READ);
        const ticks = new BigUint64Array(times.getMappedRange());
        for (let i = 0; i < labels.length; i++) {
          gpuMs += Number(ticks[i * 2 + 1] - ticks[i * 2]) / 1e6;
        }
        times.unmap();
      }
      samples.push({ index, cpuMs, gpuMs, passes: labels.length, labels });
    }
    return { status: "passed", comparedBytes, samples };
  } finally {
    await device.queue.onSubmittedWorkDone();
    physical.destroy();
    for (const resource of [output, readback, queries, resolved, times]) resource.destroy();
  }
}
