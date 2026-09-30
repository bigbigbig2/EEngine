import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  encodeWebCanonicalGeometryV1,
  encodeWebGeometryCookRecipeV1,
  beginWebGeometryCookWasmBuilderV1,
  cookWebGeometryWasmV1,
  planWebGeometryWasmV1,
  WEB_GEOMETRY_COOKER_ABI_VERSION,
  WEB_GEOMETRY_COOK_PAGE_PENDING,
  WEB_GEOMETRY_COOK_PAGE_READY,
  WEB_GEOMETRY_COOK_PAGE_UNDECLARED
} = await import("../../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js");
const Module = (await import("../../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.mjs")).default;

async function loadArtifact() {
  const wasm = await readFile(new URL("../../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.wasm", import.meta.url));
  return Module({
    instantiateWasm(info, receive) {
      WebAssembly.instantiate(wasm, info).then(result => receive(result.instance));
      return {};
    }
  });
}

function triangleCanonical(materialId = 0, xOffset = 0) {
  const vertices = Float32Array.from([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ]);
  for (let vertex = 0; vertex < 3; vertex++) vertices[vertex * 18] += xOffset;
  return encodeWebCanonicalGeometryV1([{
    materialId,
    meshletFlags: 1,
    attributeMask: 1,
    generateNormals: true,
    vertices,
    indices: Uint32Array.from([0, 1, 2])
  }]);
}

// Faceted boxes: each triangle has independent corner records, including
// duplicate wedges that match the position representative's attributes.
function hardSeamBoxesCanonical() {
  const values = [], indices = [];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
  ];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let box = 0; box < 16; box++) {
    for (const [normal, u, v] of faces) {
      for (const corner of [0, 1, 2, 0, 2, 3]) {
        const [s, t] = corners[corner];
        const position = normal.map((n, axis) => n + u[axis] * s + v[axis] * t +
          (axis === 0 ? (box % 4) * 3 : axis === 2 ? Math.floor(box / 4) * 3 : 0));
        indices.push(indices.length);
        values.push(...position, ...normal, 1, 0, 0, 1, (s + 1) / 2, (t + 1) / 2, 0, 0, 1, 1, 1, 1);
      }
    }
  }
  return encodeWebCanonicalGeometryV1([{ materialId: 0, meshletFlags: 1,
    attributeMask: 11, generateNormals: false,
    vertices: Float32Array.from(values), indices: Uint32Array.from(indices) }]);
}

