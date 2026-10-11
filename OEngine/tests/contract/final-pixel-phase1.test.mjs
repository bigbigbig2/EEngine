import "../webgpu-test-globals.mjs";
import { nativeSurfacePublicationDescriptors as s3Descriptors } from "../oracle/reference/s3/native_surface.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";

globalThis.GPUTextureUsage = {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
const { planFinalPixelLightingDirectory, packNativeTemporalSeedView } = await import(
  "../../.test-dist/gpu/FinalPixelAbi.js"
);
const { NativeTemporalSeed } = await import("../../.test-dist/render/temporal/NativeTemporalSeed.js");
const { nativeSurfaceBindingGroups, nativeSurfacePublicationDescriptors } = await import(
  "../../.test-dist/shaders/native_surface.js"
);
const { AppearanceGraphBuilder } = await import("../../.test-dist/material/AppearanceGraph.js");
const { compileAppearanceGraph } = await import("../../.test-dist/material/AppearanceGraphCompiler.js");
const { lowerNativeMaterial } = await import("../../.test-dist/shaders/native_material.js");
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const limits = {
  minStorageBufferOffsetAlignment: 256,
  maxBufferSize: 1 << 28,
  maxStorageBufferBindingSize: 1 << 27,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { resolve, promise };
};

test("complete Final Pixel removes the sampled-limit counterexample without a continuation", () => {
  const builder = new AppearanceGraphBuilder();
  builder.output("baseColor", builder.constant([0.4, 0.25, 0.1]));
  const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));
  const profile = { compact: true, productGeometry: true, unlit: false, reactive: true, physicalSun: true };
  const sampled = (descriptor) => descriptor.groups.flat().filter((entry) => entry.texture).length;
  for (const limit of [16, 19]) {
    const material = Array.from({ length: limit - 6 }, (_, binding) => ({
      binding,
      visibility: 4,
      texture: { sampleType: "float" },
    }));
    const old = s3Descriptors(program, material, profile, {
      maxSampledTexturesPerShaderStage: limit,
    });
    assert.ok(old.continuation, "current supported layout requires its explicit continuation");
    assert.equal(sampled(old.descriptor), limit);
    assert.ok(sampled(old.continuation) <= limit);
    const target = nativeSurfaceBindingGroups(material, { ...profile, finalPixel: true });
    assert.equal(target.flat().filter((entry) => entry.texture).length, limit);
    const fused = nativeSurfacePublicationDescriptors(
      program,
      material,
      { ...profile, finalPixel: true },
      { maxSampledTexturesPerShaderStage: limit },
    );
    assert.equal(fused.continuation, undefined);
  }
});

test("directory retains complete producer domains and rejects capacity overflow before allocation", () => {
  for (const lookupCount of [1, 24, 48, 48 * 17 * 24]) {
    const plan = planFinalPixelLightingDirectory(limits, lookupCount, 98688);
    assert.equal(plan.descriptorOffset % 256, 0);
    assert.equal(plan.solarOffset, 98688 * 16);
    assert.equal(plan.solarBytes, 131072);
    assert.ok(plan.lookupOffset >= plan.solarOffset + plan.solarBytes);
    assert.ok(plan.lookupOffset - plan.solarOffset - plan.solarBytes + 16 <= 256);
    assert.equal(plan.bytes, plan.lookupOffset + lookupCount * 8);
    assert.deepEqual([...plan.words], [plan.lookupOffset / 4, lookupCount, 0, 98688]);
  }
  for (const count of [0, -1, NaN, Infinity, 1.5, 0x100000000]) {
    assert.throws(() => planFinalPixelLightingDirectory(limits, count, 98688));
  }
  assert.throws(() => planFinalPixelLightingDirectory(limits, 0xffffffff, 98688), /capacity/);
  assert.throws(
    () => planFinalPixelLightingDirectory({ ...limits, minStorageBufferOffsetAlignment: 512 }, 1, 1),
    /padding/,
  );
});

