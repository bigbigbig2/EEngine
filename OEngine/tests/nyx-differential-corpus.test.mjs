import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });

const {
  encodeWebCanonicalGeometryV1,
  encodeWebGeometryCookRecipeV1,
  cookWebGeometryWasmV1
} = await import("../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js");
const { openGlbRangeSource } = await import("../.test-dist/loaders/gltf/streaming/GlbRangeSource.js");
const { buildGlbSceneCatalog } = await import("../.test-dist/loaders/gltf/streaming/GlbSceneCatalog.js");
const { canonicalizeGlbPrimitiveV1 } = await import("../.test-dist/assets/web-cook/gltf/GlbPrimitiveCanonicalizer.js");
const {
  decodeGroupHeaderV3,
  decodeMeshletHeaderV3,
  decodeHierarchyNodeV3,
  hierarchyNodeIsGroupV3,
  hierarchyNodeChildStartV3,
  hierarchyNodeChildCountV3,
  hierarchyNodeGroupIdV3
} = await import("../.test-dist/assets/GeometryAbiV3.js");
const { MemoryRangeReadablePackV3, openOegPackV3 } = await import("../.test-dist/assets/OegPackV3.js");
const { descriptorFromOegPack } = await import("../.test-dist/assets/geometry-product/index.js");

const cooker = resolve("tools/oengine-asset-core/build/oengine-asset-cooker.exe");
const WEB_COOKER_MODULE = "../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.mjs";
const WEB_COOKER_WASM = new URL("../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.wasm", import.meta.url);

function runNyxReferenceHarness() {
  const result = spawnSync(process.execPath, ["tools/build-nyx-reference-harness.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 120_000
  });
  assert.equal(result.status, 0, `original Nyx reference harness failed:\n${result.stderr || result.stdout}`);
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(line, "original Nyx reference harness must emit a JSON summary");
  return JSON.parse(line);
}

function runNyxModelConvertReferenceHarness() {
  const result = spawnSync(process.execPath, ["tools/build-nyx-model-convert-reference-harness.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 120_000
  });
  assert.equal(result.status, 0, `original Nyx ModelConvert reference harness failed:\n${result.stderr || result.stdout}`);
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(line, "original Nyx ModelConvert harness must emit a JSON summary");
  return JSON.parse(line);
}

