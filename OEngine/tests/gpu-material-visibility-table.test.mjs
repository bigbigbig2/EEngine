import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUBufferUsage = { COPY_DST: 1, STORAGE: 2, UNIFORM: 4 };
globalThis.GPUTextureUsage = { COPY_DST: 1, RENDER_ATTACHMENT: 2, TEXTURE_BINDING: 4, COPY_SRC: 8 };
globalThis.GPUShaderStage = { FRAGMENT: 2 };

const {
  GPU_MATERIAL_VISIBILITY_CAPACITY,
  GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY,
  GpuMaterialVisibilityTable
} = await import("../.test-dist/gpu/GpuMaterialVisibilityTable.js");
const { GPU_MATERIAL_VISIBILITY_RECORD_STRIDE } = await import(
  "../.test-dist/gpu/GpuMaterialVisibilityAbi.js"
);
const { StandardShadeMaterial } = await import(
  "../.test-dist/material/StandardShadeMaterial.js"
);
const { ShadeImage, ShadeTexture } = await import(
  "../.test-dist/texture/ShadeTexture.js"
);

test("R4-B Material owner assigns dense slots independent of global material.id and rolls back abort", () => {
  const graphics = fakeGraphics();
  const table = new GpuMaterialVisibilityTable(graphics);
  const command = new FakeCommand();
  let material = new StandardShadeMaterial();
  while (material.id <= GPU_MATERIAL_VISIBILITY_CAPACITY + 32) {
    material = new StandardShadeMaterial();
  }
  material.texture_albedo = validTexture();

  const staged = table.stage([material], command);
  assert.equal(staged.bindings.materialCapacity, GPU_MATERIAL_VISIBILITY_CAPACITY);
  assert.equal(staged.bindings.textureCapacity, GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY);
  assert.deepEqual(staged.materialSlots, [0]);
  assert.equal(command.writes.length, 1);
  assert.equal(command.writes[0].offset, 0 * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE);
  assert.equal(new DataView(command.writes[0].bytes.buffer).getUint32(0, true), 0);
  assert.equal(command.renderPassCount, 1);
  assert.deepEqual(table.evidence(), {
    schemaVersion: 6,
    abiVersion: 3,
    materialCapacity: GPU_MATERIAL_VISIBILITY_CAPACITY,
    textureCapacity: GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY,
    residentMaterialSlotCount: 1,
    retiringMaterialSlotCount: 0,
    freeMaterialSlotCount: GPU_MATERIAL_VISIBILITY_CAPACITY - 1,
    residentTextureCount: 1,
    retiringTextureCount: 0,
    freeTextureLayerCount: GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY - 2,
    textureFallbackCount: 0,
    samplerFallbackCount: 0,
    allocatedBytes: 23_287_040,
    residentTextureBytes: 22_369_536,
    textureSize: 256,
    mipLevelCount: 9,
    highResolutionTextureSize: 4096,
    highResolutionTextureCapacity: 16,
    highResolutionMipLevelCount: 13,
    highResolutionArrayAllocated: false,
    residentHighResolutionTextureCount: 0,
    retiringHighResolutionTextureCount: 0,
    freeHighResolutionTextureLayerCount: 15,
    privateSubmitCount: 0,
    takeoverTask: null
  });
  assert.equal(graphics.submitCount, 0);

  command.abort();
  assert.equal(table.evidence().residentMaterialSlotCount, 0);
  assert.equal(table.evidence().freeMaterialSlotCount, GPU_MATERIAL_VISIBILITY_CAPACITY);
  assert.equal(table.evidence().residentTextureCount, 0);
  assert.equal(
    table.evidence().freeTextureLayerCount,
    GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY - 1
  );

  table.destroy();
  assert.equal(graphics.buffers[0].destroyCount, 1);
  assert.equal(graphics.texturesCreated[0].destroyCount, 1);
});

