import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  GPU_SPARSE_SHADING_REQUIRED_LIMITS
} from "../.test-dist/gpu/GpuSparseShadingCapability.js";
import {
  createGpuSparseShadingPipelineDescriptor,
  GPU_SHADING_OUTPUT_DEPENDENCY,
  gpuSparseShadingBindGroupLayoutDescriptors,
  gpuSparseShadingBindingDeclarationsWgsl,
  gpuSparseShadingContractModuleWgsl,
  gpuSparseShadingPipelineBindingBudget
} from "../.test-dist/gpu/GpuSparseShadingPipelineContract.js";
import {
  GPU_SPARSE_SHADING_BINDING_GROUP_LIMITS,
  GPU_SPARSE_SHADING_STAGE_LIMITS
} from "../.test-dist/gpu/GpuShadingBindingBudget.js";
import {
  GPU_SHADING_PROGRAM,
  shadingProgramUsesTextures
} from "../.test-dist/gpu/GpuShadingProgramAbi.js";

const adapter = {
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: { ...GPU_SPARSE_SHADING_REQUIRED_LIMITS, subgroupMinSize: 4, subgroupMaxSize: 128 }
};
const plan = createGpuSparseShadingCapabilityPlan(adapter);
const capability = captureGpuSparseShadingCapabilityRecord(plan, {
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: { ...GPU_SPARSE_SHADING_REQUIRED_LIMITS, subgroupMinSize: 4, subgroupMaxSize: 128 },
  textureFormatFeatures: ["texture-formats-tier1"],
  formatProfile: "desktop-tier1-v1"
});
const bindingLimits = {
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 17,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 8,
  maxStorageBuffersPerShaderStage: 10,
  maxStorageTexturesPerShaderStage: 5,
  maxUniformBuffersPerShaderStage: 4
};

function descriptor(programId, textureBindingSetId, outputDependencyMask, extra = {}) {
  return createGpuSparseShadingPipelineDescriptor({
    programId,
    textureBindingSetId,
    outputDependencyMask,
    capability,
    ...extra
  });
}

function names(value) {
  return value.groups.flatMap((group) => group.bindings.map((binding) => binding.name));
}

test("pipeline cache identity changes for every compiled dimension and ignores runtime noise", () => {
  const base = descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 0, 0);
  assert.notEqual(base.cacheKey, descriptor(GPU_SHADING_PROGRAM.PbrBase, 0, 0).cacheKey);
  assert.notEqual(base.cacheKey, descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 1, 0).cacheKey);
  assert.notEqual(base.cacheKey, descriptor(
    GPU_SHADING_PROGRAM.PbrGeneric,
    0,
    GPU_SHADING_OUTPUT_DEPENDENCY.Velocity
  ).cacheKey);
  assert.notEqual(base.cacheKey, descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 0, 0, {
    capability: { ...capability, fingerprint: `${capability.fingerprint}:changed` }
  }).cacheKey);
  assert.notEqual(base.cacheKey, descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 0, 0, {
    capability: { ...capability, formatProfile: "desktop-tier1-v2" }
  }).cacheKey);
  const withNoise = createGpuSparseShadingPipelineDescriptor({
    programId: GPU_SHADING_PROGRAM.PbrGeneric,
    textureBindingSetId: 0,
    outputDependencyMask: 0,
    capability,
    frameIndex: 999,
    visibleBinCount: 7
  });
  assert.equal(base.cacheKey, withNoise.cacheKey);
  assert.equal(base.binId, GPU_SHADING_PROGRAM.PbrGeneric);
  assert.throws(() => descriptor(GPU_SHADING_PROGRAM.UnlitFactor, 1, 0), /Textureless/u);
  assert.throws(() => descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 0, 8), /reserved bits/u);
});

