import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { NyxWebRuntimeCooker, NYX_WEB_RUNTIME_PRODUCER_ID } = await import(
  "../../.test-dist/assets/web-cook/NyxWebRuntimeCooker.js"
);
const { decodeGeometryProductDescriptorBinaryV1 } = await import(
  "../../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js"
);
const { MemoryWebGeometryPageSpillStoreV1 } = await import(
  "../../.test-dist/assets/geometry-product/WebGeometryPageSpillStoreV1.js"
);

function spillStore(pageCapacity = 8) {
  return new MemoryWebGeometryPageSpillStoreV1({ maxBytes: pageCapacity * (262144 + 144) });
}

function productSections() {
  const page = new Uint8Array(262144),
    pageHash = createHash("sha256").update(page).digest();
  const asset = new Uint8Array(128),
    assetView = new DataView(asset.buffer);
  asset.fill(1, 0, 32);
  for (const [at, value] of [
    [72, 0],
    [76, 1],
    [80, 0],
    [84, 1],
    [88, 0],
    [92, 1],
    [96, 0],
    [100, 1],
    [104, 1],
    [108, 1],
    [112, 1],
    [116, 0]
  ])
    assetView.setUint32(at, value, true);
  const hierarchy = new Uint8Array(48),
    hierarchyView = new DataView(hierarchy.buffer);
  hierarchyView.setFloat32(12, 1, true);
  hierarchyView.setUint32(44, 1, true);
  const group = new Uint8Array(16),
    groupView = new DataView(group.buffer);
  groupView.setUint32(8, 64, true);
  groupView.setUint32(12, 1, true);
  const pageRecords = new Uint8Array(32);
  pageRecords.set(pageHash.subarray(0, 16));
  const pageView = new DataView(pageRecords.buffer);
  pageView.setUint32(20, 1, true);
  const formats = new Uint8Array(16),
    formatView = new DataView(formats.buffer);
  formatView.setUint16(0, 16, true);
  formatView.setUint16(2, 3, true);
  formatView.setUint8(5, 6);
  formatView.setUint8(10, 1); // Current Product ABI: Float32x3 position encoding.
  const u32 = (values) => {
    const bytes = new Uint8Array(values.length * 4),
      view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setUint32(index * 4, value, true));
    return bytes;
  };
  return {
    1: asset,
    2: u32([0]),
    3: hierarchy,
    4: group,
    5: pageRecords,
    6: u32([0]),
    7: formats,
    8: new Uint8Array(32).fill(4),
    10: new Uint8Array(32).fill(5),
    page,
    pageHash
  };
}

