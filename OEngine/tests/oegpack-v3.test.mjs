import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });

const {
  MemoryRangeReadablePackV3,
  OegPackV3Error,
  openOegPackV3
} = await import("../.test-dist/assets/OegPackV3.js");
const {
  decodeGroupHeaderV3,
  decodeMeshletHeaderV3,
  OEGPACK_V3_PAGE_BYTES
} = await import("../.test-dist/assets/GeometryAbiV3.js");
const { GeometryBootstrapResidencyV3 } = await import("../.test-dist/gpu/GeometryBootstrapResidencyV3.js");
const {
  descriptorFromOegPack,
  OegPackProductRevisionSource,
  validateGeometryProductDescriptorV1
} = await import("../.test-dist/assets/geometry-product/index.js");
const { createGeometryCookRecipeV3, geometryCookRecipeV3Key } = await import("../.test-dist/assets/GeometryCookRecipe.js");
const { GltfLoader } = await import("../.test-dist/loaders/gltf/GltfLoader.js");
const { buildPackedGltfSource } = await import("../.test-dist/loaders/load_gltf.js");

const cooker = resolve("tools/oengine-asset-core/build/oengine-asset-cooker.exe");
const fixtureRoot = await mkdtemp(join(tmpdir(), "oengine-oeg3-"));
const input = join(fixtureRoot, "canonical.glb");
await writeFile(input, buildFixtureGlb());

function runCook(name, threads, extra = [], source = input) {
  const output = join(fixtureRoot, name);
  const result = spawnSync(cooker, [source, "--out", output, "--threads", String(threads), ...extra], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout.trim());
  return { output, evidence };
}

async function packBytes(output) {
  const files = await import("node:fs/promises").then(({ readdir }) => readdir(output));
  const pack = files.find(name => name.endsWith(".oegpack"));
  assert.ok(pack);
  return { name: pack, bytes: new Uint8Array(await readFile(join(output, pack))) };
}

test("A0 ABI headers freeze the V3 physical record sizes", async () => {
  const geometry = await readFile("tools/oengine-asset-core/include/oengine_asset/GeometryAbi.h", "utf8");
  const pack = await readFile("tools/oengine-asset-core/include/oengine_asset/OegPackFormat.h", "utf8");
  for (const assertion of [
    "sizeof(GeometryHierarchyNodeV3) == 48u",
    "sizeof(GeometryGroupDirectoryV3) == 16u",
    "sizeof(GroupHeaderV3) == 64u",
    "sizeof(MeshletHeaderV3) == 48u"
  ]) assert.match(geometry, new RegExp(assertion.replace(/[()]/g, "\\$&")));
  assert.match(pack, /sizeof\(OegPackHeaderV3\) == 256u/);
  assert.match(pack, /sizeof\(GeometryAssetRecordV3\) == 128u/);
  assert.match(pack, /sizeof\(GeometryPageDirectoryV3\) == 64u/);
});

