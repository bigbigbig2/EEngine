import test from "node:test";
import assert from "node:assert/strict";

import {
  computeGeometryMaxCutTriangles,
  computePackedMaxCutTriangles,
  selectGeometryHierarchyInstances
} from "../.test-dist/geometry/GeometryHierarchy.js";

const FRUSTUM = Object.freeze([
  [1, 0, 0, 5],
  [-1, 0, 0, 5],
  [0, 1, 0, 5],
  [0, -1, 0, 5],
  [0, 0, -1, -1],
  [0, 0, 1, 100]
]);

test("R3-A world-space selector applies instance translation and rejects an outside instance", () => {
  const asset = createTwoLevelAsset();
  const result = selectGeometryHierarchyInstances([
    createInstance(asset, 7, translation(0, 0, -10)),
    createInstance(asset, 8, translation(100, 0, -10))
  ], {
    view: perspectiveView(),
    sseThreshold: 20,
    traversalQueueCapacity: 8
  });

  assert.equal(result.candidateInstances, 2);
  assert.equal(result.visibleInstances, 1);
  assert.equal(result.rejectedInstancesFrustum, 1);
  assert.deepEqual(result.rootQueue, {
    capacity: 2,
    written: 1,
    attempted: 1,
    peak: 1,
    overflow: 0,
    fallback: 0
  });
  assert.deepEqual(
    result.selectedClusters.map((record) => [
      record.instanceRecordIndex,
      record.localClusterIndex
    ]),
    [[7, 1], [7, 2]]
  );
  assert.deepEqual(
    result.rasterWork.map((record) => [
      record.meshletRecordIndex,
      record.localTriangleIndex
    ]),
    [[201, 0], [202, 0]]
  );
});

test("R3-A selector treats a single-level package as one virtual resident Cluster", () => {
  const asset = createAsset([], [], 3, [0, 0, 0, 2]);
  const result = selectGeometryHierarchyInstances([
    createInstance(asset, 7, translation(0, 0, -10))
  ], {
    view: perspectiveView(),
    sseThreshold: 20,
    traversalQueueCapacity: 1
  });

  assert.equal(result.visitedClusters, 1);
  assert.deepEqual(result.selectedClusters.map((record) => ({
    instanceRecordIndex: record.instanceRecordIndex,
    clusterRecordIndex: record.clusterRecordIndex,
    localClusterIndex: record.localClusterIndex
  })), [{
    instanceRecordIndex: 7,
    clusterRecordIndex: 100,
    localClusterIndex: 0
  }]);
  assert.deepEqual(
    result.rasterWork.map((record) => record.meshletRecordIndex),
    [200, 201, 202]
  );
  assert.deepEqual(result.traversalRounds, [{
    roundIndex: 0,
    input: 1,
    written: 0,
    attempted: 0,
    peak: 0,
    overflow: 0,
    fallback: 0
  }]);
});

test("R3-A selector uses conservative non-uniform mirrored scale and near-sphere distance", () => {
  const asset = createTwoLevelAsset();
  const mirroredNonUniform = new Float32Array([
    -2, 0, 0, 0,
    0, 3, 0, 0,
    0, 0, 1, 0,
    0, 0, -20, 1
  ]);
  const result = selectGeometryHierarchyInstances([
    createInstance(asset, 9, mirroredNonUniform)
  ], {
    view: perspectiveView(),
    sseThreshold: 50,
    traversalQueueCapacity: 8
  });

  assert.deepEqual(
    result.selectedClusters.map((record) => record.localClusterIndex),
    [1, 2]
  );
  assert.equal(result.capacityFallbacks, 0);
  assert.equal(result.maxDepthReached, 1);
});

test("R3-A selector transforms object-space bounds by instance rotation", () => {
  const asset = createAsset([
    cluster({
      childBegin: 0,
      childCount: 0,
      meshletBegin: 0,
      meshletCount: 1,
      error: 0,
      centerX: 4,
      radius: 0.5,
      depth: 0
    })
  ], [], 1, [4, 0, 0, 0.5]);
  const rotationZ90 = new Float32Array([
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 1, 0,
    0, 0, -10, 1
  ]);
  const narrowXView = {
    ...perspectiveView(),
    frustumPlanes: [
      [1, 0, 0, 1],
      [-1, 0, 0, 1],
      [0, 1, 0, 5],
      [0, -1, 0, 5],
      [0, 0, -1, -1],
      [0, 0, 1, 100]
    ]
  };
  const result = selectGeometryHierarchyInstances([
    createInstance(asset, 17, rotationZ90)
  ], {
    view: narrowXView,
    sseThreshold: 0,
    traversalQueueCapacity: 1
  });
  assert.equal(result.visibleInstances, 1);
  assert.deepEqual(
    result.selectedClusters.map((record) => record.localClusterIndex),
    [0]
  );
});

