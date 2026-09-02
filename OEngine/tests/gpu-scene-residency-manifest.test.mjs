import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { createGeometryCookRecipe } = await import(
  "../.test-dist/assets/GeometryCookRecipe.js"
);
const { buildBoxSourceGeometry } = await import(
  "../.test-dist/geometry/BoxGeometry.js"
);
const { cookGeometryAssetPackage } = await import(
  "../.test-dist/geometry/GeometryCooker.js"
);
const { StandardShadeMaterial } = await import(
  "../.test-dist/material/StandardShadeMaterial.js"
);
const {
  SCENE_RESIDENCY_MANIFEST_SCHEMA_VERSION,
  createSceneResidencyManifest
} = await import("../.test-dist/gpu/GpuSceneResidencyManifest.js");
const { visibilityRasterWorkBufferByteLength } = await import(
  "../.test-dist/gpu/GpuVisibilityKeyAbi.js"
);

test("SceneResidencyManifest validates references and freezes exact capacity before GPU mutation", async () => {
  const asset = (await cookGeometryAssetPackage(
    buildBoxSourceGeometry(),
    createGeometryCookRecipe()
  )).asset;
  const source = makeSource(asset);
  const manifest = createSceneResidencyManifest(source, {
    maxBufferSize: 1 << 20,
    maxStorageBufferBindingSize: 1 << 20
  });

  assert.equal(manifest.schemaVersion, SCENE_RESIDENCY_MANIFEST_SCHEMA_VERSION);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.packages), true);
  assert.equal(Object.isFrozen(manifest.totals), true);
  assert.equal(manifest.totals.packageCount, 1);
  assert.equal(manifest.totals.uniquePackageCount, 1);
  assert.equal(manifest.totals.instanceCount, 1);
  assert.ok(manifest.totals.sourceTriangles > 0);
  assert.ok(manifest.totals.maxRasterTriangleCut > 0);

  const requiredBytes = visibilityRasterWorkBufferByteLength(
    manifest.totals.maxRasterTriangleCut
  );
  assert.throws(
    () => createSceneResidencyManifest(source, {
      maxBufferSize: requiredBytes - 1,
      maxStorageBufferBindingSize: requiredBytes - 1
    }),
    /exact RasterWork requires/
  );

  const invalid = { ...source, geometryIndices: new Uint32Array([1]) };
  assert.throws(
    () => createSceneResidencyManifest(invalid, {
      maxBufferSize: 1 << 20,
      maxStorageBufferBindingSize: 1 << 20
    }),
    /outside the package dictionary/
  );
});

test("the reconstruction Gate keeps its baseline conditions and stop budgets machine-readable", async () => {
  const target = JSON.parse(await readFile(new URL(
    "../benchmarks/packed-asset-to-surface-targets.json",
    import.meta.url
  ), "utf8"));
  assert.equal(target.schemaVersion, 1);
  assert.equal(target.conditions.internalWidth, 1921);
  assert.equal(target.conditions.internalHeight, 913);
  assert.equal(target.conditions.ao, false);
  assert.equal(target.conditions.ssr, false);
  assert.equal(target.conditions.temporal, false);
  assert.equal(target.metrics.hierarchyAndExactFilterP50Ms.maximum, 1);
  assert.equal(target.metrics.hardwareVisibilityP50Ms.maximum, 2);
  assert.equal(target.metrics.workGenerationToSurfaceP50Ms.maximum, 8);
  assert.equal(target.metrics.allocatedSceneMemoryMiB.maximum, 450);
});

function makeSource(asset) {
  return {
    geometries: [asset],
    materials: [new StandardShadeMaterial()],
    count: 1,
    geometryIndices: new Uint32Array([0]),
    materialIndices: new Uint32Array([0]),
    currentTransforms: new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]),
    boundsSpheres: new Float32Array([0, 0, 0, 2])
  };
}
