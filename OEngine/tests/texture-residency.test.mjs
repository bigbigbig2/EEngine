import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUBufferUsage = { UNIFORM: 1 };
globalThis.GPUTextureUsage = { COPY_DST: 1, RENDER_ATTACHMENT: 2, TEXTURE_BINDING: 4, COPY_SRC: 8 };
globalThis.GPUShaderStage = { FRAGMENT: 2 };

const { TextureResidency, TEXTURE_RESIDENCY_BASE_CAPACITY } = await import(
  "../.test-dist/gpu/TextureResidency.js"
);
const { StandardShadeMaterial } = await import("../.test-dist/material/StandardShadeMaterial.js");
const { ShadeImage, ShadeTexture } = await import("../.test-dist/texture/ShadeTexture.js");

test("TextureResidency shares TextureRef and retires layers after GPU completion", async () => {
  const graphics = fakeGraphics();
  const residency = new TextureResidency(graphics);
  const shared = validTexture();
  const a = new StandardShadeMaterial();
  const b = new StandardShadeMaterial();
  a.texture_albedo = shared;
  b.texture_normal = shared;
  const stage = new FakeCommand();
  const staged = residency.stage([a, b], stage);
  assert.equal(staged.textureRefs.get(shared), 1);
  assert.equal(residency.evidence().residentTextureCount, 1);
  stage.finish();
  const releaseA = new FakeCommand();
  residency.release([a], releaseA);
  releaseA.finish();
  assert.equal(residency.evidence().residentTextureCount, 1);
  const done = deferred();
  const releaseB = new FakeCommand(done.promise);
  residency.release([b], releaseB);
  releaseB.finish();
  assert.equal(residency.evidence().retiringTextureCount, 1);
  done.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(residency.evidence().retiringTextureCount, 0);
  residency.destroy();
});

test("4K residency uses transaction-sized bank instead of fixed 16-layer allocation", () => {
  const graphics = fakeGraphics();
  const residency = new TextureResidency(graphics);
  const texture = validTexture(4096, 4096);
  const material = new StandardShadeMaterial();
  material.texture_albedo = texture;
  const command = new FakeCommand();
  const stage = residency.stage([material], command);
  const ref = stage.textureRefs.get(texture);
  assert.equal((ref & 0x80000000) >>> 0, 0x80000000);
  assert.equal(ref & 0x7fffffff, 1);
  assert.deepEqual(graphics.texturesCreated[1].descriptor.size, [4096, 4096, 2]);
  assert.equal(residency.evidence().highResolutionTextureCapacity, 2);
  residency.destroy();
});

test("bulk 2K residency preflights one exact power-of-two bank", () => {
  const graphics = fakeGraphics();
  const residency = new TextureResidency(graphics);
  const materials = Array.from({ length: 25 }, () => {
    const material = new StandardShadeMaterial();
    material.texture_orm = validTexture(2048, 2048);
    return material;
  });
  residency.stage(materials, new FakeCommand());
  assert.deepEqual(graphics.texturesCreated[1].descriptor.size, [2048, 2048, 32]);
  assert.equal(residency.evidence().residentHighResolutionTextureCount, 25);
  assert.equal(residency.evidence().freeHighResolutionTextureLayerCount, 6);
  residency.destroy();
});

test("base bank capacity fails before upload work", () => {
  const graphics = fakeGraphics();
  const residency = new TextureResidency(graphics);
  const materials = Array.from({ length: TEXTURE_RESIDENCY_BASE_CAPACITY }, () => {
    const material = new StandardShadeMaterial();
    material.texture_albedo = validTexture();
    return material;
  });
  const command = new FakeCommand();
  assert.throws(() => residency.stage(materials, command), /only 63/);
  assert.equal(command.renderPassCount, 0);
  residency.destroy();
});

class FakeSignal {
  listeners = [];
  addOne(listener) { this.listeners.push(listener); }
  send(...args) { for (const listener of this.listeners.splice(0)) listener(...args); }
}
class FakeCommand {
  onFinished = new FakeSignal();
  onAborted = new FakeSignal();
  renderPassCount = 0;
  constructor(gpuDone = Promise.resolve()) { this.gpuDone = gpuDone; }
  allocateTransientBufferAndLoad() { return {}; }
  beginRenderPass() {
    this.renderPassCount++;
    return { setViewport() {}, setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
  }
  finish() { this.onFinished.send(this); }
  abort() { this.onAborted.send(this, new Error("aborted")); }
}

function fakeGraphics() {
  const texturesCreated = [];
  const residentTextures = new Map();
  return {
    texturesCreated,
    device: {
      limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 },
      createTexture(descriptor) {
        const texture = {
          descriptor,
          destroyCount: 0,
          createView: () => ({ texture }),
          destroy() { this.destroyCount++; }
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

function validTexture(width = 1, height = 1) {
  const image = ShadeImage.fromArrayBuffer(
    new Uint8Array(4), 4, "uint8", 1, 1, 1
  );
  image.width = width;
  image.height = height;
  image.color_space = 0;
  image.normalized = true;
  return ShadeTexture.from(image);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