test("R4-B Texture owner refcounts shared layers and reuses them only after GPU completion", async () => {
  const graphics = fakeGraphics();
  const table = new GpuMaterialVisibilityTable(graphics);
  const sharedTexture = validTexture();
  const a = new StandardShadeMaterial();
  const b = new StandardShadeMaterial();
  a.texture_albedo = sharedTexture;
  b.texture_normal = sharedTexture;

  const stage = new FakeCommand();
  table.stage([a, b], stage);
  const sharedLayer = textureRef(stage.writes[0]);
  assert.equal(sharedLayer, 1);
  stage.finish();
  assert.equal(table.evidence().residentTextureCount, 1);
  assert.equal(table.evidence().retiringTextureCount, 0);
  assert.equal(
    table.evidence().freeTextureLayerCount,
    GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY - 2
  );

  const releaseA = new FakeCommand();
  table.release([a], releaseA);
  releaseA.finish();
  await Promise.resolve();
  assert.equal(table.evidence().residentTextureCount, 1);

  const completion = deferred();
  const releaseB = new FakeCommand(completion.promise);
  table.release([b], releaseB);
  releaseB.finish();
  assert.equal(table.evidence().residentTextureCount, 0);
  assert.equal(table.evidence().retiringTextureCount, 1);
  assert.equal(
    table.evidence().freeTextureLayerCount,
    GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY - 2
  );

  const whileRetiring = new StandardShadeMaterial();
  whileRetiring.texture_albedo = validTexture();
  const whileRetiringStage = new FakeCommand();
  table.stage([whileRetiring], whileRetiringStage);
  assert.notEqual(textureRef(whileRetiringStage.writes[0]), sharedLayer);
  whileRetiringStage.finish();

  completion.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(table.evidence().retiringTextureCount, 0);
  assert.equal(
    table.evidence().freeTextureLayerCount,
    GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY - 2
  );

  const reused = new StandardShadeMaterial();
  reused.texture_albedo = validTexture();
  const reusedStage = new FakeCommand();
  table.stage([reused], reusedStage);
  assert.equal(textureRef(reusedStage.writes[0]), sharedLayer);
  table.destroy();
});

test("R4-B Material owner refcounts shared residency and reuses slots only after GPU completion", async () => {
  const graphics = fakeGraphics();
  const table = new GpuMaterialVisibilityTable(graphics);
  const a = new StandardShadeMaterial();
  const b = new StandardShadeMaterial();
  const first = new FakeCommand();
  const firstStage = table.stage([a, b], first);
  first.finish();
  assert.deepEqual(firstStage.materialSlots, [0, 1]);

  const shared = new FakeCommand();
  assert.deepEqual(table.stage([a], shared).materialSlots, [0]);
  shared.finish();

  const releaseShared = new FakeCommand();
  table.release([a], releaseShared);
  releaseShared.finish();
  assert.equal(table.evidence().residentMaterialSlotCount, 2);

  const completion = deferred();
  const releaseLast = new FakeCommand(completion.promise);
  table.release([a, b], releaseLast);
  releaseLast.finish();
  assert.equal(table.evidence().residentMaterialSlotCount, 0);
  assert.equal(table.evidence().retiringMaterialSlotCount, 2);
  assert.equal(table.evidence().freeMaterialSlotCount, GPU_MATERIAL_VISIBILITY_CAPACITY - 2);

  completion.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(table.evidence().retiringMaterialSlotCount, 0);
  assert.equal(table.evidence().freeMaterialSlotCount, GPU_MATERIAL_VISIBILITY_CAPACITY);

  const reused = table.stage([new StandardShadeMaterial()], new FakeCommand());
  assert.ok(firstStage.materialSlots.includes(reused.materialSlots[0]));
  table.destroy();
});

test("R4-B 4K textures use the lazy bounded high-resolution array", () => {
  const graphics = fakeGraphics();
  const table = new GpuMaterialVisibilityTable(graphics);
  const texture = validTexture();
  texture.image.width = 4096;
  texture.image.height = 4096;
  const material = new StandardShadeMaterial();
  material.texture_albedo = texture;
  const command = new FakeCommand();
  const staged = table.stage([material], command);
  const ref = textureRef(command.writes[0]);
  assert.equal((ref & 0x80000000) >>> 0, 0x80000000);
  assert.equal(ref & 0x7fffffff, 1);
  assert.notEqual(
    staged.bindings.highResolutionTextureArray,
    staged.bindings.textureArray
  );
  assert.equal(table.evidence().highResolutionArrayAllocated, true);
  assert.equal(table.evidence().residentHighResolutionTextureCount, 1);
  assert.equal(graphics.texturesCreated.length, 2);
  assert.deepEqual(graphics.texturesCreated[1].descriptor.size, [4096, 4096, 16]);
  table.destroy();
});

test("R4-B 2K bulk residency selects a 32-layer bank without upscaling to 4K", () => {
  const graphics = fakeGraphics();
  const table = new GpuMaterialVisibilityTable(graphics);
  const materials = Array.from({ length: 25 }, () => {
    const texture = validTexture();
    texture.image.width = 2048;
    texture.image.height = 2048;
    const material = new StandardShadeMaterial();
    material.texture_orm = texture;
    return material;
  });
  const command = new FakeCommand();

  table.stage(materials, command);

  assert.deepEqual(graphics.texturesCreated[1].descriptor.size, [2048, 2048, 32]);
  assert.equal(graphics.texturesCreated[1].descriptor.mipLevelCount, 12);
  assert.equal(table.evidence().highResolutionTextureSize, 2048);
  assert.equal(table.evidence().highResolutionTextureCapacity, 32);
  assert.equal(table.evidence().residentHighResolutionTextureCount, 25);
  assert.equal(table.evidence().freeHighResolutionTextureLayerCount, 6);
  table.destroy();
});