test("A1-A7 native cook is deterministic across thread counts and TS opens the golden pack", async () => {
  const first = runCook("one-thread", 1);
  const second = runCook("four-threads", 4);
  const packA = await packBytes(first.output);
  const packB = await packBytes(second.output);
  assert.equal(packA.name, packB.name);
  assert.deepEqual(packA.bytes, packB.bytes);
  assert.deepEqual(await readFile(join(first.output, "scene.oescene")), await readFile(join(second.output, "scene.oescene")));
  assert.equal(createHash("sha256").update(packA.bytes).digest("hex"), GOLDEN_PACK_SHA256);

  const opened = await openOegPackV3(new MemoryRangeReadablePackV3(packA.bytes));
  assert.equal(opened.header.formatMajor, 3);
  assert.equal(opened.header.pageBytes, 262144);
  assert.equal(opened.header.recipeHash, createHash("sha256").update(geometryCookRecipeV3Key(createGeometryCookRecipeV3())).digest("hex"), "C++ and TS recipe mirrors must hash identically");
  assert.equal(opened.assets.length, 1, "identical source meshes must content-deduplicate");
  assert.equal(opened.assets[0].rootNodeCount, 2, "opaque and mask domains remain separate roots");
  assert.ok(opened.hierarchy.length > opened.assets[0].rootNodeCount);
  assert.ok(opened.groups.some(group => (group.flags & 1) !== 0));
  assert.ok(opened.pages.every(page => page.decodedBytes === OEGPACK_V3_PAGE_BYTES));
  assert.ok(first.evidence.parentMeshlets > 0, "fixture must exercise iterative Nyx simplification");
  assert.ok(first.evidence.vertexDuplicationRatio > 0);

  const scene = JSON.parse(await readFile(join(first.output, "scene.oescene"), "utf8"));
  assert.equal(scene.assets.length, 1);
  assert.equal(scene.instances.length, 3, "two references to mesh 0 and one content-identical mesh 1 share one asset");

  const sourceBytes = await readFile(input);
  const loader = new GltfLoader(); loader.loadImageSlots = [];
  const document = await loader.loadFromBinary(
    sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength),
    new URL(`file:///${input.replaceAll("\\", "/")}`).href
  );
  const v2 = buildPackedGltfSource(document);
  const v2InstancedTriangles = [...v2.geometryIndices].reduce((sum, geometryId) => sum + v2.geometries[geometryId].triangleCount, 0);
  const v3InstancedTriangles = scene.instances.reduce((sum, instance) => sum + opened.assets[instance.asset].sourceTriangleCount, 0);
  assert.equal(v3InstancedTriangles, v2InstancedTriangles, "V3 content dedup and material-domain grouping must preserve V2 instanced triangle semantics");
  assert.equal(new Set(v2.materialIndices).size, opened.assets[0].rootNodeCount, "V3 roots must preserve the V2 material-domain split");
});

test("S1 OEGPACK adapter emits a producer-neutral Product V1 descriptor and exclusive pages", async () => {
  const cooked = runCook("product-adapter", 2);
  const { bytes } = await packBytes(cooked.output);
  const opened = await openOegPackV3(new MemoryRangeReadablePackV3(bytes));
  const descriptor = descriptorFromOegPack(opened);
  const report = validateGeometryProductDescriptorV1(descriptor);
  assert.equal(report.valid, true, report.issues.map(issue => issue.message).join("; "));
  assert.equal(descriptor.runtimeProfile, "oengine-vg-v1-v3-decoded");
  assert.equal(descriptor.producerKind, "offline-native");
  assert.equal(descriptor.assetRecords.byteLength, opened.assets.length * 128);
  assert.equal(descriptor.hierarchyNodes.byteLength, opened.hierarchy.length * 48);
  assert.equal(descriptor.groupDirectory.byteLength, opened.groups.length * 16);
  assert.equal(descriptor.pageRecords.byteLength, opened.pages.length * 32);
  assert.deepEqual([...descriptor.activationPageIds], [...new Set(opened.bootstrapPageIds)].sort((a, b) => a - b));
  const source = new OegPackProductRevisionSource(opened, descriptor);
  const page = await source.readPage(descriptor.activationPageIds[0]);
  assert.equal(page.bytes.byteLength, 262144);
  assert.deepEqual([...createHash("sha256").update(new Uint8Array(page.bytes)).digest().subarray(0, 16)], [...descriptor.pageRecords.slice(descriptor.activationPageIds[0] * 32, descriptor.activationPageIds[0] * 32 + 16)]);
  source.release();
  await assert.rejects(source.readPage(descriptor.activationPageIds[0]), /released/i);
});

