import test from "node:test";
import assert from "node:assert/strict";
import { planSurfaceWorkCapacity } from "../../.test-dist/gpu/GpuSurfaceWorkAbi.js";
const limits = {
  maxBufferSize: 1024 ** 3,
  maxStorageBufferBindingSize: 128 * 1024 ** 2,
  maxTextureDimension2D: 8192,
  maxComputeWorkgroupsPerDimension: 65535
};
test("1080p exports retain actual cross-stage fields while raw normals stay producer-local", () => {
  const plan = planSurfaceWorkCapacity(1920, 1080, limits, 32767, 16 * 1024 ** 2);
  assert.equal(plan.fieldChannels, 16);
  assert.equal(plan.workStrideBytes, 48 + 64 + 24);
  assert.equal(plan.bankRows * 4, 1088);
  assert.equal(plan.heapBytes, 1920 * 272 * (48 + 64 + 24));
  for (const local of [1, 6, 12, 13, 14]) {
    assert.equal(plan.fieldOffsets[local], 0xffffffff, "no closed plane without a later reader");
  }
  assert.equal(
    plan.signalBytes,
    1920 * 272 * (72 + 4),
    "six RGB f32 signals and one explicit state word per sample"
  );
  for (const bytes of [plan.heapBytes, plan.signalBytes, plan.controlBytes])
    assert.ok(bytes <= limits.maxStorageBufferBindingSize);
  assert.ok(plan.scratchBytes < 768 * 1024 ** 2);
});
test("constant/absent fields have no pixel slot; all-unlit has no closed lighting products", () => {
  const plan = planSurfaceWorkCapacity(25, 9, limits, (1 << 0) | (1 << 3), 1024, false);
  assert.equal(plan.fieldChannels, 4);
  assert.equal(plan.fieldOffsets[0], 0);
  assert.equal(plan.fieldOffsets[3], 3);
  assert.equal(plan.fieldOffsets[1], 0xffffffff);
  assert.equal(plan.hotWords, 2);
  assert.equal(plan.guideChannels, 0);
  assert.equal(plan.signalBytes, 16, "legal unused runtime-array binding only; no signal work");
  assert.equal(plan.workStrideBytes, 8 + 12 + 4);
});
test("control reset excludes queue/recipe payload and mandatory resources are independent of optional admission", () => {
  const plan = planSurfaceWorkCapacity(33, 17, limits, 1, 1024);
  assert.equal(plan.tileBase * 4, 2048);
  assert.equal(plan.bankTiles, 5);
  assert.equal(plan.queueBase - plan.tileBase, 4 * 5 * 8);
  assert.equal(plan.recipeBase - plan.queueBase, 4 * 5 * (4 * 2 + 1));
  assert.equal(plan.controlBytes - plan.recipeBase * 4, 4 * 5 * 4 * 4);
  assert.ok(plan.heapBytes >= 33 * 8 * 48);
});
test("invalid or unsupported complete profiles reject before any GPU allocation", () => {
  for (const dimensions of [
    [0, 1080],
    [1920, 0],
    [-1, 9],
    [1.1, 8],
    [8193, 9]
  ])
    assert.throws(() => planSurfaceWorkCapacity(...dimensions, limits, 1, 16), RangeError);
  for (const mask of [-1, 0x8000, 1.5])
    assert.throws(() => planSurfaceWorkCapacity(16, 16, limits, mask, 16), RangeError);
  for (const bytes of [0, 15, 17, 2 ** 32])
    assert.throws(() => planSurfaceWorkCapacity(16, 16, limits, 1, bytes), RangeError);
  assert.throws(
    () =>
      planSurfaceWorkCapacity(
        1920,
        1080,
        { ...limits, maxStorageBufferBindingSize: 32 * 1024 ** 2 },
        32767,
        1024
      ),
    /binding limits/
  );
  assert.throws(
    () => planSurfaceWorkCapacity(1920, 1080, { ...limits, maxComputeWorkgroupsPerDimension: 1 }, 1, 1024),
    /workgroup limits/
  );
});

test("local Geometry completion retains no full-screen UV pool in physical scratch", () => {
  const plan = planSurfaceWorkCapacity(1920, 1080, limits, 32767, 16 * 1024 ** 2, true);
  assert.equal(
    plan.scratchBytes,
    plan.controlBytes + 4 * (plan.heapBytes + plan.signalBytes) + 16 * 1024 ** 2 + 8192
  );
  assert.ok(plan.scratchBytes < 768 * 1024 ** 2);
});

test("NPOT mandatory destinations cover each real sample once across disjoint banks", () => {
  for (const [width, height] of [
    [1, 1],
    [17, 9],
    [33, 17],
    [1920, 1080]
  ]) {
    const plan = planSurfaceWorkCapacity(width, height, limits, 32767, 1024);
    assert.equal(plan.bankRows % 8, 0);
    assert.ok(plan.bankRows * 4 >= height);
    assert.ok(plan.bankRows * 4 - height < 32);
    assert.ok(plan.bankPixels >= width * plan.bankRows);
    assert.ok(plan.bankTiles * 64 >= plan.bankPixels);
    assert.equal(plan.heapBytes, plan.bankPixels * plan.workStrideBytes);
  }
});