function fakeModule(sections) {
  const heap = new Uint8Array(8 * 1024 * 1024);
  let next = 1024;
  let canonicalInput = null;
  const canonicalWindows = [];
  // Page production is modelled per PageID so the two-phase path can be driven
  // out of order, repeated, and with undeclared PageIDs, exactly like the ABI.
  const produceCalls = [],
    releaseCalls = [];
  const mutable = {
    /** PageIDs already produced by the payload stage, in production order. */
    get produceCalls() {
      return produceCalls;
    },
    set produceCalls(value) {
      produceCalls.length = 0;
      produceCalls.push(...value);
    },
    get releaseCalls() {
      return releaseCalls;
    },
    pageCount: 1,
    /** PageIDs the descriptor declares. */
    declared: new Set([0]),
    /** Set to the PageIDs the caller wants reported as still PENDING. */
    pending: new Set()
  };
  const module = {
    HEAPU8: heap,
    get canonicalInput() {
      return canonicalInput;
    },
    get canonicalWindows() {
      return canonicalWindows.map((bytes) => bytes.slice());
    },
    mutation: mutable,
    _malloc(bytes) {
      const at = next;
      next += bytes;
      return at;
    },
    _free() {},
    _oengine_web_geometry_cook_abi_version() {
      return 4;
    },
    _oengine_web_geometry_cook(address, bytes) {
      canonicalInput = heap.slice(address, address + bytes);
      return 1;
    },
    _oengine_web_geometry_cook_plan(address, bytes) {
      canonicalInput = heap.slice(address, address + bytes);
      sections[10] = new Uint8Array(createHash("sha256").update(canonicalInput).digest());
      sections.produced = new Set();
      return 2;
    },
    _oengine_web_geometry_cook_builder_begin() {
      canonicalWindows.length = 0;
      return 3;
    },
    _oengine_web_geometry_cook_builder_append(_handle, address, bytes) {
      canonicalWindows.push(heap.slice(address, address + bytes));
      return 1;
    },
    _oengine_web_geometry_cook_builder_finish() {
      sections[10] = new Uint8Array(
        createHash("sha256")
          .update(Buffer.concat(canonicalWindows.map((bytes) => Buffer.from(bytes))))
          .digest()
      );
      sections.produced = new Set();
      return 2;
    },
    _oengine_web_geometry_cook_builder_destroy() {},
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
    _oengine_web_geometry_cook_release_page(_handle, pageId) {
      releaseCalls.push(pageId);
      return 1;
    },
    _oengine_web_geometry_cook_destroy() {},
    _oengine_web_geometry_cook_page_count() {
      return mutable.pageCount;
    },
    _oengine_web_geometry_cook_section_size(_handle, section, index) {
      return section === 9
        ? index === 0
          ? sections.page.byteLength
          : 0
        : (sections[section]?.byteLength ?? 0);
    },
    _oengine_web_geometry_cook_copy_section(_handle, section, index, output, outputBytes) {
      const bytes = section === 9 ? sections.page : sections[section];
      if (!bytes || bytes.byteLength !== outputBytes) return 0;
      heap.set(bytes, output);
      return 1;
    },
    _oengine_web_geometry_cook_last_error_size() {
      return 0;
    },
    _oengine_web_geometry_cook_copy_last_error() {
      return 0;
    }
  };
  return module;
}

function context() {
  const positionBytes = new ArrayBuffer(36),
    view = new DataView(positionBytes);
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0]
  ].forEach((value, vertex) =>
    value.forEach((component, axis) => view.setFloat32(vertex * 12 + axis * 4, component, true))
  );
  const position = {
    accessorIndex: 0,
    bufferIndex: 0,
    byteOffset: 0,
    byteLength: 36,
    byteStride: 12,
    componentType: 5126,
    componentCount: 3,
    count: 3,
    normalized: false
  };
  const unit = {
    nodeIndex: 0,
    instanceNodeIndices: [0],
    meshIndex: 0,
    primitiveIndex: 0,
    materialIndex: 0,
    mode: 4,
    vertexCount: 3,
    triangleCount: 1,
    attributes: { POSITION: position },
    material: { materialIndex: 0, alphaMode: "OPAQUE", doubleSided: false },
    ranges: [position]
  };
  return {
    unit,
    context: {
      source: { sourceIdentity: { kind: "session", hash: new Uint8Array(32).fill(3) } },
      catalog: {},
      signal: new AbortController().signal,
      readRange: async (range) => positionBytes.slice(range.byteOffset, range.byteOffset + range.byteLength)
    }
  };
}

test("Nyx Web Runtime Cooker rejects the retired native ABI before planning", async () => {
  const module = fakeModule(productSections());
  module._oengine_web_geometry_cook_abi_version = () => 3;
  const input = context();
  const cooker = new NyxWebRuntimeCooker(module, {
    maxSourceWindowBytes: 24,
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144
  });
  await assert.rejects(cooker.cookBootstrap(input.unit, input.context), /ABI version mismatch/);
});

