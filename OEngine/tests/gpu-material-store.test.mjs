import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUBufferUsage = { COPY_DST: 1, STORAGE: 2 };

const { GPU_MATERIAL_CAPACITY, GpuMaterialStore } = await import(
  "../.test-dist/gpu/GpuMaterialStore.js"
);
const { GPU_MATERIAL_VISIBILITY_RECORD_STRIDE } = await import(
  "../.test-dist/gpu/GpuMaterialVisibilityAbi.js"
);
const { StandardShadeMaterial } = await import(
  "../.test-dist/material/StandardShadeMaterial.js"
);

test("GpuMaterialStore owns stable slots and rolls back an aborted transaction", () => {
  const device = fakeDevice();
  const store = new GpuMaterialStore(device);
  const material = new StandardShadeMaterial();
  const command = new FakeCommand();
  const staged = store.stage([material], new Map(), command);
  assert.deepEqual(staged.materialSlots, [0]);
  assert.equal(command.writes[0].offset, 0);
  assert.equal(new DataView(command.writes[0].bytes.buffer).getUint32(0, true), 0);
  assert.equal(store.evidence().residentMaterialSlotCount, 1);
  command.abort();
  assert.equal(store.evidence().residentMaterialSlotCount, 0);
  assert.equal(store.evidence().freeMaterialSlotCount, GPU_MATERIAL_CAPACITY);
  store.destroy();
  assert.equal(device.buffers[0].destroyCount, 1);
});

test("GpuMaterialStore delays slot reuse until GPU completion", async () => {
  const store = new GpuMaterialStore(fakeDevice());
  const a = new StandardShadeMaterial();
  const first = new FakeCommand();
  assert.deepEqual(store.stage([a], new Map(), first).materialSlots, [0]);
  first.finish();
  const done = deferred();
  const release = new FakeCommand(done.promise);
  store.release([a], release);
  release.finish();
  assert.equal(store.evidence().retiringMaterialSlotCount, 1);
  const b = new StandardShadeMaterial();
  const second = store.stage([b], new Map(), new FakeCommand());
  assert.notEqual(second.materialSlots[0], 0);
  done.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const c = new StandardShadeMaterial();
  assert.equal(store.stage([c], new Map(), new FakeCommand()).materialSlots[0], 0);
  store.destroy();
});

test("GpuMaterialStore rejects capacity and unsupported UV before GPU writes", () => {
  const store = new GpuMaterialStore(fakeDevice());
  const invalid = new StandardShadeMaterial();
  invalid.base_color_uv_set = 3;
  const command = new FakeCommand();
  assert.throws(() => store.stage([invalid], new Map(), command), /supports TEXCOORD_0/);
  assert.equal(command.writes.length, 0);
  const materials = Array.from({ length: GPU_MATERIAL_CAPACITY + 1 }, () => new StandardShadeMaterial());
  assert.throws(() => store.stage(materials, new Map(), command), /only 4096/);
  store.destroy();
});

class FakeSignal {
  listeners = [];
  addOne(listener) { this.listeners.push(listener); }
  send(...args) { for (const listener of this.listeners.splice(0)) listener(...args); }
}

class FakeCommand {
  onFinished = new FakeSignal();
  onAborted = new FakeSignal();
  writes = [];
  constructor(gpuDone = Promise.resolve()) { this.gpuDone = gpuDone; }
  writeBuffer(_buffer, offset, data, dataOffset, size) {
    this.writes.push({ offset, bytes: new Uint8Array(data, dataOffset, size).slice() });
  }
  abort() { this.onAborted.send(this, new Error("aborted")); }
  finish() { this.onFinished.send(this); }
}

function fakeDevice() {
  const buffers = [];
  return {
    buffers,
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer(descriptor) {
      const mapped = new ArrayBuffer(descriptor.size);
      const buffer = {
        descriptor,
        destroyCount: 0,
        getMappedRange: () => mapped,
        unmap() {},
        destroy() { this.destroyCount++; }
      };
      buffers.push(buffer);
      return buffer;
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
