import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
globalThis.GPUBufferUsage = { UNIFORM: 64, STORAGE: 128, INDIRECT: 256, COPY_SRC: 4, COPY_DST: 8 };
import { FrameGeometryVertices } from "../../.test-dist/render/FrameGeometryVertices.js";
import { FrameGeometryArena } from "../../.test-dist/render/FrameGeometryArena.js";
import { CurrentHzbLateRecheckGpu } from "../../.test-dist/render/CurrentHzbLateRecheck.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
function fixture(filtered = true) {
  const accounting = new ResourceAccounting(),
    buffers = [],
    commands = [];
  let loss;
  const limits = {
    maxStorageBuffersPerShaderStage: 16,
    maxBindingsPerBindGroup: 1000,
    maxBindGroups: 4,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupsPerDimension: 2,
    minStorageBufferOffsetAlignment: 256,
    maxStorageBufferBindingSize: 1 << 24,
    maxBufferSize: 1 << 24,
  };
  const device = {
    limits,
    lost: new Promise((resolve) => {
      loss = resolve;
    }),
    queue: { writeBuffer() {} },
    createShaderModule: (d) => ({ ...d, getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (d) => d,
    createPipelineLayout: (d) => d,
    createComputePipelineAsync: async (d) => d,
    createBindGroup: (d) => d,
    createBuffer(d) {
      const data = new ArrayBuffer(d.size),
        b = {
          ...d,
          destroyed: 0,
          getMappedRange: () => data,
          unmap() {},
          destroy() {
            this.destroyed++;
          },
        };
      buffers.push(b);
      return b;
    },
  };
  const arenaOwner = new FrameGeometryArena(device, accounting),
    metadata = { size: 256, usage: GPUBufferUsage.COPY_SRC };
  const budget = {
    workCapacity: 4,
    filteredWorkCapacity: filtered ? 4 : 0,
    vertexCapacity: 9,
    triangleCapacity: 3,
    dictionaryCapacity: 16,
    coefficientCapacity: 8,
    probeLimit: 8,
    maxBytes: 16384,
  };
  const arena = arenaOwner.prepare(metadata, 256, budget),
    source = { size: 1024, usage: GPUBufferUsage.STORAGE };
  const input = {
    arena,
    instances: { records: source },
    work: source,
    assets: {
      sparseShading: {
        assetMetadataHeap: source,
        vertexPayloadHeap: source,
        geometryWordBase: 0,
        meshletWordBase: 0,
        meshletVertexWordBase: 0,
        meshletTriangleWordBase: 0,
        vertexDataWordBase: 0,
      },
    },
  };
  const encoder = {
    beginComputePass() {
      return {
        setPipeline(p) {
          commands.push(["pipeline", p.compute.entryPoint]);
        },
        setBindGroup(i, g) {
          commands.push(["group", i, g]);
        },
        dispatchWorkgroups(...args) {
          commands.push(["dispatch", ...args]);
        },
        dispatchWorkgroupsIndirect(...args) {
          commands.push(["indirect", ...args]);
        },
        end() {},
      };
    },
  };
  const lateInput = {
    sourceGeometry: arena.sourceDirectory,
    filteredGeometry: arena.filteredDirectory,
    sourceQueue: source,
    capacity: 4,
    camera: {},
    instances: source,
    virtualGeometry: { metadata: source },
    productBanks: [source, source, source, source],
    counters: source,
    countersEnabled: false,
    width: 1,
    height: 1,
    mipLevelCount: 1,
  };
  return { device, accounting, buffers, commands, arenaOwner, input, encoder, lateInput, loss };
}
test("selected vertices borrow the sole arena, await async preparation and reuse allocations without arena double accounting", async () => {
  const f = fixture(),
    owner = new FrameGeometryVertices(f.device, f.accounting),
    arenaBytes = f.arenaOwner.allocatedBytes;
  assert.throws(() => owner.prepare(f.input), /completed scene preparation/);
  await owner.ready;
  const p = owner.prepare(f.input);
  // Settings 64B, control 32B, indirect 16B and two raster addresses 16B each.
  assert.equal(p.byteLength, 144 + 9 * 96);
  assert.equal(f.accounting.snapshot().totalBytes, arenaBytes + 144 + 9 * 96);
  const count = f.buffers.length;
  for (let i = 0; i < 3; i++) owner.encode(f.encoder, p);
  assert.equal(f.buffers.length, count);
  assert.equal(f.commands.filter((c) => c[0] === "indirect").length, 3);
  assert.equal(f.commands.filter((c) => c[0] === "group" && c[1] === 1).length, 3);
  owner.release(p);
  assert.equal(f.accounting.snapshot().totalBytes, arenaBytes);
  assert.equal(f.input.arena.buffer.destroyed, 0);
  f.arenaOwner.destroy();
  owner.destroy();
  assert.equal(f.accounting.snapshot().totalBytes, 0);
});
test("vertex byte/dispatch/capability failure and binding exceptions never leak owned or borrowed storage", async () => {
  const f = fixture(false),
    owner = new FrameGeometryVertices(f.device, f.accounting, false, 95);
  await owner.ready;
  assert.throws(() => owner.prepare(f.input), RangeError);
  assert.equal(owner.allocatedBytes, 0);
  const other = new FrameGeometryVertices(f.device, f.accounting);
  await other.ready;
  const make = f.device.createBindGroup;
  f.device.createBindGroup = () => {
    throw new Error("binding failed");
  };
  assert.throws(() => other.prepare(f.input), /binding failed/);
  assert.equal(other.allocatedBytes, 0);
  assert.equal(f.accounting.snapshot().totalBytes, f.arenaOwner.allocatedBytes);
  assert.ok(f.buffers.slice(1).every((b) => b.destroyed === 1));
  f.device.createBindGroup = make;
  const p = other.prepare(f.input);
  assert.equal(p.rasterSettings, p.filteredRasterSettings);
  assert.equal(p.byteLength, 128 + 9 * 96);
  f.loss({});
  await new Promise((resolve) => setImmediate(resolve));
  other.release(p);
  assert.equal(f.accounting.snapshot().totalBytes, 0);
  f.device.limits.maxBindingsPerBindGroup = 16;
  assert.throws(() => new FrameGeometryVertices(f.device), /fifteen storage/);
  owner.destroy();
  other.destroy();
});
test("HZB owner uses separate indirect write/read scopes and GPU completion retirement, with no arena ownership", async () => {
  const f = fixture(),
    owner = new CurrentHzbLateRecheckGpu(f.device, f.accounting);
  assert.throws(() => owner.prepare(f.lateInput), /completed scene preparation/);
  await owner.ready;
  const p = owner.prepare(f.lateInput);
  assert.equal(owner.allocatedBytes, 32 + 4 * 24 + 64);
  assert.ok(owner.matches(p, { ...f.lateInput }));
  assert.ok(!owner.matches(p, { ...f.lateInput, filteredGeometry: f.input.arena.sourceDirectory }));
  owner.encode(f.encoder, p, {});
  assert.equal(f.commands.filter((c) => c[0] === "indirect").length, 1);
  assert.equal(f.commands.filter((c) => c[0] === "group" && c[1] === 1).length, 1);
  owner.release(p);
  assert.equal(owner.allocatedBytes, 0);
  assert.equal(f.input.arena.buffer.destroyed, 0);
  f.arenaOwner.destroy();
  owner.destroy();
  assert.equal(f.accounting.snapshot().totalBytes, 0);
});
test("HZB alias/capacity/binding failures are rejected or rolled back, including destroy during compilation", async () => {
  const f = fixture(),
    owner = new CurrentHzbLateRecheckGpu(f.device, f.accounting);
  await owner.ready;
  assert.throws(
    () => owner.prepare({ ...f.lateInput, filteredGeometry: f.lateInput.sourceGeometry }),
    /overlap/,
  );
  assert.throws(() => owner.prepare({ ...f.lateInput, capacity: 257 }), RangeError);
  f.device.createBindGroup = () => {
    throw new Error("binding failed");
  };
  assert.throws(() => owner.prepare(f.lateInput), /binding failed/);
  assert.equal(owner.allocatedBytes, 0);
  assert.equal(f.accounting.snapshot().totalBytes, f.arenaOwner.allocatedBytes);
  owner.destroy();
  f.arenaOwner.destroy();
  const pending = new CurrentHzbLateRecheckGpu(f.device);
  pending.destroy();
  await assert.rejects(pending.ready, /stopped during preparation/);
});
