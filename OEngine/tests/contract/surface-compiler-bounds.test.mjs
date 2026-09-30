import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { materialEvaluationWgsl } from "../../.test-dist/shaders/surface_material_evaluation.js";
import { ShaderModuleCache } from "../../.test-dist/gpu/GPUDescriptorCaches.js";
import { packSurfaceSampleDispatch, SURFACE_SAMPLE_DISPATCH } from "../../.test-dist/render/surface/SurfaceSampleAbi.js";
import { surfaceSampleWorkerWgsl } from "../../.test-dist/shaders/surface_sample_worker.js";
import { compileSurfaceProgramLayout } from "../../.test-dist/render/surface/SurfaceKernelBindingPlan.js";

test("all bounded work kinds share one heavy worker with a uniform dispatch ABI", () => {
  const limits = { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxStorageBuffersPerShaderStage: 16,
    maxStorageTexturesPerShaderStage: 2, maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 8,
    maxUniformBuffersPerShaderStage: 12 };
  const { plan } = compileSurfaceProgramLayout({ kernel: { programId: 15, outputDependencyMask: 0, textureBankMask: 1 },
    virtualGeometry: false, lighting: "direct", physicalEnvironment: false,
    source: "surface-samples-v1", capabilityFingerprint: "webgpu-core", formatProfile: "rgba16float" }, limits);
  const source = surfaceSampleWorkerWgsl(plan, true, false, false, 0, 1, false);
  assert.equal([...source.matchAll(/@compute/gu)].length, 1);
  assert.equal([...source.matchAll(/\bsurface_write\(/gu)].length, 2); // Definition and one common call.
  assert.match(source, /@workgroup_size\(64\)/u);
  for (const mode of ["implicit", "compact", "fallback"]) {
    assert.deepEqual([...packSurfaceSampleDispatch(3, mode)], [3, SURFACE_SAMPLE_DISPATCH[mode], 0, 0]);
    assert.match(source, new RegExp(`sample_dispatch.y==${SURFACE_SAMPLE_DISPATCH[mode]}u`));
  }
  assert.throws(() => packSurfaceSampleDispatch(4, "implicit"), RangeError);
  assert.match(source, /sample_load\(sample_tile\(tile\)\)!=2u/u);
  assert.match(source, /sample_load\(sample_tile\(tile\)\)!=3u/u);
  assert.match(source, /pixel.x>=shading_view.width \|\| pixel.y>=shading_view.height/u);
});

test("generic PBR shares one bounded sampling site across all ten material roles", () => {
  const source = materialEvaluationWgsl({ programId: 15, outputDependencyMask: 0, textureBankMask: 12 });
  assert.equal([...source.matchAll(/\bsparse_sample\(/gu)].length, 1);
  assert.match(source, /role_slot<10u/u);
  for (let slot = 0; slot < 10; slot++) {
    assert.match(source, new RegExp(`case ${slot}u:`));
    assert.match(source, new RegExp(`let sample_${slot}=role_samples\\[${slot}\\]`));
  }
  for (const field of ["texture_ref", "normal_texture_ref", "orm_texture_ref", "emissive_texture_ref", "occlusion_texture_ref"]) {
    assert.ok(source.includes(`material.payload.${field}`));
  }
  for (const role of ["specular", "specular_color", "coat", "coat_roughness", "coat_normal"]) {
    assert.ok(source.includes(`texture_role=material.closure.${role};`));
  }
  assert.match(source, /if !role_active \{ continue; \}/u);
  assert.match(source, /sparse_texture_route_valid\(material_slot,role_slot,texture_role.texture_ref\)/u);
  assert.match(source, /sparse_transform_closure_uv\(texture_role,uv_dx,true\)/u);
  assert.match(source, /gradient_valid,role_samples\[role_slot\]/u);
  assert.match(source, /vec4f\(0\.5,0\.5,1\.0,1\.0\)/u);
});

test("coat exclusion and fixed material specialization retain their exact read sets", () => {
  const withoutCoat = materialEvaluationWgsl({ programId: 15, outputDependencyMask: 0, textureBankMask: 1 }, false, false);
  assert.match(withoutCoat, /role_slot<7u/u);
  for (const slot of [7, 8, 9]) assert.doesNotMatch(withoutCoat, new RegExp(`case ${slot}u:`));
  const factor = materialEvaluationWgsl({ programId: 4, outputDependencyMask: 0, textureBankMask: 1 });
  assert.doesNotMatch(factor, /role_slot|sparse_sample\(/u);
  const unlit = materialEvaluationWgsl({ programId: 3, outputDependencyMask: 0, textureBankMask: 1 }, true);
  assert.doesNotMatch(unlit, /role_slot|material\.closure\.coat/u);
});

test("shader diagnostics retain the failing label and settle rejected validation scopes", async () => {
  const recorded = [];
  const prior = console.error;
  console.error = (...args) => recorded.push(args);
  try {
    const cache = new ShaderModuleCache({
      pushErrorScope() {},
      createShaderModule() { return { getCompilationInfo: () => Promise.reject(new Error("Instance dropped")) }; },
      popErrorScope: () => Promise.reject(new Error("Instance dropped"))
    });
    cache.obtain({ label: "Surface/samples implicit", code: "@compute @workgroup_size(1) fn shade() {}" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recorded.length, 2);
    assert.ok(recorded.every(args => args[0].includes("Surface/samples implicit")));
    cache.clear();
    assert.deepEqual(cache.diagnostics, []);
  } finally { console.error = prior; }
});