test("Nyx Web Runtime Cooker gives a spatially sharded primitive a stable Product identity", async () => {
  const a = productSections(),
    b = productSections(),
    firstContext = context(),
    secondContext = context();
  const firstModule = fakeModule(a),
    secondModule = fakeModule(b);
  const firstCooker = new NyxWebRuntimeCooker(firstModule, {
    maxSourceWindowBytes: 24,
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144
  });
  const secondCooker = new NyxWebRuntimeCooker(secondModule, {
    maxSourceWindowBytes: 24,
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144
  });
  const first = await firstCooker.cookBootstrap(firstContext.unit, firstContext.context);
  const second = await secondCooker.cookBootstrap(secondContext.unit, secondContext.context);
  assert.deepEqual([...first.productId], [...second.productId]);
  assert.deepEqual(first.sceneAssetIndices, [0]);
  assert.equal(firstModule.canonicalWindows.length, 1);
  assert.deepEqual(
    { primitives: firstCooker.evidence().spatialPrimitives, shards: firstCooker.evidence().spatialShards },
    { primitives: 1, shards: 1 }
  );
  assert.equal(firstCooker.evidence().spatialExternalScratchMaterializations, 0);
  assert.equal(firstCooker.evidence().spatialExternalScratchReleases, 0);
  first.release();
  second.release();
});

test("Nyx Web Runtime Cooker assembles an immutable revision and validates transferred pages", async () => {
  const sections = productSections(),
    { unit, context: cookContext } = context();
  const cooker = new NyxWebRuntimeCooker(fakeModule(sections), {
    maxCanonicalInputBytes: 4096,
    maxDecodedProductBytes: 262144
  });
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
  const sections = productSections(),
    { unit, context: cookContext } = context();
  const module = fakeModule(sections);
  const cooker = new NyxWebRuntimeCooker(module, {
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144
  });
  const second = {
    ...unit,
    nodeIndex: 1,
    instanceNodeIndices: [1],
    meshIndex: 3,
    materialIndex: 2,
    material: { ...unit.material, materialIndex: 2 }
  };
  // Mixed material/mesh domains are admitted; they become independent Product assets.
  const revision = await cooker.cookBootstrapBatch([second, unit], cookContext);
  assert.equal(revision.pageCount, 1);
  const canonical = module.canonicalInput;
  const view = new DataView(canonical.buffer, canonical.byteOffset, canonical.byteLength);
  assert.equal(view.getUint32(20, true), 2, "canonical input carries one domain per unit");
  const domainTable = view.getUint32(32, true);
  assert.equal(view.getUint32(domainTable, true), 0, "node 0 domain sorts first regardless of input order");
  // ABI3 retains material/geometry words and appends four f32 UV weights.
  assert.equal(view.getUint32(domainTable + 48, true), 2, "node 1 domain sorts second");
  for (let axis = 0; axis < 4; axis++) {
    assert.equal(view.getFloat32(domainTable + 32 + axis * 4, true), Math.fround(0.1));
  }
  revision.release();
  await assert.rejects(() => cooker.cookBootstrapBatch([], cookContext), /at least one GLB primitive/i);
});

test("Nyx Web Runtime Cooker publishes independent revision-zero Products per spatial shard", async () => {
  const sections = productSections(),
    { unit, context: cookContext } = context();
  const second = { ...unit, nodeIndex: 1, instanceNodeIndices: [1], meshIndex: 1 };
  cookContext.catalog.primitives = [unit, second];
  const store = spillStore();
  const cooker = new NyxWebRuntimeCooker(fakeModule(sections), {
    maxSourceWindowBytes: 24,
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144,
    spillStore: store
  });
  const revisions = [];
  let failure;
  await cooker.cookProgressive(
    [unit, second],
    cookContext,
    async (revision) => {
      revisions.push(revision);
    },
    (error) => {
      failure = error;
    }
  );
  assert.equal(failure, undefined);
  assert.equal(revisions.length, 2);
  assert.deepEqual(
    revisions.map((revision) => revision.revision),
    [0, 0]
  );
  assert.deepEqual(
    revisions.map((revision) => revision.sceneAssetIndices),
    [[0], [1]]
  );
  assert.notDeepEqual([...revisions[0].productId], [...revisions[1].productId]);
  for (const revision of revisions)
    assert.equal(decodeGeometryProductDescriptorBinaryV1(revision.descriptor).replaces, undefined);
  for (const revision of revisions) revision.release();
});

