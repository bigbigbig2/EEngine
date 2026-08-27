import test from "node:test";
import assert from "node:assert/strict";

import { createGeometryCookRecipe } from "../.test-dist/assets/GeometryCookRecipe.js";
import {
  GEOMETRY_DIRECTORY_RECORD_STRIDE,
  GEOMETRY_MESHLET_RECORD_STRIDE,
  GEOMETRY_SECTION_TYPES,
  GeometryAssetPackageError,
  openGeometryAssetPackage
} from "../.test-dist/assets/GeometryAssetPackage.js";
import {
  openRuntimeAssetPackage,
  writeRuntimeAssetPackage
} from "../.test-dist/assets/RuntimeAssetPackage.js";
import { createSourceGeometry } from "../.test-dist/assets/SourceGeometry.js";
import { buildBoxSourceGeometry } from "../.test-dist/geometry/BoxGeometry.js";
import { cookGeometryAssetPackage } from "../.test-dist/geometry/GeometryCooker.js";

test("R2-B-01 cooks deterministic meshoptimizer Meshlet sections and reopens them", async () => {
  const source = buildBoxSourceGeometry(2, 4, 6);
  const recipe = createGeometryCookRecipe({ hierarchyMode: "single-level" });
  const first = await cookGeometryAssetPackage(source, recipe);
  const second = await cookGeometryAssetPackage(source, recipe);

  assert.deepEqual(new Uint8Array(first.bytes), new Uint8Array(second.bytes));
  assert.deepEqual(first.evidence, second.evidence);
  assert.equal(first.evidence.sourceVertexCount, 24);
  assert.equal(first.evidence.sourceTriangleCount, 12);
  assert.ok(first.evidence.meshletCount > 0);
  assert.equal(first.evidence.meshletTriangleCount, 12);
  assert.ok(first.evidence.meshletCount < 12);

  const asset = await openGeometryAssetPackage(first.bytes);
  assert.equal(asset.directory.vertexCount, 24);
  assert.equal(asset.directory.sourceTriangleCount, 12);
  assert.equal(asset.directory.meshletCount, first.evidence.meshletCount);
  assert.equal(asset.directory.maxMeshletVertices, 64);
  assert.equal(asset.directory.maxMeshletTriangles, 128);
  assert.equal(asset.package.section(GEOMETRY_SECTION_TYPES.GeometryDirectory).elementStride, GEOMETRY_DIRECTORY_RECORD_STRIDE);
  assert.equal(asset.package.section(GEOMETRY_SECTION_TYPES.MeshletRecords).elementStride, GEOMETRY_MESHLET_RECORD_STRIDE);

  for (const meshlet of asset.meshlets) {
    assert.ok(meshlet.vertexCount > 0 && meshlet.vertexCount <= 64);
    assert.ok(meshlet.triangleCount > 0 && meshlet.triangleCount <= 128);
    assert.ok(Number.isFinite(meshlet.bounds.radius) && meshlet.bounds.radius >= 0);
    const vertices = asset.meshletVertexIndices.subarray(
      meshlet.vertexOffset,
      meshlet.vertexOffset + meshlet.vertexCount
    );
    for (const vertex of vertices) {
      const position = source.attributes.get("position").data;
      const distance = Math.hypot(
        position[vertex * 3] - meshlet.bounds.centerX,
        position[vertex * 3 + 1] - meshlet.bounds.centerY,
        position[vertex * 3 + 2] - meshlet.bounds.centerZ
      );
      assert.ok(distance <= meshlet.bounds.radius, `Meshlet sphere misses vertex ${vertex}`);
    }
  }
  assert.deepEqual(
    canonicalTriangles(expandMeshletTriangles(asset)),
    canonicalTriangles(source.indices)
  );
});