/** Deterministic single-mesh grid GLB: POSITION/NORMAL + indices. */
function buildGridGlb(size = 33, { attributeSeams = false } = {}) {
  const baseVertexCount = size * size;
  const vertexCount = baseVertexCount * (attributeSeams ? 2 : 1), cellCount = (size - 1) * (size - 1);
  const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const vertex = y * size + x, px = x * 0.125, py = y * 0.125;
    // Binary-exact coordinates keep the original C++ and JS/WASM corpus
    // identical instead of comparing two platform libm implementations.
    const pz = (x % 5) * 0.0625 + (y % 7) * 0.03125;
    positions.set([px, py, pz], vertex * 3);
    const normal = 1 / Math.sqrt(3);
    normals.set([normal, normal, normal], vertex * 3);
    if (attributeSeams) {
      positions.set([px, py, pz], (baseVertexCount + vertex) * 3);
      normals.set([-normal, -normal, -normal], (baseVertexCount + vertex) * 3);
    }
  }
  const indices = new Uint32Array(cellCount * 6);
  let cursor = 0;
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const a = y * size + x, b = a + 1, c = a + size, d = c + 1;
    indices.set(attributeSeams
      ? [a, b, d, baseVertexCount + a, baseVertexCount + d, baseVertexCount + c]
      : [a, b, d, a, d, c], cursor);
    cursor += 6;
  }
  const chunks = [positions, normals, indices], offsets = [];
  let binaryBytes = 0;
  for (const chunk of chunks) { binaryBytes = (binaryBytes + 3) & ~3; offsets.push(binaryBytes); binaryBytes += chunk.byteLength; }
  const binary = new Uint8Array((binaryBytes + 3) & ~3);
  chunks.forEach((chunk, index) => binary.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offsets[index]));
  const json = {
    asset: { version: "2.0", generator: "OEngine ADR-0016 differential corpus v1" },
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: chunks.map((chunk, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: chunk.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3", min: [0, 0, -3], max: [(size - 1) * 0.125, (size - 1) * 0.125, 3] },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: "VEC3" },
      { bufferView: 2, componentType: 5125, count: indices.length, type: "SCALAR" }
    ],
    materials: [{ name: "corpus-opaque" }],
    meshes: [{ name: `corpus-${size}${attributeSeams ? "-attribute-seams" : ""}`, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
  };
  const jsonSource = new TextEncoder().encode(JSON.stringify(json)), jsonBytes = (jsonSource.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonBytes + 8 + binary.byteLength, glb = new Uint8Array(total), view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true); view.setUint32(12, jsonBytes, true); view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonBytes); glb.set(jsonSource, 20);
  const binHeader = 20 + jsonBytes; view.setUint32(binHeader, binary.byteLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); glb.set(binary, binHeader + 8);
  return glb;
}

async function cookWithWebRuntime(glb, module, recipe = {}) {
  const source = await openGlbRangeSource("https://corpus.test/grid.glb", {
    fetch: async () => new Response(glb.slice().buffer, { status: 200, headers: { "content-encoding": "identity" } })
  });
  try {
    const catalog = buildGlbSceneCatalog(source);
    const domains = [];
    for (const unit of catalog.primitives) {
      domains.push(await canonicalizeGlbPrimitiveV1(unit, { readRange: (range) => source.readBufferRange(range.bufferIndex, range.byteOffset, range.byteLength) }));
    }
    const result = cookWebGeometryWasmV1(module, encodeWebCanonicalGeometryV1(domains), encodeWebGeometryCookRecipeV1(recipe), 64 * 1024 * 1024);
    const sections = result.descriptorSections();
    const pages = [];
    for (let pageId = 0; pageId < result.pageCount; pageId++) pages.push(new Uint8Array(result.copyPage(pageId)));
    result.release();
    return { sections, pages, triangleCount: domains.reduce((sum, domain) => sum + domain.indices.length / 3, 0) };
  } finally {
    source.release();
  }
}

async function cookWithNativeOffline(glb) {
  const root = await mkdtemp(join(tmpdir(), "oengine-corpus-"));
  const input = join(root, "corpus.glb"), output = join(root, "out");
  await writeFile(input, glb);
  const run = spawnSync(cooker, [input, "--out", output, "--threads", "1"], { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const files = await readdir(output);
  const packName = files.find((name) => name.endsWith(".oegpack"));
  assert.ok(packName, "native cooker must emit one .oegpack");
  const pack = await openOegPackV3(new MemoryRangeReadablePackV3(new Uint8Array(await readFile(join(output, packName)))));
  const descriptor = descriptorFromOegPack(pack);
  const pages = [];
  for (let pageId = 0; pageId < pack.pages.length; pageId++) pages.push(new Uint8Array((await pack.readPage(pageId)).bytes));
  return { descriptor, pages };
}

function summarize(sections, pages) {
  const assetView = new DataView(sections.assetRecords.buffer, sections.assetRecords.byteOffset, sections.assetRecords.byteLength);
  const assets = sections.assetRecords.byteLength / 128;
  let boundsMin = [Infinity, Infinity, Infinity], boundsMax = [-Infinity, -Infinity, -Infinity], maxError = 0, maxMeshletVertices = 0, maxMeshletTriangles = 0, meshlets = 0, triangles = 0;
  for (let asset = 0; asset < assets; asset++) {
    for (let axis = 0; axis < 3; axis++) {
      boundsMin[axis] = Math.min(boundsMin[axis], assetView.getFloat32(asset * 128 + 48 + axis * 4, true));
      boundsMax[axis] = Math.max(boundsMax[axis], assetView.getFloat32(asset * 128 + 60 + axis * 4, true));
    }
  }
  const hierarchy = new DataView(sections.hierarchyNodes.buffer, sections.hierarchyNodes.byteOffset, sections.hierarchyNodes.byteLength);
  for (let node = 0; node < sections.hierarchyNodes.byteLength / 48; node++) maxError = Math.max(maxError, decodeHierarchyNodeV3(hierarchy, node * 48).maxParentError);
  const groupView = new DataView(sections.groupDirectory.buffer, sections.groupDirectory.byteOffset, sections.groupDirectory.byteLength);
  const decodedGroups = [];
  for (let group = 0; group < sections.groupDirectory.byteLength / 16; group++) {
    const pageId = groupView.getUint32(group * 16, true), offset = groupView.getUint32(group * 16 + 4, true), payload = groupView.getUint32(group * 16 + 8, true);
    const page = pages[pageId];
    assert.ok(page && offset + payload <= page.byteLength, `group ${group} payload must be wholly contained in page ${pageId}`);
    const header = decodeGroupHeaderV3(new DataView(page.buffer, page.byteOffset + offset, payload));
    const items = [];
    for (let meshlet = 0; meshlet < header.meshletCount; meshlet++) {
      const item = decodeMeshletHeaderV3(new DataView(page.buffer, page.byteOffset + offset + header.meshletHeaderOffset + meshlet * 48, 48));
      maxMeshletVertices = Math.max(maxMeshletVertices, item.vertexCount);
      maxMeshletTriangles = Math.max(maxMeshletTriangles, item.triangleCount);
      meshlets++;
      triangles += item.triangleCount;
      items.push(item);
    }
    decodedGroups.push({ header, items });
  }
  let refineEdges = 0;
  for (let coarseGroup = 0; coarseGroup < decodedGroups.length; coarseGroup++) {
    const coarse = decodedGroups[coarseGroup].header;
    for (const meshlet of decodedGroups[coarseGroup].items) {
      if (meshlet.refineGroupId === 0xffffffff) continue;
      refineEdges++;
      assert.ok(meshlet.refineGroupId < decodedGroups.length, `Group ${coarseGroup} refine link must stay in the Product`);
      const fine = decodedGroups[meshlet.refineGroupId].header;
      assert.ok(coarse.lodLevel > fine.lodLevel, `Group ${coarseGroup} refine link must point to a finer LOD`);
      assert.ok(coarse.parentError + 1e-4 >= fine.parentError, `Group ${coarseGroup} parent error must be monotonic across refinement`);
    }
  }
  return {
    assets, hierarchy: sections.hierarchyNodes.byteLength / 48, groups: sections.groupDirectory.byteLength / 16,
    pages: sections.pageRecords.byteLength / 32, bootstrap: sections.bootstrapPageIds.length,
    boundsMin, boundsMax, maxError, maxMeshletVertices, maxMeshletTriangles, meshlets, triangles, refineEdges
  };
}

function assertNyxInvariants(summary) {
  assert.ok(summary.assets > 0 && summary.groups > 0 && summary.pages > 0, "Product must be non-empty");
  assert.ok(summary.bootstrap > 0 && summary.bootstrap <= summary.pages, "bootstrap cut must be a non-empty subset of pages");
  assert.ok(summary.maxMeshletVertices <= 128, `Nyx meshlet vertex limit exceeded (${summary.maxMeshletVertices})`);
  assert.ok(summary.maxMeshletTriangles <= 128, `Nyx meshlet triangle limit exceeded (${summary.maxMeshletTriangles})`);
  assert.ok(summary.maxError >= 0 && Number.isFinite(summary.maxError), "parent error must be finite");
  for (let axis = 0; axis < 3; axis++) assert.ok(summary.boundsMin[axis] <= summary.boundsMax[axis], "asset bounds must be well ordered");
}

function assertHierarchyAndBootstrap(sections) {
  const assetView = new DataView(sections.assetRecords.buffer, sections.assetRecords.byteOffset, sections.assetRecords.byteLength);
  const hierarchyView = new DataView(sections.hierarchyNodes.buffer, sections.hierarchyNodes.byteOffset, sections.hierarchyNodes.byteLength);
  const hierarchyCount = sections.hierarchyNodes.byteLength / 48;
  const groupCount = sections.groupDirectory.byteLength / 16;
  const pageCount = sections.pageRecords.byteLength / 32;
  const nodeBounds = [];
  for (let node = 0; node < hierarchyCount; node++) {
    const decoded = decodeHierarchyNodeV3(hierarchyView, node * 48);
    nodeBounds.push(decoded);
    assert.ok(decoded.maxParentError >= 0 && Number.isFinite(decoded.maxParentError), `hierarchy node ${node} error must be finite`);
    if (hierarchyNodeIsGroupV3(decoded.packedNodeData)) {
      assert.ok(hierarchyNodeGroupIdV3(decoded.packedNodeData) < groupCount, `hierarchy leaf ${node} points outside Group directory`);
    } else {
      const childCount = hierarchyNodeChildCountV3(decoded.packedNodeData);
      const childStart = hierarchyNodeChildStartV3(decoded.packedNodeData);
      assert.ok(childCount > 0 && childCount <= 8, `hierarchy node ${node} child count must be 1..8`);
      assert.ok(childStart < hierarchyCount && childStart + childCount <= hierarchyCount, `hierarchy node ${node} child range must be reachable`);
    }
  }
  const epsilon = 1e-3;
  for (let asset = 0; asset < sections.assetRecords.byteLength / 128; asset++) {
    const base = asset * 128;
    const min = [assetView.getFloat32(base + 48, true), assetView.getFloat32(base + 52, true), assetView.getFloat32(base + 56, true)];
    const max = [assetView.getFloat32(base + 60, true), assetView.getFloat32(base + 64, true), assetView.getFloat32(base + 68, true)];
    const begin = assetView.getUint32(base + 80, true), count = assetView.getUint32(base + 84, true);
    assert.ok(begin + count <= hierarchyCount, `asset ${asset} hierarchy range must be valid`);
    for (let node = begin; node < begin + count; node++) {
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(nodeBounds[node].bboxMin[axis] >= min[axis] - epsilon && nodeBounds[node].bboxMax[axis] <= max[axis] + epsilon, `asset ${asset} node ${node} bounds must be contained`);
      }
    }
  }
  const bootstrap = [...sections.bootstrapPageIds];
  assert.equal(new Set(bootstrap).size, bootstrap.length, "bootstrap cut must not duplicate pages");
  assert.ok(bootstrap.every(page => page < pageCount), "bootstrap cut must reference existing pages");
}

test("Native Offline and Web Runtime cook the same GLB into an equivalent Nyx Product", async () => {
  const glb = buildGridGlb(33);
  const Module = (await import(WEB_COOKER_MODULE)).default;
  const wasm = await readFile(WEB_COOKER_WASM);
  const module = await Module({ instantiateWasm(info, receive) { WebAssembly.instantiate(wasm, info).then((result) => receive(result.instance)); return {}; } });

  const web = await cookWithWebRuntime(glb, module);
  const native = await cookWithNativeOffline(glb);

  const webSummary = summarize(web.sections, web.pages);
  const nativeSummary = summarize({
    assetRecords: native.descriptor.assetRecords,
    hierarchyNodes: native.descriptor.hierarchyNodes,
    groupDirectory: native.descriptor.groupDirectory,
    pageRecords: native.descriptor.pageRecords,
    bootstrapPageIds: native.descriptor.bootstrapPageIds
  }, native.pages);

  assertNyxInvariants(webSummary);
  assertNyxInvariants(nativeSummary);
  // Recipe identity must match: both producers ran the same frozen recipe.
  assert.deepEqual([...web.sections.recipeHash], [...native.descriptor.recipeHash], "Offline and Web must report the same recipe hash");
  // Layout/IDs/compression may differ, but the structural geometry contract may not.
  assert.equal(webSummary.assets, nativeSummary.assets, "asset count");
  assert.equal(webSummary.hierarchy, nativeSummary.hierarchy, "hierarchy node count");
  assert.equal(webSummary.groups, nativeSummary.groups, "group count");
  assert.equal(webSummary.bootstrap, nativeSummary.bootstrap, "bootstrap cut size");
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(webSummary.boundsMin[axis] - nativeSummary.boundsMin[axis]) < 1e-3, `bounds min axis ${axis}`);
    assert.ok(Math.abs(webSummary.boundsMax[axis] - nativeSummary.boundsMax[axis]) < 1e-3, `bounds max axis ${axis}`);
  }
  assert.equal(webSummary.maxMeshletVertices, nativeSummary.maxMeshletVertices, "max meshlet vertices");
  assert.equal(webSummary.maxMeshletTriangles, nativeSummary.maxMeshletTriangles, "max meshlet triangles");
});

