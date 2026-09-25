import assert from "node:assert/strict";
import test from "node:test";

import "../webgpu-test-globals.mjs";

import {
  SURFACE_PRODUCT, SURFACE_PRODUCT_CONTRACTS,
  surfaceProgramKey, surfaceBindingRevision,
  surfaceMaterialRequirements, closeSurfaceBindings
} from "../../.test-dist/render/surface/SurfaceProducts.js";
import { GPU_SURFACE_KERNEL_DEMAND } from "../../.test-dist/gpu/GpuSurfaceProgramSpecialization.js";

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

test("material resource closure follows triangle, texture and direct-light demands", () => {
  const base = {
    kernel: { programId: 0, outputDependencyMask: 0, textureBankMask: 0 },
    virtualGeometry: false, lighting: "direct", source: "kernel",
    layoutSignature: "new-surface", capabilityFingerprint: "portable", formatProfile: "rgba16float"
  };
  const unlit = surfaceMaterialRequirements(base);
  assert.equal(unlit.triangleReconstruction, false);
  assert.equal(unlit.directLighting, false);
  assert.deepEqual(unlit.roles, [
    "visibility-key", "meshlet-work", "material-records", "frame-view", "radiance-output"
  ]);
  const texturedPbr = { ...base, virtualGeometry: true,
    kernel: { programId: 15, outputDependencyMask: GPU_SURFACE_KERNEL_DEMAND.Motion, textureBankMask: 3 }
  };
  const pbr = surfaceMaterialRequirements(texturedPbr);
  assert.equal(pbr.triangleReconstruction, true);
  assert.equal(pbr.directLighting, true);
  for (const role of ["instance-records", "vertex-payload", "visibility-depth",
    "virtual-product-metadata", "virtual-product-banks", "texture-routes",
    "texture-banks", "texture-samplers", "direct-light-records", "direct-light-clusters"]) {
    assert.ok(pbr.roles.includes(role), role);
  }
  assert.throws(() => surfaceMaterialRequirements({ ...base,
    kernel: { ...base.kernel, textureBankMask: 1 }
  }), /no Surface consumer/);
  assert.throws(() => surfaceMaterialRequirements({ ...texturedPbr,
    kernel: { ...texturedPbr.kernel, textureBankMask: 0 }
  }), /requires a texture bank/);
});

test("publication bindings close only the selected program's resource demand", () => {
  const closure = {
    kernel: { programId: 0, outputDependencyMask: 0, textureBankMask: 0 },
    virtualGeometry: false, lighting: "unlit", source: "kernel",
    layoutSignature: "new-surface", capabilityFingerprint: "portable", formatProfile: "rgba16float"
  };
  const revision = {
    programKey: surfaceProgramKey(closure), publicationRevision: 1, materialGeneration: 1,
    textureGeneration: 1, sceneResourceEpoch: 1, deviceEpoch: 1
  };
  const resources = Object.fromEntries(surfaceMaterialRequirements(closure).roles.map(role => [role, {}]));
  assert.deepEqual(Object.keys(closeSurfaceBindings(closure, revision, resources).resources), Object.keys(resources));
  assert.throws(() => closeSurfaceBindings(closure, revision,
    Object.fromEntries(Object.entries(resources).filter(([role]) => role !== "material-records"))),
  /missing material-records/);
  assert.throws(() => closeSurfaceBindings(closure, revision,
    { ...resources, "texture-routes": {} }), /no consumer/);
  assert.throws(() => closeSurfaceBindings(closure,
    { ...revision, programKey: "another-program" }, resources), /identity mismatch/);
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
