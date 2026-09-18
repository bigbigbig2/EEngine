import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { WebCookCoordinator } = await import("../.test-dist/assets/web-cook/WebCookCoordinator.js");
const { encodeGeometryProductDescriptorBinaryV1 } = await import("../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js");

function makeTwoPrimitiveGlb() {
  const document = {
    asset: { version: "2.0" }, buffers: [{ byteLength: 86 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 },
      { buffer: 0, byteOffset: 44, byteLength: 36 }, { buffer: 0, byteOffset: 80, byteLength: 6 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC3", min: [10, 0, 0], max: [11, 1, 0] },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" }
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }, { primitives: [{ attributes: { POSITION: 2 }, indices: 3 }] }],
    nodes: [{ mesh: 0 }, { mesh: 1 }], scenes: [{ nodes: [0, 1] }]
  };
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const json = new Uint8Array(Math.ceil(encoded.byteLength / 4) * 4); json.set(encoded); json.fill(0x20, encoded.byteLength);
  const bin = new Uint8Array(86); const view = new DataView(bin.buffer);
  [[0, 0, 0], [1, 0, 0], [0, 1, 0], [10, 0, 0], [11, 0, 0], [10, 1, 0]].forEach((vertex, index) => vertex.forEach((component, axis) => view.setFloat32(index * 12 + axis * 4 + (index >= 3 ? 8 : 0), component, true)));
  view.setUint16(36, 0, true); view.setUint16(38, 1, true); view.setUint16(40, 2, true);
  view.setUint16(80, 0, true); view.setUint16(82, 1, true); view.setUint16(84, 2, true);
  const bytes = new Uint8Array(12 + 8 + json.byteLength + 8 + bin.byteLength), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, json.byteLength, true); header.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20);
  const binHeader = 20 + json.byteLength; header.setUint32(binHeader, bin.byteLength, true); header.setUint32(binHeader + 4, 0x004e4942, true); bytes.set(bin, binHeader + 8);
  return bytes;
}

function productFixture() {
  const page = new Uint8Array(262144), hash = createHash("sha256").update(page).digest(), productId = new Uint8Array(32).fill(7);
  const asset = new Uint8Array(128), av = new DataView(asset.buffer); asset.fill(1, 0, 32); for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  const hierarchy = new Uint8Array(48), hv = new DataView(hierarchy.buffer); hv.setFloat32(12, 1, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16), gv = new DataView(groups.buffer); gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  const pages = new Uint8Array(32); pages.set(hash.subarray(0, 16)); new DataView(pages.buffer).setUint32(20, 1, true);
  const formats = new Uint8Array(16), fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(5, 6);
  return { page, hash, productId, descriptor: { schemaVersion: 1, productId, revision: 0, producerKind: "web-runtime", producerId: "visible-first-test", producerVersion: "1", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: 262144, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: pages, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0]) } };
}

test("Web Cook visible-first selects one prioritized primitive before reading the other", async () => {
  const glb = makeTwoPrimitiveGlb(), product = productFixture(), fetched = [];
  const coordinator = new WebCookCoordinator("visible-first", 1, {
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 4096, maxOutputBytes: 262144, maxQueuedEvents: 16 },
    source: { fetch: async (_url, init) => { const match = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(match[1]), end = Number(match[2]); fetched.push([start, end]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } },
    bootstrapUnitCount: 1,
    cooker: {
      async cookProgressive(units, context, onRevision) {
        assert.equal(units.length, 2);
        assert.equal(context.bootstrapUnits.length, 1);
        for (const range of context.bootstrapUnits[0].ranges) await context.readRange(range);
        await onRevision({ descriptor: encodeGeometryProductDescriptorBinaryV1(product.descriptor), productId: product.productId, revision: 0, pageCount: 1, sceneAssetIndices: [1], async readPage(pageId) { return { pageId, decodedHash128: product.hash.subarray(0, 16), bytes: product.page.buffer }; }, release() {} });
      }
    }
  });
  await coordinator.open("https://example.test/visible-first.glb");
  const catalogEvent = coordinator.drainEvents().find(event => event.type === "SceneCatalogReady");
  const secondKey = catalogEvent.catalog.primitives[1].assetKey;
  coordinator.setSourcePriority(secondKey, 100, 1);
  coordinator.grantOutputCredits(1, 262144);
  await coordinator.cookBootstrap();
  assert.equal(coordinator.evidence().bootstrapUnits, 1);
  assert.equal(coordinator.evidence().completedUnits, 1);
  assert.equal(coordinator.drainEvents().some(event => event.type === "RevisionOffered" && event.sceneAssetIndices?.[0] === 1), true);
  assert.ok(fetched.every(([start]) => start < glb.byteLength));
  coordinator.dispose();
});