test("R2-B-01 freezes 32/64, 64/64 and 64/128 offline variants", async () => {
  const source = buildGridSourceGeometry(16, 16);
  const variants = {
    "32/64": createGeometryCookRecipe({
      hierarchyMode: "single-level",
      meshletMaxVertices: 32,
      meshletMaxTriangles: 64
    }),
    "64/64": createGeometryCookRecipe({
      hierarchyMode: "single-level",
      meshletMaxVertices: 64,
      meshletMaxTriangles: 64
    }),
    "64/128": createGeometryCookRecipe({
      hierarchyMode: "single-level",
      meshletMaxVertices: 64,
      meshletMaxTriangles: 128
    })
  };
  const actual = {};
  for (const [name, recipe] of Object.entries(variants)) {
    const cooked = await cookGeometryAssetPackage(source, recipe);
    actual[name] = {
      meshletCount: cooked.evidence.meshletCount,
      vertexIndexCount: cooked.evidence.meshletVertexIndexCount,
      triangleCount: cooked.evidence.meshletTriangleCount,
      packageBytes: cooked.evidence.packageBytes,
      contentHash: cooked.evidence.contentHash
    };
  }
  assert.deepEqual(actual, {
    "32/64": {
      meshletCount: 13,
      vertexIndexCount: 393,
      triangleCount: 512,
      packageBytes: 5056,
      contentHash: "b4571b2f54857249299ee06805fd147fec5573ba2ab705877cd5f556dcabe065"
    },
    "64/64": {
      meshletCount: 8,
      vertexIndexCount: 375,
      triangleCount: 512,
      packageBytes: 4416,
      contentHash: "b1cdd425d9422d6364e1a88a5dbc32931b451a4463597d3500633df7491c5d83"
    },
    "64/128": {
      meshletCount: 6,
      vertexIndexCount: 342,
      triangleCount: 512,
      packageBytes: 4064,
      contentHash: "cb63d50124f7d2e9f14b173eba6409326c585dac62378095775a2ad9b0aa32ca"
    }
  });
});

test("R2-B-01 never merges incompatible material boundaries", async () => {
  const source = createSourceGeometry({
    sourceId: "two-material-quad",
    indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
    attributes: [{
      semantic: "position",
      componentCount: 3,
      data: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        1, 1, 0
      ])
    }],
    materialRanges: [
      {
        firstTriangle: 0,
        triangleCount: 1,
        materialId: 7,
        alphaMode: "opaque",
        doubleSided: false
      },
      {
        firstTriangle: 1,
        triangleCount: 1,
        materialId: 9,
        alphaMode: "mask",
        doubleSided: true
      }
    ]
  });
  const cooked = await cookGeometryAssetPackage(
    source,
    createGeometryCookRecipe({ hierarchyMode: "single-level" })
  );
  const asset = await openGeometryAssetPackage(cooked.bytes);

  assert.equal(asset.meshlets.length, 2);
  assert.deepEqual(asset.meshlets.map((meshlet) => meshlet.materialId), [7, 9]);
  assert.equal(asset.meshlets[0].alphaMode, "opaque");
  assert.equal(asset.meshlets[0].doubleSided, false);
  assert.equal(asset.meshlets[1].alphaMode, "mask");
  assert.equal(asset.meshlets[1].doubleSided, true);
  assert.deepEqual(
    canonicalTriangles(expandMeshletTriangles(asset)),
    canonicalTriangles(source.indices)
  );
});

test("R2-B-01 applies degenerate policy before external Meshlet output is accepted", async () => {
  const source = createSourceGeometry({
    sourceId: "degenerate-policy",
    indices: new Uint32Array([0, 0, 1]),
    attributes: [{
      semantic: "position",
      componentCount: 3,
      data: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0
      ])
    }]
  });

  const warned = await cookGeometryAssetPackage(
    source,
    createGeometryCookRecipe({
      hierarchyMode: "single-level",
      degenerateTrianglePolicy: "warn"
    })
  );
  assert.ok(warned.evidence.warnings.includes("degenerate-triangles:1"));
  assert.equal(warned.evidence.meshletTriangleCount, 1);

  await assert.rejects(
    () => cookGeometryAssetPackage(
      source,
      createGeometryCookRecipe({
        hierarchyMode: "single-level",
        degenerateTrianglePolicy: "reject"
      })
    ),
    /recipe rejects/
  );
});

