import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage = { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 };
globalThis.GPUTextureUsage = {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16
};
const { SurfaceV4 } = await import("../../.test-dist/render/surface/SurfaceV4.js");
const { nativeSurfaceDescriptor } = await import("../../.test-dist/shaders/native_surface.js");
const { AppearanceGraphBuilder } = await import("../../.test-dist/material/AppearanceGraph.js");
const { compileAppearanceGraph } = await import("../../.test-dist/material/AppearanceGraphCompiler.js");
const { lowerNativeMaterial } = await import("../../.test-dist/shaders/native_material.js");
const { AppearanceProgramRegistry } = await import("../../.test-dist/gpu/AppearanceProgramRegistry.js");
const { GpuNativeMaterialPublication } = await import("../../.test-dist/gpu/GpuNativeMaterialPublication.js");
const { NativeRasterWorkPartitions } = await import(
  "../../.test-dist/render/surface/NativeRasterWorkPartitions.js"
);
const { NativeVisibilityPass } = await import("../../.test-dist/render/surface/NativeVisibilityPass.js");
const { FrameGraph } = await import("../../.test-dist/framegraph/FrameGraph.js");
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
function fixture({ reactive = false, compact = false } = {}) {
  const loss = deferred(),
    resources = [],
    calls = [];
  const device = {
    limits: {
      maxTextureDimension2D: 8192,
      maxStorageBufferBindingSize: 1 << 27,
      maxBufferSize: 1 << 28,
      maxUniformBufferBindingSize: 65536,
      minUniformBufferOffsetAlignment: 256,
      minStorageBufferOffsetAlignment: 256,
      maxBindingsPerBindGroup: 1000,
      maxBindGroups: 4,
      maxStorageBuffersPerShaderStage: 16,
      maxUniformBuffersPerShaderStage: 12,
      maxSampledTexturesPerShaderStage: 16,
      maxSamplersPerShaderStage: 16,
      maxStorageTexturesPerShaderStage: 8,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupStorageSize: 32768,
      maxComputeWorkgroupsPerDimension: 65535
    },
    lost: loss.promise,
    pushErrorScope() {},
    popErrorScope: async () => null,
    createShaderModule: (descriptor) => ({
      ...descriptor,
      getCompilationInfo: async () => ({ messages: [] })
    }),
    createBindGroupLayout: (descriptor) => descriptor,
    createPipelineLayout: (descriptor) => descriptor,
    createBindGroup: (descriptor) => descriptor,
    createComputePipelineAsync: async (descriptor) => descriptor,
    createRenderPipelineAsync: async (descriptor) => descriptor,
    createBuffer({ size, usage }) {
      const buffer = {
        size,
        usage,
        bytes: new ArrayBuffer(size),
        destroyed: false,
        getMappedRange() {
          return this.bytes;
        },
        unmap() {},
        destroy() {
          this.destroyed = true;
        }
      };
      resources.push(buffer);
      return buffer;
    },
    createTexture({ size, format, usage }) {
      const texture = {
        width: size[0],
        height: size[1],
        depthOrArrayLayers: 1,
        format,
        usage,
        destroyed: false,
        createView() {
          return { texture: this };
        },
        destroy() {
          this.destroyed = true;
        }
      };
      resources.push(texture);
      return texture;
    },
    queue: {
      writeTexture() {},
      writeBuffer(buffer, offset, value) {
        const bytes =
          value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        new Uint8Array(buffer.bytes, offset, bytes.length).set(bytes);
      }
    }
  };
  const builder = new AppearanceGraphBuilder();
  builder.output("baseColor", builder.constant([0.1, 0.2, 0.3]));
  builder.output("alpha", builder.constant(1));
  const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));
  const registry = new AppearanceProgramRegistry(device);
  const descriptor = nativeSurfaceDescriptor(program, [], {
    compact,
    productGeometry: false,
    unlit: true,
    reactive
  });
  const publication = new GpuNativeMaterialPublication(device, registry, [
    { materialSlot: 0, bindingSet: 0, program, descriptor }
  ]);
  const buffer = (size) =>
    device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
  const images = (width, height) => ({
    visibility: device.createTexture({ size: [width, height], format: "r32uint", usage: 20 }),
    depth: device.createTexture({ size: [width, height], format: "depth32float", usage: 20 }),
    background: device.createTexture({ size: [width, height], format: "rgba16float", usage: 4 }),
    ...(reactive
      ? { reactive: device.createTexture({ size: [width, height], format: "rgba8unorm", usage: 12 }) }
      : {})
  });
  const frame = {
    width: 16,
    height: 8,
    generation: 7,
    frameIndex: 0,
    cameraPosition: [0, 0, 3],
    preExposure: buffer(16),
    viewMatrix: identity,
    ...images(16, 8),
    geometry: {
      meshletWork: buffer(256),
      arena: buffer(256),
      vertexPayload: buffer(256),
      instances: buffer(512),
      source: [0, 0, 0, 0],
      sourcePayload: [0, 0, 0, 0]
    },
    publication,
    lightingEntries: [],
    routes: [
      { programIndex: 0, bindingSet: 0, materialEntries: [], frameInputs: new Float32Array(4), unlit: true }
    ]
  };
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    dispatchWorkgroups(...args) {
      calls.push(["dispatch", ...args]);
    },
    dispatchWorkgroupsIndirect() {},
    drawIndirect(...args) {
      calls.push(["drawIndirect", ...args]);
    },
    end() {}
  };
  const encoder = {
    copyBufferToBuffer(...args) {
      calls.push(["copy", ...args]);
    },
    beginComputePass() {
      return pass;
    },
    beginRenderPass() {
      return pass;
    }
  };
  return { device, loss, resources, calls, frame, publication, registry, images, encoder };
}