test("page independence: every group on an arbitrary page decodes from page-local bytes", async () => {
  const cooked = runCook("page-independent", 2);
  const { bytes } = await packBytes(cooked.output);
  const opened = await openOegPackV3(new MemoryRangeReadablePackV3(bytes));
  const pageId = opened.pages.length - 1;
  const page = await opened.readPage(pageId);
  const groups = opened.groups.map((group, id) => ({ group, id })).filter(({ group }) => group.pageId === pageId);
  assert.ok(groups.length > 0);
  for (const { group } of groups) {
    const view = new DataView(page.buffer, page.byteOffset + group.offsetInDecodedPage, group.payloadBytes);
    const header = decodeGroupHeaderV3(view);
    const format = opened.vertexFormats[header.vertexFormatId];
    assert.equal(header.payloadBytes, group.payloadBytes);
    for (let index = 0; index < header.meshletCount; index++) {
      const meshlet = decodeMeshletHeaderV3(view, header.meshletHeaderOffset + index * 48);
      assert.ok(meshlet.vertexByteOffset >= header.vertexDataOffset);
      assert.ok(meshlet.triangleByteOffset >= header.triangleDataOffset);
      const triangles = new Uint8Array(view.buffer, view.byteOffset + meshlet.triangleByteOffset, meshlet.triangleCount * 3);
      assert.ok([...triangles].every(local => local < meshlet.vertexCount));
      for (let vertex = 0; vertex < meshlet.vertexCount; vertex++) {
        const vertexOffset = meshlet.vertexByteOffset + vertex * format.strideBytes + format.positionOffset;
        const decoded = [0, 1, 2].map(axis => {
          const quantized = view.getUint16(vertexOffset + axis * 2, true);
          return meshlet.bboxMin[axis] + (meshlet.bboxMax[axis] - meshlet.bboxMin[axis]) * quantized / 65535;
        });
        const distance = Math.hypot(decoded[0] - header.boundsSphere[0], decoded[1] - header.boundsSphere[1], decoded[2] - header.boundsSphere[2]);
        assert.ok(distance <= header.boundsSphere[3] + 1e-4, "quantized vertex must remain inside its conservative group sphere");
      }
    }
  }
});

test("A6 pack sharding preserves whole-asset locality and scene references", async () => {
  const shardedInput = join(fixtureRoot, "sharded.glb");
  await writeFile(shardedInput, buildFixtureGlb({ distinctMaterialIds: true }));
  const cooked = runCook("sharded", 2, ["--shard-bytes", "1"], shardedInput);
  const files = await import("node:fs/promises").then(({ readdir }) => readdir(cooked.output));
  const packNames = files.filter(name => name.endsWith(".oegpack")).sort();
  assert.equal(packNames.length, 2, "two distinct assets must split into two target-limited shards");
  const scene = JSON.parse(await readFile(join(cooked.output, "scene.oescene"), "utf8"));
  assert.equal(scene.packs.length, 2);
  assert.equal(scene.assets.length, 2);
  assert.deepEqual(new Set(scene.assets.map(asset => asset.pack)), new Set([0, 1]));
  for (const name of packNames) {
    const bytes = new Uint8Array(await readFile(join(cooked.output, name)));
    const opened = await openOegPackV3(new MemoryRangeReadablePackV3(bytes));
    assert.equal(opened.assets.length, 1, "an asset that fits one logical shard must not be split");
  }
});