test("R3-A near-plane crossing fails open and singular transforms fail explicitly", () => {
  const asset = createTwoLevelAsset();
  const nearCrossing = selectGeometryHierarchyInstances([
    createInstance(asset, 15, translation(0, 0, -0.5))
  ], {
    view: perspectiveView(),
    sseThreshold: 20,
    traversalQueueCapacity: 8
  });
  assert.equal(nearCrossing.rejectedInstancesFrustum, 0);
  assert.deepEqual(
    nearCrossing.selectedClusters.map((record) => record.localClusterIndex),
    [1, 2]
  );

  assert.throws(
    () => selectGeometryHierarchyInstances([
      createInstance(asset, 16, new Float32Array([
        0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 1
      ]))
    ], {
      view: perspectiveView(),
      sseThreshold: 20,
      traversalQueueCapacity: 8
    }),
    /three non-zero axes/
  );

  assert.throws(
    () => selectGeometryHierarchyInstances([
      createInstance(asset, 17, new Float32Array([
        1, 0, 0, 0,
        2, 0, 0, 0,
        0, 0, 1, 0,
        0, 0, -10, 1
      ]))
    ], {
      view: perspectiveView(),
      sseThreshold: 20,
      traversalQueueCapacity: 8
    }),
    /non-singular/
  );
});

test("R3-A orthographic SSE is independent of depth", () => {
  const asset = createTwoLevelAsset();
  const result = selectGeometryHierarchyInstances([
    createInstance(asset, 10, translation(-2, 0, -10)),
    createInstance(asset, 11, translation(2, 0, -80))
  ], {
    view: {
      kind: "orthographic",
      cameraPosition: [0, 0, 0],
      verticalWorldSize: 20,
      viewportHeight: 100,
      frustumPlanes: FRUSTUM
    },
    sseThreshold: 20,
    traversalQueueCapacity: 8
  });

  assert.deepEqual(
    result.selectedClusters.map((record) => [
      record.instanceRecordIndex,
      record.localClusterIndex
    ]),
    [[10, 1], [10, 2], [11, 1], [11, 2]]
  );
});

test("R3-A traversal capacity reserves all children or selects the renderable parent", () => {
  const asset = createTwoLevelAsset();
  const result = selectGeometryHierarchyInstances([
    createInstance(asset, 12, translation(0, 0, -10))
  ], {
    view: perspectiveView(),
    sseThreshold: 0,
    traversalQueueCapacity: 1
  });

  assert.deepEqual(
    result.selectedClusters.map((record) => record.localClusterIndex),
    [0]
  );
  assert.deepEqual(
    result.rasterWork.map((record) => record.meshletRecordIndex),
    [200]
  );
  assert.equal(result.capacityFallbacks, 1);
  assert.equal(result.traversalRounds[0].attempted, 2);
  assert.equal(result.traversalRounds[0].written, 0);
  assert.equal(result.traversalRounds[0].overflow, 1);
  assert.equal(result.traversalRounds[0].fallback, 1);
});

test("R3-A root queue overflow is a hard error rather than silent instance loss", () => {
  const asset = createTwoLevelAsset();
  assert.throws(
    () => selectGeometryHierarchyInstances([
      createInstance(asset, 13, translation(-2, 0, -10)),
      createInstance(asset, 14, translation(2, 0, -10))
    ], {
      view: perspectiveView(),
      sseThreshold: 20,
      rootQueueCapacity: 1,
      traversalQueueCapacity: 8
    }),
    /RootTraversal capacity 1 cannot contain 2 visible roots/
  );
});

test("R3-A max-cut capacity bounds every legal hierarchy cut and packed instances", () => {
  const asset = createCapacityAsset();
  assert.equal(computeGeometryMaxCutTriangles(asset), 7);
  assert.equal(computePackedMaxCutTriangles([
    { asset },
    { asset },
    { asset: createTwoLevelAsset() }
  ]), 16);
});

test("R3-A max-cut capacity matches exhaustive legal cuts for fixed random trees", () => {
  for (let seed = 1; seed <= 64; seed++) {
    const generated = createRandomCapacityAsset(seed);
    const legalCuts = enumerateLegalCutMeshletCounts(generated.root);
    assert.equal(
      computeGeometryMaxCutTriangles(generated.asset),
      Math.max(...legalCuts),
      `seed ${seed}`
    );
  }
});

test("R3-A max-cut capacity rejects a hierarchy whose exact triangle cut exceeds u32", () => {
  const asset = createAsset([
    cluster({ childBegin: 0, childCount: 2, meshletBegin: 0, meshletCount: 1, error: 1, radius: 1, depth: 0 }),
    cluster({ childBegin: 2, childCount: 0, meshletBegin: 0, meshletCount: 1, error: 0, radius: 1, depth: 1 }),
    cluster({ childBegin: 2, childCount: 0, meshletBegin: 1, meshletCount: 1, error: 0, radius: 1, depth: 1 })
  ], [1, 2], 2, [0, 0, 0, 1]);
  asset.meshlets[0].triangleCount = 0xffffffff;
  asset.meshlets[1].triangleCount = 0xffffffff;
  assert.throws(
    () => computeGeometryMaxCutTriangles(asset),
    /outside u32/
  );
});

