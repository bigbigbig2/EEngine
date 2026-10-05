import assert from "node:assert/strict";
import test from "node:test";
import { WinnerPrimitiveInterpolation } from "../../.test-dist/render/surface/WinnerPrimitiveInterpolation.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";

globalThis.GPUBufferUsage = { UNIFORM: 64, STORAGE: 128, INDIRECT: 256, COPY_SRC: 4, COPY_DST: 8 };
globalThis.GPUShaderStage = { COMPUTE: 4 };
function fixture() {
  let loss;
  const buffers = [],
    compiled = [],
    commands = [];
  const accounting = new ResourceAccounting();
  const device = {
    limits: {
      maxStorageBuffersPerShaderStage: 8,
      maxBindingsPerBindGroup: 1000,
      maxBindGroups: 4,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxBufferSize: 1 << 24,
      maxStorageBufferBindingSize: 1 << 24,
      maxTextureDimension2D: 8192,
      maxComputeWorkgroupsPerDimension: 65535,
    },
    lost: new Promise((resolve) => {
      loss = resolve;
    }),
    queue: { writeBuffer() {} },
    createBindGroupLayout: (d) => d,
    createPipelineLayout: (d) => d,
    createShaderModule: (d) => d,
    async createComputePipelineAsync(d) {
      compiled.push(d);
      return d;
    },
    createBuffer(d) {
      const b = {
        ...d,
        destroyed: 0,
        destroy() {
          this.destroyed++;
        },
      };
      buffers.push(b);
      return b;
    },
    createBindGroup: (d) => d,
  };
  const geometry = {
    directory: { size: 32, usage: 128 },
    clips: { size: 48, usage: 128 },
    triangles: { size: 4, usage: 128 },
  };
  device.limits.minStorageBufferOffsetAlignment = 256;
  const input = {
    geometry,
    visibility: {},
    width: 32,
    height: 16,
    budget: { dictionaryCapacity: 16, coefficientCapacity: 8, probeLimit: 8, maxBytes: 1024 },
  };
  const encoder = {
    clearBuffer(b) {
      commands.push(["clear", b]);
    },
    beginComputePass(d) {
      commands.push(["begin", d.label]);
      return {
        setPipeline(p) {
          commands.push(["pipeline", p.compute.entryPoint]);
        },
        setBindGroup(index) {
          commands.push(["group", index]);
        },
        dispatchWorkgroups(...args) {
          commands.push(["dispatch", ...args]);
        },
        dispatchWorkgroupsIndirect(buffer, offset) {
          commands.push(["indirect", buffer, offset]);
        },
        end() {
          commands.push(["end"]);
        },
      };
    },
  };
  return { device, input, encoder, buffers, compiled, commands, accounting, loss };
}
test("winner owner rejects extent, capacity and byte failures before allocating", async () => {
  const f = fixture(),
    owner = await WinnerPrimitiveInterpolation.create(f.device);
  for (const budget of [
    { ...f.input.budget, dictionaryCapacity: 15 },
    { ...f.input.budget, maxBytes: 10 },
    { ...f.input.budget, coefficientCapacity: 32 },
    { ...f.input.budget, probeLimit: 32 },
  ]) {
    assert.throws(() => owner.prepare({ ...f.input, budget }), RangeError);
  }
  assert.throws(() => owner.prepare({ ...f.input, width: 0 }), RangeError);
  assert.throws(
    () => owner.prepare({ ...f.input, geometry: { ...f.input.geometry, clips: { size: 8, usage: 128 } } }),
    RangeError,
  );
  assert.equal(f.buffers.length, 0);
  owner.destroy();
});
test("stable frames reuse asynchronous pipelines and bounded allocation; indirect arguments have a separate write scope", async () => {
  const f = fixture(),
    owner = await WinnerPrimitiveInterpolation.create(f.device, { accounting: f.accounting });
  const a = owner.prepare(f.input),
    bytes = 48 + 16 * 8 + 8 * 48 + 32 + 8 * 4 + 16;
  assert.equal(a.byteLength, bytes);
  assert.equal(f.accounting.snapshot().totalBytes, bytes);
  for (let frame = 0; frame < 3; frame++) owner.encode(f.encoder, a);
  assert.equal(f.compiled.length, 4);
  assert.equal(f.buffers.length, 6);
  assert.deepEqual(
    f.commands
      .filter((c) => c[0] === "pipeline")
      .slice(0, 4)
      .map((c) => c[1]),
    ["winner_reset", "winner_request", "winner_finalize", "winner_build"],
  );
  assert.equal(f.commands.filter((c) => c[0] === "group" && c[1] === 1).length, 3);
  const indirect = f.commands.find((c) => c[0] === "indirect");
  assert.notEqual(indirect[1], a.control);
  assert.equal(indirect[2], 0);
  owner.release(a);
  assert.equal(f.accounting.snapshot().totalBytes, 0);
  assert.ok(f.buffers.every((b) => b.destroyed === 1));
  assert.throws(() => owner.encode(f.encoder, a), /stale/);
  owner.destroy();
});
test("capability preflight and device loss revoke every prepared allocation exactly once", async () => {
  const f = fixture();
  f.device.limits.maxStorageBuffersPerShaderStage = 7;
  await assert.rejects(WinnerPrimitiveInterpolation.create(f.device), /eight storage/);
  assert.equal(f.compiled.length, 0);
  f.device.limits.maxStorageBuffersPerShaderStage = 8;
  const owner = await WinnerPrimitiveInterpolation.create(f.device, { accounting: f.accounting });
  owner.prepare(f.input);
  owner.prepare(f.input);
  f.loss({ reason: "destroyed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.buffers.every((b) => b.destroyed === 1));
  assert.equal(f.accounting.snapshot().totalBytes, 0);
  assert.throws(() => owner.prepare(f.input), /destroyed/);
  owner.destroy();
});
test("a binding failure rolls back all allocations and accounting", async () => {
  const f = fixture(),
    owner = await WinnerPrimitiveInterpolation.create(f.device, { accounting: f.accounting });
  f.device.createBindGroup = () => {
    throw new Error("fixture binding failure");
  };
  assert.throws(() => owner.prepare(f.input), /binding failure/);
  assert.equal(f.accounting.snapshot().totalBytes, 0);
  assert.ok(f.buffers.every((b) => b.destroyed === 1));
  owner.destroy();
});

function arenaInput(f) {
  const buffer = {
    size: 4096,
    usage: 128 | 8,
    destroyed: 0,
    destroy() {
      this.destroyed++;
    },
  };
  const range = (offset, size) => ({ buffer, offset, size });
  return {
    ...f.input,
    geometry: { directory: range(0, 32), clips: range(256, 48), triangles: range(512, 4) },
    storage: {
      dictionary: range(768, 128),
      coefficients: range(1024, 384),
      work: range(1536, 32),
      control: range(1792, 32),
    },
  };
}
test("typed arena ranges share storage without writable aliasing or duplicate physical accounting", async () => {
  const f = fixture(),
    owner = await WinnerPrimitiveInterpolation.create(f.device, { accounting: f.accounting });
  const input = arenaInput(f),
    a = owner.prepare(input);
  assert.equal(a.byteLength, 64);
  assert.equal(a.workingByteLength, 640);
  assert.equal(f.accounting.snapshot().totalBytes, 64);
  assert.equal(f.buffers.length, 2);
  assert.throws(() => owner.prepare(input), /overlap/);
  owner.encode(f.encoder, a);
  const reset = f.commands.find((c) => c[0] === "clear");
  assert.equal(reset[1], input.storage.control.buffer);
  owner.release(a);
  assert.equal(input.storage.control.buffer.destroyed, 0);
  assert.equal(f.accounting.snapshot().totalBytes, 0);
  const next = owner.prepare(input);
  owner.destroy();
  owner.release(next);
});
test("misaligned, truncated, over-budget and aliased writable views fail before allocation", async () => {
  const f = fixture(),
    owner = await WinnerPrimitiveInterpolation.create(f.device),
    input = arenaInput(f);
  for (const coefficients of [
    { ...input.storage.coefficients, offset: 1028 },
    { ...input.storage.coefficients, offset: 768 },
    { ...input.storage.coefficients, size: 380 },
    { ...input.storage.coefficients, offset: 3840 },
    { ...input.storage.coefficients, size: 2048 },
  ]) {
    assert.throws(() => owner.prepare({ ...input, storage: { ...input.storage, coefficients } }), RangeError);
  }
  assert.throws(
    () =>
      owner.prepare({
        ...input,
        storage: { ...input.storage, dictionary: { ...input.storage.dictionary, offset: 0 } },
      }),
    /overlap/,
  );
  assert.throws(
    () =>
      owner.prepare({
        ...input,
        geometry: { ...input.geometry, directory: input.geometry.directory.buffer },
      }),
    /overlap/,
  );
  assert.throws(
    () =>
      owner.prepare({
        ...input,
        geometry: { ...input.geometry, clips: { ...input.geometry.clips, offset: 0 } },
      }),
    /overlap/,
  );
  assert.equal(f.buffers.length, 0);
  owner.destroy();
});
test("winner cumulative physical owner budget includes allocations still awaiting retirement", async () => {
  const f = fixture(),
    owner = await WinnerPrimitiveInterpolation.create(f.device, { maxBytes: 640 });
  const a = owner.prepare(f.input);
  assert.throws(() => owner.prepare(f.input), /byte or storage/);
  owner.release(a);
  owner.prepare(f.input);
  owner.destroy();
});
