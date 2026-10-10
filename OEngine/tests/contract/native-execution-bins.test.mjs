import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeExecutionBins,
  planNativeExecutionBins,
  nativeExecutionDispatch,
} from "../../.test-dist/render/surface/NativeExecutionBins.js";

const limits = {
  maxComputeWorkgroupsPerDimension: 65535,
  maxBufferSize: 1 << 28,
  maxStorageBufferBindingSize: 1 << 27,
  maxComputeWorkgroupSizeX: 256,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupStorageSize: 16384,
  maxStorageBuffersPerShaderStage: 8,
  maxTextureDimension2D: 16384,
};
const bins = (count) => Array.from({ length: count }, (_, programIndex) => ({ programIndex, bindingSet: 0 }));
const options = (count, extra = {}) => ({ width: 1920, height: 1080, bins: bins(count), ...extra });

test("one known bin bypasses all management resources, dispatches and pipelines", async () => {
  const owner = new NativeExecutionBins({ limits, lost: new Promise(() => {}) }, options(1));
  await owner.ready;
  assert.equal(owner.plan.mode, "dense");
  assert.equal(owner.plan.dispatches, 0);
  assert.equal(owner.allocatedBytes, 0);
  assert.equal(owner.queue, null);
  assert.equal(owner.scratch, null);
  owner.encode({});
  owner.destroy();
  assert.throws(() => owner.encode({}), /not ready/);
});

test("tile banks cover every tile in every bin without a pixel queue or scan", () => {
  const plan = planNativeExecutionBins(limits, options(7));
  assert.equal(plan.tileCapacity, 240 * 135);
  assert.equal(plan.queueBytes, 7 * (240 * 135 * 12 + 32));
  assert.equal(plan.scratchBytes, (4 + 7) * 4);
  assert.equal(plan.dispatches, 2);
  assert.throws(() => planNativeExecutionBins(limits, options(400)), /working set/);
  assert.throws(() => planNativeExecutionBins(limits, options(65537)), /Queue word count/);
  const many = planNativeExecutionBins(limits, options(513, { width: 37, height: 21 }));
  assert.equal(many.tileCapacity, 15);
  assert.equal(many.dispatches, 2);
});

test("preflight rejects incomplete capacity and capability before resource creation", () => {
  assert.throws(
    () => planNativeExecutionBins({ ...limits, maxStorageBufferBindingSize: 4096 }, options(2)),
    /working set/,
  );
  assert.throws(
    () => planNativeExecutionBins({ ...limits, maxStorageBuffersPerShaderStage: 5 }, options(2)),
    /six storage/,
  );
  assert.throws(
    () => planNativeExecutionBins({ ...limits, maxComputeInvocationsPerWorkgroup: 32 }, options(2)),
    /64-lane/,
  );
  assert.throws(
    () =>
      planNativeExecutionBins(
        limits,
        options(2, {
          bins: [
            { programIndex: 0, bindingSet: 0 },
            { programIndex: 0, bindingSet: 0 },
          ],
        }),
      ),
    /unique/,
  );
  assert.throws(() => planNativeExecutionBins(limits, options(2, { width: 0 })), /Width/);
  assert.throws(() => planNativeExecutionBins(limits, options(2, { width: 16385 })), /texture limit/);
  assert.throws(
    () => planNativeExecutionBins(limits, options(2, { maxWorkgroupsPerDimension: 2 })),
    /2D dispatch/,
  );
});

test("dispatch geometry represents zero, tails and counts above the x limit", () => {
  assert.deepEqual(nativeExecutionDispatch(0, 65535), [0, 0]);
  assert.deepEqual(nativeExecutionDispatch(65536, 65535), [65535, 2]);
  assert.deepEqual(nativeExecutionDispatch(17, 8), [8, 3]);
  assert.throws(() => nativeExecutionDispatch(65, 8), /capacity/);
});

