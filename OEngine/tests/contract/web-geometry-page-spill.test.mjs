import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const {
  MemoryWebGeometryPageSpillStoreV1,
  OpfsWebGeometryPageSpillStoreV1,
  pageSpillKeyV1
} = await import("../../.test-dist/assets/geometry-product/WebGeometryPageSpillStoreV1.js");
const { encodeWebCanonicalGeometryV1, encodeWebGeometryCookRecipeV1, planWebGeometryWasmV1 } = await import("../../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js");
const { planWasmGeometryProductRevisionV1 } = await import("../../.test-dist/assets/geometry-product/WasmGeometryProductV1.js");
const Module = (await import("../../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.mjs")).default;
import { readFile } from "node:fs/promises";

async function loadArtifact() {
  const wasm = await readFile(new URL("../../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.wasm", import.meta.url));
  return Module({ instantiateWasm(info, receive) { WebAssembly.instantiate(wasm, info).then(result => receive(result.instance)); return {}; } });
}

function triangleCanonical() {
  const vertices = new Float32Array(54);
  vertices[18] = 1;
  vertices[36 + 1] = 1;
  return encodeWebCanonicalGeometryV1([{ materialId: 0, meshletFlags: 1, attributeMask: 1, generateNormals: true, vertices, indices: Uint32Array.from([0, 1, 2]) }]);
}

function page(fill) {
  return Uint8Array.from({ length: 262144 }, () => fill).buffer;
}

function key(generation = 4) {
  return { productId: new Uint8Array(32).fill(7), revision: 2, pageId: 9, sessionGeneration: generation };
}

test("memory page spill is checksum-verified, bounded, and generation-scoped", async () => {
  const store = new MemoryWebGeometryPageSpillStoreV1({ maxBytes: 2 * (262144 + 144) });
  const first = await store.put({ ...key(), decodedHash128: new Uint8Array(16).fill(3), bytes: page(0x2a) });
  assert.equal(first.payloadChecksum.byteLength, 32);
  assert.equal(first.decodedPageHash128.length, 16);
  const reread = await store.read(key());
  assert.ok(reread);
  assert.deepEqual(new Uint8Array(reread.bytes), new Uint8Array(first.bytes));
  structuredClone(reread.bytes, { transfer: [reread.bytes] });
  const afterTransfer = await store.read(key());
  assert.equal(afterTransfer.bytes.byteLength, 262144);
  assert.deepEqual([...afterTransfer.payloadChecksum], [...new Uint8Array(createHash("sha256").update(new Uint8Array(page(0x2a))).digest())]);
  await assert.rejects(() => store.put({ ...key(), decodedHash128: new Uint8Array(16).fill(3), bytes: page(0x2b) }), /collides|different payload/i);
  assert.equal((await store.read({ ...key(), sessionGeneration: 5 })), null, "old generation must not hit a new generation");
  const evidence = store.evidence();
  assert.equal(evidence.ownerCount, 1);
  assert.equal(evidence.currentBytes, 262144 + 144);
  assert.equal(evidence.peakBytes, evidence.currentBytes);
  await store.release(key());
  assert.equal(store.evidence().currentBytes, 0);
  assert.equal(store.evidence().ownerCount, 0);
});

test("memory page spill rejects a partial budget before publication", async () => {
  const store = new MemoryWebGeometryPageSpillStoreV1({ maxBytes: 262144 + 143 });
  await assert.rejects(() => store.put({ ...key(), decodedHash128: new Uint8Array(16), bytes: page(1) }), /maxBytes/i);
  assert.equal(store.evidence().ownerCount, 0);
  assert.equal(store.evidence().currentBytes, 0);
});

