import test from "node:test";
import assert from "node:assert/strict";

import {
  ResourceAccounting,
  estimateBufferBytes,
  estimateTextureBytes
} from "../.test-dist/debug/profiling/ResourceAccounting.js";

test("resource accounting tracks owner bytes and releases them", () => {
  const accounting = new ResourceAccounting();
  const buffer = accounting.created({ kind: "buffer", category: "resident", owner: "scene", bytes: 128 });
  accounting.created({ kind: "texture", category: "history", owner: "history", bytes: 256 });
  assert.deepEqual(accounting.snapshot().owners, {
    scene: { buffer: 128 },
    history: { texture: 256 }
  });
  accounting.destroyed(buffer);
  assert.equal(accounting.snapshot().totalBytes, 256);
  assert.deepEqual(accounting.snapshot().categories, {
    resident: { bytes: 0, peakBytes: 128, count: 0 },
    history: { bytes: 256, peakBytes: 256, count: 1 }
  });
  assert.equal(accounting.snapshot().createdCount, 2);
  assert.equal(accounting.snapshot().destroyedCount, 1);
  assert.throws(() => accounting.destroyed(buffer), /already released/);
});

test("texture estimate accounts uncompressed mips, layers, samples and 3D depth", () => {
  assert.equal(estimateTextureBytes({ format: "rgba8unorm", width: 4, height: 4, depthOrArrayLayers: 2, mipLevelCount: 2 }), 160);
  assert.equal(estimateTextureBytes({ format: "rgba8unorm", width: 4, height: 4, sampleCount: 4 }), 256);
  assert.equal(estimateTextureBytes({ format: "r8unorm", width: 4, height: 4, depthOrArrayLayers: 4, dimension: "3d", mipLevelCount: 3 }), 73);
  assert.throws(() => estimateTextureBytes({ format: "unknown-format", width: 1, height: 1 }), /unsupported/);
});

test("texture estimate uses block footprints for compressed formats", () => {
  assert.equal(estimateTextureBytes({ format: "bc1-rgba-unorm", width: 7, height: 5 }), 32);
  assert.equal(estimateTextureBytes({ format: "bc3-rgba-unorm-srgb", width: 7, height: 5 }), 64);
  assert.equal(estimateTextureBytes({ format: "astc-8x8-unorm", width: 9, height: 9 }), 64);
  assert.equal(estimateTextureBytes({ format: "etc2-rgb8unorm", width: 4, height: 4, mipLevelCount: 2 }), 16);
  assert.throws(
    () => estimateTextureBytes({ format: "bc1-rgba-unorm", width: 4, height: 4, sampleCount: 4 }),
    /compressed.*multisampled/i
  );
});

test("buffer estimate preserves exact accounted descriptor bytes", () => {
  assert.equal(estimateBufferBytes({ size: 513 }), 513);
  assert.throws(() => estimateBufferBytes({ size: Number.POSITIVE_INFINITY }), /finite/);
  assert.throws(() => estimateBufferBytes({ size: -1 }), /non-negative/);
});

test("resource handles cannot release another ledger entry with the same id", () => {
  const left = new ResourceAccounting();
  const right = new ResourceAccounting();
  left.created({ kind: "buffer", owner: "left", bytes: 4 });
  const foreign = right.created({ kind: "buffer", owner: "right", bytes: 8 });
  assert.throws(() => left.destroyed(foreign), /unknown|another ledger/);
  assert.equal(left.snapshot().totalBytes, 4);
});
