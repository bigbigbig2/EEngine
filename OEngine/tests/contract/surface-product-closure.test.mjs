import assert from "node:assert/strict";
import test from "node:test";

import "../webgpu-test-globals.mjs";

import {
  SURFACE_PRODUCT, SURFACE_PRODUCT_CONTRACTS,
  surfaceProgramKey, surfaceBindingRevision,
  surfaceMaterialRequirements, closeSurfaceBindings
} from "../../.test-dist/render/surface/SurfaceProducts.js";
import { GPU_SURFACE_KERNEL_DEMAND } from "../../.test-dist/gpu/GpuSurfaceProgramSpecialization.js";
import { surfaceSampleWorkerWgsl } from "../../.test-dist/shaders/surface_sample_worker.js";
import { planSurfaceKernelBindings, compileSurfaceProgramLayout,
  createSurfaceBindGroupLayouts } from
  "../../.test-dist/render/surface/SurfaceKernelBindingPlan.js";

const desktopLimits = Object.freeze({
  maxBindGroups: 4, maxBindingsPerBindGroup: 16,
  maxStorageBuffersPerShaderStage: 16, maxStorageTexturesPerShaderStage: 2,
  maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 12
});

test("sample workers share the resource closure without motion or HDR readback", () => {
  const plan = compileSurfaceProgramLayout({
    kernel: { programId: 15, outputDependencyMask: 0, textureBankMask: 0x1ff },
    virtualGeometry: false, lighting: "direct", source: "surface-samples-v1",
    capabilityFingerprint: "webgpu-core", formatProfile: "rgba16float"
  }, desktopLimits).plan;
  for (const mode of ["implicit", "compact", "fallback"]) {
    const source = surfaceSampleWorkerWgsl(plan, mode, true, false);
    const actual = [...source.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)/gu)]
      .map(match => match[1] + ":" + match[2]).sort();
    assert.deepEqual(actual, plan.bindings.map(binding => binding.group + ":" + binding.binding).sort());
    assert.match(source, /fn shade\(/u);
    assert.doesNotMatch(source, /output_motion|textureLoad\(output_hdr|previous_object_to_world\s*\*/u);
  }
});

test("logical Surface values distinguish normals, radiance and material identity; motion belongs to Temporal", () => {
  assert.equal(Object.keys(SURFACE_PRODUCT).length, 6);
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.GeometricNormal].space, "world");
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.ShadingNormal].space, "world");
  assert.notEqual(SURFACE_PRODUCT.GeometricNormal, SURFACE_PRODUCT.ShadingNormal);
  assert.equal(SURFACE_PRODUCT.Motion, undefined);
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.Radiance].exposure, "pre-exposed");
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.MaterialIdentity].precision, "integer-exact");
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.IndirectVisibility].coverage, "full-internal");
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.IndirectVisibility].missing, "neutral-one");
  for (const contract of Object.values(SURFACE_PRODUCT_CONTRACTS)) {
    if (contract.kind !== SURFACE_PRODUCT.IndirectVisibility) {
      assert.equal(contract.coverage, "opaque-visibility-hit");
      assert.equal(contract.missing, "no-hit-or-explicit-error");
    }
    assert.equal(contract.resolution, "internal-full");
    assert.equal(Object.hasOwn(contract, "textureFormat"), false);
  }
});

test("material resource closure follows triangle, texture and direct-light demands", () => {
  const base = {
    kernel: { programId: 0, outputDependencyMask: 0, textureBankMask: 0 },
    virtualGeometry: false, lighting: "direct", source: "surface-samples-v1",
    layoutSignature: "new-surface", capabilityFingerprint: "portable", formatProfile: "rgba16float"
  };
  const unlit = surfaceMaterialRequirements(base);
  assert.equal(unlit.triangleReconstruction, false);
  assert.equal(unlit.directLighting, false);
  assert.deepEqual(unlit.roles, [
    "shading-work", "visibility-key", "sample-results", "meshlet-work",
    "material-records", "frame-view", "pre-exposure", "radiance-output",
    "sample-profile"
  ]);
  const texturedPbr = { ...base, virtualGeometry: true,
    kernel: { programId: 15, outputDependencyMask: 0, textureBankMask: 3 }
  };
  const pbr = surfaceMaterialRequirements(texturedPbr);
  assert.equal(pbr.triangleReconstruction, true);
  assert.equal(pbr.directLighting, true);
  for (const role of ["instance-records", "vertex-payload", "visibility-depth",
    "virtual-product-metadata", "virtual-product-banks", "texture-routes",
    "texture-banks", "texture-samplers", "direct-light-records",
    "direct-light-cluster-lookup", "direct-light-cluster-data",
    "direct-light-cluster-params"]) {
    assert.ok(pbr.roles.includes(role), role);
  }
  assert.throws(() => surfaceMaterialRequirements({ ...base,
    kernel: { ...base.kernel, textureBankMask: 1 }
  }), /no Surface consumer/);
  assert.throws(() => surfaceMaterialRequirements({ ...texturedPbr,
    kernel: { ...texturedPbr.kernel, textureBankMask: 0 }
  }), /requires a texture bank/);
});

