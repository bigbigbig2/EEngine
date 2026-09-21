import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyGpuShadingBinsReference,
  createGpuShadingBinLayouts,
  finalizeGpuShadingBinsReference,
  GPU_SHADING_BIN_COUNT,
  GPU_SHADING_BIN_FRAME_FLAG,
  GPU_SHADING_BIN_INVALID_ID,
  shadingBinActiveMask
} from "../.test-dist/gpu/GpuShadingBinAbi.js";

function classify({
  width,
  height,
  pixels,
  activeBinIds,
  capacityOverrides,
  layoutRevisionOverrides,
  maxDispatchDimension = 65535
}) {
  return classifyGpuShadingBinsReference({
    width,
    height,
    binIds: Uint8Array.from(pixels),
    activeBinIds,
    generation: 3,
    layoutRevision: 7,
    maxDispatchDimension,
    capacityOverrides,
    layoutRevisionOverrides
  });
}

function zeroArgs(args) {
  assert.equal(args.length, GPU_SHADING_BIN_COUNT);
  for (const record of args) {
    assert.deepEqual(record, { workgroupCountX: 0, workgroupCountY: 1, workgroupCountZ: 1 });
  }
}

test("empty and background-only images produce no records and complete zero dispatch args", () => {
  const empty = classify({ width: 0, height: 0, pixels: [], activeBinIds: [] });
  assert.equal(empty.records.length, 0);
  assert.equal(empty.control.frameFlags, 0);
  assert.equal(empty.control.finalizedGeneration, 3);
  assert.equal(empty.control.layoutRevision, 7);
  zeroArgs(empty.indirectArgs);

  const background = classify({
    width: 3,
    height: 2,
    pixels: Array(6).fill(GPU_SHADING_BIN_INVALID_ID),
    activeBinIds: [0]
  });
  assert.deepEqual(background.recordsByBin[0], []);
  assert.equal(background.control.generatedMaskLo, 0);
  assert.equal(background.control.errorCount, 0);
});

test("a uniform 64 by 64 macro emits one record for every covered microtile", () => {
  const result = classify({
    width: 64,
    height: 64,
    pixels: Array(64 * 64).fill(15),
    activeBinIds: [15]
  });
  assert.equal(result.counters[15].attemptedCount, 64);
  assert.equal(result.counters[15].writtenCount, 64);
  assert.equal(result.counters[15].overflowCount, 0);
  assert.deepEqual(result.recordsByBin[15], Array.from({ length: 64 }, (_, index) => index));
  assert.deepEqual(result.indirectArgs[15], {
    workgroupCountX: 64,
    workgroupCountY: 1,
    workgroupCountZ: 1
  });
  assert.equal(result.control.generatedMaskLo, 1 << 15);
  assert.equal(result.control.frameFlags, 0);
});

test("all 64 bins in one microtile each produce the same global microtile id once", () => {
  const result = classify({
    width: 8,
    height: 8,
    pixels: Array.from({ length: 64 }, (_, index) => index),
    activeBinIds: Array.from({ length: 64 }, (_, index) => index)
  });
  for (let binId = 0; binId < 64; binId++) {
    assert.deepEqual(result.recordsByBin[binId], [0]);
    assert.equal(result.counters[binId].attemptedCount, 1);
    assert.deepEqual(result.indirectArgs[binId], {
      workgroupCountX: 1,
      workgroupCountY: 1,
      workgroupCountZ: 1
    });
  }
  assert.equal(result.control.generatedMaskLo, 0xffffffff);
  assert.equal(result.control.generatedMaskHi, 0xffffffff);
});

test("partial edges and mixed pixels deduplicate by bin and global microtile", () => {
  const pixels = Array(9 * 9).fill(GPU_SHADING_BIN_INVALID_ID);
  pixels[0] = 2;
  pixels[1] = 2;
  pixels[8] = 2;
  pixels[8 * 9] = 2;
  pixels[8 * 9 + 8] = 3;
  const result = classify({ width: 9, height: 9, pixels, activeBinIds: [2, 3] });
  assert.deepEqual(result.recordsByBin[2], [0, 1, 2]);
  assert.deepEqual(result.recordsByBin[3], [3]);
  assert.equal(result.counters[2].writtenCount, 3);
  assert.equal(result.counters[3].writtenCount, 1);
});

test("deterministic property matrix matches an independent per-microtile set oracle", () => {
  let state = 0x6d2b79f5;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const activeBinIds = [0, 5, 15, 31, 32, 47, 63];
  const extents = [[1, 1], [7, 9], [17, 15], [65, 67], [129, 17]];
  for (const [width, height] of extents) {
    const pixels = Array.from({ length: width * height }, () => {
      const sample = random() % 10;
      return sample < 3 ? GPU_SHADING_BIN_INVALID_ID : activeBinIds[random() % activeBinIds.length];
    });
    const expected = Array.from({ length: 64 }, () => new Set());
    const microtilesX = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const binId = pixels[y * width + x];
        if (binId === GPU_SHADING_BIN_INVALID_ID) continue;
        expected[binId].add(Math.floor(y / 8) * microtilesX + Math.floor(x / 8));
      }
    }
    const result = classify({ width, height, pixels, activeBinIds });
    assert.equal(result.control.frameFlags, 0);
    for (let binId = 0; binId < 64; binId++) {
      assert.deepEqual(
        [...result.recordsByBin[binId]].sort((left, right) => left - right),
        [...expected[binId]].sort((left, right) => left - right),
        `${width}x${height} bin ${binId}`
      );
      assert.equal(result.counters[binId].overflowCount, 0);
    }
  }
});