test("coarse LOD reduces real geometry while preserving corner attributes", async () => {
  const { decodeGroupHeaderV3, decodeMeshletHeaderV3 } = await import("../../.test-dist/assets/GeometryAbiV3.js");
  const module = await loadArtifact();
  const fixtures = [{ name: "duplicated box wedges", canonical: hardSeamBoxesCanonical(), minimumAlignment: 0.999, minimumCorners: 16 * 12 * 3, requireCoarse: false }];
  // Real counterexample: locking only coincident wedges still lets Sloppy
  // reconnect nearby window-wall faces to the opposite side.
  globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });
  const { openGlbRangeSource } = await import("../../.test-dist/loaders/gltf/streaming/GlbRangeSource.js");
  const { buildGlbSceneCatalog } = await import("../../.test-dist/loaders/gltf/streaming/GlbSceneCatalog.js");
  const { canonicalizeGlbPrimitiveV1 } = await import("../../.test-dist/assets/web-cook/gltf/GlbPrimitiveCanonicalizer.js");
  const glb = new Uint8Array(await readFile(new URL("../../../examples/assets/three/rendering-lab/dungeon_warkarma.glb", import.meta.url)));
  const source = await openGlbRangeSource("https://fixture.test/dungeon.glb", { fetch: async () => new Response(glb.slice().buffer, { status: 200 }) });
  try {
    const catalog = buildGlbSceneCatalog(source);
    for (const meshIndex of [0, 1, 2, 5, 10, 11]) {
      const unit = catalog.primitives.find(primitive => primitive.meshIndex === meshIndex);
      const domain = await canonicalizeGlbPrimitiveV1(unit, { readRange: r => source.readBufferRange(r.bufferIndex, r.byteOffset, r.byteLength) });
      fixtures.push({ name: `Dungeon mesh ${meshIndex}`, canonical: encodeWebCanonicalGeometryV1([domain]), minimumAlignment: 0.9, minimumCorners: domain.indices.length, requireCoarse: false });
    }
  } finally { source.release(); }
  const normalize = value => { const length = Math.hypot(...value); return value.map(x => x / length); };
  const subtract = (a, b) => a.map((x, i) => x - b[i]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  for (const fixture of fixtures) for (const simplifyPermissive of [true, false]) {
    const result = cookWebGeometryWasmV1(module, fixture.canonical,
      encodeWebGeometryCookRecipeV1({ simplifyPermissive, simplifyWithUpdate: true }), 16 * 262144);
    try {
      const sections = result.descriptorSections();
      const directory = new DataView(sections.groupDirectory.buffer, sections.groupDirectory.byteOffset, sections.groupDirectory.byteLength);
      const formats = new DataView(sections.vertexFormats.buffer, sections.vertexFormats.byteOffset, sections.vertexFormats.byteLength);
      let cornersChecked = 0;
      const levels = new Map();
      for (let g = 0; g < directory.byteLength / 16; g++) {
        const page = result.copyPage(directory.getUint32(g * 16, true));
        const group = new DataView(page, directory.getUint32(g * 16 + 4, true), directory.getUint32(g * 16 + 8, true));
        const header = decodeGroupHeaderV3(group), format = header.vertexFormatId * 16;
        const level = levels.get(header.lodLevel) ?? { triangles: 0, meshlets: 0 };
        level.meshlets += header.meshletCount;
        levels.set(header.lodLevel, level);
        const stride = formats.getUint16(format, true), positionOffset = formats.getUint8(format + 4), normalOffset = formats.getUint8(format + 5);
        for (let m = 0; m < header.meshletCount; m++) {
          const meshlet = decodeMeshletHeaderV3(group, header.meshletHeaderOffset + m * 48);
          level.triangles += meshlet.triangleCount;
          for (let t = 0; t < meshlet.triangleCount; t++) {
            const vertices = [0, 1, 2].map(c => meshlet.vertexByteOffset + group.getUint8(meshlet.triangleByteOffset + t * 3 + c) * stride);
            const p = vertices.map(at => [0, 1, 2].map(axis => group.getFloat32(at + positionOffset + axis * 4, true)));
            const geometric = normalize(cross(subtract(p[1], p[0]), subtract(p[2], p[0])));
            for (const at of vertices) {
              let x = Math.max(-1, group.getInt16(at + normalOffset, true) / 32767);
              let y = Math.max(-1, group.getInt16(at + normalOffset + 2, true) / 32767);
              const z = 1 - Math.abs(x) - Math.abs(y);
              if (z < 0) { const oldX = x; x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1); y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1); }
              const normal = normalize([x, y, z]);
              const alignment = normal.reduce((sum, n, axis) => sum + n * geometric[axis], 0);
              // A coarse face may tilt as geometry is reduced. Its original
              // corner attributes must not be replaced by opposite-side ones.
              const minimum = header.lodLevel === 0 ? fixture.minimumAlignment : 0;
              assert.ok(header.lodLevel === 0 ? alignment > minimum : alignment >= -1e-4, `${fixture.name} permissive=${simplifyPermissive} LOD${header.lodLevel} group=${g} meshlet=${m} triangle=${t}: normal alignment ${alignment}`);
              cornersChecked++;
            }
          }
        }
      }
      assert.ok(cornersChecked >= fixture.minimumCorners, `${fixture.name}: original faces must remain represented`);
      const fine = levels.get(0);
      const coarse = levels.get(Math.max(...levels.keys()));
      if (fixture.requireCoarse === true) {
        assert.ok(levels.size >= 2, `${fixture.name}: fixing shading must not disable coarse LOD`);
        assert.ok(coarse.triangles <= fine.triangles * 0.51, `${fixture.name}: retain at least 49% triangle reduction`);
        assert.ok(coarse.meshlets < fine.meshlets, `${fixture.name}: the coarse cut must emit fewer meshlets`);
      }
    } finally { result.release(); }
  }
});

test("checked-in Web geometry artifact consumes independent canonical windows", async () => {
  const module = await loadArtifact();
  const builder = beginWebGeometryCookWasmBuilderV1(module, encodeWebGeometryCookRecipeV1(), 8 * 262144);
  let plan;
  try {
    builder.append(triangleCanonical(0, 0));
    builder.append(triangleCanonical(1, 4));
    plan = builder.finish();
    assert.equal(plan.descriptorSections().assetRecords.byteLength, 2 * 128);
    assert.ok(plan.pageCount >= 1);
    for (let pageId = 0; pageId < plan.pageCount; pageId++) assert.equal(plan.pageStatus(pageId), WEB_GEOMETRY_COOK_PAGE_PENDING);
  } finally {
    plan?.release();
    builder.release();
  }
});

test("checked-in Web geometry artifact executes the Product ABI", async () => {
  const module = await loadArtifact();
  assert.equal(module._oengine_web_geometry_cook_abi_version(), WEB_GEOMETRY_COOKER_ABI_VERSION);
  assert.equal(WEB_GEOMETRY_COOKER_ABI_VERSION, 3);
  const result = cookWebGeometryWasmV1(module, triangleCanonical(), encodeWebGeometryCookRecipeV1(), 8 * 262144);
  try {
    assert.ok(result.pageCount >= 1);
    assert.equal(result.copyPage(0).byteLength, 262144);
    assert.equal(result.descriptorSections().pageRecords.byteLength, result.pageCount * 32);
  } finally {
    result.release();
  }
});

