import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../webgpu-test-globals.mjs";
import { GPUTextureAllocator } from "../../.test-dist/gpu/GPUTextureAllocator.js";
import { GPUTextureContext } from "../../.test-dist/gpu/GPUTextureContext.js";
import { GPUTextureManager } from "../../.test-dist/gpu/GPUTextureManager.js";
import { GPUCameraStateManager } from "../../.test-dist/render/GPUCameraState.js";
import { GPUVolumetrics } from "../../.test-dist/gpu/GPUVolumetrics.js";
import { ShadeImage, ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { resolveTextureView } from "../../.test-dist/render/RenderTargetViews.js";

const oengineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

globalThis.GPUBufferUsage ??= Object.freeze({
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
  INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256,
});

function textureFromDescriptor(descriptor, createView) {
  const size = Array.from(descriptor.size);
  return {
    label: descriptor.label ?? "",
    width: size[0] ?? 1,
    height: size[1] ?? 1,
    depthOrArrayLayers: size[2] ?? 1,
    mipLevelCount: descriptor.mipLevelCount ?? 1,
    sampleCount: descriptor.sampleCount ?? 1,
    dimension: descriptor.dimension ?? "2d",
    format: descriptor.format,
    usage: descriptor.usage,
    createView,
    destroy() {},
  };
}

test("texture allocation isolates retained pool descriptors from API instrumentation", () => {
  let creationCount = 0;
  const device = {
    createTexture(descriptor) {
      creationCount++;
      descriptor.usage |= GPUTextureUsage.COPY_SRC;
      return textureFromDescriptor(descriptor, () => ({}));
    },
  };
  const allocator = new GPUTextureAllocator(device);
  const request = {
    width: 1920,
    height: 945,
    format: "r8uint",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  };

  const first = allocator.get(request);
  void first.gpu_texture;
  assert.equal(first.descriptor.usage, request.usage);
  allocator.release(first);

  const second = allocator.get(request);
  assert.equal(second, first);
  assert.equal(creationCount, 1);
  allocator.release(second);
  allocator.destroy();
});

test("persistent texture owners reuse their default view", () => {
  let viewCreationCount = 0;
  const stableView = { label: "stable environment view" };
  const device = {
    createTexture(descriptor) {
      return textureFromDescriptor(descriptor, () => {
        viewCreationCount++;
        return stableView;
      });
    },
  };
  const texture = new GPUTextureContext(device, {
    label: "environment",
    size: [1, 1, 1],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });

  assert.equal(resolveTextureView(texture), stableView);
  assert.equal(resolveTextureView(texture), stableView);
  assert.equal(viewCreationCount, 1);
  texture.destroy();
});

test("owner teardown destroys shared imports once, clears mip work and preserves borrowed targets", () => {
  const destroyed = [];
  const device = {
    limits: { minUniformBufferOffsetAlignment: 256 },
    queue: { writeTexture() {} },
    createSampler() { return {}; },
    createBuffer(descriptor) {
      return { destroy() { destroyed.push(descriptor.label); } };
    },
    createTexture(descriptor) {
      return {
        ...textureFromDescriptor(descriptor, () => ({})),
        destroy() { destroyed.push(descriptor.label); },
      };
    },
  };
  const manager = new GPUTextureManager({ device });
  const image = new ShadeImage();
  image.width = image.height = 2;
  image.depth = 1;
  image.source = new ArrayBuffer(16);
  const a = ShadeTexture.from(image);
  const b = ShadeTexture.from(image);
  a.label = b.label = "shared import";
  assert.equal(manager.obtain(a), manager.obtain(b));
  assert.equal(manager.pending_mipmap_count, 1);
  const borrowed = manager.contextFromDescriptor({
    label: "borrowed target", size: [1, 1, 1], format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  void borrowed.gpu_texture;
  manager.destroy();
  assert.equal(manager.pending_mipmap_count, 0);
  assert.equal(manager.gpu_memory_usage, 0);
  assert.equal(destroyed.filter(label => label === "shared import").length, 1);
  assert.ok(destroyed.includes("MipmapGenerator/parameters"));
  assert.ok(!destroyed.includes("borrowed target"));
  borrowed.destroy();

  const cameras = new GPUCameraStateManager(device);
  const camera = {};
  assert.equal(cameras.obtain(camera), cameras.obtain(camera));
  cameras.obtain({});
  cameras.destroy();
  cameras.destroy();
  assert.equal(destroyed.filter(label => label === "GPUCameraState/Ud").length, 2);
  new GPUVolumetrics(device, { version: 0, volumes: [] }).destroy();
  assert.ok(destroyed.includes("GPUVolumetrics/settings"));
});