test("A8 bootstrap owner uploads fixed slots, resolves groups, and destroys every bank", async () => {
  const cooked = runCook("bootstrap", 2);
  const { bytes } = await packBytes(cooked.output);
  const opened = await openOegPackV3(new MemoryRangeReadablePackV3(bytes));
  const incoming = new Uint32Array(opened.groups.length);
  const refineChildren = Array.from({ length: opened.groups.length }, () => []);
  const decodedPages = new Map();
  for (let groupId = 0; groupId < opened.groups.length; groupId++) {
    const directory = opened.groups[groupId];
    let page = decodedPages.get(directory.pageId);
    if (!page) { page = await opened.readPage(directory.pageId); decodedPages.set(directory.pageId, page); }
    const groupView = new DataView(page.buffer, page.byteOffset + directory.offsetInDecodedPage, directory.payloadBytes);
    const group = decodeGroupHeaderV3(groupView);
    for (let meshletIndex = 0; meshletIndex < group.meshletCount; meshletIndex++) {
      const refine = decodeMeshletHeaderV3(groupView, group.meshletHeaderOffset + meshletIndex * 48).refineGroupId;
      if (refine !== 0xffffffff) { incoming[refine]++; refineChildren[groupId].push(refine); }
    }
  }
  const dagRoots = opened.groups.map((_, groupId) => groupId).filter(groupId => incoming[groupId] === 0);
  assert.ok(dagRoots.length > 0);
  assert.deepEqual(opened.groups.map((group, groupId) => (group.flags & 1) ? groupId : -1).filter(id => id >= 0), dagRoots, "bootstrap groups must be exactly the refine-DAG roots");
  const reached = new Uint8Array(opened.groups.length); const stack = [...dagRoots];
  while (stack.length) { const group = stack.pop(); if (reached[group]) continue; reached[group] = 1; stack.push(...refineChildren[group]); }
  assert.ok(!reached.includes(0), "bootstrap cut must refine-reach every group without holes");
  const writes = [];
  const buffers = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer(descriptor) { const buffer = { descriptor, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(buffer); return buffer; },
    queue: { writeBuffer(buffer, offset, data) { writes.push({ buffer, offset, bytes: data.byteLength }); } }
  };
  const residency = await GeometryBootstrapResidencyV3.create(device, opened);
  const pageWrites = writes.filter(write => write.bytes === 262144);
  const locationTableWrites = writes.filter(write => write.bytes !== 262144);
  assert.equal(pageWrites.length, new Set(opened.bootstrapPageIds).size);
  assert.equal(locationTableWrites.length, 1, "Product admission publishes one page-location table update");
  assert.ok(pageWrites.every(write => write.offset % 262144 === 0));
  for (let groupId = 0; groupId < opened.groups.length; groupId++) {
    const expected = new Set(opened.bootstrapPageIds).has(opened.groups[groupId].pageId);
    assert.equal(residency.groupAddress(groupId) !== undefined, expected);
  }
  assert.equal(residency.evidence().uploadedBytes, pageWrites.length * 262144);
  residency.destroy();
  assert.ok(buffers.every(buffer => buffer.destroyed));
});