function perspectiveView() {
  return {
    kind: "perspective",
    cameraPosition: [0, 0, 0],
    verticalFovRadians: Math.PI / 2,
    viewportHeight: 100,
    nearPlane: 1,
    frustumPlanes: FRUSTUM
  };
}

function createInstance(asset, instanceRecordIndex, objectToWorld) {
  return {
    asset,
    instanceRecordIndex,
    geometryRecordIndex: 4,
    clusterRecordBegin: 100,
    meshletRecordBegin: 200,
    materialHandle: 300,
    objectToWorld
  };
}

function createTwoLevelAsset() {
  return createAsset([
    cluster({ childBegin: 0, childCount: 2, meshletBegin: 0, meshletCount: 1, error: 10, radius: 4, depth: 0 }),
    cluster({ childBegin: 2, childCount: 0, meshletBegin: 1, meshletCount: 1, error: 0, centerX: -2, radius: 2, depth: 1 }),
    cluster({ childBegin: 2, childCount: 0, meshletBegin: 2, meshletCount: 1, error: 0, centerX: 2, radius: 2, depth: 1 })
  ], [1, 2], 3, [0, 0, 0, 4]);
}

function createCapacityAsset() {
  return createAsset([
    cluster({ childBegin: 0, childCount: 2, meshletBegin: 0, meshletCount: 1, error: 10, radius: 5, depth: 0 }),
    cluster({ childBegin: 2, childCount: 2, meshletBegin: 1, meshletCount: 4, error: 5, centerX: -2, radius: 2, depth: 1 }),
    cluster({ childBegin: 4, childCount: 0, meshletBegin: 5, meshletCount: 3, error: 0, centerX: 2, radius: 2, depth: 1 }),
    cluster({ childBegin: 4, childCount: 0, meshletBegin: 8, meshletCount: 2, error: 0, centerX: -3, radius: 1, depth: 2 }),
    cluster({ childBegin: 4, childCount: 0, meshletBegin: 10, meshletCount: 1, error: 0, centerX: -1, radius: 1, depth: 2 })
  ], [1, 2, 3, 4], 11, [0, 0, 0, 5]);
}

function createAsset(clusters, children, meshletCount, boundsSphere) {
  return {
    directory: {
      clusterRoot: 0,
      clusterCount: clusters.length,
      meshletCount,
      boundsSphere: new Float32Array(boundsSphere)
    },
    clusters,
    clusterChildren: new Uint32Array(children),
    meshlets: Array.from({ length: meshletCount }, () => ({ triangleCount: 1 }))
  };
}

function cluster({
  childBegin,
  childCount,
  meshletBegin,
  meshletCount,
  error,
  centerX = 0,
  centerY = 0,
  centerZ = 0,
  radius,
  depth
}) {
  return {
    childBegin,
    childCount,
    meshletBegin,
    meshletCount,
    parent: 0xffffffff,
    depth,
    materialId: 0,
    flags: 0,
    geometricError: error,
    boundsBox: new Float32Array([
      centerX - radius,
      centerY - radius,
      centerZ - radius,
      centerX + radius,
      centerY + radius,
      centerZ + radius
    ]),
    bounds: { centerX, centerY, centerZ, radius },
    cone: { apexX: 0, apexY: 0, apexZ: 0, axisX: 0, axisY: 0, axisZ: 1, cutoff: 1 }
  };
}

function translation(x, y, z) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1
  ]);
}

function createRandomCapacityAsset(seed) {
  const random = mulberry32(seed);
  const createNode = (depth) => {
    const childCount = depth < 3 && random() < 0.7
      ? 2 + Math.floor(random() * 2)
      : 0;
    const node = {
      meshletCount: 1 + Math.floor(random() * 4),
      children: []
    };
    for (let child = 0; child < childCount; child++) {
      node.children.push(createNode(depth + 1));
    }
    return node;
  };
  const root = createNode(0);
  const nodes = [];
  const assign = (node, depth) => {
    node.index = nodes.length;
    node.depth = depth;
    nodes.push(node);
    for (const child of node.children) assign(child, depth + 1);
  };
  assign(root, 0);
  const children = [];
  let meshletBegin = 0;
  const clusters = nodes.map((node) => {
    const childBegin = children.length;
    for (const child of node.children) children.push(child.index);
    const result = cluster({
      childBegin,
      childCount: node.children.length,
      meshletBegin,
      meshletCount: node.meshletCount,
      error: node.children.length === 0 ? 0 : 1,
      radius: 1,
      depth: node.depth
    });
    meshletBegin += node.meshletCount;
    return result;
  });
  return {
    root,
    asset: createAsset(clusters, children, meshletBegin, [0, 0, 0, 1])
  };
}

function enumerateLegalCutMeshletCounts(node) {
  const counts = [node.meshletCount];
  if (node.children.length === 0) return counts;
  let expanded = [0];
  for (const child of node.children) {
    const childCuts = enumerateLegalCutMeshletCounts(child);
    expanded = expanded.flatMap((sum) => childCuts.map((count) => sum + count));
  }
  return counts.concat(expanded);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}
