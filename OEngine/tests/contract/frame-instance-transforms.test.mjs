import assert from "node:assert/strict";
import test from "node:test";
import { FrameInstanceTransforms } from "../../.test-dist/render/FrameInstanceTransforms.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";

globalThis.GPUBufferUsage = { UNIFORM: 64, STORAGE: 128, INDIRECT: 256, COPY_SRC: 4, COPY_DST: 8 };
globalThis.GPUShaderStage = { COMPUTE: 4 };
function fixture() {
  let loss; const buffers = [], commands = [], compiled = [], accounting = new ResourceAccounting();
  const device = { limits: { maxStorageBuffersPerShaderStage: 8, maxBindingsPerBindGroup: 1000, maxBindGroups: 4,
    maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxBufferSize: 1 << 24,
    maxStorageBufferBindingSize: 1 << 24, maxComputeWorkgroupsPerDimension: 2 },
    lost: new Promise(resolve => { loss = resolve; }), queue: { writeBuffer() {} },
    createBindGroupLayout: d => d, createPipelineLayout: d => d, createShaderModule: d => d,
    async createComputePipelineAsync(d) { compiled.push(d); return d; },
    createBuffer(d) { const b = { ...d, destroyed: 0, destroy() { this.destroyed++; } }; buffers.push(b); return b; },
    createBindGroup: d => d };
  const input = { camera: { size: 624 }, source: { size: 176 * 5 }, work: { size: 32 + 24 * 192 }, workCapacity: 192, instanceCapacity: 5 };
  const encoder = { clearBuffer(b) { commands.push(["clear", b]); }, beginComputePass() { return {
    setPipeline(p) { commands.push(["pipeline", p.compute.entryPoint]); },
    setBindGroup(i, group) { commands.push(["group", i, group]); },
    dispatchWorkgroups(...args) { commands.push(["dispatch", ...args]); },
    dispatchWorkgroupsIndirect(b, at) { commands.push(["indirect", b, at]); }, end() {} }; } };
  return { device, input, encoder, buffers, commands, compiled, accounting, loss };
}
test("frame geometry awaits async pipelines, launches actual GPU demand and reuses every allocation", async () => {
  const f = fixture(), owner = new FrameInstanceTransforms(f.device, f.accounting);
  assert.throws(() => owner.prepare(f.input), /completed scene preparation/);
  await owner.ready;
  const p = owner.prepare(f.input), bytes = 5 * (288 + 4 + 4) + 48;
  assert.equal(p.records.size, 5 * 288); assert.equal(p.byteLength, bytes);
  assert.equal(owner.allocatedBytes, bytes); assert.equal(f.accounting.snapshot().totalBytes, bytes);
  for (let frame = 0; frame < 3; frame++) owner.encode(f.encoder, p);
  assert.equal(f.buffers.length, 6); assert.equal(f.compiled.length, 4);
  assert.deepEqual(f.commands.filter(c => c[0] === "pipeline").slice(0, 4).map(c => c[1]),
    ["frame_instance_begin", "frame_instance_select", "frame_instance_finalize", "frame_instance_build"]);
  assert.equal(f.commands.filter(c => c[0] === "indirect").length, 6);
  // Only begin/finalize write indirect; neither pass consumes it as an indirect input.
  assert.equal(f.commands.filter(c => c[0] === "group" && c[1] === 1).length, 6);
  const camera = {}; owner.rebind(p, camera); owner.encode(f.encoder, p);
  assert.equal(f.commands.filter(c => c[0] === "group" && c[1] === 0).at(-1)[2].entries[0].resource.buffer, camera);
  owner.release(p); assert.equal(owner.allocatedBytes, 0); assert.equal(f.accounting.snapshot().totalBytes, 0);
  assert.ok(f.buffers.every(b => b.destroyed === 1)); assert.throws(() => owner.encode(f.encoder, p), /stale/); owner.destroy();
});
test("physical capacity, cumulative byte budget and 2D dispatch are checked before allocation", async () => {
  const f = fixture(), owner = new FrameInstanceTransforms(f.device, f.accounting, false, 1600); await owner.ready;
  for (const input of [{ ...f.input, instanceCapacity: 5.5 }, { ...f.input, instanceCapacity: 6 },
    { ...f.input, workCapacity: 193 }, { ...f.input, work: { size: 100000 }, workCapacity: 257 }]) {
    assert.throws(() => owner.prepare(input), RangeError);
  }
  assert.equal(f.buffers.length, 0); const p = owner.prepare(f.input);
  assert.throws(() => owner.prepare(f.input), RangeError); assert.equal(f.buffers.length, 6);
  owner.release(p); owner.destroy();
});
test("binding failure rolls back bytes; failed camera rebind keeps original binding", async () => {
  const f = fixture(), owner = new FrameInstanceTransforms(f.device, f.accounting); await owner.ready;
  const original = f.device.createBindGroup;
  f.device.createBindGroup = () => { throw new Error("binding failure"); };
  assert.throws(() => owner.prepare(f.input), /binding failure/);
  assert.equal(owner.allocatedBytes, 0); assert.equal(f.accounting.snapshot().totalBytes, 0);
  assert.ok(f.buffers.every(b => b.destroyed === 1));
  f.device.createBindGroup = original; const p = owner.prepare(f.input);
  f.device.createBindGroup = () => { throw new Error("rebind failure"); };
  assert.throws(() => owner.rebind(p, {}), /rebind failure/);
  f.device.createBindGroup = original;
  owner.rebind(p, f.input.camera); owner.encode(f.encoder, p);
  assert.equal(f.commands.filter(c => c[0] === "group" && c[1] === 0).at(-1)[2].entries[0].resource.buffer, f.input.camera);
  owner.destroy();
});
test("device loss or destroy during async readiness prevents publication and late retirement is harmless", async () => {
  const f = fixture(), owner = new FrameInstanceTransforms(f.device, f.accounting); await owner.ready;
  const p = owner.prepare(f.input); f.loss({ reason: "destroyed" }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.accounting.snapshot().totalBytes, 0); assert.ok(f.buffers.every(b => b.destroyed === 1));
  owner.release(p); owner.destroy(); assert.throws(() => owner.prepare(f.input), /completed scene preparation/);
  const g = fixture(), pending = new FrameInstanceTransforms(g.device); pending.destroy();
  await assert.rejects(pending.ready, /stopped during preparation/);
  g.device.limits.maxStorageBuffersPerShaderStage = 6;
  assert.throws(() => new FrameInstanceTransforms(g.device), /seven storage/);
});