test("corruption in header, metadata, compressed bytes, and logical links fails explicitly", async () => {
  const cooked = runCook("corruption", 1);
  const { bytes } = await packBytes(cooked.output);
  const badMagic = bytes.slice(); badMagic[0] ^= 1;
  await assert.rejects(openOegPackV3(new MemoryRangeReadablePackV3(badMagic)), /magic/i);
  const badHash = bytes.slice(); badHash[44] ^= 1;
  await assert.rejects(openOegPackV3(new MemoryRangeReadablePackV3(badHash)), /hash/i);

  const opened = await openOegPackV3(new MemoryRangeReadablePackV3(bytes));
  const badPage = bytes.slice();
  const pageOffset = Number(opened.pages[0].compressedFileOffset);
  badPage[pageOffset] ^= 0x80;
  const openedBadPage = await openOegPackV3(new MemoryRangeReadablePackV3(badPage));
  await assert.rejects(openedBadPage.readPage(0), /checksum/i);

  const badPageOffset = bytes.slice();
  const badPageOffsetView = new DataView(badPageOffset.buffer);
  const pageDirectoryOffset = Number(badPageOffsetView.getBigUint64(104, true));
  badPageOffsetView.setBigUint64(pageDirectoryOffset, badPageOffsetView.getBigUint64(pageDirectoryOffset, true) + 1n, true);
  await rewriteMetadataHash(badPageOffset);
  await assert.rejects(openOegPackV3(new MemoryRangeReadablePackV3(badPageOffset)), /page \d+ compressed range/i);

  const badCompressedSize = bytes.slice();
  const badCompressedSizeView = new DataView(badCompressedSize.buffer);
  badCompressedSizeView.setUint32(pageDirectoryOffset + 8, 0, true);
  await rewriteMetadataHash(badCompressedSize);
  await assert.rejects(openOegPackV3(new MemoryRangeReadablePackV3(badCompressedSize)), /page 0 directory/i);

  const badDecodedHash = bytes.slice();
  badDecodedHash[pageDirectoryOffset + 32] ^= 1;
  await rewriteMetadataHash(badDecodedHash);
  const openedBadDecodedHash = await openOegPackV3(new MemoryRangeReadablePackV3(badDecodedHash));
  await assert.rejects(openedBadDecodedHash.readPage(0), /decoded hash/i);

  const badGroup = bytes.slice();
  const view = new DataView(badGroup.buffer);
  const groupDirectoryOffset = Number(view.getBigUint64(96, true));
  view.setUint32(groupDirectoryOffset + 4, 262140, true);
  await rewriteMetadataHash(badGroup);
  await assert.rejects(openOegPackV3(new MemoryRangeReadablePackV3(badGroup)), /wholly contained/i);

  const badHierarchy = bytes.slice();
  const hierarchyOffset = Number(new DataView(badHierarchy.buffer).getBigUint64(88, true));
  new DataView(badHierarchy.buffer).setUint32(hierarchyOffset + 44, 0xfffffff0, true);
  await rewriteMetadataHash(badHierarchy);
  await assert.rejects(openOegPackV3(new MemoryRangeReadablePackV3(badHierarchy)), /hierarchy/i);

  const rawCooked = runCook("corrupt-refine", 1, ["--raw-threshold", "262144"]);
  const rawPack = await packBytes(rawCooked.output);
  const rawOpened = await openOegPackV3(new MemoryRangeReadablePackV3(rawPack.bytes));
  let refined;
  for (let groupId = 0; groupId < rawOpened.groups.length && !refined; groupId++) {
    const directory = rawOpened.groups[groupId];
    const page = await rawOpened.readPage(directory.pageId);
    const group = decodeGroupHeaderV3(new DataView(page.buffer, page.byteOffset + directory.offsetInDecodedPage, directory.payloadBytes));
    for (let meshletIndex = 0; meshletIndex < group.meshletCount; meshletIndex++) {
      const meshlet = decodeMeshletHeaderV3(new DataView(page.buffer, page.byteOffset + directory.offsetInDecodedPage, directory.payloadBytes), group.meshletHeaderOffset + meshletIndex * 48);
      if (meshlet.refineGroupId !== 0xffffffff) { refined = { groupId, directory, pageId: directory.pageId, refineOffset: group.meshletHeaderOffset + meshletIndex * 48 + 12 }; break; }
    }
  }
  assert.ok(refined, "fixture must contain a refinement edge");
  const badRefine = rawPack.bytes.slice();
  const badRefineView = new DataView(badRefine.buffer);
  const rawPageDirectory = Number(badRefineView.getBigUint64(104, true)) + refined.pageId * 64;
  assert.equal(badRefineView.getUint32(rawPageDirectory + 24, true), 0, "refine corruption fixture must use a raw page");
  const rawPayloadOffset = Number(badRefineView.getBigUint64(rawPageDirectory, true));
  badRefineView.setUint32(rawPayloadOffset + refined.directory.offsetInDecodedPage + refined.refineOffset, refined.groupId, true);
  const rawPageBytes = badRefine.subarray(rawPayloadOffset, rawPayloadOffset + OEGPACK_V3_PAGE_BYTES);
  const decodedDigest = createHash("sha256").update(rawPageBytes).digest();
  badRefine.set(decodedDigest.subarray(0, 16), rawPageDirectory + 32);
  badRefineView.setUint32(rawPageDirectory + 48, crc32(rawPageBytes), true);
  await rewriteMetadataHash(badRefine);
  const badRefinePath = join(fixtureRoot, "bad-refine.oegpack"); await writeFile(badRefinePath, badRefine);
  const validate = spawnSync(cooker, ["validate", badRefinePath], { encoding: "utf8", windowsHide: true });
  assert.notEqual(validate.status, 0);
  assert.match(validate.stderr, /refinement LOD is not strictly finer/i);
});

