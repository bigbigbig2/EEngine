import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { NyxWebRuntimeCooker, NYX_WEB_RUNTIME_PRODUCER_ID } = await import("../.test-dist/assets/web-cook/NyxWebRuntimeCooker.js");
const { decodeGeometryProductDescriptorBinaryV1 } = await import("../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js");

function productSections() {
  const page = new Uint8Array(262144), pageHash = createHash("sha256").update(page).digest();
  const asset = new Uint8Array(128), assetView = new DataView(asset.buffer); asset.fill(1, 0, 32); for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) assetView.setUint32(at, value, true);
  const hierarchy = new Uint8Array(48), hierarchyView = new DataView(hierarchy.buffer); hierarchyView.setFloat32(12, 1, true); hierarchyView.setUint32(44, 1, true);
  const group = new Uint8Array(16), groupView = new DataView(group.buffer); groupView.setUint32(8, 64, true); groupView.setUint32(12, 1, true);
  const pageRecords = new Uint8Array(32); pageRecords.set(pageHash.subarray(0, 16)); const pageView = new DataView(pageRecords.buffer); pageView.setUint32(20, 1, true);
  const formats = new Uint8Array(16), formatView = new DataView(formats.buffer); formatView.setUint16(0, 16, true); formatView.setUint16(2, 3, true); formatView.setUint8(5, 6);
  const u32 = values => { const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer); values.forEach((value, index) => view.setUint32(index * 4, value, true)); return bytes; };
  return { 1: asset, 2: u32([0]), 3: hierarchy, 4: group, 5: pageRecords, 6: u32([0]), 7: formats, 8: new Uint8Array(32).fill(4), 10: new Uint8Array(32).fill(5), page, pageHash };
}

function fakeModule(sections) {
  const heap = new Uint8Array(8 * 1024 * 1024); let next = 1024; let canonicalInput = null;
  // Page production is modelled per PageID so the two-phase path can be driven
  // out of order, repeated, and with undeclared PageIDs, exactly like the ABI.
  const produceCalls = [];
  const mutable = {
    /** PageIDs already produced by the payload stage, in production order. */
    get produceCalls() { return produceCalls; },
    set produceCalls(value) { produceCalls.length = 0; produceCalls.push(...value); },
    pageCount: 1,
    /** PageIDs the descriptor declares. */
    declared: new Set([0]),
    /** Set to the PageIDs the caller wants reported as still PENDING. */
    pending: new Set()
  };
  const module = {
    HEAPU8: heap,
    get canonicalInput() { return canonicalInput; },
    mutation: mutable,
    _malloc(bytes) { const at = next; next += bytes; return at; },
    _free() {},
    _oengine_web_geometry_cook_abi_version() { return 2; },
    _oengine_web_geometry_cook(address, bytes) { canonicalInput = heap.slice(address, address + bytes); return 1; },
    _oengine_web_geometry_cook_plan(address, bytes) { canonicalInput = heap.slice(address, address + bytes); sections.produced = new Set(); return 2; },
    _oengine_web_geometry_cook_produce_page(handle, pageId, output, outputBytes) {
      if (!mutable.declared.has(pageId)) return 3;
      if (mutable.pending.has(pageId)) return 2;
      const bytes = sections.page;
      if (bytes.byteLength !== outputBytes) return 0;
      heap.set(bytes, output);
      if (!produceCalls.includes(pageId)) produceCalls.push(pageId);
      return 1;
    },
    _oengine_web_geometry_cook_page_status(_handle, pageId) {
      if (!mutable.declared.has(pageId)) return 3;
      return mutable.pending.has(pageId) ? 2 : 1;
    },
    _oengine_web_geometry_cook_destroy() {},
    _oengine_web_geometry_cook_page_count() { return mutable.pageCount; },
    _oengine_web_geometry_cook_section_size(_handle, section, index) { return section === 9 ? (index === 0 ? sections.page.byteLength : 0) : (sections[section]?.byteLength ?? 0); },
    _oengine_web_geometry_cook_copy_section(_handle, section, index, output, outputBytes) { const bytes = section === 9 ? sections.page : sections[section]; if (!bytes || bytes.byteLength !== outputBytes) return 0; heap.set(bytes, output); return 1; },
    _oengine_web_geometry_cook_last_error_size() { return 0; },
    _oengine_web_geometry_cook_copy_last_error() { return 0; }
  };
  return module;
}

