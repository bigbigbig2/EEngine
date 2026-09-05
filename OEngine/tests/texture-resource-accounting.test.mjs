import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1 << 0,
  COPY_DST: 1 << 1,
  TEXTURE_BINDING: 1 << 2,
  STORAGE_BINDING: 1 << 3,
  RENDER_ATTACHMENT: 1 << 4
};
globalThis.GPUShaderStage ??= {
  VERTEX: 1 << 0,
  FRAGMENT: 1 << 1,
  COMPUTE: 1 << 2
};
globalThis.GPUBufferUsage ??= {
  COPY_SRC: 1 << 0,
  COPY_DST: 1 << 1,
  UNIFORM: 1 << 2,
  STORAGE: 1 << 3,
  INDIRECT: 1 << 4
};

const { ResourceAccounting } = await import(
  "../.test-dist/debug/profiling/ResourceAccounting.js"
);
const { GPUTextureContext } = await import(
  "../.test-dist/gpu/GPUTextureContext.js"
);
const { GPUTextureAllocator } = await import(
  "../.test-dist/gpu/GPUTextureAllocator.js"
);
const { LightProbeAtlasTexture } = await import(
  "../.test-dist/gpu/LightProbeAtlas.js"
);

test("GPUTextureContext accounts lazy history allocation, resize and destroy", () => {
  const accounting = new ResourceAccounting();
  const context = new GPUTextureContext(
    fakeDevice(),
    textureDescriptor("history", 4, 4, "rgba8unorm"),
    { accounting, category: "history", owner: "test/history" }
  );

  assert.equal(accounting.snapshot().totalBytes, 0);
  void context.gpu_texture;
  assert.deepEqual(accounting.snapshot().categories.history, {
    bytes: 64,
    peakBytes: 64,
    count: 1
  });

  context.resize(8, 4);
  assert.equal(accounting.snapshot().categories.history.bytes, 128);
  assert.equal(accounting.snapshot().categories.history.count, 1);
  context.destroy();
  assert.equal(accounting.snapshot().totalBytes, 0);
});

test("GPUTextureAllocator classifies physical pool textures as transient", () => {
  const accounting = new ResourceAccounting();
  const allocator = new GPUTextureAllocator(fakeDevice(), accounting);
  const texture = allocator.get({
    width: 8,
    height: 4,
    format: "r8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING
  });

  void texture.gpu_texture;
  assert.deepEqual(accounting.snapshot().categories.transient, {
    bytes: 32,
    peakBytes: 32,
    count: 1
  });
  allocator.release(texture);
  allocator.destroy();
  assert.equal(accounting.snapshot().totalBytes, 0);
});

test("LightProbeAtlasTexture accounts its physical atlas footprint", () => {
  const accounting = new ResourceAccounting();
  const atlas = new LightProbeAtlasTexture(
    fakeDevice(),
    "test atlas",
    "rg16float",
    GPUTextureUsage.TEXTURE_BINDING,
    4,
    4,
    { accounting, category: "atlas", owner: "test/atlas" }
  );

  void atlas.texture;
  assert.equal(atlas.gpu_memory_usage, 64);
  assert.equal(accounting.snapshot().categories.atlas.bytes, 64);
  atlas.resize(8, 4);
  assert.equal(atlas.gpu_memory_usage, 128);
  assert.equal(accounting.snapshot().categories.atlas.bytes, 128);
  atlas.destroy();
  assert.equal(accounting.snapshot().totalBytes, 0);
});

function textureDescriptor(label, width, height, format) {
  return {
    label,
    size: [width, height, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING
  };
}

function fakeDevice() {
  return {
    createTexture(descriptor) {
      const [width, height, depthOrArrayLayers = 1] = descriptor.size;
      return {
        ...descriptor,
        width,
        height,
        depthOrArrayLayers,
        createView() { return {}; },
        destroy() {}
      };
    }
  };
}
