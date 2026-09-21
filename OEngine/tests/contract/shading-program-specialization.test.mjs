import assert from "node:assert/strict";
import test from "node:test";

import "./webgpu-test-globals.mjs";

import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  GPU_SPARSE_SHADING_REQUIRED_LIMITS
} from "../.test-dist/gpu/GpuSparseShadingCapability.js";
import {
  GPU_SHADING_MATERIAL_ABI_VERSION,
  GPU_SHADING_MATERIAL_RECORD_STRIDE,
  GPU_SHADING_TEXTURE_ROUTE_STRIDE,
  packGpuShadingMaterialRecord,
  packGpuShadingTextureRoute,
  unpackGpuShadingMaterialHeader,
  unpackGpuShadingTextureRoute
} from "../.test-dist/gpu/GpuShadingMaterialAbi.js";
import {
  GPU_MATERIAL_VISIBILITY_ABI_VERSION
} from "../.test-dist/gpu/GpuMaterialVisibilityAbi.js";
import {
  createGpuSparseShadingPipelineDescriptor,
  GPU_SHADING_OUTPUT_DEPENDENCY,
  gpuSparseShadingBindGroupLayoutDescriptors
} from "../.test-dist/gpu/GpuSparseShadingPipelineContract.js";
import {
  GPU_SHADING_PROGRAM,
  GPU_SHADING_PROGRAM_COUNT,
  shadingProgramUsesTextures
} from "../.test-dist/gpu/GpuShadingProgramAbi.js";
import { SparseShadingResolvePass } from "../.test-dist/render/passes/SparseShadingResolvePass.js";
import {
  GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG,
  SPARSE_SHADING_DIAGNOSTICS_FINALIZER_WGSL,
  createSparseShadingProgramFamily,
  createSparseShadingShaderVariant
} from "../.test-dist/shaders/sparse_shading_resolve.js";
import {
  LIGHT_CLUSTER_ASSIGN_WGSL,
  LIGHT_CLUSTER_DATA_HEADER_BYTES,
  LIGHT_CLUSTER_LIST_CAPACITY
} from "../.test-dist/shaders/light_cluster.js";
import {
  OENGINE_ENVIRONMENT_BRDF_WGSL,
  evaluateEnvironmentBrdfReference
} from "../.test-dist/shaders/environment_brdf.js";
import { OPAQUE_LIGHTING_RESOLVE_WGSL } from "../.test-dist/shaders/opaque_lighting_resolve.js";

const adapterLimits = {
  ...GPU_SPARSE_SHADING_REQUIRED_LIMITS
};
const plan = createGpuSparseShadingCapabilityPlan({
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: adapterLimits,
  info: { subgroupMinSize: 4, subgroupMaxSize: 128 }
});
const capability = captureGpuSparseShadingCapabilityRecord(plan, {
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: adapterLimits,
  textureFormatFeatures: ["texture-formats-tier1"],
  formatProfile: "desktop-tier1-v1"
});

function descriptor(programId, outputDependencyMask = 0, set = 0) {
  return createGpuSparseShadingPipelineDescriptor({
    programId,
    textureBindingSetId: shadingProgramUsesTextures(programId) ? set : 0,
    outputDependencyMask,
    shadowSamplingEnabled: true,
    capability
  });
}

function bindingPairs(source) {
  return [...source.matchAll(/@group\((\d+)\)\s+@binding\((\d+)\)/gu)]
    .map((match) => `${match[1]}:${match[2]}`);
}

