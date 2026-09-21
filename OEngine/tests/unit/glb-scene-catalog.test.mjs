import assert from "node:assert/strict";
import test from "node:test";

const { openGlbRangeSource } = await import("../.test-dist/loaders/gltf/streaming/GlbRangeSource.js");
const { buildGlbSceneCatalog } = await import("../.test-dist/loaders/gltf/streaming/GlbSceneCatalog.js");

function makeGlb() {
  const jsonObject = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 42 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1], metallicFactor: 0.25, roughnessFactor: 0.75, baseColorTexture: { index: 0, texCoord: 1 } }, emissiveFactor: [0.1, 0.2, 0.3] }],
    images: [{ uri: "data:image/png;base64,AA==" }],
    textures: [{ source: 0 }],
    nodes: [{ mesh: 0, translation: [2, 3, 4] }],
    scenes: [{ nodes: [0] }]
  };
  const encoded = new TextEncoder().encode(JSON.stringify(jsonObject));
  const json = new Uint8Array(Math.ceil(encoded.byteLength / 4) * 4); json.set(encoded); json.fill(0x20, encoded.byteLength);
  const bin = new Uint8Array(42).map((_, index) => index);
  const bytes = new Uint8Array(12 + 8 + json.byteLength + 8 + bin.byteLength);
  const view = new DataView(bytes.buffer); view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, json.byteLength, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20);
  const binHeader = 20 + json.byteLength; view.setUint32(binHeader, bin.byteLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); bytes.set(bin, binHeader + 8);
  return bytes;
}

test("GLB scene catalog is metadata-first and reports exact accessor ranges", async () => {
  const bytes = makeGlb();
  const source = await openGlbRangeSource("https://example.test/catalog.glb", { fetch: async (_url, init) => {
    const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(range[1]); const end = Number(range[2]);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`, "Content-Encoding": "identity" } });
  } });
  const catalog = buildGlbSceneCatalog(source);
  assert.equal(source.transferMode, "range");
  assert.equal(catalog.primitives.length, 1);
  assert.equal(catalog.primitives[0].vertexCount, 3);
  assert.equal(catalog.primitives[0].triangleCount, 1);
  assert.deepEqual([...catalog.instances[0].worldMatrix], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]);
  assert.deepEqual(catalog.primitives[0].material.baseColorFactor, [0.2, 0.4, 0.6, 1]);
  assert.deepEqual(catalog.primitives[0].material.baseColorTexture, { textureIndex: 0, texCoord: 1, offset: [0, 0], scale: [1, 1], rotation: 0 });
  assert.deepEqual(catalog.textures, [{ textureIndex: 0, sourceIndex: 0, sampler: {} }]);
  assert.deepEqual(catalog.images, [{ imageIndex: 0, uri: "data:image/png;base64,AA==" }]);
  assert.equal(catalog.primitives[0].material.metallicFactor, 0.25);
  assert.deepEqual(catalog.primitives[0].ranges.map(range => [range.bufferIndex, range.byteOffset, range.byteLength]), [[0, 0, 36], [0, 36, 6]]);
  assert.deepEqual([...new Uint8Array(await source.readBufferRange(0, 36, 6))], [36, 37, 38, 39, 40, 41]);
  source.release();
});
