import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  encodeWebCanonicalGeometryV1,
  encodeWebGeometryCookRecipeV1,
  cookWebGeometryWasmV1,
  planWebGeometryWasmV1,
  WEB_GEOMETRY_COOKER_ABI_VERSION,
  WEB_GEOMETRY_COOK_PAGE_PENDING,
  WEB_GEOMETRY_COOK_PAGE_READY,
  WEB_GEOMETRY_COOK_PAGE_UNDECLARED
} = await import("../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js");
const Module = (await import("../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.mjs")).default;

async function loadArtifact() {
  const wasm = await readFile(new URL("../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.wasm", import.meta.url));
  return Module({
    instantiateWasm(info, receive) {
      WebAssembly.instantiate(wasm, info).then(result => receive(result.instance));
      return {};
    }
  });
}

function triangleCanonical() {
  return encodeWebCanonicalGeometryV1([{
    materialId: 0,
    meshletFlags: 1,
    attributeMask: 1,
    generateNormals: true,
    vertices: Float32Array.from([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]),
    indices: Uint32Array.from([0, 1, 2])
  }]);
}

test("checked-in Web geometry artifact executes the Product ABI", async () => {
  const module = await loadArtifact();
  assert.equal(module._oengine_web_geometry_cook_abi_version(), WEB_GEOMETRY_COOKER_ABI_VERSION);
  assert.equal(WEB_GEOMETRY_COOKER_ABI_VERSION, 2);
  const result = cookWebGeometryWasmV1(module, triangleCanonical(), encodeWebGeometryCookRecipeV1(), 8 * 262144);
  try {
    assert.ok(result.pageCount >= 1);
    assert.equal(result.copyPage(0).byteLength, 262144);
    assert.equal(result.descriptorSections().pageRecords.byteLength, result.pageCount * 32);
  } finally {
    result.release();
  }
});

test("checked-in Web geometry artifact publishes a descriptor before any payload", async () => {
  const module = await loadArtifact();
  const canonical = triangleCanonical(), recipe = encodeWebGeometryCookRecipeV1();
  const monolithic = cookWebGeometryWasmV1(module, canonical, recipe, 8 * 262144);
  const plan = planWebGeometryWasmV1(module, canonical, recipe, 8 * 262144);
  try {
    // The descriptor stage freezes the whole ID graph, so the plan already
    // agrees with the monolithic cook on every descriptor section.
    assert.equal(plan.pageCount, monolithic.pageCount);
    const monolithicDescriptor = monolithic.descriptorSections(), planDescriptor = plan.descriptorSections();
    for (const key of [
      "assetRecords", "rootNodeIds", "hierarchyNodes", "groupDirectory",
      "pageRecords", "bootstrapPageIds", "activationPageIds", "vertexFormats", "recipeHash"
    ]) {
      assert.deepEqual(planDescriptor[key], monolithicDescriptor[key], `${key} must match the monolithic cook`);
    }

    // Every declared page starts PENDING, and an undeclared PageID is refused
    // without extending the ID graph.
    for (let pageId = 0; pageId < plan.pageCount; pageId++) {
      assert.equal(plan.pageStatus(pageId), WEB_GEOMETRY_COOK_PAGE_PENDING);
    }
    assert.equal(plan.pageStatus(plan.pageCount), WEB_GEOMETRY_COOK_PAGE_UNDECLARED);
    const undeclared = plan.producePage(plan.pageCount);
    assert.equal(undeclared.status, WEB_GEOMETRY_COOK_PAGE_UNDECLARED);
    assert.equal(undeclared.bytes, null);
    assert.equal(plan.pageCount, monolithic.pageCount);

    // Produce out of order, then repeat: payloads must be byte-identical to the
    // monolithic cook regardless of advance order.
    const last = plan.pageCount - 1;
    const outOfOrder = plan.producePage(last);
    assert.equal(outOfOrder.status, WEB_GEOMETRY_COOK_PAGE_READY);
    assert.deepEqual(new Uint8Array(outOfOrder.bytes), new Uint8Array(monolithic.copyPage(last)));
    const repeated = plan.producePage(last);
    assert.equal(repeated.status, WEB_GEOMETRY_COOK_PAGE_READY);
    assert.deepEqual(new Uint8Array(repeated.bytes), new Uint8Array(outOfOrder.bytes));

    const produced = plan.produceAll();
    assert.equal(produced, plan.pageCount - 1);
    for (let pageId = 0; pageId < plan.pageCount; pageId++) {
      assert.equal(plan.pageStatus(pageId), WEB_GEOMETRY_COOK_PAGE_READY);
      assert.deepEqual(new Uint8Array(plan.copyPage(pageId)), new Uint8Array(monolithic.copyPage(pageId)));
    }
  } finally {
    plan.release();
    monolithic.release();
  }
});


test("plan-backed revision re-reads a page after its first buffer was transferred", async () => {
  const { planWasmGeometryProductRevisionV1 } = await import("../.test-dist/assets/geometry-product/WasmGeometryProductV1.js");
  const module = await loadArtifact();
  const revision = await planWasmGeometryProductRevisionV1(module, triangleCanonical(), encodeWebGeometryCookRecipeV1(), {
    producerId: "oengine-test",
    producerVersion: "two-phase-reread-v1",
    sourceIdentityKind: "content-sha256",
    sourceIdentityHash: new Uint8Array(32),
    revision: 0,
    maxDecodedProductBytes: 8 * 262144
  });
  try {
    // Consumers transfer the page buffer across a Worker boundary, which
    // detaches it for everyone still holding a reference - including the
    // producer's own cache. Every re-read has to return the full payload again,
    // so this transfers each buffer before asking for the page once more.
    let payload;
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await revision.readPage(0);
      assert.equal(page.bytes.byteLength, 262144, `read ${attempt} must return the full payload`);
      const current = new Uint8Array(page.bytes.slice(0));
      if (payload !== undefined) assert.deepEqual(current, payload, `read ${attempt} must be byte-identical`);
      payload = current;
      structuredClone(page.bytes, { transfer: [page.bytes] });
      assert.equal(page.bytes.byteLength, 0, "the transferred buffer must be detached");
    }
  } finally {
    revision.release();
  }
});