test("Nyx Web Runtime Cooker gives ordinary windows stable, non-colliding Product identities", async () => {
  const sections = productSections(),
    { unit, context: cookContext } = context();
  const second = { ...unit, nodeIndex: 1, instanceNodeIndices: [1], meshIndex: 1 };
  cookContext.catalog.primitives = [unit, second];
  const run = async () => {
    const cooker = new NyxWebRuntimeCooker(fakeModule(sections), {
      maxSourceWindowBytes: 8192,
      maxCanonicalInputBytes: 8192,
      maxDecodedProductBytes: 262144,
      maxDomainsPerProduct: 1,
      spillStore: spillStore()
    });
    const revisions = [];
    await cooker.cookProgressive([unit, second], cookContext, async (revision) => {
      revisions.push(revision);
    });
    const identities = revisions.map((revision) => [...revision.productId]);
    revisions.forEach((revision) => revision.release());
    return identities;
  };
  const first = await run(),
    repeated = await run();
  assert.equal(first.length, 2);
  assert.notDeepEqual(first[0], first[1], "ordinary windows from one source must not share a spill key");
  assert.deepEqual(repeated, first, "the same stable Product partition must reproduce its identity");
});

test("Nyx Web Runtime Cooker fails the session when a later required Product fails", async () => {
  const sections = productSections(),
    { unit, context: cookContext } = context();
  const second = { ...unit, nodeIndex: 1, instanceNodeIndices: [1], meshIndex: 1 };
  cookContext.catalog.primitives = [unit, second];
  const base = fakeModule(sections);
  let calls = 0;
  const failing = {
    ...base,
    _oengine_web_geometry_cook_plan(address, bytes) {
      calls++;
      if (calls === 2) return 0;
      return base._oengine_web_geometry_cook_plan(address, bytes);
    },
    _oengine_web_geometry_cook_last_error_size() {
      return 9;
    },
    _oengine_web_geometry_cook_copy_last_error(output, outputBytes) {
      if (outputBytes !== 9) return 0;
      base.HEAPU8.set(new TextEncoder().encode("shard-err"), output);
      return 1;
    }
  };
  const cooker = new NyxWebRuntimeCooker(failing, {
    maxSourceWindowBytes: 24,
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144,
    spillStore: spillStore()
  });
  const revisions = [];
  await assert.rejects(
    () =>
      cooker.cookProgressive([unit, second], cookContext, async (revision) => {
        revisions.push(revision);
      }),
    /shard-err/
  );
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revision, 0);
  assert.deepEqual(revisions[0].sceneAssetIndices, [0]);
  for (const revision of revisions) revision.release();
});

test("Nyx Web Runtime Cooker publishes before page production and spills before completion", async () => {
  const sections = productSections(),
    { unit, context: cookContext } = context();
  const module = fakeModule(sections);
  const store = spillStore();
  const cooker = new NyxWebRuntimeCooker(module, {
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144,
    spillStore: store
  });
  const revisions = [];
  await cooker.cookProgressive(
    [unit],
    cookContext,
    async (revision) => {
      assert.deepEqual(module.mutation.produceCalls, [], "publication must not wait for page production");
      assert.equal(store.evidence().writes, 0);
      revisions.push(revision);
    },
    () => {}
  );
  assert.equal(revisions.length, 1);
  const [revision] = revisions;
  assert.equal(revision.hasPendingPages, false);
  assert.deepEqual(module.mutation.produceCalls, [0]);
  assert.deepEqual(module.mutation.releaseCalls, [0], "committed spill releases the WASM page owner");
  const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
  assert.equal(descriptor.pageRecords.byteLength / 32, 1);
  assert.deepEqual([...descriptor.activationPageIds], [0]);
  assert.equal(store.evidence().writes, 1);
  for (const revision of revisions) revision.release();
});

