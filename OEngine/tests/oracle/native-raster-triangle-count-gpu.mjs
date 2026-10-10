import assert from "node:assert/strict";
import { NativeRasterWorkPartitions } from "../../.test-dist/render/surface/NativeRasterWorkPartitions.js";
import { FRAME_GEOMETRY_ARENA_VERSION } from "../../.test-dist/gpu/GpuFrameGeometryArenaAbi.js";

export async function runNativeRasterTriangleCountGpuOracle(device) {
  const resources = [];
  const buffer = (words) => {
    const b = device.createBuffer({
      size: words.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(b, 0, words);
    resources.push(b);
    return b;
  };
  // Seven work records exercise each bucket edge, both sides and a capacity miss.
  const counts = [1, 32, 33, 64, 65, 96, 128, 7];
  const queue = new Uint32Array(8 + counts.length * 6);
  queue.set([counts.length, counts.length, 0, counts.length, 0, 7, 0, 0]);
  counts.forEach((_, i) => queue.set([0, 0, 0, 0, 128 | (i % 2 ? 16 : 0), 0], 8 + i * 6));
  const work = buffer(queue),
    material = buffer(new Uint32Array([0, 0, 0, 1]));
  const metadata = new Uint32Array(16 + 4 + counts.length * 6);
  metadata[0] = FRAME_GEOMETRY_ARENA_VERSION;
  metadata[4] = 16;
  metadata[5] = 16;
  metadata.set([counts.length, 7, 0, 0], 16);
  counts.forEach((count, i) => metadata.set([0, 0, i === 7 ? 0 : 128, count], 20 + i * 6));
  const arena = buffer(metadata);
  const owner = new NativeRasterWorkPartitions(device, {
    work,
    metadata: arena,
    publication: { rasterDirectory: material, rasterClasses: [{}] },
    capacity: counts.length,
    meshletWordBase: 0,
    frameGeometryHeader: 0,
    generation: 7,
  });
  const readback = device.createBuffer({
    size: owner.states.size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  resources.push(readback);
  try {
    await owner.ready;
    const run = async (generation) => {
      metadata[17] = generation;
      device.queue.writeBuffer(arena, 0, metadata);
      const encoder = device.createCommandEncoder();
      owner.encode(encoder);
      encoder.copyBufferToBuffer(owner.states, 0, readback, 0, owner.states.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const states = new Uint32Array(readback.getMappedRange()).slice();
      readback.unmap();
      return states;
    };
    const states = await run(7);
    const expected = new Uint32Array(8);
    counts.forEach((count, i) => expected[Math.floor(((i === 7 ? 128 : count) - 1) / 32) * 2 + (i % 2)]++);
    for (let i = 0; i < 8; i++) assert.equal(states[i * 4], expected[i], `bucket ${i}`);
    assert.deepEqual(Array.from(states.slice(32, 36)), [0, 0, 0, 0]);
    const stale = await run(6);
    assert.equal(stale[6 * 4], 4);
    assert.equal(stale[7 * 4], 4, "stale directory must retain full source work");
    assert.deepEqual(Array.from(stale.slice(32, 36)), [0, 0, 0, 0]);
    return { status: "passed", counts, completeCapacityMiss: true, completeStaleDirectory: true };
  } finally {
    owner.destroy();
    resources.forEach((resource) => resource.destroy());
  }
}
