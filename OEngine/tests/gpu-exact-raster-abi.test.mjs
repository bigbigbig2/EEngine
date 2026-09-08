import test from "node:test";
import assert from "node:assert/strict";

const {
  GPU_EXACT_RASTER_RECORD_STRIDE,
  GPU_TRIANGLE_SETUP_RECORD_STRIDE,
  GPU_TRIANGLE_SETUP_FALLBACK,
  GPU_EXACT_RASTER_SETUP_FLAGS,
  packExactRasterRecord,
  unpackExactRasterRecord,
  packTriangleSetupRecord,
  unpackTriangleSetupRecord,
  tryBuildTriangleSetup,
  reconstructTriangleSetupBarycentrics
} = await import("../.test-dist/gpu/GpuExactRasterAbi.js");

test("ExactRasterRecord packs the 24-byte RasterWork prefix plus setup handle", () => {
  const record = {
    instanceRecordIndex: 1,
    geometryRecordIndex: 2,
    meshletRecordIndex: 3,
    localTriangleIndex: 4,
    materialHandle: 5,
    rasterFlags: 6,
    setupIndex: GPU_TRIANGLE_SETUP_FALLBACK,
    exactFlags: GPU_EXACT_RASTER_SETUP_FLAGS.nearCrossing
  };
  const bytes = packExactRasterRecord(record);
  assert.equal(GPU_EXACT_RASTER_RECORD_STRIDE, 32);
  assert.equal(bytes.byteLength, 32);
  assert.deepEqual(unpackExactRasterRecord(bytes), record);
});

test("triangle setup is bounded by coverage and fails open for near crossings", () => {
  const large = tryBuildTriangleSetup({
    vertices: [
      { x: -0.8, y: -0.8, z: 0.5, w: 1 },
      { x: 0.8, y: -0.8, z: 0.5, w: 1 },
      { x: -0.8, y: 0.8, z: 0.5, w: 1 }
    ],
    width: 100,
    height: 100,
    coverageThresholdPixels: 32
  });
  assert.equal(large.kind, "cached");
  if (large.kind === "cached") {
    assert.equal(GPU_TRIANGLE_SETUP_RECORD_STRIDE, 40);
    assert.equal(packTriangleSetupRecord(large.record).byteLength, 40);
    const roundTrip = unpackTriangleSetupRecord(packTriangleSetupRecord(large.record));
    for (const name of ["qCenter", "dqDx", "dqDy"]) {
      const values = large.record[name];
      values.forEach((value, index) => assert.ok(Math.abs(value - roundTrip[name][index]) < 1e-5));
    }
    assert.equal(roundTrip.flags, large.record.flags);
  }

  const crossing = tryBuildTriangleSetup({
    vertices: [
      { x: -0.2, y: -0.2, z: -0.1, w: 1 },
      { x: 0.2, y: -0.2, z: 0.5, w: 1 },
      { x: 0, y: 0.2, z: 0.5, w: 1 }
    ],
    width: 100,
    height: 100
  });
  assert.deepEqual(crossing, { kind: "fallback", reason: "near-crossing" });
});

test("triangle setup reconstruction matches affine center weights", () => {
  const result = tryBuildTriangleSetup({
    vertices: [
      { x: -1, y: -1, z: 0.5, w: 1 },
      { x: 1, y: -1, z: 0.5, w: 1 },
      { x: -1, y: 1, z: 0.5, w: 1 }
    ],
    width: 100,
    height: 100,
    coverageThresholdPixels: 0
  });
  assert.equal(result.kind, "cached");
  if (result.kind !== "cached") return;
  const setup = result.record;
  const center = reconstructTriangleSetupBarycentrics(setup, 25, 25, 100, 100);
  assert.ok(Math.abs(center.weights[0] - 0) < 1e-6);
  assert.ok(Math.abs(center.weights[1] - 0.25) < 1e-6);
  assert.ok(Math.abs(center.weights[2] - 0.75) < 1e-6);
  assert.ok(center.ddx.every(Number.isFinite));
  assert.ok(center.ddy.every(Number.isFinite));
});
