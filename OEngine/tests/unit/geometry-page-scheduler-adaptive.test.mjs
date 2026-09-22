import assert from "node:assert/strict";
import test from "node:test";

const { GeometryPageSchedulerV1 } = await import("../../.test-dist/gpu/GeometryPageScheduler.js");

test("adaptive scheduler stays within caps and throttles stable high-pressure frames", () => {
  const scheduler = new GeometryPageSchedulerV1({
    maxConcurrentReads: 8,
    maxInFlightBytes: 8 * 1024 * 1024,
    maxUploadBytesPerFrame: 4 * 1024 * 1024,
    minConcurrentReads: 1,
    minInFlightBytes: 262144,
    minUploadBytesPerFrame: 262144
  });
  const cap = scheduler.budget();
  const stable = scheduler.setPressure({ cameraState: "stable", gpuPressure: 0.9, frameTimeMs: 30, targetFrameTimeMs: 16.67, ioThroughputBytesPerSecond: 4 * 1024 * 1024 });
  assert.ok(stable.maxConcurrentReads < cap.maxConcurrentReads);
  assert.ok(stable.maxInFlightBytes < cap.maxInFlightBytes);
  assert.ok(stable.maxUploadBytesPerFrame < cap.maxUploadBytesPerFrame);
  assert.ok(stable.maxConcurrentReads >= 1);
  assert.ok(scheduler.evidence().adaptive.throttledFrames >= 1);
});

test("camera cuts burst to declared caps and do not exceed them", () => {
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 4, maxInFlightBytes: 2 * 1024 * 1024, maxUploadBytesPerFrame: 1024 * 1024 });
  const cap = scheduler.budget();
  const cut = scheduler.setPressure({ cameraState: "cut", gpuPressure: 1, frameTimeMs: 100, targetFrameTimeMs: 16.67 });
  assert.deepEqual(cut, cap);
  assert.equal(scheduler.evidence().adaptive.cameraCutBursts, 1);
});

test("pressure validation rejects invalid values", () => {
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 262144, maxUploadBytesPerFrame: 262144 });
  assert.throws(() => scheduler.setPressure({ gpuPressure: 2 }), /gpuPressure/);
  assert.throws(() => scheduler.setPressure({ frameTimeMs: -1 }), /frame time/);
  assert.throws(() => scheduler.setPressure({ cameraState: "invalid" }), /camera state/);
});
