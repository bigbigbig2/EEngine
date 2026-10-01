import assert from "node:assert/strict";
import test from "node:test";
import { frameGeometryArenaLayout, frameGeometryArenaHeader } from "../../.test-dist/gpu/GpuFrameGeometryArenaAbi.js";
import { FrameGeometryArena } from "../../.test-dist/render/FrameGeometryArena.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";

globalThis.GPUBufferUsage = { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 };
const limits = { minStorageBufferOffsetAlignment: 256, maxBufferSize: 1 << 24, maxStorageBufferBindingSize: 1 << 24 };
const budget = { workCapacity: 3, filteredWorkCapacity: 3, vertexCapacity: 9, triangleCapacity: 3,
  dictionaryCapacity: 16, coefficientCapacity: 8, probeLimit: 8, maxBytes: 16384 };
function fixture(maxBytes) {
  let loss; const buffers = [], copies = [], accounting = new ResourceAccounting();
  const device = { limits: { ...limits }, lost: new Promise(resolve => { loss = resolve; }), createBuffer(d) {
    const data = new ArrayBuffer(d.size), b = { ...d, destroyed: 0, getMappedRange: () => data,
      unmap() {}, destroy() { this.destroyed++; }, data }; buffers.push(b); return b;
  } };
  const metadata = { size: 236, usage: GPUBufferUsage.COPY_SRC };
  const encoder = { copyBufferToBuffer(...args) { copies.push(args); } };
  return { owner: new FrameGeometryArena(device, accounting, maxBytes), device, metadata, encoder, buffers, copies, accounting, loss };
}
test("arena layout retains raw metadata offsets and budgets physical gaps and both directory namespaces", () => {
  for (const alignment of [16, 64, 256, 512]) {
    const layout = frameGeometryArenaLayout(236, budget, { ...limits, minStorageBufferOffsetAlignment: alignment });
    let end = 236;
    for (const [name, region] of Object.entries(layout)) if (typeof region === "object") {
      assert.equal(region.offset % alignment, 0, name); assert.ok(region.offset >= end, name); end = region.offset + region.size;
    }
    assert.equal(layout.byteLength, end); assert.equal(layout.metadataBytes, 236);
    const header = frameGeometryArenaHeader(layout, budget);
    assert.deepEqual(Array.from(header.slice(0, 4)), [1, 3, 9, 3]);
    assert.equal(header[4] * 4, layout.sourceDirectory.offset); assert.equal(header[5] * 4, layout.filteredDirectory.offset);
    assert.equal(header[8] * 4, layout.dictionary.offset); assert.equal(header[9] * 4, layout.coefficients.offset);
    assert.equal(header[10], 16); assert.equal(header[11], 8); assert.equal(header[12], 8);
  }
});
test("views without late HZB allocate no second directory; filtered queues have an explicit independent capacity", () => {
  const full = frameGeometryArenaLayout(236, budget, limits);
  const direct = frameGeometryArenaLayout(236, { ...budget, filteredWorkCapacity: 0 }, limits);
  assert.equal(direct.sourceDirectory, direct.filteredDirectory); assert.ok(direct.byteLength < full.byteLength);
  assert.equal(frameGeometryArenaHeader(direct, { ...budget, filteredWorkCapacity: 0 })[13], 0);
  const partial = frameGeometryArenaLayout(236, { ...budget, filteredWorkCapacity: 1 }, limits);
  assert.equal(partial.filteredDirectory.size, 32);
  assert.throws(() => frameGeometryArenaLayout(236, { ...budget, filteredWorkCapacity: 4 }, limits), RangeError);
});
test("arena preflight rejects invalid bounds and whole-buffer limits before allocating", () => {
  const f = fixture();
  for (const invalid of [{ ...budget, workCapacity: 0 }, { ...budget, vertexCapacity: 0x100000000 },
    { ...budget, dictionaryCapacity: 15 }, { ...budget, coefficientCapacity: 32 }, { ...budget, probeLimit: 17 }, { ...budget, maxBytes: 16 }]) {
    assert.throws(() => f.owner.prepare(f.metadata, 236, invalid), RangeError);
  }
  assert.throws(() => f.owner.prepare(f.metadata, 240, budget), RangeError);
  assert.throws(() => f.owner.prepare({ ...f.metadata, usage: 0 }, 236, budget), RangeError);
  f.device.limits.maxStorageBufferBindingSize = 1024;
  assert.throws(() => f.owner.prepare(f.metadata, 236, budget), RangeError);
  assert.equal(f.buffers.length, 0); f.owner.destroy();
});
test("aborted metadata publication retries; committed stable frames encode zero copies", () => {
  const f = fixture(), p = f.owner.prepare(f.metadata, 236, budget);
  const abandoned = f.owner.encodeMetadataPublication(f.encoder, p);
  assert.equal(f.copies.length, 1); void abandoned;
  const commit = f.owner.encodeMetadataPublication(f.encoder, p); assert.equal(f.copies.length, 2);
  commit(); commit(); f.owner.encodeMetadataPublication(f.encoder, p)(); assert.equal(f.copies.length, 2);
  assert.deepEqual(f.copies[0], [f.metadata, 0, p.buffer, 0, 236]);
  assert.equal(f.owner.allocatedBytes, p.layout.byteLength); assert.equal(f.accounting.snapshot().totalBytes, p.layout.byteLength);
  assert.deepEqual(Array.from(new Uint32Array(p.buffer.data, p.layout.header.offset, 16)), Array.from(frameGeometryArenaHeader(p.layout, budget)));
  f.owner.release(p); assert.equal(f.accounting.snapshot().totalBytes, 0);
  assert.equal(f.buffers[0].destroyed, 1); assert.throws(() => f.owner.encodeMetadataPublication(f.encoder, p), /stale/); f.owner.destroy();
});
test("arena cumulative budget includes retained worksets and releases only its single physical buffer", () => {
  const size = frameGeometryArenaLayout(236, budget, limits).byteLength, f = fixture(size);
  const p = f.owner.prepare(f.metadata, 236, budget);
  assert.throws(() => f.owner.prepare(f.metadata, 236, budget), /cumulative/);
  f.owner.release(p); f.owner.prepare(f.metadata, 236, budget); f.owner.destroy();
  assert.ok(f.buffers.every(b => b.destroyed === 1)); assert.equal(f.accounting.snapshot().totalBytes, 0);
});
test("device loss revokes ranges and late publication/retirement cannot resurrect the arena", async () => {
  const f = fixture(), p = f.owner.prepare(f.metadata, 236, budget), commit = f.owner.encodeMetadataPublication(f.encoder, p);
  f.loss({ reason: "destroyed" }); await new Promise(resolve => setImmediate(resolve));
  commit(); f.owner.release(p); f.owner.destroy();
  assert.equal(p.buffer.destroyed, 1); assert.equal(f.accounting.snapshot().totalBytes, 0);
  assert.throws(() => f.owner.prepare(f.metadata, 236, budget), /destroyed/);
});
test("mapped-header initialization failure rolls back physical storage", () => {
  const f = fixture(); const make = f.device.createBuffer;
  f.device.createBuffer = d => { const b = make(d); b.getMappedRange = () => { throw new Error("fixture mapped failure"); }; return b; };
  assert.throws(() => f.owner.prepare(f.metadata, 236, budget), /mapped failure/);
  assert.equal(f.buffers[0].destroyed, 1); assert.equal(f.owner.allocatedBytes, 0); assert.equal(f.accounting.snapshot().totalBytes, 0);
  f.owner.destroy();
});