function fixture() {
  const textures = [],
    loss = deferred();
  const device = {
    limits: {
      maxTextureDimension2D: 4096,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageTexturesPerShaderStage: 4,
      maxSampledTexturesPerShaderStage: 4,
    },
    lost: loss.promise,
    createBindGroupLayout: (value) => value,
    createPipelineLayout: (value) => value,
    createShaderModule: (value) => value,
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: (value) => value,
    createTexture({ size, format }) {
      const texture = {
        width: size[0],
        height: size[1],
        format,
        destroyed: false,
        createView() {
          return { texture: this };
        },
        destroy() {
          this.destroyed = true;
        },
      };
      textures.push(texture);
      return texture;
    },
  };
  const owner = new NativeTemporalSeed(device);
  const camera = (z) => {
    const view = [...identity];
    view[14] = z;
    return {
      view,
      projection: identity,
      inverseView: identity,
      inverseProjection: identity,
      jitter: [z, 0],
      preExposure: 1 + Math.abs(z),
    };
  };
  const encode = (frame, complete = true) => {
    const fence = deferred(),
      before = [],
      finished = [],
      aborted = [];
    const command = {
      device,
      closed: false,
      gpuDone: fence.promise,
      onBeforeFinish: { addOne: (fn) => before.push(fn) },
      onFinished: { addOne: (fn) => finished.push(fn) },
      onAborted: { addOne: (fn) => aborted.push(fn) },
      abort() {
        this.closed = true;
        for (const fn of aborted) fn();
      },
      finish() {
        for (const fn of before) fn();
        this.closed = true;
        for (const fn of finished) fn();
      },
    };
    owner.attach(command);
    if (complete) {
      const resources = new Map(),
        callbacks = [];
      let next = 0;
      const graph = {
        import_resource(_name, _descriptor, resource) {
          const id = next++;
          resources.set(id, resource);
          return id;
        },
        add(_name, _data, callback) {
          callbacks.push(callback);
          return {
            read() {},
            make_side_effect() {},
            create(_name, descriptor) {
              const id = next++;
              resources.set(
                id,
                device.createTexture({
                  size: [descriptor.width, descriptor.height],
                  format: descriptor.format,
                }),
              );
              return id;
            },
          };
        },
      };
      const products = owner.importProducts(graph);
      owner.addClassification(graph, products);
      const encoder = {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
      };
      for (const callback of callbacks)
        callback({}, { get: (id) => resources.get(id) }, { encoder: { gpu_encoder: encoder } });
    }
    return { command, fence };
  };
  return { owner, camera, textures, encode, device };
}

test("successful submit advances identity/camera together; abort and deferred resize preserve them", async () => {
  const f = fixture();
  const first = f.owner.prepare(19, 13, "native", f.camera(-2));
  assert.equal(first.previousValid, false);
  const a = f.encode(first);
  a.command.finish();
  const submitted = [a];
  const writtenIdentities = [first.identity];
  let previousIdentity = first.identity;
  for (const z of [-3, -4]) {
    const frame = f.owner.prepare(19, 13, "native", f.camera(z));
    assert.equal(frame.previousIdentity, previousIdentity);
    assert.equal(frame.previousValid, true);
    assert.equal(new Float32Array(frame.view.buffer)[46], z + 1);
    const command = f.encode(frame);
    command.command.finish();
    submitted.push(command);
    previousIdentity = frame.identity;
    writtenIdentities.push(frame.identity);
  }
  // Three unresolved fences, with exactly the same identity pair.
  assert.equal(new Set(writtenIdentities).size, 2);
  const aborted = f.owner.prepare(21, 15, "upscale", f.camera(-99));
  assert.equal(aborted.previousValid, false);
  f.owner.abort();
  const retry = f.owner.prepare(19, 13, "native", f.camera(-5));
  assert.equal(retry.previousIdentity, previousIdentity);
  assert.equal(retry.previousValid, true);
  assert.equal(new Float32Array(retry.view.buffer)[46], -4);
  const rejected = f.encode(retry);
  rejected.command.abort();
  const after = f.owner.prepare(19, 13, "native", f.camera(-6));
  assert.equal(after.identity, retry.identity);
  assert.equal(new Float32Array(after.view.buffer)[46], -4);
  f.owner.abort();
  f.owner.destroy();
  assert.equal(first.identity.destroyed, false, "submitted history retired before last consumer fence");
  for (const item of submitted) item.fence.resolve();
  await Promise.all(submitted.map((item) => item.fence.promise));
  await Promise.resolve();
  assert.equal(first.identity.destroyed, true);
  assert.equal(f.owner.allocatedBytes, 0);
  f.owner.destroy();
});