function context() {
  const positionBytes = new ArrayBuffer(36), view = new DataView(positionBytes); [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((value, vertex) => value.forEach((component, axis) => view.setFloat32(vertex * 12 + axis * 4, component, true)));
  const position = { accessorIndex: 0, bufferIndex: 0, byteOffset: 0, byteLength: 36, byteStride: 12, componentType: 5126, componentCount: 3, count: 3, normalized: false };
  const unit = { nodeIndex: 0, instanceNodeIndices: [0], meshIndex: 0, primitiveIndex: 0, materialIndex: 0, mode: 4, vertexCount: 3, triangleCount: 1, attributes: { POSITION: position }, material: { materialIndex: 0, alphaMode: "OPAQUE", doubleSided: false }, ranges: [position] };
  return { unit, context: { source: { sourceIdentity: { kind: "session", hash: new Uint8Array(32).fill(3) } }, catalog: {}, signal: new AbortController().signal, readRange: async () => positionBytes } };
}

test("Nyx Web Runtime Cooker assembles an immutable revision and validates transferred pages", async () => {
  const sections = productSections(), { unit, context: cookContext } = context();
  const cooker = new NyxWebRuntimeCooker(fakeModule(sections), { maxCanonicalInputBytes: 4096, maxDecodedProductBytes: 262144 });
  const revision = await cooker.cookBootstrap(unit, cookContext);
  const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
  assert.equal(descriptor.producerId, NYX_WEB_RUNTIME_PRODUCER_ID);
  assert.equal(descriptor.revision, 0);
  assert.equal(revision.pageCount, 1);
  const page = await revision.readPage(0);
  assert.equal(page.bytes.byteLength, 262144);
  revision.release();
  await assert.rejects(() => revision.readPage(0), /released/i);
});

test("Nyx Web Runtime Cooker emits one asset per GLB domain in the catalog's stable order", async () => {
  const sections = productSections(), { unit, context: cookContext } = context();
  const module = fakeModule(sections);
  const cooker = new NyxWebRuntimeCooker(module, { maxCanonicalInputBytes: 8192, maxDecodedProductBytes: 262144 });
  const second = { ...unit, nodeIndex: 1, instanceNodeIndices: [1], meshIndex: 3, materialIndex: 2, material: { ...unit.material, materialIndex: 2 } };
  // Mixed material/mesh domains are admitted; they become independent Product assets.
  const revision = await cooker.cookBootstrapBatch([second, unit], cookContext);
  assert.equal(revision.pageCount, 1);
  const canonical = module.canonicalInput;
  const view = new DataView(canonical.buffer, canonical.byteOffset, canonical.byteLength);
  assert.equal(view.getUint32(20, true), 2, "canonical input carries one domain per unit");
  const domainTable = view.getUint32(32, true);
  assert.equal(view.getUint32(domainTable, true), 0, "node 0 domain sorts first regardless of input order");
  assert.equal(view.getUint32(domainTable + 32, true), 2, "node 1 domain sorts second");
  revision.release();
  await assert.rejects(() => cooker.cookBootstrapBatch([], cookContext), /at least one GLB primitive/i);
});

test("Nyx Web Runtime Cooker offers a bootstrap revision, then a richer replacement", async () => {
  const sections = productSections(), { unit, context: cookContext } = context();
  const cooker = new NyxWebRuntimeCooker(fakeModule(sections), { maxCanonicalInputBytes: 8192, maxDecodedProductBytes: 262144 });
  const revisions = [];
  let failure;
  await cooker.cookProgressive([unit], cookContext, async (revision) => { revisions.push(revision); }, (error) => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].revision, 0);
  assert.equal(revisions[1].revision, 1);
  const bootstrap = decodeGeometryProductDescriptorBinaryV1(revisions[0].descriptor);
  const richer = decodeGeometryProductDescriptorBinaryV1(revisions[1].descriptor);
  assert.deepEqual([...richer.replaces.productId], [...bootstrap.productId]);
  assert.equal(richer.replaces.revision, bootstrap.revision);
  for (const revision of revisions) revision.release();
});

