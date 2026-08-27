import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUBufferUsage ??= {
  COPY_DST: 1 << 0,
  COPY_SRC: 1 << 1,
  STORAGE: 1 << 2,
  UNIFORM: 1 << 3
};
globalThis.GPUShaderStage ??= {
  VERTEX: 1 << 0,
  FRAGMENT: 1 << 1,
  COMPUTE: 1 << 2
};
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1 << 0,
  COPY_DST: 1 << 1,
  TEXTURE_BINDING: 1 << 2,
  STORAGE_BINDING: 1 << 3,
  RENDER_ATTACHMENT: 1 << 4
};

const { GPUBufferAllocator } = await import(
  "../.test-dist/gpu/GPUBufferAllocator.js"
);
const { FrameGraphResourceManager } = await import(
  "../.test-dist/framegraph/FrameGraph.js"
);
const { resolveMainFrameFeatureTopology } = await import(
  "../.test-dist/render/MainFrameFeatureTopology.js"
);
const { RenderDebugView } = await import(
  "../.test-dist/debug/RenderDebugView.js"
);
const { GPUViewKey, ViewManager } = await import(
  "../.test-dist/render/ViewManager.js"
);

test("transient buffers cannot return to the shared pool before GPU completion", async () => {
  const created = [];
  const device = {
    limits: { maxBufferSize: 1 << 20 },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        destroyCount: 0,
        destroy() {
          this.destroyCount++;
        }
      };
      created.push(buffer);
      return buffer;
    }
  };
  const allocator = new GPUBufferAllocator(device);
  let releaseFence;
  const fence = new Promise((resolve) => {
    releaseFence = resolve;
  });
  const descriptor = { size: 64, usage: GPUBufferUsage.STORAGE };
  const first = allocator.get(descriptor);
  assert.equal(allocator.release(first, fence), true);
  assert.equal(allocator.pending_count, 1);
  assert.equal(allocator.cached_count, 0);

  const second = allocator.get(descriptor);
  assert.notEqual(second, first);
  assert.equal(created.length, 2);

  releaseFence();
  await fence;
  await Promise.resolve();
  assert.equal(allocator.pending_count, 0);
  assert.equal(allocator.cached_count, 1);

  allocator.release(second);
  allocator.get(descriptor);
  assert.equal(created.length, 2);
});

test("allocator destruction retires pending buffers only after their fence", async () => {
  let releaseFence;
  const fence = new Promise((resolve) => {
    releaseFence = resolve;
  });
  const buffer = {
    size: 64,
    usage: GPUBufferUsage.STORAGE,
    destroyCount: 0,
    destroy() {
      this.destroyCount++;
    }
  };
  const allocator = new GPUBufferAllocator({
    limits: { maxBufferSize: 1 << 20 },
    createBuffer: () => buffer
  });
  allocator.release(allocator.get({ size: 64, usage: buffer.usage }), fence);
  allocator.destroy();
  assert.equal(buffer.destroyCount, 0);
  releaseFence();
  await fence;
  await Promise.resolve();
  assert.equal(buffer.destroyCount, 1);
});

test("FrameGraph aliases locally and returns resources to queue-ordered pools", () => {
  const buffer = { size: 64, usage: GPUBufferUsage.STORAGE };
  const texture = { isGPUTextureContext: true };
  const releases = [];
  const graphics = {
    device: {},
    buffer_allocator_main: {
      get: () => buffer,
      release: (resource, reuseAfter) => releases.push([resource, reuseAfter])
    },
    allocator_textures: {
      get: () => texture,
      release: (resource, reuseAfter) => releases.push([resource, reuseAfter])
    }
  };
  const manager = new FrameGraphResourceManager();
  manager.attachGraphics(graphics, null);
  const allocatedBuffer = manager.get({
    kind: "transient_buffer",
    size: 64,
    usage: GPUBufferUsage.STORAGE
  });
  const allocatedTexture = manager.get({
    kind: "transient_texture",
    width: 4,
    height: 4,
    format: "rgba8unorm",
    usage: 1
  });
  manager.release(allocatedBuffer);
  manager.release(allocatedTexture);
  assert.deepEqual(releases, []);
  manager.finish();
  assert.deepEqual(releases, [[buffer, undefined], [texture, undefined]]);
});