test("widest PbrGeneric specialization exactly reaches the frozen four-group budget", () => {
  const widest = descriptor(
    GPU_SHADING_PROGRAM.PbrGeneric,
    3,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.Velocity
  );
  const budget = gpuSparseShadingPipelineBindingBudget(widest, bindingLimits);
  assert.equal(budget.schemaVersion, 2);
  assert.deepEqual(budget.groups, GPU_SPARSE_SHADING_BINDING_GROUP_LIMITS);
  assert.deepEqual(budget.totals, {
    sampledTextures: 16,
    samplers: 8,
    storageBuffers: 10,
    storageTextures: 5,
    uniformBuffers: 4
  });
  assert.deepEqual(GPU_SPARSE_SHADING_STAGE_LIMITS, {
    bindGroups: 4,
    sampledTextures: 16,
    samplers: 8,
    storageBuffers: 10,
    storageTextures: 5,
    uniformBuffers: 4
  });
  assert.throws(
    () => gpuSparseShadingPipelineBindingBudget(widest, {
      ...bindingLimits,
      maxStorageBuffersPerShaderStage: 9
    }),
    /maxStorageBuffersPerShaderStage >= 10/u
  );
  assert.throws(
    () => gpuSparseShadingPipelineBindingBudget(widest, {
      ...bindingLimits,
      maxBindingsPerBindGroup: 16
    }),
    /maxBindingsPerBindGroup >= 17/u
  );
});

test("all concrete program, set and output specializations derive legal budgets", () => {
  let variants = 0;
  for (let programId = 0; programId < 16; programId++) {
    const sets = shadingProgramUsesTextures(programId) ? [0, 1, 2, 3] : [0];
    for (const textureBindingSetId of sets) {
      for (let outputDependencyMask = 0; outputDependencyMask < 8; outputDependencyMask++) {
        const value = descriptor(programId, textureBindingSetId, outputDependencyMask);
        const budget = gpuSparseShadingPipelineBindingBudget(value, bindingLimits);
        assert.ok(value.groups.length <= 4);
        assert.ok(budget.totals.sampledTextures <= 16);
        assert.ok(budget.totals.samplers <= 8);
        assert.ok(budget.totals.storageBuffers <= 10);
        assert.ok(budget.totals.storageTextures <= 5);
        assert.ok(budget.totals.uniformBuffers <= 4);
        variants++;
      }
    }
  }
  assert.equal(variants, 440);
});

test("textureless, unlit and ColorOnly variants physically omit unused declarations", () => {
  const unlitColorOnly = descriptor(GPU_SHADING_PROGRAM.UnlitFactor, 0, 0);
  const unlitNames = names(unlitColorOnly);
  assert.deepEqual(unlitColorOnly.groups.map((group) => group.group), [0, 1, 2]);
  assert.ok(unlitNames.includes("shading_bin_id"));
  assert.ok(unlitNames.includes("visibility_key"));
  assert.ok(unlitNames.includes("meshlet_work"));
  assert.ok(unlitNames.includes("material_records"));
  assert.ok(unlitNames.includes("shading_view"));
  for (const forbidden of [
    "visibility_depth",
    "instance_records",
    "asset_metadata_heap",
    "vertex_payload_heap",
    "texture_descriptor_routing_heap",
    "light_database",
    "output_normal",
    "output_albedo_ao",
    "output_material",
    "output_velocity"
  ]) assert.ok(!unlitNames.includes(forbidden), forbidden);
  assert.ok(!unlitNames.some((name) => name.startsWith("material_texture_")));
  assert.ok(!unlitNames.some((name) => name.startsWith("material_sampler_")));
  assert.ok(!unlitNames.some((name) => name.startsWith("lighting_")));

  const pbrTextureless = descriptor(GPU_SHADING_PROGRAM.PbrFactor, 0, 0);
  const pbrNames = names(pbrTextureless);
  assert.ok(pbrNames.includes("light_database"));
  assert.ok(!pbrNames.includes("texture_descriptor_routing_heap"));
  assert.ok(!pbrNames.some((name) => name.startsWith("material_texture_")));

  const texturedUnlit = descriptor(GPU_SHADING_PROGRAM.UnlitTexture, 2, 0);
  const texturedNames = names(texturedUnlit);
  assert.ok(texturedNames.includes("texture_descriptor_routing_heap"));
  assert.ok(texturedNames.includes("material_texture_8"));
  assert.ok(!texturedNames.includes("light_database"));
});