test("checked-in Web geometry artifact publishes a descriptor before any payload", async () => {
  const module = await loadArtifact();
  const canonical = triangleCanonical(), recipe = encodeWebGeometryCookRecipeV1();
  const monolithic = cookWebGeometryWasmV1(module, canonical, recipe, 8 * 262144);
  const plan = planWebGeometryWasmV1(module, canonical, recipe, 8 * 262144);
  try {
    // The descriptor stage freezes the whole ID graph, so the plan already
    // agrees with the monolithic cook on every descriptor section.
    assert.equal(plan.pageCount, monolithic.pageCount);
    const monolithicDescriptor = monolithic.descriptorSections(), planDescriptor = plan.descriptorSections();
    for (const key of [
      "assetRecords", "rootNodeIds", "hierarchyNodes", "groupDirectory",
      "pageRecords", "bootstrapPageIds", "activationPageIds", "vertexFormats", "recipeHash"
    ]) {
      assert.deepEqual(planDescriptor[key], monolithicDescriptor[key], `${key} must match the monolithic cook`);
    }

    // Every declared page starts PENDING, and an undeclared PageID is refused
    // without extending the ID graph.
    for (let pageId = 0; pageId < plan.pageCount; pageId++) {
      assert.equal(plan.pageStatus(pageId), WEB_GEOMETRY_COOK_PAGE_PENDING);
    }
    assert.equal(plan.pageStatus(plan.pageCount), WEB_GEOMETRY_COOK_PAGE_UNDECLARED);
    const undeclared = plan.producePage(plan.pageCount);
    assert.equal(undeclared.status, WEB_GEOMETRY_COOK_PAGE_UNDECLARED);
    assert.equal(undeclared.bytes, null);
    assert.equal(plan.pageCount, monolithic.pageCount);

    // Produce out of order, then repeat: payloads must be byte-identical to the
    // monolithic cook regardless of advance order.
    const last = plan.pageCount - 1;
    const outOfOrder = plan.producePage(last);
    assert.equal(outOfOrder.status, WEB_GEOMETRY_COOK_PAGE_READY);
    assert.deepEqual(new Uint8Array(outOfOrder.bytes), new Uint8Array(monolithic.copyPage(last)));
    const repeated = plan.producePage(last);
    assert.equal(repeated.status, WEB_GEOMETRY_COOK_PAGE_READY);
    assert.deepEqual(new Uint8Array(repeated.bytes), new Uint8Array(outOfOrder.bytes));

    const produced = plan.produceAll();
    assert.equal(produced, plan.pageCount - 1);
    for (let pageId = 0; pageId < plan.pageCount; pageId++) {
      assert.equal(plan.pageStatus(pageId), WEB_GEOMETRY_COOK_PAGE_READY);
      assert.deepEqual(new Uint8Array(plan.copyPage(pageId)), new Uint8Array(monolithic.copyPage(pageId)));
    }
  } finally {
    plan.release();
    monolithic.release();
  }
});


test("plan-backed revision re-reads a page after its first buffer was transferred", async () => {
  const { planWasmGeometryProductRevisionV1 } = await import("../../.test-dist/assets/geometry-product/WasmGeometryProductV1.js");
  const module = await loadArtifact();
  const revision = await planWasmGeometryProductRevisionV1(module, triangleCanonical(), encodeWebGeometryCookRecipeV1(), {
    producerId: "oengine-test",
    producerVersion: "two-phase-reread-v1",
    sourceIdentityKind: "content-sha256",
    sourceIdentityHash: new Uint8Array(32),
    revision: 0,
    maxDecodedProductBytes: 8 * 262144
  });
  try {
    // Consumers transfer the page buffer across a Worker boundary, which
    // detaches it for everyone still holding a reference - including the
    // producer's own cache. Every re-read has to return the full payload again,
    // so this transfers each buffer before asking for the page once more.
    let payload;
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await revision.readPage(0);
      assert.equal(page.bytes.byteLength, 262144, `read ${attempt} must return the full payload`);
      const current = new Uint8Array(page.bytes.slice(0));
      if (payload !== undefined) assert.deepEqual(current, payload, `read ${attempt} must be byte-identical`);
      payload = current;
      structuredClone(page.bytes, { transfer: [page.bytes] });
      assert.equal(page.bytes.byteLength, 0, "the transferred buffer must be detached");
    }
  } finally {
    revision.release();
  }
});
