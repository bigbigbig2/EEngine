import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });

const { load_oegpack_product } = await import("../.test-dist/assets/geometry-product/OegPackProductAsset.js");
const { createOegPackSceneSource } = await import("../.test-dist/assets/geometry-product/OegPackSceneSourceV1.js");
const { OegPackSceneManifestError, parseOegPackSceneManifestV3 } = await import("../.test-dist/assets/geometry-product/OegPackSceneManifestV3.js");
const { OegPackV3Error } = await import("../.test-dist/assets/OegPackV3.js");

const cooker = resolve("tools/oengine-asset-core/build/oengine-asset-cooker.exe");

/** Deterministic single-mesh grid GLB: POSITION/NORMAL/TEXCOORD_0 + indices. */
function buildGridGlb(size = 9) {
  const vertexCount = size * size, cellCount = (size - 1) * (size - 1);
  const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3), uv0 = new Float32Array(vertexCount * 2);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const vertex = y * size + x, px = x * 0.125, py = y * 0.125;
    positions.set([px, py, Math.sin(px * 0.31) * Math.cos(py * 0.27)], vertex * 3);
    normals.set([0, 0, 1], vertex * 3); uv0.set([x / (size - 1), y / (size - 1)], vertex * 2);
  }
  const indices = new Uint32Array(cellCount * 6);
  let cursor = 0;
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const a = y * size + x, b = a + 1, c = a + size, d = c + 1;
    indices.set([a, b, d, a, d, c], cursor); cursor += 6;
  }
  const chunks = [positions, normals, uv0, indices], offsets = [];
  let binaryBytes = 0;
  for (const chunk of chunks) { binaryBytes = (binaryBytes + 3) & ~3; offsets.push(binaryBytes); binaryBytes += chunk.byteLength; }
  const binary = new Uint8Array((binaryBytes + 3) & ~3);
  chunks.forEach((chunk, index) => binary.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offsets[index]));
  const json = {
    asset: { version: "2.0", generator: "OEngine ADR-0016 offline parity corpus" },
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: chunks.map((chunk, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: chunk.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3", min: [0, 0, -1], max: [(size - 1) * 0.125, (size - 1) * 0.125, 1] },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: vertexCount, type: "VEC2" },
      { bufferView: 3, componentType: 5125, count: indices.length, type: "SCALAR" }
    ],
    materials: [{ name: "offline-opaque" }],
    meshes: [{ name: `offline-${size}`, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
  };
  const jsonSource = new TextEncoder().encode(JSON.stringify(json)), jsonBytes = (jsonSource.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonBytes + 8 + binary.byteLength, glb = new Uint8Array(total), view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes, true); view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonBytes); glb.set(jsonSource, 20);
  const binHeader = 20 + jsonBytes;
  view.setUint32(binHeader, binary.byteLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); glb.set(binary, binHeader + 8);
  return glb;
}

let cached;
/** Cooks one GLB with the Native Offline Cooker and returns pack + manifest bytes. */
async function cookedFixture(recipe = []) {
  if (cached) return cached;
  const root = await mkdtemp(join(tmpdir(), "oengine-offline-"));
  const input = join(root, "offline.glb"), output = join(root, "out");
  await writeFile(input, buildGridGlb());
  const run = spawnSync(cooker, [input, "--out", output, "--threads", "1", ...recipe], { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const packName = (await readdir(output)).find(name => name.endsWith(".oegpack"));
  assert.ok(packName, "the native cooker must emit one .oegpack");
  cached = { pack: new Uint8Array(await readFile(join(output, packName))), manifest: await readFile(join(output, "scene.oescene"), "utf8"), packName };
  return cached;
}

test("scene manifest parser accepts the native writer output and rejects malformed manifests", async () => {
  const fixture = await cookedFixture();
  const manifest = parseOegPackSceneManifestV3(fixture.manifest);
  assert.equal(manifest.schema, "oengine-scene-v3");
  assert.equal(manifest.packs.length, 1);
  assert.match(manifest.packs[0].packId, /^[0-9a-f]{64}$/u);
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.instances.length, 1);
  assert.equal(manifest.instances[0].materialBindingTable, 0);
  assert.equal(manifest.instances[0].transform.length, 16);
  assert.ok(manifest.instances[0].transform.every(Number.isFinite));

  const original = JSON.parse(fixture.manifest);
  const reject = (mutate, pattern) => {
    const copy = structuredClone(original);
    mutate(copy);
    assert.throws(() => parseOegPackSceneManifestV3(JSON.stringify(copy)), pattern);
  };
  reject(value => { value.schema = "oengine-scene-v4"; }, OegPackSceneManifestError);
  reject(value => { value.packs[0].packId = value.packs[0].packId.toUpperCase(); }, /lowercase hex/u);
  reject(value => { value.packs[0].packId = "abc"; }, /lowercase hex/u);
  reject(value => { value.assets[0].pack = 7; }, /outside packs/u);
  reject(value => { value.instances[0].asset = 3; }, /outside assets/u);
  reject(value => { value.instances[0].transform[3] = "x"; }, /finite number/u);
  reject(value => { value.instances[0].transform = [1, 2, 3]; }, /16 entries/u);
  reject(value => { value.instances[0].flags = -1; }, /u32/u);
  reject(value => { value.extra = 1; }, /unknown key/u);
  reject(value => { delete value.instances; }, /missing 'instances'/u);
  assert.throws(() => parseOegPackSceneManifestV3("{"), /not valid JSON/u);
});

test("Offline Product asset serves hash-validated pages from a memory source", async () => {
  const fixture = await cookedFixture();
  const asset = await load_oegpack_product({ kind: "memory", bytes: fixture.pack, manifest: fixture.manifest });
  const before = asset.evidence();
  assert.equal(before.selection, "memory");
  assert.equal(before.state, "open");
  assert.equal(before.pageCount, asset.pack.pages.length);
  assert.equal(before.activationPageCount, asset.descriptor.activationPageIds.length);
  assert.ok(before.activationPageCount >= 1 && before.activationPageCount <= before.pageCount);
  assert.equal(before.manifestReady, true);
  const iterator = asset.revisions()[Symbol.asyncIterator]();
  const revision = (await iterator.next()).value;
  assert.equal(revision.descriptor.revision, 0);
  assert.equal(revision.descriptor.producerKind, "offline-native");
  for (const pageId of asset.descriptor.activationPageIds) {
    const page = await revision.readPage(pageId);
    assert.equal(page.pageId, pageId);
    assert.equal(page.bytes.byteLength, 262144);
  }
  // The Offline source is a random-access artifact: the same page is re-readable,
  // which is what device-loss recovery depends on.
  const again = await revision.readPage(asset.descriptor.activationPageIds[0]);
  assert.equal(again.bytes.byteLength, 262144);
  assert.equal(asset.evidence().revisionsOffered, 1);
  asset.release();
  assert.equal(asset.evidence().state, "released");
  assert.throws(() => asset.revisions(), /released/u);
});

test("Offline Product asset requires honored HTTP ranges and reports failures", async () => {
  const fixture = await cookedFixture();
  const originalFetch = globalThis.fetch;
  const rangeReads = [];
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("scene.oescene")) return new Response(fixture.manifest, { status: 200, headers: { "content-encoding": "identity" } });
      if (String(url).endsWith("bad.oegpack")) return new Response("no ranges here", { status: 200, headers: { "content-encoding": "identity" } });
      if (String(url).endsWith("missing.oegpack")) return new Response("", { status: 404 });
      const range = String(init?.headers?.Range ?? "");
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
      assert.ok(match, "the Offline route must request pack byte ranges");
      const start = Number(match[1]), end = Number(match[2]);
      rangeReads.push(start);
      const slice = fixture.pack.slice(start, end + 1);
      return new Response(slice, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${fixture.pack.byteLength}`, "content-encoding": "identity" } });
    };
    const asset = await load_oegpack_product({ kind: "http-range", url: "https://offline.test/pack.oegpack", manifestUrl: "https://offline.test/scene.oescene" });
    assert.equal(asset.evidence().manifestReady, true);
    assert.ok(rangeReads.length >= 1, "opening the pack must issue range reads");
    assert.equal(asset.evidence().rangeReads, rangeReads.length);
    asset.release();
    await assert.rejects(load_oegpack_product({ kind: "http-range", url: "https://offline.test/bad.oegpack" }), (error) => error instanceof OegPackV3Error && /byte range/u.test(error.message));
    await assert.rejects(load_oegpack_product({ kind: "http-range", url: "https://offline.test/missing.oegpack" }), (error) => error instanceof OegPackV3Error && /byte range/u.test(error.message));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Offline scene mapper builds the shared Virtual Geometry scene source", async () => {
  const fixture = await cookedFixture();
  const asset = await load_oegpack_product({ kind: "memory", bytes: fixture.pack, manifest: fixture.manifest });
  const mapped = createOegPackSceneSource(asset, { fitHeight: 2, fitBase: [0, -1, 0] });
  const source = mapped.source;
  assert.equal(source.assetCount, asset.descriptor.assetRecords.byteLength / 128);
  assert.equal(source.geometryProfiles.length, source.assetCount);
  assert.equal(mapped.materials.length, 1);
  const manifest = parseOegPackSceneManifestV3(fixture.manifest);
  assert.equal(source.count, manifest.instances.length);
  assert.equal(source.geometryIndices.length, source.count);
  assert.equal(source.currentTransforms.length, source.count * 16);
  assert.equal(source.boundsSpheres.length, source.count * 4);
  assert.equal(source.geometryProfiles[0].hasNormal, true);
  assert.equal(source.geometryProfiles[0].hasUv0, true);
  assert.equal(source.geometryProfiles[0].hasTangent, false);
  // fitHeight frames the model: base at -1, height 2.
  let minY = Infinity, maxY = -Infinity;
  for (let index = 0; index < source.count; index++) {
    minY = Math.min(minY, source.boundsMin[index * 3 + 1]);
    maxY = Math.max(maxY, source.boundsMax[index * 3 + 1]);
  }
  assert.ok(Math.abs(minY - (-1)) < 1e-3, `fitted base must be -1, got ${minY}`);
  assert.ok(Math.abs(maxY - 1) < 1e-3, `fitted height must be 2, got ${maxY - minY}`);
  assert.equal(source.flags?.length, source.count);

  // The Offline mapper refuses to mix assets from another pack.
  const raw = JSON.parse(fixture.manifest);
  raw.packs = [{ packId: "0".repeat(64), uri: raw.packs[0].uri }];
  const foreignAsset = await load_oegpack_product({ kind: "memory", bytes: fixture.pack, manifest: JSON.stringify(raw) });
  assert.throws(() => createOegPackSceneSource(foreignAsset), /does not reference this Product pack/u);
  foreignAsset.release();
  asset.release();
});