async function rewriteMetadataHash(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Number(view.getBigUint64(128, true));
  bytes.fill(0, 176, 208);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice(0, end)));
  bytes.set(digest, 176);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function buildFixtureGlb({ distinctMaterialIds = false } = {}) {
  const size = 33;
  const vertices = size * size;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uv0 = new Float32Array(vertices * 2);
  const uv1 = new Float32Array(vertices * 2);
  const colors = new Uint8Array(vertices * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const vertex = y * size + x;
    positions.set([x / 8, y / 8, Math.sin(x * 0.3) * Math.cos(y * 0.2) * 0.15], vertex * 3);
    normals.set([0, 0, 1], vertex * 3);
    uv0.set([x / (size - 1), y / (size - 1)], vertex * 2);
    uv1.set([(x % 8) / 7, (y % 8) / 7], vertex * 2);
    colors.set([x * 7, y * 7, 180, 255], vertex * 4);
  }
  const indices = new Uint32Array((size - 1) * (size - 1) * 6);
  let cursor = 0;
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const a = y * size + x, b = a + 1, c = a + size, d = c + 1;
    indices.set([a, b, d, a, d, c], cursor); cursor += 6;
  }
  const chunks = [positions, normals, uv0, uv1, colors, indices];
  const offsets = [];
  let byteOffset = 0;
  for (const chunk of chunks) { byteOffset = (byteOffset + 3) & ~3; offsets.push(byteOffset); byteOffset += chunk.byteLength; }
  const binary = new Uint8Array((byteOffset + 3) & ~3);
  chunks.forEach((chunk, index) => binary.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offsets[index]));
  const bufferViews = chunks.map((chunk, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: chunk.byteLength }));
  const accessors = [
    { bufferView: 0, componentType: 5126, count: vertices, type: "VEC3", min: [0, 0, -0.15], max: [4, 4, 0.15] },
    { bufferView: 1, componentType: 5126, count: vertices, type: "VEC3" },
    { bufferView: 2, componentType: 5126, count: vertices, type: "VEC2" },
    { bufferView: 3, componentType: 5126, count: vertices, type: "VEC2" },
    { bufferView: 4, componentType: 5121, normalized: true, count: vertices, type: "VEC4" },
    { bufferView: 5, componentType: 5125, count: indices.length, type: "SCALAR" }
  ];
  const attributes = { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TEXCOORD_1: 3, COLOR_0: 4 };
  const json = {
    asset: { version: "2.0", generator: "OEngine OEG3 acceptance fixture" },
    buffers: [{ byteLength: binary.byteLength }], bufferViews, accessors,
    materials: distinctMaterialIds
      ? [{ name: "opaque" }, { name: "mask", alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: true }, { name: "opaque-copy" }, { name: "mask-copy", alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: true }]
      : [{ name: "opaque" }, { name: "mask", alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: true }],
    meshes: [
      { name: "shared", primitives: [{ attributes, indices: 5, material: 0 }, { attributes, indices: 5, material: 1 }] },
      { name: "content-duplicate", primitives: [{ attributes, indices: 5, material: distinctMaterialIds ? 2 : 0 }, { attributes, indices: 5, material: distinctMaterialIds ? 3 : 1 }] }
    ],
    nodes: [{ mesh: 0 }, { mesh: 0, translation: [5, 0, 0] }, { mesh: 1, translation: [0, 5, 0] }],
    scenes: [{ nodes: [0, 1, 2] }], scene: 0
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = (jsonBytes.length + 3) & ~3;
  const total = 12 + 8 + jsonLength + 8 + binary.byteLength;
  const glb = new Uint8Array(total);
  const header = new DataView(glb.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, total, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength); glb.set(jsonBytes, 20);
  const binHeader = 20 + jsonLength;
  header.setUint32(binHeader, binary.byteLength, true); header.setUint32(binHeader + 4, 0x004e4942, true);
  glb.set(binary, binHeader + 8);
  return glb;
}

// Updated only when an intentional ABI/algorithm/recipe change is reviewed.
const GOLDEN_PACK_SHA256 = "4f68db668a787382091b6bffe8599f602eb90014df1ca647734f50b83d31497f";