class FakeFile {
  constructor(bytes) { this.bytes = bytes; }
  async arrayBuffer() { return this.bytes.slice(0); }
}
class FakeWritable {
  constructor(handle) { this.handle = handle; this.bytes = null; }
  async write(bytes) { this.bytes = bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  async close() { this.handle.bytes = this.bytes; }
  async abort() { this.bytes = null; }
}
class FakeFileHandle {
  constructor(directory, name) { this.directory = directory; this.name = name; this.bytes = directory.files.get(name) ?? null; }
  async createWritable() { return new FakeWritable(this); }
  async getFile() { if (this.bytes === null) throw new DOMException("missing", "NotFoundError"); return new FakeFile(this.bytes); }
}
class FakeDirectory {
  constructor() { this.files = new Map(); }
  async getFileHandle(name, options = {}) { if (!this.files.has(name) && options.create !== true) throw new DOMException("missing", "NotFoundError"); const handle = new FakeFileHandle(this, name); const directory = this; Object.defineProperty(handle, "bytes", { get() { return directory.files.get(name) ?? null; }, set(value) { if (value === null) directory.files.delete(name); else directory.files.set(name, value); }, configurable: true }); return handle; }
  async removeEntry(name) { if (!this.files.delete(name)) throw new DOMException("missing", "NotFoundError"); }
}

test("OPFS envelope re-reads exact bytes and rejects corruption", async () => {
  const directory = new FakeDirectory();
  const store = new OpfsWebGeometryPageSpillStoreV1({ directory, maxBytes: 2 * (262144 + 144), namespace: "test-pages" });
  const artifact = await store.put({ ...key(), decodedHash128: new Uint8Array(16).fill(8), bytes: page(5) });
  const filename = [...directory.files.keys()][0];
  assert.match(filename, /^test-pages-/u);
  const reread = await store.read(key());
  assert.deepEqual(new Uint8Array(reread.bytes), new Uint8Array(artifact.bytes));
  const corrupted = new Uint8Array(directory.files.get(filename));
  corrupted[corrupted.length - 1] ^= 0xff;
  directory.files.set(filename, corrupted.buffer);
  await assert.rejects(() => store.read(key()), /artifact|checksum|invalid/i);
  await store.dispose();
  assert.equal(store.evidence().ownerCount, 0);
});

test("page spill keys are stable and include the runtime generation", () => {
  assert.equal(pageSpillKeyV1(key()), `${"07".repeat(32)}:2:9:4`);
  assert.notEqual(pageSpillKeyV1(key(4)), pageSpillKeyV1(key(5)));
});

test("plan-backed Product reads through spill and returns a stable copy after transfer", async () => {
  const module = await loadArtifact();
  assert.equal(typeof module._oengine_web_geometry_cook_release_page, "function", "checked-in WASM artifact must carry the Phase D release hook");
  const store = new MemoryWebGeometryPageSpillStoreV1({ maxBytes: 2 * (262144 + 144) });
  const revision = await planWasmGeometryProductRevisionV1(module, triangleCanonical(), encodeWebGeometryCookRecipeV1(), {
    producerId: "oengine-spill-test",
    producerVersion: "cook-and-spill-v1",
    sourceIdentityKind: "session",
    sourceIdentityHash: new Uint8Array(32).fill(6),
    revision: 1,
    sessionGeneration: 17,
    spillStore: store,
    maxDecodedProductBytes: 2 * 262144
  });
  try {
    const [first, concurrent] = await Promise.all([revision.readPage(0), revision.readPage(0)]);
    const firstBytes = new Uint8Array(first.bytes.slice(0));
    assert.equal(store.evidence().writes, 1);
    assert.deepEqual(new Uint8Array(concurrent.bytes), firstBytes, "same-page concurrent demand must share one cook");
    structuredClone(first.bytes, { transfer: [first.bytes] });
    const second = await revision.readPage(0);
    assert.deepEqual(new Uint8Array(second.bytes), firstBytes);
    assert.equal(store.evidence().writes, 1, "second read must hit spill, not cook again");
    assert.ok(store.evidence().reads >= 2);
  } finally {
    revision.release();
  }
  assert.equal(store.evidence().ownerCount, 0);
});
