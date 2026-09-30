import assert from "node:assert/strict";
import test from "node:test";
import { surfaceLightingRateReference } from "../../.test-dist/render/surface/SurfaceProbe.js";
import { surfaceCellSamples, surfaceSampleCapacity, surfaceSampleDispatch,
  surfaceTileReservationReference, packSurfaceSampleHeader } from "../../.test-dist/render/surface/SurfaceSampleAbi.js";
const limits = { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024,
  maxTextureDimension2D: 8192, maxComputeWorkgroupsPerDimension: 65535 };
test("directional lighting profile rejects current unknown or high-frequency inputs", () => {
  const budget = { color: 0, parameter: 0, normal: 0, depth: 0, uv: 0,
    lightingPosition: 0.2, lightingView: 0.1, minimumRoughness: 0.8 };
  const risk = { shadow: false, environment: false, punctualLights: 0, roughness: 1, ormTexture: false,
    positions: [[0, 0, 1], [0.1, 0, 1], [0, 0.1, 1], [0.1, 0.1, 1]],
    viewDirections: Array(4).fill([0, 0, 1]), ao: [255, 255, 255, 255] };
  assert.equal(surfaceLightingRateReference(3, budget, risk), 3);
  for (const failure of [{ shadow: true }, { environment: true }, { punctualLights: 1 },
    { roughness: 0.1 }, { roughness: NaN }, { ormTexture: true }, { ao: [1, 1, 0, 1] },
    { positions: Array(4).fill([NaN, 0, 1]) }]) {
    assert.equal(surfaceLightingRateReference(3, budget, { ...risk, ...failure }), 0);
  }
  const directional = { ...risk, positions: [[0, 0, 1], [0.1, 0, 1], [0, 1, 1], [0.1, 1, 1]] };
  assert.equal(surfaceLightingRateReference(3, budget, directional), 1);
});
test("every directional cell rate partitions the tile exactly once", () => {
  for (const rate of [0, 1, 2, 3]) {
    const coverage = new Uint8Array(64);
    let count = 0;
    for (let cell = 0; cell < 16; cell++) {
      for (const sample of surfaceCellSamples(rate, cell)) {
        count++;
        assert.notEqual((sample.low | sample.high) >>> 0, 0);
        for (let pixel = 0; pixel < 64; pixel++) {
          if (((pixel < 32 ? sample.low : sample.high) >>> (pixel % 32)) & 1) coverage[pixel]++;
        }
      }
    }
    assert.deepEqual([...coverage], Array(64).fill(1));
    assert.equal(count, [64, 32, 32, 16][rate]);
  }
});
test("multi-pool reservation commits the entire tile or none, including partial waste", () => {
  const first = surfaceTileReservationReference(20, 8, { records: 0, results: 0 }, { records: 64, results: 4 });
  assert.equal(first.committed, false);
  assert.deepEqual(first.attempted, { records: 20, results: 8 });
  const next = surfaceTileReservationReference(40, 0, first.attempted, { records: 64, results: 4 });
  assert.equal(next.committed, true);
  assert.equal(surfaceTileReservationReference(0, 0, { records: 0, results: 0 }, { records: 0, results: 0 }).committed, true);
  assert.equal(surfaceTileReservationReference(65, 0, { records: 0, results: 0 }, { records: 64, results: 64 }).committed, false);
});
test("capacity negotiates every fixed/pool allocation and legal two-dimensional indirect", () => {
  const capacity = surfaceSampleCapacity(1919, 1079, limits);
  assert.equal(capacity.tileCount, 240 * 135);
  assert.ok(capacity.workBytes <= limits.maxStorageBufferBindingSize);
  assert.equal(packSurfaceSampleHeader(capacity)[9], capacity.recordBase);
  assert.deepEqual(surfaceSampleDispatch(0, 3), [0, 0, 1]);
  assert.deepEqual(surfaceSampleDispatch(8, 3), [3, 3, 1]);
  assert.throws(() => surfaceSampleDispatch(10, 3), /invalid/);
  assert.throws(() => surfaceSampleCapacity(8, 8, { ...limits, maxStorageBufferBindingSize: 16 }), /tile states/);
  assert.throws(() => surfaceSampleCapacity(0, 8, limits), /extent/);
  const empty = surfaceSampleCapacity(9, 7, limits, { records: 0, results: 0 });
  assert.equal(empty.tileCount, 2); assert.equal(empty.resultHeight, 1);
});
