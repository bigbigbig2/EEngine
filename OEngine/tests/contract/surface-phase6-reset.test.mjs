import test from "node:test";
import assert from "node:assert/strict";
import {
  surfaceCellWorkspaceLayout,
  surfaceCellWorkspaceResetRanges,
} from "../../.test-dist/gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceDemandLayout, surfaceDemandResetRanges } from "../../.test-dist/gpu/GpuSurfaceDemandAbi.js";

const overlaps = (offset, bytes, first, last) => offset < last && offset + bytes > first;
test("Workspace resets optional result maps and atomic masks without touching payload", () => {
  const layout = surfaceCellWorkspaceLayout(700),
    ranges = surfaceCellWorkspaceResetRanges(700);
  assert.deepEqual(ranges, [
    [0, 512],
    [layout.geometryProofs, layout.primitives - layout.geometryProofs],
    [layout.fieldStoreMasks, layout.demands - layout.fieldStoreMasks],
    [layout.proofTileCounts, 28],
  ]);
  for (const [offset, bytes] of ranges) {
    assert.equal(offset % 4, 0);
    assert.equal(bytes % 4, 0);
    for (const [first, last] of [
      [layout.proofResults, layout.geometryProofs],
      [layout.addresses, layout.fieldStoreMasks],
      [layout.demands, layout.proofTileCounts],
      [layout.proofDispatch, layout.bytes],
    ]) {
      assert.equal(overlaps(offset, bytes, first, last), false);
    }
  }
  assert.ok(ranges.reduce((sum, range) => sum + range[1], 0) < layout.bytes / 4);
});
test("Demand resets dictionary/control and three atomic masks while retaining actual-count payload", () => {
  const layout = surfaceDemandLayout(44800, 256),
    ranges = surfaceDemandResetRanges(layout);
  assert.deepEqual(ranges, [
    [0, layout.offsets.field_requests],
    [layout.offsets.geometry_masks, layout.targets * 12],
  ]);
  for (const [offset, bytes] of ranges) {
    for (const [first, last] of [
      [layout.offsets.field_requests, layout.offsets.geometry_masks],
      [layout.offsets.material_entries, layout.bytes],
    ])
      assert.equal(overlaps(offset, bytes, first, last), false);
  }
  assert.ok(ranges.reduce((sum, range) => sum + range[1], 0) < layout.bytes / 2);
});