test("all optional features off have no optional owner or history", () => {
  const base = {
    shadows: false,
    ssr: false,
    ssao: false,
    temporal: false,
    bloom: false,
    automaticExposure: false,
    motionBlur: false,
    sharpening: false,
    fusedIndirect: false,
    upscaleType: 0,
    debugView: RenderDebugView.None,
    indirectLightingMode: 0
  };
  const disabled = resolveMainFrameFeatureTopology(base);
  assert.deepEqual(disabled.persistentOwners, []);
  assert.deepEqual(disabled.histories, []);
  assert.equal(disabled.enabledFeatureBits, 0);

  const cases = [
    ["ssao", { ssao: true }, "ssao", "ssao-history"],
    ["ssr", { ssr: true }, "ssr", "ssr-history"],
    ["taa", { temporal: true }, "taa", "temporal-color-history"],
    ["nss", { temporal: true, upscaleType: 1 }, "nss", "nss-feedback-history"],
    ["bloom", { bloom: true }, "bloom", null],
    ["exposure", { automaticExposure: true }, "automatic-exposure", "automatic-exposure-history"],
    ["motion blur", { motionBlur: true }, "motion-blur", null],
    ["sharpen", { sharpening: true }, "sharpen", null],
    ["debug", { debugView: RenderDebugView.Depth }, "render-debug", null]
  ];
  for (const [name, change, owner, history] of cases) {
    const topology = resolveMainFrameFeatureTopology({ ...base, ...change });
    assert.equal(topology.persistentOwners.includes(owner), true, name);
    if (history !== null) {
      assert.equal(topology.histories.includes(history), true, name);
    }
  }
});

test("dynamic handles do not change feature bits but topology changes do", () => {
  const base = {
    shadows: true,
    ssr: false,
    ssao: true,
    temporal: true,
    bloom: true,
    automaticExposure: true,
    motionBlur: false,
    sharpening: true,
    fusedIndirect: true,
    upscaleType: 0,
    debugView: RenderDebugView.None,
    indirectLightingMode: 1
  };
  const first = resolveMainFrameFeatureTopology(base);
  const same = resolveMainFrameFeatureTopology({ ...base });
  assert.equal(first.enabledFeatureBits, same.enabledFeatureBits);
  assert.notEqual(
    first.enabledFeatureBits,
    resolveMainFrameFeatureTopology({ ...base, ssr: true }).enabledFeatureBits
  );
  assert.notEqual(
    first.enabledFeatureBits,
    resolveMainFrameFeatureTopology({ ...base, upscaleType: 1 }).enabledFeatureBits
  );
});

test("view deletion removes lookup immediately and retires history after GPU work", () => {
  const camera = { id: 1 };
  const scene = { id: 2 };
  const context = {
    destroyCount: 0,
    destroy() {
      this.destroyCount++;
    }
  };
  const manager = new ViewManager(
    {},
    { obtain: () => ({}) },
    { obtain: () => ({}) },
    () => context
  );
  const key = new GPUViewKey(camera, scene);
  const command = {
    retired: [],
    destroyAfterGpuDone(resource) {
      this.retired.push(resource);
    }
  };
  assert.equal(manager.obtain(key, command), context);
  assert.equal(manager.exists(key), true);
  assert.equal(manager.remove(key, command), true);
  assert.equal(manager.exists(key), false);
  assert.deepEqual(command.retired, [context]);
  assert.equal(context.destroyCount, 0);
  assert.equal(manager.remove(key, command), false);
});
