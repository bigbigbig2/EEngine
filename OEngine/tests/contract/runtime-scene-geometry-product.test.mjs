import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });

const { cookSceneGeometryProductV1, canonicalizeSceneGeometryV1 } = await import("../.test-dist/assets/geometry-product/SceneGeometryCanonicalizerV1.js");
const { buildVirtualGeometrySceneSourceV1 } = await import("../.test-dist/assets/geometry-product/VirtualGeometrySceneSourceV1.js");
const { decodeGeometryProductDescriptorBinaryV1 } = await import("../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js");
const { decodeGeometryProductPageRecordV1 } = await import("../.test-dist/assets/geometry-product/GeometryProductV1.js");
const { BoxGeometry } = await import("../.test-dist/geometry/BoxGeometry.js");
const { Scene } = await import("../.test-dist/scene/Scene.js");
const { Mesh } = await import("../.test-dist/scene/Mesh.js");
const { StandardShadeMaterial } = await import("../.test-dist/material/StandardShadeMaterial.js");
const { ShadeTransparencyMode } = await import("../.test-dist/material/enums.js");

const MODULE_URL = "../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.mjs";
const WASM_URL = new URL("../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.wasm", import.meta.url);

let cookedModule;
async function cookerModule() {
  if (cookedModule) return cookedModule;
  const factory = (await import(MODULE_URL)).default;
  const wasm = await readFile(WASM_URL);
  cookedModule = await factory({ instantiateWasm(info, receive) { WebAssembly.instantiate(wasm, info).then(result => receive(result.instance)); return {}; } });
  return cookedModule;
}

const COOK_OPTIONS = Object.freeze({
  producerId: "oengine-nyx-web-runtime",
  producerVersion: "nyx-b749346382b0-web-cooker-abi1-product-v1",
  maxDecodedProductBytes: 64 * 1024 * 1024
});

function meshScene({ materials = 1, geometry = () => new BoxGeometry(2, 2, 2) } = {}) {
  const scene = new Scene();
  for (let index = 0; index < materials; index++) {
    const mesh = new Mesh();
    mesh.geometry = geometry();
    const material = new StandardShadeMaterial();
    material.diffuse_color.set(0.2 + index * 0.3, 0.4, 0.6, 1);
    mesh.material = material;
    mesh.position.set(index * 4, 0, 0);
    scene.add(mesh);
  }
  scene.updateMatrices();
  return scene;
}

test("an ordinary Scene canonicalizes into one cookable domain", () => {
  const scene = meshScene();
  const canonical = canonicalizeSceneGeometryV1(scene);
  assert.equal(canonical.domains.length, 1);
  assert.equal(canonical.profiles.length, 1);
  assert.equal(canonical.instances.length, 1);
  assert.equal(canonical.materials.length, 1);
  const domain = canonical.domains[0];
  assert.ok(domain.vertices.length >= 3 * 18);
  assert.equal(domain.vertices.length % 18, 0);
  assert.equal(domain.indices.length % 3, 0);
  assert.equal(domain.generateNormals, false);
  assert.equal(canonical.profiles[0].hasNormal, true);
  assert.equal(canonical.instances[0].assetIndex, 0);
  assert.equal(canonical.instances[0].transform.length, 16);
  // Canonicalization is pure: the same Scene yields byte-identical input.
  assert.deepEqual(new Uint8Array(canonicalizeSceneGeometryV1(scene).canonicalInput).slice(0, 64), new Uint8Array(canonical.canonicalInput).slice(0, 64));
});

test("a geometry used with two materials becomes two Product assets", () => {
  const shared = new BoxGeometry(2, 2, 2);
  const scene = meshScene({ materials: 2, geometry: () => shared });
  const canonical = canonicalizeSceneGeometryV1(scene);
  assert.equal(canonical.domains.length, 2, "each material domain owns its own Product asset");
  assert.equal(canonical.instances.length, 2);
  assert.deepEqual(canonical.instances.map(instance => instance.assetIndex), [0, 1]);
  assert.deepEqual(canonical.instances.map(instance => instance.materialIndex), [0, 1]);
  assert.equal(canonical.domains[0].materialId, 0);
  assert.equal(canonical.domains[1].materialId, 1);
});