test("incomplete Seed consumer prevents commit and malformed camera/extent allocates nothing", () => {
  const f = fixture();
  assert.throws(() => f.owner.prepare(0, 13, "native", f.camera(-2)));
  assert.throws(() => f.owner.prepare(19, 13, "native", { ...f.camera(-2), preExposure: 0 }));
  assert.throws(() =>
    packNativeTemporalSeedView(19, 13, true, [identity, identity, [...identity.slice(0, 15), NaN], identity]),
  );
  assert.equal(f.textures.length, 0);
  const frame = f.owner.prepare(19, 13, "native", f.camera(-2));
  const incomplete = f.encode(frame, false);
  assert.throws(() => incomplete.command.finish(), /incomplete/);
  incomplete.command.abort();
  const retry = f.owner.prepare(19, 13, "native", f.camera(-3));
  assert.equal(retry.previousValid, false);
  f.owner.abort();
  f.owner.destroy();
  assert.equal(f.owner.allocatedBytes, 0);
});


test("cached Seed graph resolves current roles on every execute and abort preserves submitted camera", () => {
  const { owner, camera, device } = fixture();
  owner.prepare(19, 13, "native", camera(-2));
  const imported = new Map(), callbacks = [];
  let next = 0, groups = [];
  device.createBindGroup = (descriptor) => { groups.push(descriptor); return descriptor; };
  const graph = {
    import_resource(_name, _descriptor, binding) { const id = next++; imported.set(id, binding); return id; },
    add(_name, _data, callback) {
      callbacks.push(callback);
      return {
        read() {}, make_side_effect() {},
        create(_name, descriptor) { const id = next++; imported.set(id, device.createTexture({size: [descriptor.width, descriptor.height], format: descriptor.format})); return id; },
      };
    },
  };
  const bind = (_name, resolve) => ({ resolve });
  const products = owner.importProducts(graph, bind);
  owner.addClassification(graph, products, bind);
  const execute = (abort = false) => {
    const before = [], finished = [], aborted = [];
    const encoder = { beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }) };
    const command = {
      device, closed: false, gpu_encoder: encoder, gpuDone: Promise.resolve(),
      onBeforeFinish: {addOne: (fn) => before.push(fn)},
      onFinished: {addOne: (fn) => finished.push(fn)},
      onAborted: {addOne: (fn) => aborted.push(fn)},
      abort() { this.closed = true; aborted.forEach((fn) => fn()); },
    };
    owner.attach(command);
    for (const callback of callbacks) callback({}, { get: (id) => {
      const value = imported.get(id); return value.resolve ? value.resolve(owner) : value;
    } }, { encoder: command });
    if (abort) command.abort();
    else { before.forEach((fn) => fn()); command.closed = true; finished.forEach((fn) => fn()); }
  };
  const first = owner.frame;
  execute();
  const second = owner.prepare(19, 13, "native", camera(-3));
  assert.equal(second.previousIdentity, first.identity);
  execute(true);
  const retry = owner.prepare(19, 13, "native", camera(-4));
  assert.equal(retry.identity, second.identity);
  assert.equal(new Float32Array(retry.view.buffer)[46], -2);
  execute();
  const third = owner.prepare(19, 13, "native", camera(-5));
  execute();
  assert.equal(groups[0].entries[2].resource.texture, first.identity);
  assert.equal(groups[1].entries[2].resource.texture, second.identity);
  assert.equal(groups[2].entries[3].resource.texture, first.identity);
  assert.equal(groups[3].entries[3].resource.texture, retry.identity);
  assert.notEqual(third.identity, retry.identity);
  owner.destroy();
});