function gpuFixture() {
  globalThis.GPUShaderStage = { COMPUTE: 4 };
  globalThis.GPUBufferUsage = { STORAGE: 128, UNIFORM: 64, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 256 };
  const resources = [];
  const device = {
    lost: new Promise(() => {}),
    limits,
    queue: {
      writeBuffer(buffer, offset, values) {
        new Uint32Array(buffer.bytes, offset, values.length).set(values);
      },
    },
    createBuffer({ size }) {
      const resource = {
        size,
        bytes: new ArrayBuffer(size),
        destroyed: false,
        getMappedRange() {
          return this.bytes;
        },
        unmap() {},
        destroy() {
          this.destroyed = true;
        },
      };
      resources.push(resource);
      return resource;
    },
    createBindGroupLayout: (descriptor) => descriptor,
    createPipelineLayout: (descriptor) => descriptor,
    createBindGroup: (descriptor) => descriptor,
    createShaderModule: (descriptor) => descriptor,
    createComputePipelineAsync: async (descriptor) => descriptor,
  };
  return { device, resources };
}

test("replay resets scratch and readiness, input snapshot and fence retirement are explicit", async () => {
  const { device, resources } = gpuFixture();
  const sourceOptions = options(3, { width: 19, height: 13 });
  const owner = new NativeExecutionBins(device, sourceOptions);
  assert.throws(() => owner.encode({}), /not ready/);
  await owner.ready;
  sourceOptions.width = 99;
  const bindings = owner.createBindings({
    visibility: {},
    meshletWork: {},
    frameInstances: {},
    materialDirectory: {},
    generation: 7,
  });
  assert.equal(new Uint32Array(bindings.settings.bytes)[0], 19, "input extent must be immutable");
  owner.updateGeneration(bindings, 0xffffffff);
  assert.equal(
    new Uint32Array(bindings.settings.bytes)[4],
    0xffffffff,
    "generation must retain all u32 bits",
  );
  assert.throws(() => owner.updateGeneration(bindings, 0), /nonzero u32/);
  assert.throws(() => owner.updateGeneration({}, 7), /live owner/);
  owner.updateGeneration(bindings, 7);
  assert.throws(() => owner.encode({}), /input snapshot/);
  let clears = 0;
  let dispatches = 0;
  const encoder = {
    clearBuffer(buffer) {
      assert.equal(buffer, owner.scratch);
      clears++;
    },
    beginComputePass() {
      return {
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups() {
          dispatches++;
        },
        end() {},
      };
    },
  };
  owner.encode(encoder, bindings);
  owner.encode(encoder, bindings);
  assert.equal(clears, 2);
  assert.equal(dispatches, 4);
  assert.equal(owner.indirectOffset(2), 72);
  assert.throws(() => owner.indirectOffset(3), /no indirect/);
  let release;
  const retirement = owner.retire(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  assert.throws(() => owner.encode(encoder, bindings), /not ready/);
  assert.ok(resources.every((resource) => !resource.destroyed));
  release();
  await retirement;
  assert.ok(resources.every((resource) => resource.destroyed));
  assert.equal(bindings.settings.destroyed, true);
  assert.throws(() => owner.encode(encoder, bindings), /not ready/);
});

test("compile rejection and cancellation destroy candidates and cannot publish work", async () => {
  const failure = gpuFixture();
  failure.device.createComputePipelineAsync = async () => {
    throw new Error("compile failed");
  };
  const rejected = new NativeExecutionBins(failure.device, options(2));
  await assert.rejects(rejected.ready, /compile failed/);
  assert.ok(failure.resources.every((resource) => resource.destroyed));
  const cancelled = gpuFixture();
  const owner = new NativeExecutionBins(cancelled.device, options(2));
  owner.destroy();
  await assert.rejects(owner.ready, /cancelled/);
  assert.ok(cancelled.resources.every((resource) => resource.destroyed));
});

test("rejected completion fences still release bin ownership and device loss stops dense encoding", async () => {
  const f = gpuFixture();
  const owner = new NativeExecutionBins(f.device, options(2));
  await owner.ready;
  await assert.rejects(owner.retire(Promise.reject(new Error("lost fence"))), /lost fence/);
  assert.ok(f.resources.every((resource) => resource.destroyed));
  let lose;
  const denseFixture = gpuFixture();
  denseFixture.device.lost = new Promise((resolve) => {
    lose = resolve;
  });
  const dense = new NativeExecutionBins(denseFixture.device, options(1));
  await dense.ready;
  lose({ reason: "destroyed" });
  await Promise.resolve();
  assert.throws(() => dense.encode({}), /not ready/);
});
