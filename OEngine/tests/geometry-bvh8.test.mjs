import test from "node:test";
import assert from "node:assert/strict";

import { createGeometryCookRecipe } from "../.test-dist/assets/GeometryCookRecipe.js";
import {
  GEOMETRY_BVH8_NODE_STRIDE,
  GEOMETRY_INVALID_INDEX,
  GEOMETRY_SECTION_TYPES,
  GeometryAssetPackageError,
  encodeGeometryBvh8Nodes,
  openGeometryAssetPackage,
  readGeometryBvh8Node
} from "../.test-dist/assets/GeometryAssetPackage.js";
import {
  openRuntimeAssetPackage,
  writeRuntimeAssetPackage
} from "../.test-dist/assets/RuntimeAssetPackage.js";
import { createSourceGeometry } from "../.test-dist/assets/SourceGeometry.js";
import { buildGeometryBvh8 } from "../.test-dist/geometry/GeometryBvh8.js";
import { cookGeometryAssetPackage } from "../.test-dist/geometry/GeometryCooker.js";

test("R2-B-03 serializes a reachable conservative BVH8 beside the LOD tree", async () => {
  const cooked = await cookGeometryAssetPackage(
    buildGridSourceGeometry(32, 32),
    createGeometryCookRecipe()
  );
  const asset = cooked.asset;
  assert.equal(asset.directory.bvhRoot, 0);
  assert.equal(asset.directory.bvhCount, asset.bvh8Nodes.length);
  assert.equal(cooked.evidence.bvh8NodeCount, asset.bvh8Nodes.length);
  assert.ok(asset.bvh8Nodes.length > 1);

  const clusterOwners = new Uint8Array(asset.clusters.length);
  for (let index = 0; index < asset.bvh8Nodes.length; index++) {
    const node = asset.bvh8Nodes[index];
    assert.ok(node.childCount >= 1 && node.childCount <= 8);
    assert.equal(node.validMask, node.childCount === 8 ? 0xff : (1 << node.childCount) - 1);
    for (let slot = 0; slot < node.childCount; slot++) {
      const ref = node.childRefs[slot];
      if ((node.leafMask & (1 << slot)) !== 0) {
        assert.equal(node.childRangeCounts[slot], 1);
        clusterOwners[ref]++;
        assertBoundsContain(node.childBoundsBox[slot], asset.clusters[ref].boundsBox);
      } else {
        assert.equal(node.childRangeCounts[slot], 0);
        assert.equal(asset.bvh8Nodes[ref].parent, index);
      }
    }
  }
  assert.ok(clusterOwners.every((count) => count === 1));
});

test("R2-B-03 unquantized BVH8 remains conservative for flat, line and point-like bounds", () => {
  const clusters = [
    cluster([0, 0, 0, 4, 4, 0]),
    cluster([-8, 2, 3, 8, 2, 3]),
    cluster([1e-9, 1e9, -1e-9, 1e-9, 1e9, -1e-9]),
    ...Array.from({ length: 18 }, (_, index) =>
      cluster([index, index % 3, -index, index + 0.25, index % 3 + 0.5, -index + 0.125])
    )
  ];
  const built = buildGeometryBvh8(clusters);
  const bytes = encodeGeometryBvh8Nodes(built);
  assert.equal(bytes.byteLength, built.length * GEOMETRY_BVH8_NODE_STRIDE);
  const reopened = Array.from({ length: built.length }, (_, index) =>
    readGeometryBvh8Node(bytes, index)
  );
  const owners = new Uint8Array(clusters.length);
  for (const node of reopened) {
    for (let slot = 0; slot < node.childCount; slot++) {
      if ((node.leafMask & (1 << slot)) === 0) continue;
      const ref = node.childRefs[slot];
      owners[ref]++;
      assertBoundsContain(node.childBoundsBox[slot], clusters[ref].boundsBox);
    }
  }
  assert.ok(owners.every((count) => count === 1));
});

test("R2-B-03 validator rejects a rehashed cycle and non-conservative child bounds", async () => {
  const cooked = await cookGeometryAssetPackage(
    buildGridSourceGeometry(32, 32),
    createGeometryCookRecipe()
  );
  const nodes = cooked.asset.bvh8Nodes;
  const internalNode = nodes.findIndex((node) => node.leafMask !== node.validMask);
  const internalSlot = firstSlot(nodes[internalNode], false);
  const leafNode = nodes.findIndex((node) => node.leafMask !== 0);
  const leafSlot = firstSlot(nodes[leafNode], true);
  const leafCluster = nodes[leafNode].childRefs[leafSlot];

  const corruptions = [
    {
      code: "bvh8-cycle",
      mutate(bytes) {
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          .setUint32(internalNode * GEOMETRY_BVH8_NODE_STRIDE + 32 + internalSlot * 4, internalNode, true);
      }
    },
    {
      code: "bvh8-bounds-containment",
      mutate(bytes) {
        const clusterMinX = cooked.asset.clusters[leafCluster].boundsBox[0];
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          .setFloat32(leafNode * GEOMETRY_BVH8_NODE_STRIDE + 224 + leafSlot * 16, clusterMinX - 1, true);
      }
    }
  ];
  for (const corruption of corruptions) {
    const bytes = await rewriteGeometrySection(
      cooked.bytes,
      GEOMETRY_SECTION_TYPES.Bvh8Nodes,
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

function cluster(boxValues) {
  const box = new Float32Array(boxValues);
  const centerX = 0.5 * (box[0] + box[3]);
  const centerY = 0.5 * (box[1] + box[4]);
  const centerZ = 0.5 * (box[2] + box[5]);
  return {
    childBegin: 0,
    childCount: 0,
    meshletBegin: 0,
    meshletCount: 1,
    parent: GEOMETRY_INVALID_INDEX,
    depth: 0,
    materialId: 0,
    flags: 1,
    geometricError: 0,
    boundsBox: box,
    bounds: {
      centerX,
      centerY,
      centerZ,
      radius: 0.5 * Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2])
    },
    cone: { apexX: 0, apexY: 0, apexZ: 0, axisX: 0, axisY: 1, axisZ: 0, cutoff: 1 }
  };
}

function firstSlot(node, leaf) {
  for (let slot = 0; slot < node.childCount; slot++) {
    if (((node.leafMask & (1 << slot)) !== 0) === leaf) return slot;
  }
  throw new Error("required BVH8 slot not found");
}

function buildGridSourceGeometry(widthSegments, heightSegments) {
  const row = widthSegments + 1;
  const positions = new Float32Array(row * (heightSegments + 1) * 3);
  let vertexOffset = 0;
  for (let y = 0; y <= heightSegments; y++) {
    for (let x = 0; x <= widthSegments; x++) {
      positions[vertexOffset++] = x;
      positions[vertexOffset++] = y;
      positions[vertexOffset++] = Math.sin(x * 0.2) * Math.cos(y * 0.2);
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
    sourceId: `bvh-grid:${widthSegments}:${heightSegments}`,
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
