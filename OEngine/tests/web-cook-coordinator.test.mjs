import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { WebCookCoordinator } = await import("../.test-dist/assets/web-cook/WebCookCoordinator.js");
const { encodeGeometryProductDescriptorBinaryV1 } = await import("../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js");

function makeGlb() {
  const document = { asset: { version: "2.0" }, buffers: [{ byteLength: 42 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] };
  const encoded = new TextEncoder().encode(JSON.stringify(document)); const json = new Uint8Array(Math.ceil(encoded.byteLength / 4) * 4); json.set(encoded); json.fill(0x20, encoded.byteLength);
  const bin = new Uint8Array(42).map((_, index) => index); const bytes = new Uint8Array(12 + 8 + json.byteLength + 8 + bin.byteLength); const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true); view.setUint32(12, json.byteLength, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20);
  const binHeader = 20 + json.byteLength; view.setUint32(binHeader, bin.byteLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); bytes.set(bin, binHeader + 8); return bytes;
}

function productFixture() {
  const page = new Uint8Array(262144); const hash = createHash("sha256").update(page).digest(); const productId = new Uint8Array(32).fill(7);
  const asset = new Uint8Array(128); const av = new DataView(asset.buffer); asset.fill(1, 0, 32); for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  const hierarchy = new Uint8Array(48); const hv = new DataView(hierarchy.buffer); hv.setFloat32(12, 1, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16); const gv = new DataView(groups.buffer); gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  const pages = new Uint8Array(32); pages.set(hash.subarray(0, 16)); const pv = new DataView(pages.buffer); pv.setUint32(20, 1, true);
  const formats = new Uint8Array(16); const fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(5, 6);
  const descriptor = { schemaVersion: 1, productId, revision: 1, producerKind: "web-runtime", producerId: "web-test", producerVersion: "1", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: 262144, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: pages, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0]) };
  return { descriptor, productId, page, hash };
}

test("Web Cook coordinator bounds source work and emits credited Product events", async () => {
  const glb = makeGlb(), product = productFixture(), fetched = [];
  const coordinator = new WebCookCoordinator("session-a", 1, {
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 1024, maxOutputBytes: 262144, maxQueuedEvents: 8 },
    source: { fetch: async (_url, init) => { const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(range[1]), end = Number(range[2]); fetched.push([start, end]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } },
    cooker: { async cookBootstrap(unit, context) { for (const range of unit.ranges) await context.readRange(range); return { descriptor: encodeGeometryProductDescriptorBinaryV1(product.descriptor), productId: product.productId, revision: 1, pages: [{ pageId: 0, decodedHash128: product.hash.subarray(0, 16), bytes: product.page.buffer }] }; } }
  });
  await coordinator.open("https://example.test/scene.glb"); coordinator.grantOutputCredits(1, 262144); await coordinator.cookBootstrap();
  assert.equal(coordinator.evidence().state, "complete"); assert.equal(coordinator.evidence().completedUnits, 1); assert.ok(fetched.length >= 5);
  assert.deepEqual(coordinator.drainEvents().map(event => event.type), ["SceneCatalogReady", "RevisionOffered", "PageReady", "Progress"]); coordinator.dispose();
});