test("Product passes the Nyx invariant checklist and page independence", async () => {
  const glb = buildGridGlb(33);
  const Module = (await import(WEB_COOKER_MODULE)).default;
  const wasm = await readFile(WEB_COOKER_WASM);
  const module = await Module({ instantiateWasm(info, receive) { WebAssembly.instantiate(wasm, info).then((result) => receive(result.instance)); return {}; } });
  const web = await cookWithWebRuntime(glb, module);
  assertNyxInvariants(summarize(web.sections, web.pages));
  assertHierarchyAndBootstrap(web.sections);

  const pageView = new DataView(web.sections.pageRecords.buffer, web.sections.pageRecords.byteOffset, web.sections.pageRecords.byteLength);
  for (let page = 0; page < web.pages.length; page++) {
    const expected = createHash("sha256").update(web.pages[page]).digest();
    const record = web.sections.pageRecords.subarray(page * 32, page * 32 + 16);
    assert.deepEqual([...record], [...expected.subarray(0, 16)], `page ${page} decoded hash must match its record`);
  }
});

test("Original Nyx MeshletBuilder is an independent semantic oracle", async () => {
  const reference = runNyxReferenceHarness();
  assert.ok(reference.groups > 0 && reference.hierarchy > 0 && reference.meshlets > 0, "Nyx reference must produce geometry");
  assert.ok(reference.triangles > 0, "Nyx reference must preserve triangles");
  assert.equal(reference.semanticErrors, true, "Nyx error values must be non-negative and non-NaN");
  assert.equal(reference.boundsOrdered, true, "Nyx reference bounds must be ordered");
  assert.equal(reference.deterministic, true, "same Nyx input must produce identical products");
  assert.equal(reference.emptyInputRejected, true, "Nyx empty input rejection branch must remain observable");
  assert.equal(reference.sloppyFallbackObserved, true, "Nyx sloppy simplification fallback branch must remain observable");
  assert.ok(Number.isInteger(reference.infiniteErrors) && reference.infiniteErrors >= 0, "Nyx infinity sentinel count must be reported");

  const glb = buildGridGlb(33);
  const Module = (await import(WEB_COOKER_MODULE)).default;
  const wasm = await readFile(WEB_COOKER_WASM);
  const module = await Module({ instantiateWasm(info, receive) { WebAssembly.instantiate(wasm, info).then((result) => receive(result.instance)); return {}; } });
  const web = await cookWithWebRuntime(glb, module);
  const webSummary = summarize(web.sections, web.pages);
  const native = await cookWithNativeOffline(glb);
  const nativeSummary = summarize(native.descriptor, native.pages);
  assert.ok(webSummary.groups > 0 && webSummary.hierarchy > 0, "Web producer must preserve Nyx product structure");
  assert.equal(webSummary.groups, reference.groups, "Web group count must match the independent Nyx MeshletBuilder oracle");
  assert.equal(webSummary.hierarchy, reference.hierarchy, "Web hierarchy count must match the independent Nyx MeshletBuilder oracle");
  assert.equal(webSummary.meshlets, reference.meshlets, "Web meshlet count must match the independent Nyx MeshletBuilder oracle");
  assert.equal(webSummary.triangles, reference.triangles, "Web serialized triangle count must match the independent Nyx MeshletBuilder oracle");
  assert.equal(nativeSummary.groups, reference.groups, "Native group count must match the independent Nyx MeshletBuilder oracle");
  assert.equal(nativeSummary.hierarchy, reference.hierarchy, "Native hierarchy count must match the independent Nyx MeshletBuilder oracle");
  assert.equal(nativeSummary.meshlets, reference.meshlets, "Native meshlet count must match the independent Nyx MeshletBuilder oracle");
  assert.equal(nativeSummary.triangles, reference.triangles, "Native serialized triangle count must match the independent Nyx MeshletBuilder oracle");
  assert.ok(webSummary.refineEdges > 0 && nativeSummary.refineEdges > 0, "the three-leg corpus must exercise refinement links");
  const seamGlb = buildGridGlb(33, { attributeSeams: true });
  const fallbackRecipe = { sloppyFallback: true };
  const webFallbackProduct = await cookWithWebRuntime(seamGlb, module, fallbackRecipe);
  const webFallback = summarize(webFallbackProduct.sections, webFallbackProduct.pages);
  const webNoFallbackProduct = await cookWithWebRuntime(seamGlb, module, { ...fallbackRecipe, sloppyFallback: false });
  const webNoFallback = summarize(webNoFallbackProduct.sections, webNoFallbackProduct.pages);
  assert.equal(webFallback.groups, reference.seamFallbackGroups, "Web sloppy fallback group count must match original Nyx seam corpus");
  assert.equal(webFallback.meshlets, reference.seamFallbackMeshlets, "Web sloppy fallback meshlet count must match original Nyx seam corpus");
  assert.equal(webNoFallback.groups, reference.seamNoFallbackGroups, "Web no-fallback group count must match original Nyx seam corpus");
  assert.equal(webNoFallback.meshlets, reference.seamNoFallbackMeshlets, "Web no-fallback meshlet count must match original Nyx seam corpus");
  assert.ok(webSummary.maxMeshletVertices <= 128 && webSummary.maxMeshletTriangles <= 128, "Web producer must preserve Nyx meshlet limits");
  assert.ok(Number.isFinite(webSummary.maxError), "Web adapter must encode Nyx infinity sentinel as finite FLT_MAX-compatible metadata");
  const sceneReference = runNyxModelConvertReferenceHarness();
  assert.equal(sceneReference.nextPos, 2, "Nyx WalkGraph must return preorder cursor");
  assert.equal(sceneReference.nodes, 2, "Nyx WalkGraph must visit root and child");
  assert.equal(sceneReference.meshRequests, 1, "Nyx WalkGraph must preserve mesh ownership");
  assert.equal(sceneReference.cameras, 1, "Nyx WalkGraph must preserve camera ownership");
  assert.deepEqual(sceneReference.worldTranslation, [1, 2, 0], "Nyx WalkGraph must propagate world transform");
  assert.equal(sceneReference.uniqueMeshes, 2, "Nyx ParallelCompileMeshes must deduplicate shared source meshes");
  assert.equal(sceneReference.meshInstances, 3, "Nyx BuildModel must preserve three scene instances after geometry deduplication");
  assert.equal(sceneReference.buildModelAccepted, true, "Nyx BuildModel must accept a valid scene");
  assert.equal(sceneReference.nullSceneRejected, true, "Nyx BuildModel must reject a missing scene");
  assert.equal(sceneReference.saveModelSourceAudited, true, "Nyx SaveModel source acceptance branch must be mapped");
  assert.equal(sceneReference.zeroDrawSourceAudited, true, "Nyx SaveModel zero-draw rejection branch must be mapped");
  assert.equal(sceneReference.pendingWriteSourceAudited, true, "Nyx SaveModel page-boundary rejection branch must be mapped");
  assert.equal(sceneReference.tempFilesQueuedForCleanup, true, "Nyx BuildModel must queue temporary sources for cleanup");
  assert.equal(sceneReference.deterministic, true, "same Nyx scene graph must produce identical mapping");
});

