import test from "node:test";
import assert from "node:assert/strict";

import {
  BEVY_MESHLET_REFERENCE_COMMIT,
  GEOMETRY_COOK_RECIPE_VERSION,
  MESHOPTIMIZER_COOKER_COMMIT,
  createGeometryCookRecipe,
  geometryCookRecipeKey
} from "../.test-dist/assets/GeometryCookRecipe.js";

test("GeometryCookRecipe freezes upstream versions and deterministic v1 defaults", () => {
  const recipe = createGeometryCookRecipe();

  assert.equal(GEOMETRY_COOK_RECIPE_VERSION, 1);
  assert.equal(MESHOPTIMIZER_COOKER_COMMIT, "73583c335e541c139821d0de2bf5f12960a04941");
  assert.equal(BEVY_MESHLET_REFERENCE_COMMIT, "5f8270f2e049f90139a503d1e930070d926f9427");
  assert.deepEqual(recipe, {
    recipeVersion: 1,
    meshoptimizerCommit: MESHOPTIMIZER_COOKER_COMMIT,
    hierarchyReferenceCommit: BEVY_MESHLET_REFERENCE_COMMIT,
    hierarchyMode: "renderable",
    meshletMaxVertices: 64,
    meshletMaxTriangles: 128,
    coneWeight: 0,
    simplificationTargetRatio: 0.5,
    simplificationErrorMode: "absolute",
    simplificationErrorLimit: 3.4028234663852886e38,
    simplificationFailureRatio: 0.6,
    hierarchyTargetFanout: 8,
    hierarchyMaxDepth: 32,
    bvhBranchingFactor: 8,
    quantizeBvhBounds: false,
    bvhQuantizationBits: 0,
    positionFormat: "float32x3",
    vertexQuantizationBits: 0,
    vertexQuantizationRange: "source-bounds",
    missingAttributePolicy: "preserve-optional",
    degenerateTrianglePolicy: "warn",
    degenerateTriangleThreshold: 1,
    nonManifoldPolicy: "warn",
    nonManifoldEdgeThreshold: 1,
    deterministicSeed: 0,
    floatingPointMode: "ieee754-nearest-no-fast-math"
  });
  assert.equal(
    geometryCookRecipeKey(recipe),
    '{"recipeVersion":1,"meshoptimizerCommit":"73583c335e541c139821d0de2bf5f12960a04941","hierarchyReferenceCommit":"5f8270f2e049f90139a503d1e930070d926f9427","hierarchyMode":"renderable","meshletMaxVertices":64,"meshletMaxTriangles":128,"coneWeight":0,"simplificationTargetRatio":0.5,"simplificationErrorMode":"absolute","simplificationErrorLimit":3.4028234663852886e+38,"simplificationFailureRatio":0.6,"hierarchyTargetFanout":8,"hierarchyMaxDepth":32,"bvhBranchingFactor":8,"quantizeBvhBounds":false,"bvhQuantizationBits":0,"positionFormat":"float32x3","vertexQuantizationBits":0,"vertexQuantizationRange":"source-bounds","missingAttributePolicy":"preserve-optional","degenerateTrianglePolicy":"warn","degenerateTriangleThreshold":1,"nonManifoldPolicy":"warn","nonManifoldEdgeThreshold":1,"deterministicSeed":0,"floatingPointMode":"ieee754-nearest-no-fast-math"}'
  );
  assert.equal(
    geometryCookRecipeKey(createGeometryCookRecipe({ hierarchyMode: "single-level" })),
    geometryCookRecipeKey({ ...recipe, hierarchyMode: "single-level" })
  );
});

test("GeometryCookRecipe validates limits before any external algorithm runs", () => {
  assert.throws(
    () => createGeometryCookRecipe({ meshletMaxVertices: 0 }),
    /meshletMaxVertices/
  );
  assert.throws(
    () => createGeometryCookRecipe({ meshletMaxVertices: 2 }),
    /meshletMaxVertices/
  );
  assert.throws(
    () => createGeometryCookRecipe({ simplificationTargetRatio: 1 }),
    /simplificationTargetRatio/
  );
  assert.throws(
    () => createGeometryCookRecipe({ bvhBranchingFactor: 4 }),
    /bvhBranchingFactor/
  );
  assert.throws(
    () => createGeometryCookRecipe({ deterministicSeed: -1 }),
    /deterministicSeed/
  );
  assert.throws(
    () => createGeometryCookRecipe({ hierarchyTargetFanout: 1 }),
    /hierarchyTargetFanout/
  );
  assert.throws(
    () => createGeometryCookRecipe({ hierarchyMode: "unknown" }),
    /hierarchyMode/
  );
  assert.throws(
    () => createGeometryCookRecipe({ bvhQuantizationBits: 16 }),
    /bvhQuantizationBits/
  );
  assert.throws(
    () => createGeometryCookRecipe({ quantizeBvhBounds: true }),
    /quantizeBvhBounds/
  );
  assert.throws(
    () => createGeometryCookRecipe({ floatingPointMode: "native-fast-math" }),
    /floatingPointMode/
  );
});
