import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUBufferUsage = { COPY_DST: 1, STORAGE: 2, UNIFORM: 4 };
globalThis.GPUTextureUsage = { COPY_DST: 1, RENDER_ATTACHMENT: 2, TEXTURE_BINDING: 4 };
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

test("R4-A-03 bounded Material Visibility owner stages without private submit and rolls back abort", () => {
  const graphics = fakeGraphics();
  const table = new GpuMaterialVisibilityTable(graphics);
  const command = new FakeCommand();
  const material = new StandardShadeMaterial();
  material.texture_albedo = validTexture();

  const bindings = table.stage([material], command);
  assert.equal(bindings.materialCapacity, GPU_MATERIAL_VISIBILITY_CAPACITY);
  assert.equal(bindings.textureCapacity, GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY);
  assert.equal(command.writes.length, 1);
  assert.equal(command.writes[0].offset, material.id * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE);
  assert.equal(command.renderPassCount, 1);
  assert.deepEqual(table.evidence(), {
    schemaVersion: 1,
    abiVersion: 1,
    materialCapacity: GPU_MATERIAL_VISIBILITY_CAPACITY,
    textureCapacity: GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY,
    stagedMaterialCount: 1,
    residentTextureCount: 1,
    textureFallbackCount: 0,
    samplerFallbackCount: 0,
    allocatedBytes: 4_456_448,
    privateSubmitCount: 0,
    takeoverTask: "R4-B-02"
  });
  assert.equal(graphics.submitCount, 0);

  command.abort();
  assert.equal(table.evidence().stagedMaterialCount, 0);
  assert.equal(table.evidence().residentTextureCount, 0);

  table.destroy();
  assert.equal(graphics.buffers[0].destroyCount, 1);
  assert.equal(graphics.texturesCreated[0].destroyCount, 1);
});

test("R4-A-03 Material Visibility owner rejects material handles before recording GPU work", () => {
  const graphics = fakeGraphics();
  const table = new GpuMaterialVisibilityTable(graphics);
  const command = new FakeCommand();
  const material = {
    id: GPU_MATERIAL_VISIBILITY_CAPACITY,
    texture_albedo: undefined
  };

  assert.throws(
    () => table.stage([material], command),
    /exceeds R4-A visibility capacity/
  );
  assert.equal(command.writes.length, 0);
  assert.equal(command.renderPassCount, 0);
  assert.equal(table.evidence().stagedMaterialCount, 0);
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
  onAborted = new FakeSignal();
  writes = [];
  renderPassCount = 0;

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
        maxStorageBufferBindingSize: 1 << 30
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
      mipmaps: { flush() {} },
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
