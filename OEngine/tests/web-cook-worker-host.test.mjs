import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { WebCookWorkerHost } = await import("../.test-dist/assets/web-cook/WebCookWorkerHost.js");
const { installWebCookWorkerEntry } = await import("../.test-dist/assets/web-cook/WebCookWorkerEntry.js");
const { encodeGeometryProductDescriptorBinaryV1 } = await import("../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js");

class Port {
  listeners = [];
  sent = [];
  addEventListener(_type, listener) { this.listeners.push(listener); }
  removeEventListener(_type, listener) { this.listeners = this.listeners.filter(value => value !== listener); }
  postMessage(message, transfer = []) { this.sent.push({ message, transfer }); }
  dispatch(message) { for (const listener of this.listeners.slice()) listener({ data: message }); }
}

function glbFixture() {
  const document = { asset: { version: "2.0" }, buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] };
  const encoded = new TextEncoder().encode(JSON.stringify(document)); const json = new Uint8Array(Math.ceil(encoded.byteLength / 4) * 4); json.set(encoded); json.fill(0x20, encoded.byteLength);
  const bytes = new Uint8Array(12 + 8 + json.byteLength + 8 + 36), view = new DataView(bytes.buffer); view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true); view.setUint32(12, json.byteLength, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20); const bin = 20 + json.byteLength; view.setUint32(bin, 36, true); view.setUint32(bin + 4, 0x004e4942, true); return bytes;
}

function productFixture() {
  const page = new Uint8Array(262144), hash = createHash("sha256").update(page).digest(), productId = new Uint8Array(32).fill(7);
  const asset = new Uint8Array(128), av = new DataView(asset.buffer); asset.fill(1, 0, 32); for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  const hierarchy = new Uint8Array(48), hv = new DataView(hierarchy.buffer); hv.setFloat32(12, 1, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16), gv = new DataView(groups.buffer); gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  const pages = new Uint8Array(32), pv = new DataView(pages.buffer); pages.set(hash.subarray(0, 16)); pv.setUint32(20, 1, true);
  const formats = new Uint8Array(16), fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(5, 6);
  return { page, productId, descriptor: { schemaVersion: 1, productId, revision: 0, producerKind: "web-runtime", producerId: "host-test", producerVersion: "1", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: 262144, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: pages, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0]) } };
}

test("Dedicated Worker host runs CPU cook session and transfers descriptor/page ownership", async () => {
  const port = new Port(), glb = glbFixture(), product = productFixture();
  const host = new WebCookWorkerHost({ port, source: { fetch: async (_url, init) => { const match = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(match[1]), end = Number(match[2]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } }, cooker: { async cookBootstrap() { return { descriptor: encodeGeometryProductDescriptorBinaryV1(product.descriptor), productId: product.productId, revision: 0, pageCount: 1, async readPage(pageId) { return { pageId, decodedHash128: product.descriptor.pageRecords.slice(0, 16), bytes: product.page.buffer }; }, release() {} }; } } });
  const header = { protocolVersion: 1, sessionId: "worker-host", sessionGeneration: 4 };
  port.dispatch({ ...header, type: "CreateSession", runtimeProfile: "portable-single", recipe: {}, budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 4096, maxOutputBytes: 262144, maxQueuedEvents: 8 } });
  port.dispatch({ ...header, type: "GrantOutputCredits", blockCount: 1, bytes: 262144 });
  port.dispatch({ ...header, type: "OpenSource", source: { url: "https://example.test/worker.glb" } });
  for (let attempt = 0; attempt < 20 && port.sent.every(entry => entry.message.type !== "PageReady"); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(port.sent.map(entry => entry.message.type), ["SceneCatalogReady", "RevisionOffered", "PageReady", "Progress"]);
  const offered = port.sent.find(entry => entry.message.type === "RevisionOffered"), page = port.sent.find(entry => entry.message.type === "PageReady");
  assert.ok(offered.transfer.includes(offered.message.descriptor));
  assert.ok(page.transfer.includes(page.message.bytes));
  port.dispatch({ ...header, type: "ReturnOutputCredits", blockCount: 1, bytes: 262144 });
  port.dispatch({ ...header, type: "DisposeSession" });
  host.close();
});

test("Worker entry retains session identity when WASM bootstrap fails", async () => {
  const port = new Port(), header = { protocolVersion: 1, sessionId: "entry-failure", sessionGeneration: 9 };
  const boot = installWebCookWorkerEntry({ port, moduleFactory: async () => { throw new Error("wasm-init-failed"); }, maxCanonicalInputBytes: 4096, maxDecodedProductBytes: 262144 });
  port.dispatch({ ...header, type: "CreateSession", runtimeProfile: "portable-single", recipe: {}, budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 1, maxWasmBytes: 4096, maxOutputBytes: 262144, maxQueuedEvents: 8 } });
  await assert.rejects(boot, /wasm-init-failed/);
  assert.deepEqual(port.sent.map(entry => entry.message), [{ ...header, type: "FatalSessionFailure", code: "wasm-init-failed" }]);
});