test("output dependency bits add only their exact storage outputs", () => {
  const colorOnly = names(descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 0, 0));
  const shading = names(descriptor(
    GPU_SHADING_PROGRAM.PbrGeneric,
    0,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite
  ));
  const diffuse = names(descriptor(
    GPU_SHADING_PROGRAM.PbrGeneric,
    0,
    GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite
  ));
  const velocity = names(descriptor(
    GPU_SHADING_PROGRAM.PbrGeneric,
    0,
    GPU_SHADING_OUTPUT_DEPENDENCY.Velocity
  ));
  assert.ok(colorOnly.includes("output_hdr"));
  assert.ok(!colorOnly.includes("output_normal"));
  assert.ok(shading.includes("output_normal"));
  assert.ok(shading.includes("output_albedo_ao"));
  assert.ok(shading.includes("output_material"));
  assert.ok(!shading.includes("output_velocity"));
  assert.ok(!diffuse.includes("output_normal"));
  assert.ok(diffuse.includes("output_albedo_ao"));
  assert.ok(diffuse.includes("output_material"));
  assert.ok(velocity.includes("output_velocity"));
  assert.ok(!velocity.includes("output_normal"));
});

test("binding schema, generated WGSL and BGL descriptors agree on every binding", () => {
  const value = descriptor(
    GPU_SHADING_PROGRAM.PbrGeneric,
    3,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.Velocity
  );
  const declarations = gpuSparseShadingBindingDeclarationsWgsl(value);
  const layouts = gpuSparseShadingBindGroupLayoutDescriptors(value, 4);
  assert.equal(layouts.length, value.groups.length);
  for (let groupIndex = 0; groupIndex < value.groups.length; groupIndex++) {
    const group = value.groups[groupIndex];
    const layout = layouts[groupIndex];
    assert.equal(group.group, groupIndex);
    assert.equal(layout.entries.length, group.bindings.length);
    for (let index = 0; index < group.bindings.length; index++) {
      const binding = group.bindings[index];
      const entry = layout.entries[index];
      assert.equal(entry.binding, binding.binding);
      assert.equal(entry.visibility, 4);
      assert.match(
        declarations,
        new RegExp(`@group\\(${binding.group}\\) @binding\\(${binding.binding}\\) var[^;]* ${binding.name}:`, "u")
      );
      assert.ok(entry.buffer || entry.texture || entry.sampler || entry.storageTexture);
      switch (binding.resource.category) {
        case "buffer":
          assert.equal(entry.buffer.type, binding.resource.type);
          break;
        case "texture":
          assert.equal(entry.texture.sampleType, binding.resource.sampleType);
          break;
        case "sampler":
          assert.equal(entry.sampler.type, binding.resource.type);
          break;
        case "storage-texture":
          assert.equal(entry.storageTexture.format, binding.resource.format);
          assert.equal(entry.storageTexture.access, "write-only");
          break;
      }
    }
  }
  assert.match(declarations, /output_hdr: texture_storage_2d<rgba16float, write>/u);
  assert.match(declarations, /output_normal: texture_storage_2d<rgba16uint, write>/u);
  assert.match(declarations, /output_material: texture_storage_2d<rg32uint, write>/u);
});

test("classifier contract WGSL enables only negotiated subgroups and passes source prohibitions", () => {
  const value = descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 0, 0);
  const source = gpuSparseShadingContractModuleWgsl(
    value,
    GPU_SPARSE_SHADING_REQUIRED_FEATURES
  );
  assert.match(source, /^enable subgroups;\nrequires texture_formats_tier1;/u);
  assert.doesNotMatch(source, /@subgroup_size/u);
  assert.doesNotMatch(source, /subgroupBallot\s*\([^)]*\)\.x/u);
  assert.doesNotMatch(source, /1u\s*<<\s*subgroup_invocation_id/u);
  assert.doesNotMatch(source, /diagnostic\s*\(\s*off\s*,\s*subgroup_uniformity/u);
  assert.doesNotMatch(source, /kernel_class|MaterialTile|28-class/u);
  assert.throws(
    () => gpuSparseShadingContractModuleWgsl(value, ["texture-formats-tier1"]),
    /requires enabled device feature 'subgroups'/u
  );
});

test("Step 2 cache and descriptor owners contain no frame-loop or legacy fallback registration", () => {
  const source = [
    readFileSync(new URL("../src/gpu/GpuSparseShadingPipelineContract.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../src/gpu/GpuSparseShadingCapability.ts", import.meta.url), "utf8")
  ].join("\n");
  assert.doesNotMatch(source, /requestAnimationFrame|beginFrame|frameIndex\s*:/u);
  assert.doesNotMatch(source, /MaterialTileWork|GpuMaterialKernelAbi|visibleBinCount\s*:/u);
  assert.doesNotMatch(source, /portable classifier|no-subgroup|fallback pipeline/iu);
});
