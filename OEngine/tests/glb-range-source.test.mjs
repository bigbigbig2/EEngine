import assert from "node:assert/strict";
import test from "node:test";

const { openGlbRangeSource } = await import("../.test-dist/loaders/gltf/streaming/GlbRangeSource.js");

function makeGlb() {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 4 }] }).padEnd(80, " "));
  const bin = new Uint8Array([1, 2, 3, 4]);
  const bytes = new Uint8Array(12 + 8 + json.byteLength + 8 + bin.byteLength);
  const view = new DataView(bytes.buffer); view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, json.byteLength, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20);
  const binHeader = 20 + json.byteLength; view.setUint32(binHeader, bin.byteLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); bytes.set(bin, binHeader + 8);
  return bytes;
}

test("GLB Range source validates exact 206 ranges and exposes JSON/BIN ranges", async () => {
  const bytes = makeGlb();
  const source = await openGlbRangeSource("https://example.test/scene.glb", { fetch: async (_url, init) => {
    const match = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(match[1]); const end = Number(match[2]);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`, "Content-Encoding": "identity", ETag: '"scene-1"' } });
  } });
  assert.equal(source.byteLength, bytes.byteLength); assert.equal(source.json.asset.version, "2.0"); assert.equal(source.binByteLength, 4); assert.equal(source.sourceIdentity.kind, "strong-http-validator");
  assert.deepEqual([...new Uint8Array(await source.readRange(source.binByteOffset, 4))], [1, 2, 3, 4]); source.release();
});

test("GLB Range source accepts bounded 200 fallback and rejects over-budget fallback", async () => {
  const bytes = makeGlb();
  const source = await openGlbRangeSource("https://example.test/fallback.glb", { wholeSourceFallbackBytes: bytes.byteLength, fetch: async () => new Response(bytes, { status: 200, headers: { ETag: '"scene-2"' } }) });
  assert.equal(source.sourceIdentity.kind, "strong-http-validator"); source.release();
  await assert.rejects(openGlbRangeSource("https://example.test/too-large.glb", { wholeSourceFallbackBytes: bytes.byteLength - 1, fetch: async () => new Response(bytes, { status: 200 }) }), /wholeSourceFallbackBytes/i);
});
