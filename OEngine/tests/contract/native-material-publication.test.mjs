import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial, nativeMaterialParameters } from "../../.test-dist/shaders/native_material.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { GpuNativeMaterialPublication } from "../../.test-dist/gpu/GpuNativeMaterialPublication.js";

globalThis.GPUShaderStage = { COMPUTE: 4 };
globalThis.GPUBufferUsage = { STORAGE: 128 };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("native resource-limit continuations publish with their primary pipeline atomically", async () => {
  const f = fixture();
  const a = f.source();
  const next = { ...a.descriptor, source: `${a.descriptor.source}\n// native continuation` };
  const publication = new GpuNativeMaterialPublication(f.device, f.registry, [
    { ...a, continuation: next },
    { ...a, materialSlot: 1 },
    { ...a, materialSlot: 2, continuation: next }
  ]);
  assert.deepEqual(
    publication.entries.map((entry) => entry.programIndex),
    [0, 1, 0]
  );
  await tick();
  assert.equal(f.compiles.length, 2);
  f.compiles[0].resolve({ primary: true });
  await tick();
  assert.throws(() => publication.commit(), /complete/);
  f.compiles[1].resolve({ continuation: true });
  await publication.ready;
  publication.commit();
  assert.equal(publication.continuation(0).pipeline.pipeline.continuation, true);
  assert.equal(publication.continuation(1), null);
  await publication.retire(Promise.resolve());
  assert.ok(f.buffers.every((buffer) => buffer.destroyed));
  f.registry.destroy();
});
function graph(gain = 0.3) {
  const g = new AppearanceGraphBuilder();
  g.output("alpha", g.parameter("gain", gain, { low: 0, high: 1 }));
  return lowerNativeMaterial(compileAppearanceGraph(g.build()));
}
function fixture() {
  const loss = deferred();
  const compiles = [],
    buffers = [];
  const device = {
    limits: {
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 1000,
      maxBufferSize: 1e6,
      maxStorageBufferBindingSize: 1e6,
      maxUniformBufferBindingSize: 65536,
      maxStorageBuffersPerShaderStage: 8,
      maxUniformBuffersPerShaderStage: 12,
      maxSampledTexturesPerShaderStage: 16,
      maxSamplersPerShaderStage: 16,
      maxStorageTexturesPerShaderStage: 4
    },
    lost: loss.promise,
    pushErrorScope() {},
    popErrorScope: async () => null,
    createShaderModule: ({ code }) => ({ code, getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (layout) => layout,
    createPipelineLayout: (layout) => layout,
    createComputePipelineAsync() {
      const d = deferred();
      compiles.push(d);
      return d.promise;
    },
    createBuffer({ size }) {
      const buffer = {
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
      buffers.push(buffer);
      return buffer;
    }
  };
  const registry = new AppearanceProgramRegistry(device);
  const program = graph();
  const descriptor = { source: program.source, entryPoint: "main", workgroupSize: 64, groups: [] };
  const source = (gain = 0.3, slot = 0) => ({
    materialSlot: slot,
    bindingSet: 7,
    program,
    descriptor,
    parameters: { gain: [gain] }
  });
  return { loss, compiles, buffers, device, registry, source };
}

test("instance numeric changes share a program; edits preserve the original snapshot and range", () => {
  const a = graph(0.3),
    b = graph(0.8);
  assert.equal(a.key, b.key);
  assert.equal(a.source, b.source);
  assert.notDeepEqual(a.constants, b.constants);
  assert.equal(nativeMaterialParameters(a, { gain: [0.7] })[0], Math.fround(0.7));
  assert.equal(a.constants[0], Math.fround(0.3));
  assert.throws(() => nativeMaterialParameters(a, { gain: [1.1] }), /range/);
  assert.throws(() => nativeMaterialParameters(a, { gain: [] }), /range/);
  assert.throws(() => nativeMaterialParameters(a, { missing: [0] }), /Unknown/);
});

test("raster cutoff and flags are instance constants and invalidate values without changing program identity", async () => {
  const f = fixture();
  const base = f.source();
  const first = new GpuNativeMaterialPublication(f.device, f.registry, [base]);
  const changed = new GpuNativeMaterialPublication(f.device, f.registry, [
    { ...base, raster: { alphaCutoff: 0.75, alphaMask: true, hasEmissiveTexture: true } }
  ]);
  const at = base.program.constants.length;
  assert.deepEqual([...new Float32Array(first.constants.bytes).subarray(at, at + 2)], [0.5, 0]);
  assert.deepEqual([...new Float32Array(changed.constants.bytes).subarray(at, at + 2)], [0.75, 3]);
  assert.equal(first.entries[0].signature, changed.entries[0].signature);
  assert.notEqual(first.entries[0].valueRevision, changed.entries[0].valueRevision);
  assert.equal(first.allocatedBytes, base.program.constants.length * 4 + 8 + 16 + 8);
  assert.throws(
    () =>
      new GpuNativeMaterialPublication(f.device, f.registry, [
        { ...base, raster: { alphaCutoff: NaN, alphaMask: false } }
      ]),
    /finite cutoff/
  );
  first.abort();
  changed.abort();
  await tick();
  f.compiles[0].resolve({});
  await Promise.allSettled([first.ready, changed.ready]);
  f.registry.destroy();
});

test("cancellation while compiling releases candidate resources; retry shares the in-flight program", async () => {
  const f = fixture();
  const first = new GpuNativeMaterialPublication(f.device, f.registry, [f.source()]);
  assert.throws(() => first.descriptor(0), /encoding/);
  assert.throws(() => first.commit(), /complete/);
  first.abort();
  assert.ok(f.buffers.every((buffer) => buffer.destroyed));
  const retry = new GpuNativeMaterialPublication(f.device, f.registry, [f.source(0.8)]);
  await tick();
  assert.equal(f.compiles.length, 1);
  f.compiles[0].resolve({ label: "pipeline" });
  await assert.rejects(first.ready, /cancelled/);
  await retry.ready;
  retry.commit();
  assert.equal(retry.descriptor(0).source, f.source().descriptor.source);
  assert.ok(Object.isFrozen(retry.descriptor(0)));
  assert.ok(Object.isFrozen(retry.descriptor(0).groups));
  assert.throws(() => retry.descriptor(100), /Unknown/);
  assert.equal(retry.pipeline(0).pipeline.label, "pipeline");
  const fence = deferred();
  const retired = retry.retire(fence.promise);
  assert.ok(f.buffers.slice(3).every((buffer) => !buffer.destroyed));
  assert.throws(() => retry.pipeline(0), /encoding/);
  fence.resolve();
  await retired;
  assert.ok(f.buffers.every((buffer) => buffer.destroyed));
  f.registry.destroy();
});

test("execution bins share program and binding set; temporal versions are immutable change detectors", async () => {
  const f = fixture();
  const sources = [f.source(0.3, 0), f.source(0.3, 2), { ...f.source(0.8, 3), bindingSet: 8 }];
  const first = new GpuNativeMaterialPublication(f.device, f.registry, sources);
  const retry = new GpuNativeMaterialPublication(f.device, f.registry, sources);
  assert.equal(first.materialSlotCount, 4);
  assert.deepEqual(first.bins, [
    { programIndex: 0, bindingSet: 7 },
    { programIndex: 0, bindingSet: 8 }
  ]);
  assert.deepEqual(
    first.entries.map((entry) => entry.executionBin),
    [0, 0, 1]
  );
  const directory = new Uint32Array(first.directory.bytes);
  assert.equal(directory[7], 0xffffffff);
  assert.equal(directory[15], 1);
  const versions = new Uint32Array(first.versions.bytes);
  assert.deepEqual([...versions.subarray(2, 4)], [0, 0]);
  assert.equal(versions[1], versions[5]);
  assert.notEqual(versions[1], versions[7]);
  assert.deepEqual(versions, new Uint32Array(retry.versions.bytes));
  first.abort();
  retry.abort();
  await tick();
  f.compiles[0].resolve({});
  await Promise.allSettled([first.ready, retry.ready]);
  assert.throws(
    () => new GpuNativeMaterialPublication(f.device, f.registry, [{ ...f.source(), valueRevision: 0 }]),
    /nonzero/
  );
  f.registry.destroy();
});

test("pipeline rejection and device loss release native ownership without publishing a partial candidate", async () => {
  const f = fixture();
  const failed = new GpuNativeMaterialPublication(f.device, f.registry, [f.source()]);
  await tick();
  f.compiles[0].reject(new Error("compile failure"));
  await assert.rejects(failed.ready, /compile failure/);
  assert.ok(f.buffers.every((buffer) => buffer.destroyed));
  assert.throws(() => failed.commit(), /complete/);
  const candidate = new GpuNativeMaterialPublication(f.device, f.registry, [f.source(0.7)]);
  await tick();
  f.loss.resolve({ reason: "destroyed", message: "controlled mock loss" });
  await assert.rejects(candidate.ready, /lost/);
  assert.ok(f.buffers.every((buffer) => buffer.destroyed));
  f.compiles[1].resolve({});
  await tick();
  assert.throws(() => candidate.pipeline(0), /encoding/);
});

test("duplicate slots, invalid parameter and sparse directory overflow are rejected before GPU allocation", () => {
  const f = fixture();
  assert.throws(
    () => new GpuNativeMaterialPublication(f.device, f.registry, [f.source(), f.source()]),
    /unique/
  );
  assert.throws(() => new GpuNativeMaterialPublication(f.device, f.registry, [f.source(1.5)]), /range/);
  assert.throws(
    () => new GpuNativeMaterialPublication(f.device, f.registry, [f.source(0.3, 100000)]),
    /limits/
  );
  assert.equal(f.buffers.length, 0);
  assert.equal(f.registry.evidence().programs, 0);
  f.registry.destroy();
});