test("an ordinary Scene cooks into a valid, re-readable Geometry Product", async () => {
  const module = await cookerModule();
  const scene = meshScene();
  const cooked = await cookSceneGeometryProductV1(scene, { ...COOK_OPTIONS, module });
  const descriptor = decodeGeometryProductDescriptorBinaryV1(new Uint8Array(cooked.revision.descriptor).buffer);
  assert.equal(descriptor.producerKind, "web-runtime");
  assert.equal(descriptor.producerId, COOK_OPTIONS.producerId);
  assert.equal(descriptor.sourceIdentityKind, "content-sha256");
  assert.equal(descriptor.assetRecords.byteLength / 128, 1);
  assert.ok(cooked.revision.pageCount >= 1);
  assert.ok(descriptor.activationPageIds.length >= 1 && descriptor.activationPageIds.length <= cooked.revision.pageCount);
  assert.deepEqual(descriptor.activationPageIds, Uint32Array.from([...descriptor.activationPageIds].sort((left, right) => left - right)));
  for (const pageId of descriptor.activationPageIds) {
    const page = await cooked.revision.readPage(pageId);
    const expected = decodeGeometryProductPageRecordV1(descriptor, pageId);
    assert.equal(page.pageId, pageId);
    assert.equal(page.bytes.byteLength, 262144);
    assert.deepEqual(page.decodedHash128, expected.decodedHash128);
  }
  // The runtime producer keeps every page re-readable, like every other Product
  // source, because the WASM result only releases on `release()`.
  const again = await cooked.revision.readPage(descriptor.activationPageIds[0]);
  assert.equal(again.bytes.byteLength, 262144);

  const mapped = buildVirtualGeometrySceneSourceV1(descriptor.assetRecords, cooked.canonicalization.profiles, cooked.canonicalization.instances, cooked.canonicalization.materials, { fitHeight: 2, fitBase: [0, -1, 0] });
  assert.equal(mapped.source.count, 1);
  assert.equal(mapped.source.assetCount, 1);
  assert.equal(mapped.source.geometryProfiles.length, 1);
  assert.ok(mapped.source.boundsSpheres.every(Number.isFinite));
  assert.ok(mapped.source.boundsMin.every(Number.isFinite));
  assert.ok(mapped.source.boundsMax.every(Number.isFinite));
  cooked.revision.release();
});

test("the runtime Scene producer keeps Product identity stable and supports replacement", async () => {
  const module = await cookerModule();
  const first = await cookSceneGeometryProductV1(meshScene(), { ...COOK_OPTIONS, module });
  const second = await cookSceneGeometryProductV1(meshScene(), { ...COOK_OPTIONS, module });
  assert.deepEqual(second.revision.productId, first.revision.productId, "identical Scene content must reuse the Product identity");
  const other = await cookSceneGeometryProductV1(meshScene({ geometry: () => new BoxGeometry(1, 3, 1) }), { ...COOK_OPTIONS, module });
  assert.notDeepEqual(other.revision.productId, first.revision.productId, "different content must not reuse the Product identity");

  const replacement = await cookSceneGeometryProductV1(meshScene(), {
    ...COOK_OPTIONS,
    module,
    revision: 1,
    replaces: { productId: first.revision.product.productId, revision: first.revision.product.revision }
  });
  assert.equal(replacement.revision.revision, 1);
  assert.deepEqual(replacement.revision.product.replaces.productId, first.revision.product.productId);
  assert.equal(replacement.revision.product.replaces.revision, 0);
  assert.deepEqual(replacement.revision.productId, first.revision.productId, "a replacement keeps the Product identity");

  await assert.rejects(cookSceneGeometryProductV1(meshScene(), { ...COOK_OPTIONS, module, revision: 0, replaces: { productId: first.revision.product.productId, revision: 0 } }), /newer than the revision it replaces/u);
  first.revision.release(); second.revision.release(); other.revision.release(); replacement.revision.release();
});

test("the runtime Scene producer rejects unsupported or empty input", async () => {
  const module = await cookerModule();
  const empty = new Scene();
  assert.throws(() => canonicalizeSceneGeometryV1(empty), /non-empty Scene/u);
  const foreign = new Scene();
  const mesh = new Mesh();
  mesh.geometry = {
    name: "not-meshlet-packed",
    bounding_box: new Float32Array([-1, -1, -1, 1, 1, 1]),
    bounding_sphere: new Float32Array([0, 0, 0, 1])
  };
  mesh.material = new StandardShadeMaterial();
  foreign.add(mesh);
  assert.throws(() => canonicalizeSceneGeometryV1(foreign), /meshlet-packed geometry/u);
  await assert.rejects(cookSceneGeometryProductV1(meshScene(), { ...COOK_OPTIONS, module: undefined }), /WASM cooker module/u);

  // Transparency routing must reach the canonical meshlet flags the cooker publishes.
  const scene = meshScene();
  scene.instances.instances[0].material.transparency_mode = ShadeTransparencyMode.Transparent;
  const canonical = canonicalizeSceneGeometryV1(scene);
  assert.equal(canonical.domains[0].meshletFlags & 0x7, 4, "a transparent material must publish the blend meshlet flag");
});
