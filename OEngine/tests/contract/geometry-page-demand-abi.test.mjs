import assert from "node:assert/strict";
import test from "node:test";

const abi = await import("../../.test-dist/gpu/GeometryPageDemandAbiV1.js");

test("GeometryPageDemand V1 mirrors the 16-byte header/record contract", () => {
  const record = { productTableSlot: 2, productGeneration: 9, pageId: 7, priority: 400, currentViewMissing: true, shadow: false, predictive: true };
  assert.deepEqual(abi.unpackGeometryPageDemandV1(abi.packGeometryPageDemandV1(record)), record);
  const state = abi.createGeometryPageDemandQueueV1(1, 11);
  assert.equal(abi.reserveGeometryPageDemandV1(state, record), true);
  assert.equal(abi.reserveGeometryPageDemandV1(state, { ...record, pageId: 8 }), false);
  assert.equal(state.attempted, 2); assert.equal(state.overflow, 1);
  assert.equal(abi.deduplicateGeometryPageDemandsV1([record, { ...record, priority: 500 }, { ...record, pageId: 8 }]).length, 2);
  assert.throws(() => abi.unpackGeometryPageDemandV1(new Uint8Array(16).fill(0xff)), /reserved|invalid/i);
  assert.match(abi.GEOMETRY_PAGE_DEMAND_WGSL, /atomic<u32>/);
});

test("Product-local demand mask removes camera-cut duplicates before queue compaction", () => {
  const mask = abi.createGeometryPageDemandMaskV1(96);
  const cut = [3, 3, 3, 31, 31, 64, 95, 95, 95];
  const accepted = cut.filter((pageId) => abi.markGeometryPageDemandMaskV1(mask, pageId));
  assert.deepEqual(accepted, [3, 31, 64, 95]);
  assert.equal(mask.attempted, cut.length);
  assert.equal(mask.unique, 4);
  assert.equal(mask.duplicates, 5);
  assert.equal(mask.overflow, 0);
  assert.equal(abi.geometryPageDemandMaskWordCountV1(96), 3);
  abi.clearGeometryPageDemandMaskV1(mask);
  assert.deepEqual([...mask.words], [0, 0, 0]);
  assert.equal(mask.attempted, 0);
});

test("Product-local demand mask records bounded page-id overflow", () => {
  const mask = abi.createGeometryPageDemandMaskV1(2);
  assert.equal(abi.markGeometryPageDemandMaskV1(mask, 2), false);
  assert.equal(mask.attempted, 1);
  assert.equal(mask.unique, 0);
  assert.equal(mask.overflow, 1);
  assert.throws(() => abi.geometryPageDemandMaskWordCountV1(0), /positive/i);
});
