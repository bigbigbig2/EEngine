import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({
  COPY_DST: 1 << 3,
  STORAGE: 1 << 7
});

const [
  { GpuMaterialStore, GPU_MATERIAL_CAPACITY },
  {
    GPU_SHADING_MATERIAL_RECORD_STRIDE,
    GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL,
    GPU_SHADING_TEXTURE_ROUTE_STRIDE,
    unpackGpuShadingMaterialHeader,
    unpackGpuShadingTextureRoute
  },
  { StandardShadeMaterial }
] = await Promise.all([
  import("../.test-dist/gpu/GpuMaterialStore.js"),
  import("../.test-dist/gpu/GpuShadingMaterialAbi.js"),
  import("../.test-dist/material/StandardShadeMaterial.js")
]);

test("material store publishes geometry-dependent association records in one generation", async () => {
  const device = createDevice();
  const store = new GpuMaterialStore(device);
  const material = new StandardShadeMaterial();
  material.name = "association-unlit";
  material.is_unlit = true;
  const associations = [
    { material, programId: 0, textureBindingSetId: 0 },
    { material, programId: 1, textureBindingSetId: 0 }
  ];
  const routes = new Map([[material, new Map()]]);

  const aborted = new FakeMaterialCommand(device);
  const first = store.stage(associations, routes, aborted);
  assert.equal(first.materialGeneration, 1);
  assert.equal(store.evidence().freeMaterialSlotCount, GPU_MATERIAL_CAPACITY - 2);
  aborted.abort();
  assert.equal(store.evidence().freeMaterialSlotCount, GPU_MATERIAL_CAPACITY);
  assert.equal(store.evidence().residentPublicationCount, 0);

  const committed = new FakeMaterialCommand(device);
  const stage = store.stage(associations, routes, committed);
  assert.equal(stage.materialGeneration, 1, "aborted publication must not advance generation");
  assert.equal(stage.textureGeneration, 1);
  assert.equal(stage.publicationRevision, 1);
  committed.finish();

  const materialBytes = stage.bindings.materialRecords.bytes;
  assert.deepEqual(stage.associationSlots.map((slot) =>
    unpackGpuShadingMaterialHeader(
      materialBytes,
      slot * GPU_SHADING_MATERIAL_RECORD_STRIDE
    ).programId), [0, 1]);
  for (const slot of stage.associationSlots) {
    const header = unpackGpuShadingMaterialHeader(
      materialBytes,
      slot * GPU_SHADING_MATERIAL_RECORD_STRIDE
    );
    assert.equal(header.materialGeneration, 1);
    assert.equal(header.textureGeneration, 1);
    assert.equal(header.publicationRevision, 1);
    for (let routeIndex = 0; routeIndex < GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL; routeIndex++) {
      const route = unpackGpuShadingTextureRoute(
        stage.bindings.textureRouteRecords.bytes,
        (slot * GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL + routeIndex) * GPU_SHADING_TEXTURE_ROUTE_STRIDE
      );
      assert.equal(route.textureGeneration, 1);
      assert.equal(route.publicationRevision, 1);
      assert.equal(route.textureBindingSetId, 0);
    }
  }
  assert.equal(store.evidence().residentPublicationCount, 1);
  assert.equal(store.evidence().residentMaterialSlotCount, 2);

  const abortedRelease = new FakeMaterialCommand(device);
  store.release(stage.handle, abortedRelease);
  abortedRelease.abort();
  assert.equal(store.evidence().residentPublicationCount, 1);

  const release = new FakeMaterialCommand(device);
  store.release(stage.handle, release);
  release.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.evidence().residentPublicationCount, 0);
  assert.equal(store.evidence().freeMaterialSlotCount, GPU_MATERIAL_CAPACITY);

  const nextCommand = new FakeMaterialCommand(device);
  const next = store.stage([associations[0]], routes, nextCommand);
  assert.equal(next.materialGeneration, 2);
  nextCommand.abort();
  store.destroy();
});

test("material association preflight rejects invalid identity without reserving slots", () => {
  const device = createDevice();
  const store = new GpuMaterialStore(device);
  const material = new StandardShadeMaterial();
  material.is_unlit = true;
  const command = new FakeMaterialCommand(device);
  assert.throws(
    () => store.stage(
      [{ material, programId: 16, textureBindingSetId: 0 }],
      new Map([[material, new Map()]]),
      command
    ),
    /program id must be in \[0, 15\]/i
  );
  assert.equal(store.evidence().freeMaterialSlotCount, GPU_MATERIAL_CAPACITY);
  assert.equal(store.evidence().residentPublicationCount, 0);
  store.destroy();
});

class Signal {
  listeners = [];

  addOne(listener) {
    this.listeners.push(listener);
  }

  dispatch(...args) {
    const listeners = this.listeners.splice(0);
    for (const listener of listeners) listener(...args);
  }
}

class FakeMaterialCommand {
  onFinished = new Signal();
  onAborted = new Signal();
  gpuDone = Promise.resolve();
  closed = false;

  constructor(device) {
    this.device = device;
  }

  writeBuffer(buffer, bufferOffset, data, dataOffset, size) {
    buffer.bytes.set(new Uint8Array(data, dataOffset, size), bufferOffset);
  }

  finish() {
    this.closed = true;
    this.onFinished.dispatch(this);
  }

  abort() {
    this.closed = true;
    this.onAborted.dispatch(this, new Error("injected abort"));
  }
}

function createDevice() {
  return {
    limits: {
      maxBufferSize: 128 * 1024 * 1024,
      maxStorageBufferBindingSize: 128 * 1024 * 1024
    },
    createBuffer(descriptor) {
      const bytes = new Uint8Array(descriptor.size);
      return {
        descriptor,
        bytes,
        destroyed: false,
        getMappedRange: () => bytes.buffer,
        unmap() {},
        destroy() {
          this.destroyed = true;
        }
      };
    }
  };
}
