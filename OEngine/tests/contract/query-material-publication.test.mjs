import assert from "node:assert/strict";
import test from "node:test";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";

globalThis.GPUBufferUsage = { STORAGE: 128 };
globalThis.GPUShaderStage = { COMPUTE: 4, VERTEX: 1, FRAGMENT: 2 };
const { GpuQueryMaterialPublication } = await import("../../.test-dist/gpu/GpuQueryMaterialPublication.js");

function fixture() {
  const buffers = [];
  const device = {
    limits: { maxBufferSize: 4096, maxStorageBufferBindingSize: 4096,
      maxBindGroups: 4, maxBindingsPerBindGroup: 1000,
      maxStorageBuffersPerShaderStage: 16, maxUniformBuffersPerShaderStage: 12,
      maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16,
      maxStorageTexturesPerShaderStage: 8 },
    lost: new Promise(() => {}),
    createBuffer(descriptor) {
      const bytes = new ArrayBuffer(descriptor.size);
      const buffer = { ...descriptor, bytes, destroyed: false,
        getMappedRange: () => bytes, unmap() {},
        destroy() { this.destroyed = true; } };
      buffers.push(buffer);
      return buffer;
    },
  };
  const resource = { size: 32 };
  const material = (materialSlot, constants, offset = 0) => ({ materialSlot,
    constants: Float32Array.from(constants), unlit: false, viewDependent: false,
    binding: { program: { key: "native-diffuse" },
      layoutEntries: [{ binding: 0, visibility: 4, buffer: { type: "read-only-storage" } }],
      entries: [{ binding: 0, resource: { buffer: resource, offset, size: 16 } }] },
  });
  const source = { valid: true,
    materials: [material(1, [1, 2]), material(3, [3, 4]), material(4, [5, 6], 16)] };
  return { device, buffers, material, source };
}

test("native query bins share exact buffer ranges and concatenate immutable constants once", () => {
  const f = fixture();
  const publication = new GpuQueryMaterialPublication(f.device, f.source, new ResourceAccounting());
  assert.equal(publication.bins.length, 2);
  assert.deepEqual([...new Float32Array(publication.bins[0].constants.bytes)], [1, 2, 3, 4]);
  assert.deepEqual([...new Uint32Array(publication.directory.bytes).subarray(12, 16)], [2, 0, 0, 1]);
  assert.deepEqual([...new Uint32Array(publication.directory.bytes).subarray(16, 20)], [0, 1, 0, 1]);
  f.source.materials[0].constants[0] = 99;
  assert.equal(new Float32Array(publication.bins[0].constants.bytes)[0], 1);
  assert.equal(publication.byteLength, 5 * 16 + 6 * 4);
  assert.equal(f.buffers.length, 3, "one constants buffer per physical native bin, never per AS shard");
  f.source.valid = false;
  assert.equal(publication.valid, false);
  publication.destroy();
  publication.destroy();
  assert.ok(f.buffers.every((buffer) => buffer.destroyed));
});

test("query directory rejects duplicate/invalid slots and capacity before allocating", () => {
  for (const slot of [1, -1, NaN, 0xffffffff]) {
    const f = fixture();
    f.source.materials[1] = f.material(slot, [3, 4]);
    assert.throws(() => new GpuQueryMaterialPublication(f.device, f.source), /unique finite/);
    assert.equal(f.buffers.length, 0);
  }
  const f = fixture();
  f.device.limits.maxStorageBufferBindingSize = 32;
  assert.throws(() => new GpuQueryMaterialPublication(f.device, f.source), /binding capacity/);
  assert.equal(f.buffers.length, 0);
});

test("query constants allocation failure retires every successfully created candidate resource", () => {
  const f = fixture();
  const allocate = f.device.createBuffer;
  f.device.createBuffer = (descriptor) => {
    if (f.buffers.length === 1) {
      throw new Error("allocation failure");
    }
    return allocate(descriptor);
  };
  assert.throws(() => new GpuQueryMaterialPublication(f.device, f.source), /allocation failure/);
  assert.ok(f.buffers.every((buffer) => buffer.destroyed));
});