test("R2-B-01 geometry validator rejects validly rehashed Meshlet cross-reference corruption", async () => {
  const cooked = await cookGeometryAssetPackage(
    buildBoxSourceGeometry(),
    createGeometryCookRecipe({ hierarchyMode: "single-level" })
  );
  const generic = await openRuntimeAssetPackage(cooked.bytes, {
    supportedSectionTypes: new Set(Object.values(GEOMETRY_SECTION_TYPES))
  });
  const sections = generic.sections.map((section) => ({
    type: section.type,
    required: section.required,
    data: section.bytes,
    elementStride: section.elementStride,
    elementCount: section.elementCount,
    alignment: section.alignment
  }));
  const meshletRecords = sections.find(
    (section) => section.type === GEOMETRY_SECTION_TYPES.MeshletRecords
  );
  meshletRecords.data = meshletRecords.data.slice();
  new DataView(
    meshletRecords.data.buffer,
    meshletRecords.data.byteOffset,
    meshletRecords.data.byteLength
  ).setUint32(4, 65, true);
  const corrupted = await writeRuntimeAssetPackage({ sections });

  await assert.rejects(
    () => openGeometryAssetPackage(corrupted),
    (error) => error instanceof GeometryAssetPackageError &&
      error.report.issues.some((issue) => issue.code === "meshlet-vertex-limit")
  );

  const invalidStride = await rewriteGeometrySectionDescriptor(
    cooked.bytes,
    GEOMETRY_SECTION_TYPES.MeshletRecords,
    (section) => {
      section.elementStride = GEOMETRY_MESHLET_RECORD_STRIDE / 2;
      section.elementCount *= 2;
    }
  );
  await assert.rejects(
    () => openGeometryAssetPackage(invalidStride),
    (error) => error instanceof GeometryAssetPackageError &&
      error.report.issues.some((issue) => issue.code === "geometry-section-stride")
  );

  const invalidDirectoryCount = await rewriteGeometrySectionDescriptor(
    cooked.bytes,
    GEOMETRY_SECTION_TYPES.GeometryDirectory,
    (section) => {
      const duplicated = new Uint8Array(section.data.byteLength * 2);
      duplicated.set(section.data, 0);
      duplicated.set(section.data, section.data.byteLength);
      section.data = duplicated;
      section.elementCount = 2;
    }
  );
  await assert.rejects(
    () => openGeometryAssetPackage(invalidDirectoryCount),
    (error) => error instanceof GeometryAssetPackageError &&
      error.report.issues.some((issue) => issue.code === "geometry-directory-count")
  );

  const cases = [
    {
      type: GEOMETRY_SECTION_TYPES.MeshletTriangleIndices,
      code: "meshlet-local-index",
      mutate: (bytes) => { bytes[0] = 255; }
    },
    {
      type: GEOMETRY_SECTION_TYPES.MeshletVertexIndices,
      code: "meshlet-global-index",
      mutate: (bytes) => new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).setUint32(0, 24, true)
    },
    {
      type: GEOMETRY_SECTION_TYPES.MeshletRecords,
      code: "meshlet-record-reserved",
      mutate: (bytes) => { bytes[28] = 1; }
    },
    {
      type: GEOMETRY_SECTION_TYPES.MeshletRecords,
      code: "meshlet-cone",
      mutate: (bytes) => new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).setFloat32(108, 2, true)
    },
    {
      type: GEOMETRY_SECTION_TYPES.GeometryDirectory,
      code: "geometry-identity-missing",
      mutate: (bytes) => bytes.fill(0, 120, 152)
    }
  ];
  for (const corruption of cases) {
    const rehashed = await rewriteGeometrySection(
      cooked.bytes,
      corruption.type,
      corruption.mutate
    );
    await assert.rejects(
      () => openGeometryAssetPackage(rehashed),
      (error) => error instanceof GeometryAssetPackageError &&
        error.report.issues.some((issue) => issue.code === corruption.code),
      corruption.code
    );
  }
});

function expandMeshletTriangles(asset) {
  const output = [];
  for (const meshlet of asset.meshlets) {
    const vertices = asset.meshletVertexIndices.subarray(
      meshlet.vertexOffset,
      meshlet.vertexOffset + meshlet.vertexCount
    );
    const triangles = asset.meshletTriangleIndices.subarray(
      meshlet.triangleOffset,
      meshlet.triangleOffset + meshlet.triangleCount * 3
    );
    for (const localIndex of triangles) output.push(vertices[localIndex]);
  }
  return new Uint32Array(output);
}

function canonicalTriangles(indices) {
  const triangles = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = [indices[offset], indices[offset + 1], indices[offset + 2]];
    const minimum = Math.min(...triangle);
    while (triangle[0] !== minimum) triangle.push(triangle.shift());
    triangles.push(triangle.join(","));
  }
  return triangles.sort();
}

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
    sourceId: `grid:${widthSegments}:${heightSegments}`,
    indices,
    attributes: [{
      semantic: "position",
      componentCount: 3,
      data: positions
    }]
  });
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

async function rewriteGeometrySectionDescriptor(packageBytes, type, mutate) {
  const generic = await openRuntimeAssetPackage(packageBytes, {
    supportedSectionTypes: new Set(Object.values(GEOMETRY_SECTION_TYPES))
  });
  const sections = generic.sections.map((section) => ({
    type: section.type,
    required: section.required,
    data: section.bytes.slice(),
    elementStride: section.elementStride,
    elementCount: section.elementCount,
    alignment: section.alignment
  }));
  const target = sections.find((section) => section.type === type);
  assert.ok(target, `Missing section ${type}`);
  mutate(target);
  return writeRuntimeAssetPackage({ sections });
}