test("SurfaceV4 dense frame reuses resources across generations, has one HDR writer and GPU exposure copy", async () => {
  const f = fixture(),
    surface = new SurfaceV4(f.device);
  await f.publication.ready;
  f.publication.commit();
  await surface.prepareFrame(f.frame);
  const hdr = surface.hdr,
    bytes = surface.allocatedBytes;
  assert.equal(surface.executionBins.plan.mode, "dense");
  surface.encode(f.encoder);
  assert.equal(f.calls[0][1], f.frame.preExposure);
  assert.equal(f.calls[0][4], 60);
  assert.equal(f.calls[0][5], 4);
  assert.throws(() => surface.encode(f.encoder), /one encoding/);
  surface.commit(Promise.resolve());
  await surface.prepareFrame({ ...f.frame, generation: 8, frameIndex: 1 });
  assert.equal(surface.hdr, hdr);
  assert.equal(surface.allocatedBytes, bytes);
  surface.abort();
  await surface.prepareFrame(f.frame);
  assert.equal(surface.hdr, hdr);
  surface.abort();
  surface.destroy();
  await Promise.resolve();
  assert.equal(hdr.destroyed, true);
  await f.publication.retire(Promise.resolve());
  f.registry.destroy();
});

test("SurfaceV4 resize abort keeps committed extent and resize commit retires only at its fence", async () => {
  const f = fixture(),
    surface = new SurfaceV4(f.device);
  await f.publication.ready;
  f.publication.commit();
  const fence = deferred();
  await surface.prepareFrame(f.frame);
  const original = surface.hdr;
  surface.encode(f.encoder);
  surface.commit(fence.promise);
  const resized = { ...f.frame, width: 32, height: 16, ...f.images(32, 16) };
  await surface.prepareFrame(resized);
  const candidate = surface.hdr;
  surface.abort();
  assert.equal(candidate.destroyed, true);
  assert.equal(original.destroyed, false);
  await surface.prepareFrame(f.frame);
  assert.equal(surface.hdr, original);
  surface.abort();
  await surface.prepareFrame(resized);
  surface.encode(f.encoder);
  surface.commit(Promise.resolve());
  assert.equal(original.destroyed, false);
  fence.resolve();
  await fence.promise;
  await Promise.resolve();
  assert.equal(original.destroyed, true);
  surface.destroy();
  await f.publication.retire(Promise.resolve());
  f.registry.destroy();
});

test("SurfaceV4 rejects concurrent prepare, profile mismatch and invalid inputs without extent allocation", async () => {
  const f = fixture();
  await f.publication.ready;
  f.publication.commit();
  const gate = deferred();
  f.device.createComputePipelineAsync = (descriptor) => gate.promise.then(() => descriptor);
  const surface = new SurfaceV4(f.device);
  const preparing = surface.prepareFrame(f.frame);
  await assert.rejects(surface.prepareFrame(f.frame), /already prepared/);
  surface.abort();
  gate.resolve();
  await assert.rejects(preparing, /superseded|stopped during prepare/);
  assert.equal(surface.allocatedBytes, 0);
  await assert.rejects(
    surface.prepareFrame({ ...f.frame, preExposure: { size: 16, usage: 0 } }),
    /GPU pre-exposure/
  );
  await assert.rejects(
    surface.prepareFrame({
      ...f.frame,
      routes: [{ ...f.frame.routes[0], frameInputs: new Float32Array([NaN, 0, 0, 0]) }]
    }),
    /finite/
  );
  const wrong = fixture({ compact: true });
  await wrong.publication.ready;
  wrong.publication.commit();
  const count = wrong.resources.length;
  await assert.rejects(new SurfaceV4(wrong.device).prepareFrame(wrong.frame), /incompatible/);
  assert.equal(wrong.resources.length, count);
  surface.destroy();
  await f.publication.retire(Promise.resolve());
  f.registry.destroy();
  await wrong.publication.retire(Promise.resolve());
  wrong.registry.destroy();
});

