import test from "node:test";
import assert from "node:assert/strict";

import { createGeometryCookRecipe } from "../.test-dist/assets/GeometryCookRecipe.js";
import {
  GEOMETRY_CLUSTER_RECORD_STRIDE,
  GEOMETRY_DIRECTORY_FLAGS,
  GEOMETRY_INVALID_INDEX,
  GEOMETRY_SECTION_TYPES,
  GeometryAssetPackageError,
  openGeometryAssetPackage
} from "../.test-dist/assets/GeometryAssetPackage.js";
import {
  openRuntimeAssetPackage,
  writeRuntimeAssetPackage
} from "../.test-dist/assets/RuntimeAssetPackage.js";
import { createSourceGeometry } from "../.test-dist/assets/SourceGeometry.js";
import { cookGeometryAssetPackage } from "../.test-dist/geometry/GeometryCooker.js";
import {
  projectedGeometryErrorPixels,
  selectGeometryHierarchy
} from "../.test-dist/geometry/GeometryHierarchy.js";

test("R2-B-02 cooks a strict renderable hierarchy with monotonic error", async () => {
  const cooked = await cookGeometryAssetPackage(
    buildGridSourceGeometry(32, 32),
    createGeometryCookRecipe()
  );
  const asset = await openGeometryAssetPackage(cooked.bytes);

  assert.equal(asset.directory.clusterRoot, 0);
  assert.equal(asset.directory.clusterCount, asset.clusters.length);
  assert.equal(asset.directory.flags & GEOMETRY_DIRECTORY_FLAGS.NoHierarchy, 0);
  assert.ok(cooked.evidence.leafMeshletCount > 8);
  assert.ok(cooked.evidence.parentMeshletCount > 0);
  assert.ok(cooked.evidence.clusterCount > cooked.evidence.leafMeshletCount);
  assert.ok(cooked.evidence.hierarchyDepth >= 2);

  const root = asset.clusters[asset.directory.clusterRoot];
  assert.equal(root.parent, GEOMETRY_INVALID_INDEX);
  assert.ok(root.childCount > 0);
  assert.ok(root.meshletCount > 0, "root must have a conservative raster fallback");
  for (let index = 0; index < asset.clusters.length; index++) {
    const cluster = asset.clusters[index];
    assert.ok(Number.isFinite(cluster.geometricError));
    assert.ok(cluster.geometricError >= 0);
    if (cluster.childCount === 0) {
      assert.equal(cluster.geometricError, 0);
      continue;
    }
    const children = asset.clusterChildren.subarray(
      cluster.childBegin,
      cluster.childBegin + cluster.childCount
    );
    for (const childIndex of children) {
      const child = asset.clusters[childIndex];
      assert.equal(child.parent, index);
      assert.equal(child.depth, cluster.depth + 1);
      assert.ok(child.geometricError <= cluster.geometricError);
      assertBoundsContain(cluster.boundsBox, child.boundsBox);
      assertSphereContains(cluster.bounds, child.bounds);
    }
  }
});

test("R2-B-02 CPU selector is parent/child exclusive and capacity-safe", async () => {
  const asset = (await cookGeometryAssetPackage(
    buildGridSourceGeometry(32, 32),
    createGeometryCookRecipe()
  )).asset;
  const camera = {
    cameraPosition: [16, 16, 48],
    verticalFovRadians: Math.PI / 3,
    viewportHeight: 1080,
    maxAxisScale: 1
  };

  const coarse = selectGeometryHierarchy(asset, {
    ...camera,
    sseThreshold: Number.MAX_VALUE
  });
  assert.deepEqual(coarse.selectedClusterIndices, [asset.directory.clusterRoot]);
  assert.equal(coarse.capacityFallbacks, 0);

  const fine = selectGeometryHierarchy(asset, {
    ...camera,
    sseThreshold: 0
  });
  assert.ok(fine.selectedClusterIndices.length > 1);
  assert.ok(fine.selectedClusterIndices.every(
    (index) => asset.clusters[index].childCount === 0
  ));
  assert.equal(new Set(fine.selectedMeshletIndices).size, fine.selectedMeshletIndices.length);
  assert.equal(fine.capacityFallbacks, 0);

  const limited = selectGeometryHierarchy(asset, {
    ...camera,
    sseThreshold: 0,
    maxVisitedClusters: 1
  });
  assert.deepEqual(limited.selectedClusterIndices, [asset.directory.clusterRoot]);
  assert.equal(limited.capacityFallbacks, 1);
  assert.ok(projectedGeometryErrorPixels(asset.clusters[0], camera) > 0);

  const partiallyLimited = selectGeometryHierarchy(asset, {
    ...camera,
    sseThreshold: 0,
    maxVisitedClusters: 5
  });
  assert.ok(partiallyLimited.visitedClusters <= 5);
  assert.ok(partiallyLimited.capacityFallbacks > 0);
});

