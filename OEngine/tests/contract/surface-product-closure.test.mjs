import assert from "node:assert/strict";
import test from "node:test";

import "../webgpu-test-globals.mjs";

import {
  SURFACE_PRODUCT, SURFACE_PRODUCT_CONTRACTS,
  surfaceProgramKey, surfaceBindingRevision,
  surfaceMaterialRequirements, closeSurfaceBindings
} from "../../.test-dist/render/surface/SurfaceProducts.js";
import { GPU_SURFACE_KERNEL_DEMAND } from "../../.test-dist/gpu/GpuSurfaceProgramSpecialization.js";
import { surfaceExecutionWgsl, SURFACE_WORK_CONTROL_WGSL } from
  "../../.test-dist/shaders/surface_execution.js";
import { SURFACE_EXCEPTION_LANES, surfaceExceptionLane, surfaceLaneCapacity } from
  "../../.test-dist/render/surface/SurfaceExecutionAbi.js";
import { planSurfaceKernelBindings, compileSurfaceProgramLayout,
  createSurfaceBindGroupLayouts } from
  "../../.test-dist/render/surface/SurfaceKernelBindingPlan.js";

const desktopLimits = Object.freeze({
  maxBindGroups: 4, maxBindingsPerBindGroup: 16,
  maxStorageBuffersPerShaderStage: 16, maxStorageTexturesPerShaderStage: 2,
  maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 4
});

test("production Surface has bounded Dense, Binned and whole-lane overflow paths", () => {
  assert.equal(SURFACE_EXCEPTION_LANES, 7);
  assert.equal(surfaceExceptionLane(0, true), 0);
  assert.equal(surfaceExceptionLane(1, false), 1);
  assert.equal(surfaceExceptionLane(3, true), 6);
  assert.throws(() => surfaceExceptionLane(0, false), /Dense/);
  const queue = surfaceLaneCapacity(64, 64, {
    maxBufferSize: 65536, maxStorageBufferBindingSize: 65536,
    maxComputeWorkgroupsPerDimension: 65535
  });
  assert.equal(queue.capacity, Math.ceil(64 * 64 / 7));
  assert.match(SURFACE_WORK_CONTROL_WGSL, /attempted>work\.header\.capacity/);
  assert.match(SURFACE_WORK_CONTROL_WGSL, /vec4u\(0u,0u,1u,0u\),overflow/);
  const plan = compileSurfaceProgramLayout({
    kernel: { programId: 15, outputDependencyMask: GPU_SURFACE_KERNEL_DEMAND.Motion,
      textureBankMask: 0x1ff },
    virtualGeometry: false, lighting: "direct", source: "surface-execution-v2",
    capabilityFingerprint: "webgpu-core", formatProfile: "rgba16float"
  }, desktopLimits).plan;
  for (const [mode, lane] of [["dense", 0], ["binned", 1], ["binned", 0],
    ["fallback", 1], ["fallback", 0]]) {
    const source = surfaceExecutionWgsl(plan, mode, lane, true, false);
    const actual = [...source.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)/gu)]
      .map(match => `${match[1]}:${match[2]}`).sort();
    assert.deepEqual(actual, plan.bindings.map(binding =>
      `${binding.group}:${binding.binding}`).sort());
    assert.match(source, /fn shade\(/u);
    assert.doesNotMatch(source, /ShadingWorkClassesRead/u);
    if (mode === "dense") {
      assert.match(source, /oengine_shading_anchor\(pixel\)==pixel/u);
      assert.match(source, /surface_store\(pixel,vec4f\(radiance/u);
      assert.match(source, /textureStore\(output_motion,vec2i\(output_pixel\),motion\)/u);
    }
  }
});

test("logical Surface values distinguish normals, motion, radiance and material identity", () => {
  assert.equal(Object.keys(SURFACE_PRODUCT).length, 7);
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.GeometricNormal].space, "world");
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.ShadingNormal].space, "world");
  assert.notEqual(SURFACE_PRODUCT.GeometricNormal, SURFACE_PRODUCT.ShadingNormal);
  assert.equal(SURFACE_PRODUCT_CONTRACTS[SURFACE_PRODUCT.Motion].space,
    "current-uv-minus-previous-uv");
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
    virtualGeometry: false, lighting: "direct", source: "surface-execution-v2",
    layoutSignature: "new-surface", capabilityFingerprint: "portable", formatProfile: "rgba16float"
  };
  const unlit = surfaceMaterialRequirements(base);
  assert.equal(unlit.triangleReconstruction, false);
  assert.equal(unlit.directLighting, false);
  assert.deepEqual(unlit.roles, [
    "shading-work", "visibility-key", "frequency-plan", "meshlet-work",
    "material-records", "frame-view", "radiance-output", "motion-output",
    "exception-lane"
  ]);
  const texturedPbr = { ...base, virtualGeometry: true,
    kernel: { programId: 15, outputDependencyMask: GPU_SURFACE_KERNEL_DEMAND.Motion, textureBankMask: 3 }
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
    virtualGeometry: false, lighting: "unlit", source: "surface-execution-v2",
    layoutSignature: "generated", capabilityFingerprint: "desktop", formatProfile: "rgba16float"
  };
  const narrow = planSurfaceKernelBindings(base, desktopLimits);
  assert.deepEqual(narrow.totals, {
    storageBuffers: 3, storageTextures: 2, sampledTextures: 2,
    samplers: 0, uniformBuffers: 2
  });
  assert.deepEqual(narrow.bindings.map(binding => binding.role), [
    "shading-work", "meshlet-work", "material-records", "frame-view", "radiance-output",
    "motion-output", "visibility-key", "exception-lane", "frequency-plan"
  ]);
  const full = { ...base, virtualGeometry: true, lighting: "direct",
    kernel: { programId: 15, outputDependencyMask: GPU_SURFACE_KERNEL_DEMAND.Motion,
      textureBankMask: 0x1ff } };
  const plan = planSurfaceKernelBindings(full, desktopLimits);
  assert.deepEqual(plan.totals, {
    storageBuffers: 15, storageTextures: 2, sampledTextures: 16,
    samplers: 8, uniformBuffers: 4
  });
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