test("all 16 program families are literal creation-time variants without a class switch", () => {
  const variants = createSparseShadingProgramFamily({
    textureBindingSetId: 3,
    outputDependencyMask: 0,
    shadowSamplingEnabled: true,
    capability
  });
  assert.equal(variants.length, GPU_SHADING_PROGRAM_COUNT);
  for (let programId = 0; programId < variants.length; programId++) {
    const variant = variants[programId];
    assert.equal(variant.descriptor.programId, programId);
    assert.match(variant.source, new RegExp(`OENGINE_SHADING_PROGRAM_ID: u32 = ${programId}u`, "u"));
    assert.match(variant.source, /fn shading_resolve\(/u);
    assert.doesNotMatch(variant.source, /switch\s*\(\s*program_id/u);
  }
});

test("UnlitFactor ColorOnly physically omits reconstruction, texture, lighting and optional outputs", () => {
  const source = createSparseShadingShaderVariant(descriptor(GPU_SHADING_PROGRAM.UnlitFactor)).source;
  for (const forbidden of [
    /asset_metadata_heap/u,
    /vertex_payload_heap/u,
    /instance_records/u,
    /visibility_depth/u,
    /textureSample/u,
    /light_database/u,
    /shadow_atlas/u,
    /output_normal/u,
    /output_albedo_ao/u,
    /output_material/u,
    /output_velocity/u,
    /sparse_barycentric/u,
    /sparse_position/u,
    /sparse_direct/u
  ]) assert.doesNotMatch(source, forbidden);
  assert.match(source, /sparse_evaluate_unlit_factor/u);
  assert.match(source, /factor\.xyz\*shading_view\.pre_exposure/u);
});

test("textured variants use explicit gradients or explicit level only", () => {
  for (const programId of [
    GPU_SHADING_PROGRAM.UnlitTexture,
    GPU_SHADING_PROGRAM.UnlitTextureColor,
    GPU_SHADING_PROGRAM.PbrBase,
    GPU_SHADING_PROGRAM.PbrOrmNormal,
    GPU_SHADING_PROGRAM.PbrGeneric
  ]) {
    const source = createSparseShadingShaderVariant(descriptor(programId, 0, 2)).source;
    assert.match(source, /textureSampleGrad\(/u);
    assert.match(source, /textureSampleLevel\(/u);
    assert.doesNotMatch(source, /textureSample\s*\(/u);
    assert.doesNotMatch(source, /diagnostic\s*\(\s*off/u);
  }
});

test("PbrOrm specialization reads only ORM texture data and required geometry", () => {
  const source = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrOrm,
    0,
    2
  )).source;
  assert.match(source, /sparse_normal\(geometry_base/u);
  assert.match(source, /sparse_texture_route_valid\(material_slot,\s*2u/u);
  assert.doesNotMatch(source, /sparse_texture_route_valid\(material_slot,\s*0u/u);
  assert.doesNotMatch(source, /sparse_texture_route_valid\(material_slot,\s*1u/u);
  assert.doesNotMatch(source, /sparse_texture_route_valid\(material_slot,\s*3u/u);
  assert.doesNotMatch(source, /sparse_tangent\(geometry_base,vertices/u);
  assert.match(source, /sparse_color\(geometry_base,vertices/u);
  assert.match(source, /fn sparse_transform_uv_2\(/u);
  assert.match(source, /fn sparse_sampler_2\(/u);
  assert.doesNotMatch(source, /fn sparse_transform_uv_[013]\(/u);
  assert.doesNotMatch(source, /material\.payload\.(?:uv_offset_scale|normal_uv_offset_scale|emissive_uv_offset_scale)/u);
  assert.doesNotMatch(source, /material\.payload\.flags&/u);
  assert.match(source, /surface_flags\|=OENGINE_SURFACE_FLAG_ORM_TEXTURE/u);
});

test("PbrGeneric retains all material-conditional texture slots", () => {
  const source = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrGeneric,
    0,
    2
  )).source;
  for (const slot of [0, 1, 2, 3, 4]) {
    assert.match(source, new RegExp(`fn sparse_transform_uv_${slot}\\(`, "u"));
    assert.match(source, new RegExp(`fn sparse_sampler_${slot}\\(`, "u"));
  }
  assert.match(source, /material\.payload\.occlusion_texture_ref/u);
  assert.match(source, /material\.payload\.occlusion_uv_set/u);
  assert.match(source, /sparse_uv\(geometry_base,vertices\.x,uv_set_4\)/u);
  assert.match(source, /material\.payload\.flags&/u);
});

test("normal-textured PBR derives a transformed tangent basis when geometry omits tangents", () => {
  const source = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrNormal,
    0,
    2
  )).source;
  assert.match(source, /sparse_meta_u32\(geometry_base, 51u\) != 0u/u);
  assert.match(source, /normal_uv0=sparse_transform_uv_1/u);
  assert.match(source, /derived_tangent=\(edge1\*duv2\.y-edge2\*duv1\.y\)/u);
  assert.match(source, /normal_basis_valid=false/u);
});

test("triangle reconstruction converts clip-space NDC to top-left pixel coordinates", () => {
  const source = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrFactor,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite
  )).source;
  assert.match(source, /\(ndc\.x \* 0\.5 \+ 0\.5\) \* f32\(shading_view\.width\)/u);
  assert.match(source, /\(0\.5 - ndc\.y \* 0\.5\) \* f32\(shading_view\.height\)/u);
  assert.doesNotMatch(source, /fn sparse_projected_pixel\([^)]*\)[^{]*\{ return value\.xy \/ value\.w; \}/u);
});

test("triangle reconstruction validates each instance geometry generation", () => {
  const source = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrFactor,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite
  )).source;
  assert.match(source, /fn oengine_instance_geometry_generation/u);
  assert.match(source,
    /asset_metadata_heap\[shading_view\.geometry_generation_word_base\+work\.geometry_slot\]!=oengine_instance_geometry_generation\(instance_records\[work\.instance_slot\]\)/u);
  assert.doesNotMatch(source,
    /asset_metadata_heap\[shading_view\.geometry_generation_word_base\+work\.geometry_slot\]!=shading_view\.geometry_generation/u);
});

test("actual WGSL binding pairs and output stores equal every concrete descriptor", () => {
  for (let programId = 0; programId < GPU_SHADING_PROGRAM_COUNT; programId++) {
    for (let mask = 0; mask < 8; mask++) {
      const value = descriptor(programId, mask, 1);
      const source = createSparseShadingShaderVariant(value).source;
      const actual = new Set(bindingPairs(source));
      const expected = new Set(value.groups.flatMap((group) =>
        group.bindings.map((binding) => `${binding.group}:${binding.binding}`)));
      assert.deepEqual(actual, expected, `program=${programId}, mask=${mask}`);
      assert.equal(/textureStore\(output_normal/u.test(source),
        (mask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0);
      assert.equal(/textureStore\(output_albedo_ao/u.test(source),
        (mask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0);
      assert.equal(/textureStore\(output_velocity/u.test(source),
        (mask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0);
    }
  }
});

test("lit programs fuse BRDF, cluster traversal and shadow comparison in their sole consumer", () => {
  const source = createSparseShadingShaderVariant(descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 7, 3)).source;
  assert.match(source, /fn re_direct_physical/u);
  assert.match(source, /fn directional_lights_iteration_mask/u);
  assert.match(source, /cluster_resolution_xy[\s\S]*vec2u\(31u\)[\s\S]*vec2u\(32u\)/u);
  assert.match(source, /cluster_data\.active_written/u);
  assert.match(source, /textureGatherCompare\(/u);
  assert.match(source, /fn shadowmap_csm_compute_cascade_blended/u);
  assert.match(source, /fn contact_harden_pcf_kernel/u);
  assert.match(source, /fn sparse_octahedral_unit_encode/u);
  assert.ok(
    source.indexOf("fn sparse_octahedral_unit_encode") <
    source.indexOf("sparse_octahedral_unit_encode(perturbed)")
  );
  assert.match(source, /sparse_direct\(surface,pixel\)/u);
  assert.equal((source.match(/@compute/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /shade_direct_pixel|SurfaceLite immediately/u);
  assert.doesNotMatch(source, /environment_settings|environment_texture_|environment_sampler/u);
  const unlit = createSparseShadingShaderVariant(descriptor(GPU_SHADING_PROGRAM.UnlitTexture, 0, 1)).source;
  assert.doesNotMatch(unlit, /cluster_lookup|textureGatherCompare|fn re_direct_physical/u);
});

test("velocity-off receiver variants do not read previous clip transforms", () => {
  const withoutVelocity = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrFactor,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite
  )).source;
  assert.doesNotMatch(withoutVelocity, /shading_view\.previous_view_projection\*/u);
  assert.doesNotMatch(withoutVelocity, /oengine_instance_previous_from_current\(instance\)/u);
  assert.match(withoutVelocity, /let velocity=vec2f\(0\.0\)/u);

  const withVelocity = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrFactor,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.Velocity
  )).source;
  assert.match(withVelocity, /previous_view_projection/u);
  assert.match(withVelocity, /oengine_instance_previous_from_current\(instance\)/u);
  assert.match(withVelocity, /textureStore\(output_velocity/u);
});

test("environment IBL specialization fuses prepared diffuse, specular and DFG sampling", () => {
  const source = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrGeneric,
    GPU_SHADING_OUTPUT_DEPENDENCY.EnvironmentIBL,
    3
  )).source;
  assert.match(source, /@group\(3\) @binding\(4\) var environment_diffuse/u);
  assert.match(source, /@group\(3\) @binding\(5\) var environment_specular/u);
  assert.match(source, /@group\(3\) @binding\(6\) var split_sum/u);
  assert.match(source, /@group\(3\) @binding\(7\) var environment_sampler/u);
  assert.match(source, /fn sample_prefiltered_environment/u);
  assert.match(source, /oengine_specular_ao_cones/u);
  assert.match(source, /textureSampleLevel\(\s*split_sum/u);
  assert.match(source, /environment_specular_contribution/u);
  assert.match(source, /environment_diffuse_contribution/u);
  assert.match(source, /oengine_ibl_directional_albedo\(/u);
  assert.equal(
    (source.match(/fn oengine_ibl_directional_albedo\(/gu) ?? []).length,
    1
  );
  assert.match(OPAQUE_LIGHTING_RESOLVE_WGSL, /oengine_ibl_directional_albedo\(/u);
  assert.ok(source.includes(OENGINE_ENVIRONMENT_BRDF_WGSL.trim()));
  assert.ok(OPAQUE_LIGHTING_RESOLVE_WGSL.includes(OENGINE_ENVIRONMENT_BRDF_WGSL.trim()));
});

test("shared environment BRDF oracle preserves split-sum multiple scattering and energy clamp", () => {
  const result = evaluateEnvironmentBrdfReference([0.62, 0.21], [0.04, 0.5, 0.9], 1);
  const ratio = (1 - 0.83) / 0.83;
  const expected = [0.04, 0.5, 0.9].map((f0) => {
    const single = f0 * 0.62 + 0.21;
    return single + single * f0 * ratio;
  });
  for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(result.directionalAlbedo[index] - expected[index]) < 1e-12);
    assert.equal(
      result.diffuseEnergy[index],
      Math.min(1, Math.max(0, 1 - expected[index]))
    );
  }
  assert.throws(
    () => evaluateEnvironmentBrdfReference([Number.NaN, 0], [0.04, 0.04, 0.04], 1),
    /must be finite/
  );
});

test("cluster data embeds the active-list fallback without an eleventh storage binding", () => {
  assert.equal(LIGHT_CLUSTER_DATA_HEADER_BYTES, 32);
  assert.ok(LIGHT_CLUSTER_LIST_CAPACITY > 0);
  assert.match(LIGHT_CLUSTER_ASSIGN_WGSL, /active_written: u32/u);
  assert.match(LIGHT_CLUSTER_ASSIGN_WGSL,
    new RegExp(`const ACTIVE_LIST_CAPACITY = ${LIGHT_CLUSTER_LIST_CAPACITY}u`, "u"));
  assert.match(LIGHT_CLUSTER_ASSIGN_WGSL, /return ACTIVE_LIST_CAPACITY \+ current/u);
  assert.match(LIGHT_CLUSTER_ASSIGN_WGSL,
    /ClusterMetadata\(\s*0u,\s*input\.written,\s*0u,[\s\S]*CLUSTER_METADATA_FLAG_FALLBACK/u);
  const source = createSparseShadingShaderVariant(descriptor(GPU_SHADING_PROGRAM.PbrGeneric)).source;
  assert.match(source, /cluster_data\.active_written/u);
  assert.doesNotMatch(source, /@group\(3\)[^\n]*active_light_list/u);
});

test("shadow-off lit WGSL keeps direct lighting but contains no shadow resource or sample", () => {
  const value = createGpuSparseShadingPipelineDescriptor({
    programId: GPU_SHADING_PROGRAM.PbrGeneric,
    textureBindingSetId: 3,
    outputDependencyMask: 0,
    shadowSamplingEnabled: false,
    capability
  });
  const source = createSparseShadingShaderVariant(value).source;
  assert.match(source, /fn sparse_direct/u);
  assert.match(source, /fn shadowmap_get_point_light_visibility\([\s\S]*?\) -> f32 \{ return 1\.0; \}/u);
  assert.doesNotMatch(source, /shadow_atlas|shadow_sampler|textureSampleCompare/u);
  const actual = new Set(bindingPairs(source));
  const expected = new Set(value.groups.flatMap((group) =>
    group.bindings.map((binding) => `${binding.group}:${binding.binding}`)));
  assert.deepEqual(actual, expected);
});

test("depth/comparison binding types and dynamic settings offset reach native layouts", () => {
  const previous = globalThis.GPUShaderStage;
  globalThis.GPUShaderStage = { COMPUTE: 4 };
  try {
    const layouts = gpuSparseShadingBindGroupLayoutDescriptors(
      descriptor(GPU_SHADING_PROGRAM.PbrFactor),
      GPUShaderStage.COMPUTE
    );
    assert.equal(layouts[0].entries[0].buffer.hasDynamicOffset, true);
    assert.equal(layouts[0].entries[0].buffer.minBindingSize, 32);
    assert.equal(layouts[3].entries.find(({ binding }) => binding === 4).texture.sampleType, "depth");
    assert.equal(layouts[3].entries.find(({ binding }) => binding === 5).sampler.type, "comparison");
    const textured = gpuSparseShadingBindGroupLayoutDescriptors(
      descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 7, 2),
      GPUShaderStage.COMPUTE
    );
    assert.ok(textured[2].entries.slice(2, 11).every(({ texture }) =>
      texture.sampleType === "float" && texture.viewDimension === "2d-array"));
  } finally {
    globalThis.GPUShaderStage = previous;
  }
});

test("production and diagnostics consumers are physically separate", () => {
  const value = descriptor(GPU_SHADING_PROGRAM.UnlitFactor);
  const production = createSparseShadingShaderVariant(value, false).source;
  const diagnostics = createSparseShadingShaderVariant(value, true).source;
  assert.doesNotMatch(production, /shading_claims|shading_diagnostics|duplicate|unassigned/u);
  assert.match(diagnostics, /@group\(0\) @binding\(11\).*shading_diagnostics/u);
  assert.match(diagnostics, /@group\(0\) @binding\(12\).*shading_claims/u);
  assert.match(diagnostics, /atomicAdd\(&shading_claims/u);
  assert.match(SPARSE_SHADING_DIAGNOSTICS_FINALIZER_WGSL, /shading_diagnostics\.unassigned/u);
  assert.match(SPARSE_SHADING_DIAGNOSTICS_FINALIZER_WGSL, /atomicLoad\(&shading_claims/u);
  assert.deepEqual(GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG, {
    Duplicate: 1,
    Unassigned: 2,
    IdentityMismatch: 4
  });
});

test("sparse normal output preserves the shared rgba16uint octahedral channel ABI", () => {
  const source = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrFactor,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite
  ), false).source;
  assert.match(source, /fn sparse_encode_surface_normal\(normal:vec3f\)->vec2u/u);
  assert.match(source, /vec4u\(sparse_encode_surface_normal\(surface\.shading_normal\),sparse_encode_surface_normal\(surface\.geometric_normal\)\)/u);
  assert.doesNotMatch(source, /pack2x16snorm\(surface\./u);
});

test("sparse surface outputs preserve compact flags, RGB9E5 and unlit diffuse semantics", () => {
  const source = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.UnlitTexture,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite
  ), false).source;
  assert.match(source, /oengine_surface_lite_pack_material\(surface\.metallic,surface\.roughness,surface\.flags\)/u);
  assert.match(source, /sparse_rgbe9995_encode\(encoded_emissive\)/u);
  assert.match(source, /vec4f\(0\.0,0\.0,0\.0,1\.0\),unlit/u);
  assert.doesNotMatch(source, /bitcast<u32>\(surface\.(?:roughness|metallic)\)/u);
});

test("material and texture-route publication ABI validates generations and exact strides", () => {
  assert.equal(GPU_MATERIAL_VISIBILITY_ABI_VERSION, 8);
  assert.equal(GPU_SHADING_MATERIAL_ABI_VERSION, 3);
  const header = {
    programId: GPU_SHADING_PROGRAM.PbrGeneric,
    textureBindingSetId: 2,
    materialGeneration: 11,
    textureGeneration: 12,
    publicationRevision: 13,
    flags: 0
  };
  const bytes = packGpuShadingMaterialRecord(header, materialPayload());
  assert.equal(bytes.byteLength, GPU_SHADING_MATERIAL_RECORD_STRIDE);
  assert.equal(bytes.byteLength, 304);
  assert.equal(new DataView(bytes.buffer).getUint32(32, true), 0);
  assert.deepEqual(unpackGpuShadingMaterialHeader(bytes), header);
  assert.throws(
    () => packGpuShadingMaterialRecord(header, { ...materialPayload(), reserved0: 1 }),
    /reserved0 must be zero/u
  );
  const route = { textureRef: 0x20000001, textureGeneration: 12, publicationRevision: 13, textureBindingSetId: 2 };
  const routeBytes = packGpuShadingTextureRoute(route);
  assert.equal(routeBytes.byteLength, GPU_SHADING_TEXTURE_ROUTE_STRIDE);
  assert.deepEqual(unpackGpuShadingTextureRoute(routeBytes), route);
  assert.throws(() => packGpuShadingTextureRoute({ ...route, textureGeneration: 0 }), /non-zero/u);
});

test("resolve owner compiles once and encodes one indirect call per active bin", async () => {
  const previous = globalThis.GPUShaderStage;
  globalThis.GPUShaderStage = { COMPUTE: 4 };
  try {
    const fake = fakeDevice();
    const values = [
      descriptor(GPU_SHADING_PROGRAM.UnlitFactor),
      descriptor(GPU_SHADING_PROGRAM.PbrBase, 0, 2)
    ];
    const owner = await SparseShadingResolvePass.create(fake.device, values, 17);
    assert.deepEqual(owner.activeBinIds, [0, 37]);
    assert.equal(fake.modules.length, 2);
    assert.equal(fake.pipelines.length, 2);
    const stableResources = new Map();
    const resource = (name) => {
      let value = stableResources.get(name);
      if (value === undefined) {
        value = { label: name };
        stableResources.set(name, value);
      }
      return value;
    };
    const firstBindings = owner.createFrameBindingsForExecution(resource);
    const reusedBindings = owner.createFrameBindingsForExecution(resource);
    assert.deepEqual(
      reusedBindings.map((frame) => frame.groups),
      firstBindings.map((frame) => frame.groups)
    );
    assert.deepEqual(owner.bindingCacheEvidence(), { requests: 14, creations: 7 });
    assert.equal(fake.bindGroups.length, 7);
    const calls = [];
    const command = fakeCommand(calls);
    owner.encode(command, { label: "args" }, 256, [
      { binId: 0, groups: [{}, {}, {}] },
      { binId: 37, groups: [{}, {}, {}, {}] }
    ], 17);
    assert.deepEqual(calls.filter(([name]) => name === "dispatchIndirect").map(([, offset]) => offset), [0, 444]);
    assert.equal(calls.filter(([name]) => name === "begin").length, 1);
    assert.equal(calls.filter(([name]) => name === "end").length, 1);
    const beforeInvalid = calls.length;
    assert.throws(() => owner.encode(command, {}, 256, [
      { binId: 0, groups: [{}, {}, {}] },
      { binId: 37, groups: [] }
    ], 17), /closure is incomplete/u);
    assert.equal(calls.length, beforeInvalid, "invalid late bin must not open a pass");
    assert.throws(() => owner.encode(command, {}, 256, [], 16), /publication revision/u);
    owner.destroy();
    assert.throws(() => owner.pipelineForBin(0), /destroyed/u);
  } finally {
    globalThis.GPUShaderStage = previous;
  }
});

function materialPayload() {
  return {
    reserved0: 0, alphaMode: 0, flags: 1, textureRef: 0xffffffff,
    baseColorFactorAlpha: 1, alphaCutoff: 0.5, textureUvSets: 0, samplerClass: 0,
    uvOffset: [0, 0], uvScale: [1, 1], rotationCos: 1, rotationSin: 0,
    baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, perceptualRoughness: 1,
    normalScale: 1, occlusionStrength: 1, emissiveFactor: [0, 0, 0, 1],
    normalTextureRef: 0xffffffff, ormTextureRef: 0xffffffff, emissiveTextureRef: 0xffffffff,
    textureSamplerClasses: 0,
    normalUvOffset: [0, 0], normalUvScale: [1, 1], normalRotationCos: 1, normalRotationSin: 0,
    ormUvOffset: [0, 0], ormUvScale: [1, 1], ormRotationCos: 1, ormRotationSin: 0,
    emissiveUvOffset: [0, 0], emissiveUvScale: [1, 1], emissiveRotationCos: 1, emissiveRotationSin: 0,
    textureBindingSetId: 2,
    occlusionTextureRef: 0xffffffff, occlusionUvSet: 1,
    occlusionUvOffset: [0, 0], occlusionUvScale: [1, 1],
    occlusionRotationCos: 1, occlusionRotationSin: 0
  };
}

function fakeDevice() {
  const modules = [];
  const pipelines = [];
  const bindGroups = [];
  const scopes = [];
  const device = {
    pushErrorScope() { scopes.push(null); },
    async popErrorScope() { return scopes.pop(); },
    createShaderModule(value) {
      modules.push(value);
      return { async getCompilationInfo() { return { messages: [] }; } };
    },
    createBindGroupLayout(value) { return { value }; },
    createPipelineLayout(value) { return { value }; },
    createComputePipeline(value) { pipelines.push(value); return { value }; },
    createBindGroup(value) {
      const group = { value };
      bindGroups.push(group);
      return group;
    }
  };
  return { device, modules, pipelines, bindGroups };
}

function fakeCommand(calls) {
  return {
    beginComputePass(value) {
      calls.push(["begin", value.label]);
      return {
        setPipeline() {},
        setBindGroup(group, _binding, offsets) { calls.push(["bind", group, offsets]); },
        dispatchWorkgroupsIndirect(_buffer, offset) { calls.push(["dispatchIndirect", offset]); },
        end() { calls.push(["end"]); }
      };
    }
  };
}