test("SurfaceV4 declares reactive new version and device loss destroys active ownership", async () => {
  const f = fixture({ reactive: true }),
    surface = new SurfaceV4(f.device, true);
  await f.publication.ready;
  f.publication.commit();
  await surface.prepareFrame(f.frame);
  const graph = new FrameGraph("native products"),
    reactive = graph.import_resource(
      "reactive",
      { kind: "imported", domain: "internal-full" },
      f.frame.reactive
    );
  assert.throws(() => surface.addToGraph(graph, []), /declare every/);
  const products = surface.addToGraph(graph, [], reactive);
  assert.equal(graph.getResourceNode(products.reactive).version, 1);
  const hdr = surface.hdr;
  surface.encode(f.encoder);
  surface.commit(Promise.resolve());
  f.loss.resolve({ reason: "destroyed", message: "controlled loss" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(hdr.destroyed, true);
  await assert.rejects(surface.prepareFrame(f.frame), /stopped/);
  f.registry.destroy();
});

test("native raster scheduling emits indirect commands per bin, aborts readiness safely and rejects capacity before resources", async () => {
  const f = fixture();
  await f.publication.ready;
  f.publication.commit();
  const input = {
    geometry: f.frame.geometry,
    publication: f.publication,
    routes: f.frame.routes,
    capacity: 1,
    generation: 7,
    view: new Uint8Array(192)
  };
  new Uint32Array(input.view.buffer)[38] = 7;
  const owner = new NativeVisibilityPass(f.device, input);
  await owner.ready;
  owner.encode(f.encoder, { colorAttachments: [] });
  assert.equal(f.calls.filter((call) => call[0] === "drawIndirect").length, 8);
  const resources = f.resources.slice();
  const fence = deferred(),
    retirement = owner.retire(fence.promise);
  assert.throws(() => owner.encode(f.encoder, { colorAttachments: [] }), /not ready/);
  assert.throws(() => owner.update(input.view, [new Float32Array(4)], 7), /ready/);
  assert.ok(resources.some((resource) => !resource.destroyed));
  fence.resolve();
  await retirement;
  assert.equal(owner.allocatedBytes, 0);
  const count = f.resources.length;
  assert.throws(
    () =>
      new NativeRasterWorkPartitions(f.device, {
        work: f.frame.geometry.meshletWork,
        metadata: f.frame.geometry.arena,
        publication: f.publication,
        capacity: 1e9,
        meshletWordBase: 0,
        generation: 7
      }),
    /capacity/
  );
  assert.equal(f.resources.length, count);
  const pending = new NativeVisibilityPass(f.device, input);
  pending.destroy();
  await assert.rejects(pending.ready, /stopped|cancelled/);
  await f.publication.retire(Promise.resolve());
  f.registry.destroy();
});

test("native visibility snapshots asynchronous descriptors and rejects invalid profiles before allocating", async () => {
  const f = fixture();
  await f.publication.ready;
  f.publication.commit();
  const view = new Uint8Array(192);
  new Uint32Array(view.buffer)[38] = 7;
  const input = {
    geometry: f.frame.geometry,
    publication: f.publication,
    routes: f.frame.routes,
    capacity: 1,
    generation: 7,
    view
  };
  const owner = new NativeVisibilityPass(f.device, input);
  input.geometry.source[0] = 100;
  input.routes[0].frameInputs[0] = 123;
  new Float32Array(view.buffer)[0] = NaN;
  await owner.ready;
  assert.equal(owner.input.geometry.source[0], 0);
  assert.equal(owner.input.routes[0].frameInputs[0], 0);
  assert.equal(new Float32Array(owner.input.view.buffer)[0], 0);
  owner.destroy();
  const count = f.resources.length;
  assert.throws(() => new NativeVisibilityPass(f.device, input), /finite/);
  assert.equal(f.resources.length, count);
  new Float32Array(view.buffer)[0] = 0;
  f.device.limits.maxStorageBuffersPerShaderStage = 1;
  assert.throws(() => new NativeVisibilityPass(f.device, input), /stage resources/);
  assert.equal(f.resources.length, count);
  await f.publication.retire(Promise.resolve());
  f.registry.destroy();
});