test("physical Surface closure stays within the negotiated WebGPU envelope", () => {
  const base = {
    kernel: { programId: 0, outputDependencyMask: 0, textureBankMask: 0 },
    virtualGeometry: false, lighting: "unlit", source: "surface-samples-v1",
    layoutSignature: "generated", capabilityFingerprint: "desktop", formatProfile: "rgba16float"
  };
  const narrow = planSurfaceKernelBindings(base, desktopLimits);
  assert.deepEqual(narrow.totals, {
    storageBuffers: 3, storageTextures: 2, sampledTextures: 1,
    samplers: 0, uniformBuffers: 3
  });
  assert.deepEqual(narrow.bindings.map(binding => binding.role), [
    "shading-work", "meshlet-work", "material-records", "frame-view", "pre-exposure", "radiance-output",
    "visibility-key", "sample-profile", "sample-results"
  ]);
  const full = { ...base, virtualGeometry: true, lighting: "direct",
    kernel: { programId: 15, outputDependencyMask: 0,
      textureBankMask: 0x1ff } };
  const plan = planSurfaceKernelBindings(full, desktopLimits);
  assert.deepEqual(plan.totals, {
    storageBuffers: 15, storageTextures: 2, sampledTextures: 15,
    samplers: 8, uniformBuffers: 5
  });
  const aoPlan = planSurfaceKernelBindings({ ...full, aoProfile: "scalar-high" }, desktopLimits);
  assert.equal(aoPlan.totals.storageBuffers, 16);
  assert.equal(aoPlan.bindings.find(binding => binding.role === "indirect-visibility")?.kind,
    "read-only-storage");
  assert.equal(new Set(plan.bindings.map(binding =>
    `${binding.group}:${binding.binding}`)).size, plan.bindings.length);
  assert.equal(plan.bindings.filter(binding => binding.role === "virtual-product-banks").length, 4);
  assert.equal(plan.bindings.filter(binding => binding.role === "texture-banks").length, 9);
  assert.throws(() => planSurfaceKernelBindings(full, {
    ...desktopLimits, maxStorageBuffersPerShaderStage: 14
  }), /maxStorageBuffersPerShaderStage >= 15/);
  assert.throws(() => planSurfaceKernelBindings(full, {
    ...desktopLimits, maxBindingsPerBindGroup: 15
  }), /maxBindingsPerBindGroup >= 16/);
  assert.throws(() => planSurfaceKernelBindings(full, {
    ...desktopLimits, maxBindGroups: 3
  }), /maxBindGroups >= 4/);
  assert.notEqual(plan.signature, narrow.signature);
  const compiled = compileSurfaceProgramLayout({
    kernel: full.kernel, virtualGeometry: full.virtualGeometry,
    lighting: full.lighting, source: full.source,
    capabilityFingerprint: full.capabilityFingerprint,
    formatProfile: full.formatProfile
  }, desktopLimits);
  assert.equal(compiled.closure.layoutSignature, plan.signature);
  assert.equal(compiled.plan.signature, plan.signature);
  const compact = compileSurfaceProgramLayout({
    kernel: { ...full.kernel, textureBankMask: 1 },
    virtualGeometry: true, virtualBankCount: 1, lighting: "direct",
    source: full.source, capabilityFingerprint: full.capabilityFingerprint,
    formatProfile: full.formatProfile
  }, desktopLimits);
  assert.equal(compact.plan.bindings.filter(binding => binding.role === "virtual-product-banks").length, 1);
  assert.equal(compact.plan.bindings.filter(binding => binding.role === "texture-banks").length, 1);
  assert.notEqual(compact.plan.signature, plan.signature);
  const compactWgsl = surfaceSampleWorkerWgsl(compact.plan, "implicit", true, true, false, 1, 1);
  assert.match(compactWgsl, /virtual_product_bank_0/);
  assert.doesNotMatch(compactWgsl, /virtual_product_bank_1/);
  assert.equal([...compactWgsl.matchAll(/struct OEngineInstanceRecord\s*\{/gu)].length, 1);
  const withoutSky = compileSurfaceProgramLayout({
    ...compact.closure, physicalEnvironment: false, layoutSignature: "without-sky"
  }, desktopLimits);
  assert.equal(withoutSky.plan.bindings.some(binding =>
    binding.role.startsWith("physical-")), false);
  const noSkyWgsl = surfaceSampleWorkerWgsl(withoutSky.plan, "implicit",
    true, true, false, 1, 1, false);
  assert.doesNotMatch(noSkyWgsl, /physical_environment_sun|atmosphere_world_to_planet/u);
  assert.match(noSkyWgsl, /return direct \+ surface\.emissive;/u);
  const emitted = [];
  const fakeDevice = { createBindGroupLayout(descriptor) {
    emitted.push(descriptor);
    return descriptor;
  } };
  createSurfaceBindGroupLayouts(fakeDevice, plan);
  assert.equal(emitted.length, 4);
  assert.equal(emitted[0].entries.find(entry => entry.binding === 4)
    .storageTexture.format, "rgba16float");
  assert.equal(emitted[0].entries.find(entry => entry.binding === 5)
    .texture.sampleType, "depth");
  assert.equal(emitted[2].entries.find(entry => entry.binding === 9)
    .texture.viewDimension, "2d-array");
  emitted.length = 0;
  createSurfaceBindGroupLayouts(fakeDevice, narrow);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].entries.length, 9);
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