test("Nyx Web Runtime Cooker keeps the bootstrap revision when the richer cook fails", async () => {
  const sections = productSections(), { unit, context: cookContext } = context();
  const base = fakeModule(sections);
  let calls = 0;
  // The bootstrap cut still uses the monolithic entry (it must be fully
  // resident before publication); the richer revision freezes its descriptor
  // through the plan entry. Fail the second one and the bootstrap must survive.
  const failing = {
    ...base,
    _oengine_web_geometry_cook() { calls++; return 1; },
    _oengine_web_geometry_cook_plan() { calls++; return calls === 2 ? 0 : 2; },
    _oengine_web_geometry_cook_last_error_size() { return 10; },
    _oengine_web_geometry_cook_copy_last_error(output, outputBytes) { if (outputBytes !== 10) return 0; base.HEAPU8.set(new TextEncoder().encode("richer-err"), output); return 1; }
  };
  const cooker = new NyxWebRuntimeCooker(failing, { maxCanonicalInputBytes: 8192, maxDecodedProductBytes: 262144 });
  const revisions = [];
  let failure;
  await cooker.cookProgressive([unit], cookContext, async (revision) => { revisions.push(revision); }, (error) => { failure = error; });
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revision, 0);
  assert.match(failure?.message ?? "", /richer-err/);
  for (const revision of revisions) revision.release();
});

test("Nyx Web Runtime Cooker freezes the richer descriptor without producing payloads", async () => {
  // The whole point of the two-phase split: the richer revision must hand over a
  // complete ID graph while every page is still PENDING, so the coordinator can
  // publish the descriptor and produce only what the activation cut and GPU
  // demand actually need.
  const sections = productSections(), { unit, context: cookContext } = context();
  const module = fakeModule(sections);
  // Only the activation cut is produced eagerly. A non-activation page stays
  // PENDING until something asks for it.
  module.mutation.pending.add(0);
  const cooker = new NyxWebRuntimeCooker(module, { maxCanonicalInputBytes: 8192, maxDecodedProductBytes: 262144 });
  const revisions = [];
  await cooker.cookProgressive([unit], cookContext, async (revision) => { revisions.push(revision); }, () => {});
  const [bootstrap, richer] = revisions;
  assert.equal(bootstrap.hasPendingPages, false, "the bootstrap cut is fully materialised");
  assert.equal(richer.hasPendingPages, true, "the richer descriptor is published before its payloads");
  // The descriptor is complete: identity, Group mapping and the activation cut
  // are all readable while pages are still pending.
  const descriptor = decodeGeometryProductDescriptorBinaryV1(richer.descriptor);
  assert.equal(descriptor.pageRecords.byteLength / 32, 1);
  assert.deepEqual([...descriptor.activationPageIds], [0]);
  assert.deepEqual([...descriptor.replaces.productId], [...decodeGeometryProductDescriptorBinaryV1(bootstrap.descriptor).productId]);
  for (const revision of revisions) revision.release();
});

test("Nyx Web Runtime Cooker produces a plan-backed page on demand and reuses it", async () => {
  const sections = productSections(), { unit, context: cookContext } = context();
  const module = fakeModule(sections);
  module.mutation.pending.add(0);
  const cooker = new NyxWebRuntimeCooker(module, { maxCanonicalInputBytes: 8192, maxDecodedProductBytes: 262144 });
  const revisions = [];
  await cooker.cookProgressive([unit], cookContext, async (revision) => { revisions.push(revision); }, () => {});
  const richer = revisions[1];
  module.mutation.pending.clear();
  const page = await richer.readPage(0);
  assert.equal(page.bytes.byteLength, 262144);
  assert.deepEqual(module.mutation.produceCalls, [0], "the first read advances the payload stage");
  // A produced page is immutable, so a second demand must be served from the
  // revision's own cache rather than re-running the payload stage.
  await richer.readPage(0);
  assert.deepEqual(module.mutation.produceCalls, [0]);
  for (const revision of revisions) revision.release();
});

test("Nyx Web Runtime Cooker serves the bootstrap cut even while the richer revision is pending", async () => {
  const sections = productSections(), { unit, context: cookContext } = context();
  const module = fakeModule(sections);
  module.mutation.pending.add(0);
  const cooker = new NyxWebRuntimeCooker(module, { maxCanonicalInputBytes: 8192, maxDecodedProductBytes: 262144 });
  const revisions = [];
  await cooker.cookProgressive([unit], cookContext, async (revision) => { revisions.push(revision); }, () => {});
  const [bootstrap, richer] = revisions;
  // The resident bootstrap keeps rendering: its cut is monolithic, so it stays
  // readable independently of the richer payload stage.
  const bootstrapPage = await bootstrap.readPage(0);
  assert.equal(bootstrapPage.bytes.byteLength, 262144);
  assert.equal(module.mutation.produceCalls.includes(0), false, "reading the bootstrap cut never touches the plan");
  richer.release();
  bootstrap.release();
});