test("Nyx Web Runtime Cooker fails when spill fails after publication", async () => {
  const { unit, context: cookContext } = context();
  const cooker = new NyxWebRuntimeCooker(fakeModule(productSections()), {
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144,
    spillStore: new MemoryWebGeometryPageSpillStoreV1({ maxBytes: 1 })
  });
  let published = false;
  const trace = [];
  cooker.setTaskTraceListener((event) => trace.push(event));
  await assert.rejects(() =>
    cooker.cookProgressive([unit], cookContext, async () => {
      published = true;
    })
  );
  assert.equal(published, true);
  assert.equal(
    trace.some((event) => event.kind === "completed"),
    false
  );
  assert.equal(trace.at(-1).kind, "failed");
});

test("Nyx Web Runtime Cooker emits attributable Product phase and terminal trace", async () => {
  const sections = productSections(),
    { unit, context: cookContext } = context();
  cookContext.catalog.primitives = [unit];
  const cooker = new NyxWebRuntimeCooker(fakeModule(sections), {
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144,
    spillStore: spillStore()
  });
  const trace = [];
  cooker.setTaskTraceListener((event) => trace.push(event));
  const revisions = [];
  await cooker.cookProgressive(
    [unit],
    cookContext,
    async (revision) => {
      revisions.push(revision);
    },
    () => {}
  );
  assert.deepEqual(
    trace.filter((event) => event.kind === "phase-started").map((event) => event.phase),
    ["canonicalize", "wasm-plan", "publish", "spill"]
  );
  assert.deepEqual(
    trace.filter((event) => event.kind === "phase-completed").map((event) => event.phase),
    ["canonicalize", "wasm-plan", "publish", "spill"]
  );
  const terminal = trace.at(-1);
  assert.equal(terminal.kind, "completed");
  assert.equal(terminal.task.triangles, 1);
  assert.deepEqual(terminal.task.sceneAssetIndices, [0]);
  assert.equal(terminal.metrics.pageCount, 1);
  assert.ok(terminal.metrics.spillBytes > 0);
  revisions.forEach((revision) => revision.release());
});

test("Nyx Web Runtime Cooker re-reads a published page from spill without retaining WASM payload", async () => {
  const sections = productSections(),
    { unit, context: cookContext } = context();
  const module = fakeModule(sections);
  const store = spillStore();
  const cooker = new NyxWebRuntimeCooker(module, {
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144,
    spillStore: store
  });
  const revisions = [];
  await cooker.cookProgressive(
    [unit],
    cookContext,
    async (revision) => {
      revisions.push(revision);
    },
    () => {}
  );
  const revision = revisions[0];
  const readsAfterPublication = store.evidence().reads;
  const page = await revision.readPage(0);
  assert.equal(page.bytes.byteLength, 262144);
  await revision.readPage(0);
  assert.deepEqual(module.mutation.produceCalls, [0], "publication is the only WASM production");
  assert.deepEqual(module.mutation.releaseCalls, [0]);
  assert.equal(store.evidence().reads - readsAfterPublication, 2);
  for (const revision of revisions) revision.release();
});

test("Nyx Web Runtime Cooker requires a spill owner for progressive Product publication", async () => {
  const sections = productSections(),
    { unit, context: cookContext } = context();
  const cooker = new NyxWebRuntimeCooker(fakeModule(sections), {
    maxCanonicalInputBytes: 8192,
    maxDecodedProductBytes: 262144
  });
  await assert.rejects(
    () => cooker.cookProgressive([unit], cookContext, async () => {}),
    /requires a spill store/i
  );
});