test("R4-B Material owner accepts UV2 and rejects UV3 before GPU work", () => {
  const graphics = fakeGraphics();
  const table = new GpuMaterialVisibilityTable(graphics);
  const invalidUv = new StandardShadeMaterial();
  invalidUv.base_color_uv_set = 2;
  const uvCommand = new FakeCommand();
  assert.doesNotThrow(() => table.stage([invalidUv], uvCommand));
  uvCommand.abort();
  invalidUv.base_color_uv_set = 3;
  const invalidCommand = new FakeCommand();
  assert.throws(() => table.stage([invalidUv], invalidCommand), /supports TEXCOORD_0/);
  assert.equal(invalidCommand.writes.length, 0);
  assert.equal(invalidCommand.renderPassCount, 0);

  const materials = Array.from(
    { length: GPU_MATERIAL_VISIBILITY_CAPACITY + 1 },
    () => new StandardShadeMaterial()
  );
  const capacityCommand = new FakeCommand();
  assert.throws(() => table.stage(materials, capacityCommand), /only 4096 .* are free/);
  assert.equal(capacityCommand.writes.length, 0);
  assert.equal(capacityCommand.renderPassCount, 0);
  assert.equal(table.evidence().residentMaterialSlotCount, 0);
  table.destroy();
});

class FakeSignal {
  listeners = [];

  addOne(listener) {
    this.listeners.push(listener);
  }

  send(...args) {
    for (const listener of this.listeners.splice(0)) listener(...args);
  }
}

class FakeCommand {
  onFinished = new FakeSignal();
  onAborted = new FakeSignal();
  writes = [];
  renderPassCount = 0;

  constructor(gpuDone = Promise.resolve()) {
    this.gpuDone = gpuDone;
  }

  writeBuffer(_buffer, offset, data, dataOffset, size) {
    this.writes.push({ offset, bytes: new Uint8Array(data, dataOffset, size).slice() });
  }

  allocateTransientBufferAndLoad() {
    return {};
  }

  beginRenderPass() {
    this.renderPassCount++;
    return {
      setViewport() {},
      setPipeline() {},
      setBindGroup() {},
      draw() {},
      end() {}
    };
  }

  abort() {
    this.onAborted.send(this, new Error("aborted"));
  }

  finish() {
    this.onFinished.send(this);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeGraphics() {
  const buffers = [];
  const texturesCreated = [];
  const residentTextures = new Map();
  return {
    buffers,
    texturesCreated,
    submitCount: 0,
    device: {
      limits: {
        maxBufferSize: 1 << 30,
        maxStorageBufferBindingSize: 1 << 30,
        maxTextureDimension2D: 8192,
        maxTextureArrayLayers: 256
      },
      createBuffer(descriptor) {
        const mapped = new ArrayBuffer(descriptor.size);
        const buffer = {
          descriptor,
          destroyCount: 0,
          getMappedRange: () => mapped,
          unmap() {},
          destroy() {
            this.destroyCount++;
          }
        };
        buffers.push(buffer);
        return buffer;
      },
      createTexture(descriptor) {
        const texture = {
          descriptor,
          destroyCount: 0,
          createView: () => ({ texture }),
          destroy() {
            this.destroyCount++;
          }
        };
        texturesCreated.push(texture);
        return texture;
      }
    },
    textures: {
      mipmaps: { flush() {}, generateMipmap() {} },
      obtain(source) {
        let resident = residentTextures.get(source);
        if (resident === undefined) {
          resident = {
            width: source.image.width,
            height: source.image.height,
            obtainView: () => ({ source })
          };
          residentTextures.set(source, resident);
        }
        return resident;
      }
    },
    bind_groups: { obtain: () => ({}) },
    render_pipelines: { obtain: () => ({}) }
  };
}

function validTexture() {
  const image = ShadeImage.fromArrayBuffer(
    new Uint8Array([255, 255, 255, 255]),
    4,
    "uint8",
    1,
    1,
    1
  );
  image.color_space = 0;
  image.normalized = true;
  return ShadeTexture.from(image);
}

function textureRef(write) {
  return new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength)
    .getUint32(12, true);
}