test("R2-B-02 validator rejects rehashed cycle, orphan and non-monotonic error", async () => {
  const cooked = await cookGeometryAssetPackage(
    buildGridSourceGeometry(32, 32),
    createGeometryCookRecipe()
  );
  const asset = cooked.asset;
  const firstChild = asset.clusterChildren[0];

  const cases = [
    {
      type: GEOMETRY_SECTION_TYPES.ClusterChildren,
      code: "cluster-cycle",
      mutate: (bytes) => new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).setUint32(0, 0, true)
    },
    {
      type: GEOMETRY_SECTION_TYPES.ClusterRecords,
      code: "cluster-parent",
      mutate: (bytes) => new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).setUint32(firstChild * GEOMETRY_CLUSTER_RECORD_STRIDE + 16, GEOMETRY_INVALID_INDEX, true)
    },
    {
      type: GEOMETRY_SECTION_TYPES.ClusterRecords,
      code: "cluster-error-monotonic",
      mutate: (bytes) => new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).setFloat32(32, 0, true)
    }
  ];
  for (const corruption of cases) {
    const bytes = await rewriteGeometrySection(
      cooked.bytes,
      corruption.type,
      corruption.mutate
    );
    await assert.rejects(
      () => openGeometryAssetPackage(bytes),
      (error) => error instanceof GeometryAssetPackageError &&
        error.report.issues.some((issue) => issue.code === corruption.code),
      corruption.code
    );
  }
});

function buildGridSourceGeometry(widthSegments, heightSegments) {
  const row = widthSegments + 1;
  const positions = new Float32Array(row * (heightSegments + 1) * 3);
  let vertexOffset = 0;
  for (let y = 0; y <= heightSegments; y++) {
    for (let x = 0; x <= widthSegments; x++) {
      positions[vertexOffset++] = x;
      positions[vertexOffset++] = y;
      positions[vertexOffset++] = 0;
    }
  }
  const indices = new Uint32Array(widthSegments * heightSegments * 6);
  let indexOffset = 0;
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * row + x;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices[indexOffset++] = a;
      indices[indexOffset++] = b;
      indices[indexOffset++] = c;
      indices[indexOffset++] = c;
      indices[indexOffset++] = b;
      indices[indexOffset++] = d;
    }
  }
  return createSourceGeometry({
    sourceId: `hierarchy-grid:${widthSegments}:${heightSegments}`,
    indices,
    attributes: [{ semantic: "position", componentCount: 3, data: positions }]
  });
}

function assertBoundsContain(parent, child) {
  const epsilon = 1e-5;
  assert.ok(parent[0] <= child[0] + epsilon);
  assert.ok(parent[1] <= child[1] + epsilon);
  assert.ok(parent[2] <= child[2] + epsilon);
  assert.ok(parent[3] + epsilon >= child[3]);
  assert.ok(parent[4] + epsilon >= child[4]);
  assert.ok(parent[5] + epsilon >= child[5]);
}

function assertSphereContains(parent, child) {
  const distance = Math.hypot(
    parent.centerX - child.centerX,
    parent.centerY - child.centerY,
    parent.centerZ - child.centerZ
  );
  assert.ok(distance + child.radius <= parent.radius + 1e-4);
}

async function rewriteGeometrySection(packageBytes, type, mutate) {
  const generic = await openRuntimeAssetPackage(packageBytes, {
    supportedSectionTypes: new Set(Object.values(GEOMETRY_SECTION_TYPES))
  });
  const sections = generic.sections.map((section) => {
    const data = section.bytes.slice();
    if (section.type === type) mutate(data);
    return {
      type: section.type,
      required: section.required,
      data,
      elementStride: section.elementStride,
      elementCount: section.elementCount,
      alignment: section.alignment
    };
  });
  return writeRuntimeAssetPackage({ sections });
}
