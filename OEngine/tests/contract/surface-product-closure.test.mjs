import assert from "node:assert/strict";
import test from "node:test";

import "../webgpu-test-globals.mjs";

import {
  SURFACE_PRODUCT, SURFACE_PRODUCT_CONTRACTS,
  surfaceProgramKey, surfaceBindingRevision
} from "../../.test-dist/render/surface/SurfaceProducts.js";

test("logical Surface values distinguish normals, motion, radiance and material identity", () => {
  assert.equal(Object.keys(SURFACE_PRODUCT).length, 5);
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.GeometricNormal].space, "world");
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.ShadingNormal].space, "world");
  assert.notEqual(SURFACE_PRODUCT.GeometricNormal, SURFACE_PRODUCT.ShadingNormal);
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.Motion].space,
    "current-uv-minus-previous-uv");
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.Radiance].exposure, "pre-exposed");
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.MaterialIdentity].precision, "integer-exact");
  for (const contract of Object.values(SURFACE_PRODUCT_CONTRACTS)) {
    assert.equal(contract.coverage, "opaque-visibility-hit");
    assert.equal(contract.missing, "no-hit-or-explicit-error");
    assert.equal(contract.resolution, "internal-full");
    assert.equal(Object.hasOwn(contract, "textureFormat"), false);
  }
});

test("Surface program closure excludes publication generations but includes shader and layout", () => {
  const closure = {
    kernel: { programId: 4, outputDependencyMask: 0, textureBankMask: 1 },
    virtualGeometry: true, lighting: "direct", source: "@compute fn shade() {}",
    layoutSignature: "frame/scene/material/light-v1",
    capabilityFingerprint: "adapter-capability-v1", formatProfile: "rgba16float"
  };
  const key = surfaceProgramKey(closure);
  const first = surfaceBindingRevision({
    programKey: key, publicationRevision: 1, materialGeneration: 2,
    textureGeneration: 3, sceneResourceEpoch: 4, deviceEpoch: 5
  });
  const next = surfaceBindingRevision({ ...first, publicationRevision: 2, textureGeneration: 4 });
  assert.equal(first.programKey, next.programKey);
  assert.notDeepEqual(first, next);
  assert.notEqual(key, surfaceProgramKey({ ...closure, source: "@compute fn shade2() {}" }));
  assert.notEqual(key, surfaceProgramKey({ ...closure, layoutSignature: "changed" }));
  assert.notEqual(key, surfaceProgramKey({ ...closure, capabilityFingerprint: "different" }));
  assert.notEqual(key, surfaceProgramKey({ ...closure, kernel: { ...closure.kernel, programId: 5 } }));
  assert.throws(() => surfaceProgramKey({ ...closure, source: "" }), /source is required/);
  assert.throws(() => surfaceBindingRevision({ ...first, deviceEpoch: -1 }), /deviceEpoch/);
});
