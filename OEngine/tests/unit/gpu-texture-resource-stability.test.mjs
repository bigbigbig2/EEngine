import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./webgpu-test-globals.mjs";
import {
  GPUTextureAllocator
} from "../.test-dist/gpu/GPUTextureAllocator.js";
import {
  GPUTextureContext
} from "../.test-dist/gpu/GPUTextureContext.js";
import {
  resolveTextureView
} from "../.test-dist/render/RenderTargetViews.js";

const oengineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    destroy() {}
  };
}

test("texture allocation isolates retained pool descriptors from API instrumentation", () => {
  let creationCount = 0;
  const device = {
    createTexture(descriptor) {
      creationCount++;
      descriptor.usage |= GPUTextureUsage.COPY_SRC;
      return textureFromDescriptor(descriptor, () => ({}));
    }
  };
  const allocator = new GPUTextureAllocator(device);
  const request = {
    width: 1920,
    height: 945,
    format: "r8uint",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
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
    }
  };
  const texture = new GPUTextureContext(device, {
    label: "environment",
    size: [1, 1, 1],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING
  });

  assert.equal(resolveTextureView(texture), stableView);
  assert.equal(resolveTextureView(texture), stableView);
  assert.equal(viewCreationCount, 1);
  texture.destroy();
});

test("the main graph retains environment texture owners instead of raw textures", () => {
  const pipeline = readFileSync(
    path.join(oengineRoot, "src", "render", "pipeline", "MainRenderPipeline.ts"),
    "utf8"
  );

  assert.match(
    pipeline,
    /bind\("environment", \(bindings\) => bindings\.environment\.lights\.environment\)/u
  );
  assert.match(
    pipeline,
    /bindings\.environment\.lights\.diffuseIrradiance\)/u
  );
  assert.doesNotMatch(
    pipeline,
    /bindings\.environment\.lights\.(?:environment|diffuseIrradiance)\.gpu_texture/u
  );
});