test("invalid and inactive bins fail closed while background remains ignored", () => {
  const result = classify({
    width: 3,
    height: 1,
    pixels: [GPU_SHADING_BIN_INVALID_ID, 64, 5],
    activeBinIds: [0]
  });
  assert.equal(
    result.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.InvalidBin,
    GPU_SHADING_BIN_FRAME_FLAG.InvalidBin
  );
  assert.equal(
    result.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.InactiveBin,
    GPU_SHADING_BIN_FRAME_FLAG.InactiveBin
  );
  assert.equal(result.control.errorCount, 2);
  zeroArgs(result.indirectArgs);
});

test("macro reservation is all-or-nothing at exact capacity and overflow", () => {
  const exact = classify({
    width: 16,
    height: 8,
    pixels: Array(128).fill(1),
    activeBinIds: [1],
    capacityOverrides: { 1: 2 }
  });
  assert.deepEqual(exact.recordsByBin[1], [0, 1]);
  assert.deepEqual(exact.counters[1], {
    attemptedCount: 2,
    writtenCount: 2,
    overflowCount: 0,
    flags: 0
  });

  const oneShort = classify({
    width: 16,
    height: 8,
    pixels: Array(128).fill(1),
    activeBinIds: [1],
    capacityOverrides: { 1: 1 }
  });
  assert.deepEqual(oneShort.recordsByBin[1], []);
  assert.deepEqual(oneShort.counters[1], {
    attemptedCount: 2,
    writtenCount: 0,
    overflowCount: 2,
    flags: GPU_SHADING_BIN_FRAME_FLAG.ReservationOverflow
  });
  zeroArgs(oneShort.indirectArgs);
});

test("later macro overflow preserves prior complete reservation but final output still fails closed", () => {
  const result = classify({
    width: 128,
    height: 8,
    pixels: Array(1024).fill(4),
    activeBinIds: [4],
    capacityOverrides: { 4: 8 }
  });
  assert.deepEqual(result.recordsByBin[4], Array.from({ length: 8 }, (_, index) => index));
  assert.deepEqual(result.counters[4], {
    attemptedCount: 16,
    writtenCount: 8,
    overflowCount: 8,
    flags: GPU_SHADING_BIN_FRAME_FLAG.ReservationOverflow
  });
  assert.equal(result.records.length, 8);
  zeroArgs(result.indirectArgs);
});

test("layout revision mismatch is detected before reservation and zeros every bin arg", () => {
  const result = classify({
    width: 8,
    height: 8,
    pixels: Array(64).fill(2),
    activeBinIds: [2],
    layoutRevisionOverrides: { 2: 8 }
  });
  assert.equal(result.counters[2].attemptedCount, 0);
  assert.equal(
    result.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.LayoutRevisionMismatch,
    GPU_SHADING_BIN_FRAME_FLAG.LayoutRevisionMismatch
  );
  zeroArgs(result.indirectArgs);
});

test("finalizer catches counter closure and 2D dispatch overflow independently", () => {
  const activeBinIds = [0];
  const mask = shadingBinActiveMask(activeBinIds);
  const settings = {
    width: 8,
    height: 8,
    microtilesX: 1,
    generation: 1,
    allowedMaskLo: mask.lo,
    allowedMaskHi: mask.hi,
    maxDispatchDimension: 2,
    layoutRevision: 1
  };
  const layouts = createGpuShadingBinLayouts(8, 8, activeBinIds, 1, { 0: 5 });
  const zero = Object.freeze({ attemptedCount: 0, writtenCount: 0, overflowCount: 0, flags: 0 });
  const counters = Array.from({ length: 64 }, () => zero);
  counters[0] = Object.freeze({ attemptedCount: 5, writtenCount: 5, overflowCount: 0, flags: 0 });
  const dispatchOverflow = finalizeGpuShadingBinsReference({ settings, layouts, counters });
  assert.equal(
    dispatchOverflow.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure,
    GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure
  );
  zeroArgs(dispatchOverflow.indirectArgs);

  counters[0] = Object.freeze({ attemptedCount: 4, writtenCount: 2, overflowCount: 1, flags: 0 });
  const closureFailure = finalizeGpuShadingBinsReference({ settings, layouts, counters });
  assert.equal(
    closureFailure.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure,
    GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure
  );
  zeroArgs(closureFailure.indirectArgs);
});

test("reference classifier rejects source-size and generation boundary errors", () => {
  assert.throws(
    () => classify({ width: 2, height: 2, pixels: [0], activeBinIds: [0] }),
    /source length/u
  );
  assert.throws(
    () => classifyGpuShadingBinsReference({
      width: 1,
      height: 1,
      binIds: Uint8Array.of(0),
      activeBinIds: [0],
      generation: 0,
      layoutRevision: 1,
      maxDispatchDimension: 65535
    }),
    /generation must be non-zero/u
  );
});
