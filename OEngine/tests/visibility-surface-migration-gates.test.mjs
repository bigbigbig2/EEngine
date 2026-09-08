import test from "node:test";
import assert from "node:assert/strict";

const { evaluateSurfaceAbiV2Need, evaluateTileBackendNeed } = await import(
  "../.test-dist/debug/VisibilitySurfaceMigrationGates.js"
);

test("Surface ABI gate keeps v1 without measured savings", () => {
  assert.equal(evaluateSurfaceAbiV2Need({
    baselineBytesPerPixel: 26,
    candidateBytesPerPixel: 26,
    conversionPassesAdded: 0,
    correctnessParity: true,
    independentRuns: 3
  }).status, "rejected-by-evidence");
});

test("tile backend gate requires two vendors over the ten percent trigger", () => {
  const oneVendor = evaluateTileBackendNeed([{
    vendor: "nvidia",
    classDepthP50Ms: 1.2,
    classDepthP95Ms: 1.4,
    tilePrototypeP50Ms: 1,
    tilePrototypeP95Ms: 1.2
  }]);
  assert.equal(oneVendor.status, "insufficient-evidence");
  const below = evaluateTileBackendNeed([
    { vendor: "nvidia", classDepthP50Ms: 1.05, classDepthP95Ms: 1.08, tilePrototypeP50Ms: 1, tilePrototypeP95Ms: 1 },
    { vendor: "amd", classDepthP50Ms: 1.04, classDepthP95Ms: 1.06, tilePrototypeP50Ms: 1, tilePrototypeP95Ms: 1 }
  ]);
  assert.equal(below.status, "not-needed-by-evidence");
  const required = evaluateTileBackendNeed([
    { vendor: "nvidia", classDepthP50Ms: 1.2, classDepthP95Ms: 1.3, tilePrototypeP50Ms: 1, tilePrototypeP95Ms: 1 },
    { vendor: "amd", classDepthP50Ms: 1.15, classDepthP95Ms: 1.25, tilePrototypeP50Ms: 1, tilePrototypeP95Ms: 1 }
  ]);
  assert.equal(required.status, "required");
});