test("Web Nyx cooker is deterministic for the same canonical input and recipe", async () => {
  const glb = buildGridGlb(25);
  const Module = (await import(WEB_COOKER_MODULE)).default;
  const wasm = await readFile(WEB_COOKER_WASM);
  const createModule = () => Module({ instantiateWasm(info, receive) { WebAssembly.instantiate(wasm, info).then((result) => receive(result.instance)); return {}; } });
  const first = await cookWithWebRuntime(glb, await createModule());
  const second = await cookWithWebRuntime(glb, await createModule());
  for (const key of ["assetRecords", "hierarchyNodes", "groupDirectory", "pageRecords", "bootstrapPageIds", "recipeHash"]) {
    assert.deepEqual([...first.sections[key]], [...second.sections[key]], `${key} must be byte deterministic`);
  }
  assert.equal(first.pages.length, second.pages.length, "deterministic page count");
  for (let page = 0; page < first.pages.length; page++) assert.deepEqual([...first.pages[page]], [...second.pages[page]], `page ${page} must be byte deterministic`);
});

test("invariant checker rejects illegal Nyx geometry (negative corpus)", () => {
  const base = { assets: 1, hierarchy: 1, groups: 1, pages: 1, bootstrap: 1, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], maxError: 1, maxMeshletVertices: 64, maxMeshletTriangles: 64 };
  assertNyxInvariants(base);
  assert.throws(() => assertNyxInvariants({ ...base, maxMeshletVertices: 129 }), /vertex limit/, "meshlet vertex cap");
  assert.throws(() => assertNyxInvariants({ ...base, maxMeshletTriangles: 129 }), /triangle limit/, "meshlet triangle cap");
  assert.throws(() => assertNyxInvariants({ ...base, bootstrap: 0 }), /bootstrap/, "missing bootstrap cut");
  assert.throws(() => assertNyxInvariants({ ...base, groups: 0 }), /non-empty/, "empty Product");
  assert.throws(() => assertNyxInvariants({ ...base, maxError: Number.POSITIVE_INFINITY }), /finite/, "non-finite parent error");
  assert.throws(() => assertNyxInvariants({ ...base, boundsMin: [1, 0, 0], boundsMax: [0, 1, 1] }), /well ordered/, "inverted asset bounds");
});

test("group payload outside its page fails closed (cross-page Group)", async () => {
  const glb = buildGridGlb(33);
  const Module = (await import(WEB_COOKER_MODULE)).default;
  const wasm = await readFile(WEB_COOKER_WASM);
  const module = await Module({ instantiateWasm(info, receive) { WebAssembly.instantiate(wasm, info).then((result) => receive(result.instance)); return {}; } });
  const web = await cookWithWebRuntime(glb, module);
  // Shrink the first page so a group payload can no longer be wholly contained.
  const truncated = web.pages.map((page, index) => (index === 0 ? page.slice(0, 512) : page));
  assert.throws(() => summarize(web.sections, truncated), /wholly contained/, "cross-page Group must be rejected");
});
