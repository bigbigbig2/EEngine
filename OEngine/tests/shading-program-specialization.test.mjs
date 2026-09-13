import assert from "node:assert/strict";
import test from "node:test";

import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  GPU_SPARSE_SHADING_REQUIRED_LIMITS
} from "../.test-dist/gpu/GpuSparseShadingCapability.js";
import {
  GPU_SHADING_MATERIAL_RECORD_STRIDE,
  GPU_SHADING_TEXTURE_ROUTE_STRIDE,
  packGpuShadingMaterialRecord,
  packGpuShadingTextureRoute,
  unpackGpuShadingMaterialHeader,
  unpackGpuShadingTextureRoute
} from "../.test-dist/gpu/GpuShadingMaterialAbi.js";
import {
  GPU_SPARSE_SHADING_LIGHT_TYPE,
  packGpuSparseShadingLightDatabase
} from "../.test-dist/gpu/GpuSparseShadingLightAbi.js";
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
    assert.doesNotMatch(variant.source, /switch\s*\(\s*(?:kernel_class|program_id)/u);
    assert.doesNotMatch(variant.source, /MaterialTileWork|28-class|evaluate_compute_material_tiles/u);
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

test("triangle reconstruction converts clip-space NDC to top-left pixel coordinates", () => {
  const source = createSparseShadingShaderVariant(descriptor(
    GPU_SHADING_PROGRAM.PbrFactor,
    GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite
  )).source;
  assert.match(source, /\(ndc\.x \* 0\.5 \+ 0\.5\) \* f32\(shading_view\.width\)/u);
  assert.match(source, /\(0\.5 - ndc\.y \* 0\.5\) \* f32\(shading_view\.height\)/u);
  assert.doesNotMatch(source, /fn sparse_projected_pixel\([^)]*\)[^{]*\{ return value\.xy \/ value\.w; \}/u);
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
        (mask & (GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
          GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite)) !== 0);
      assert.equal(/textureStore\(output_velocity/u.test(source),
        (mask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0);
    }
  }
});

test("lit programs fuse BRDF, cluster traversal and shadow comparison in their sole consumer", () => {
  const source = createSparseShadingShaderVariant(descriptor(GPU_SHADING_PROGRAM.PbrGeneric, 7, 3)).source;
  assert.match(source, /fn sparse_brdf/u);
  assert.match(source, /light_cluster_headers/u);
  assert.match(source, /textureSampleCompareLevel\(/u);
  assert.match(source, /sparse_direct\(surface,pixel\)/u);
  assert.equal((source.match(/@compute/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /LightingPass|shade_direct_pixel|SurfaceLite immediately/u);
  const unlit = createSparseShadingShaderVariant(descriptor(GPU_SHADING_PROGRAM.UnlitTexture, 0, 1)).source;
  assert.doesNotMatch(unlit, /light_cluster_headers|textureSampleCompareLevel|fn sparse_brdf/u);
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
  assert.match(source, /fn sparse_shadow\([^)]*\)[^{]*\{return 1\.0;\}/u);
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
    assert.equal(layouts[3].entries.find(({ binding }) => binding === 5).texture.sampleType, "depth");
    assert.equal(layouts[3].entries.find(({ binding }) => binding === 9).sampler.type, "comparison");
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
  assert.equal(bytes.byteLength, 272);
  assert.deepEqual(unpackGpuShadingMaterialHeader(bytes), header);
  const route = { textureRef: 0x20000001, textureGeneration: 12, publicationRevision: 13, textureBindingSetId: 2 };
  const routeBytes = packGpuShadingTextureRoute(route);
  assert.equal(routeBytes.byteLength, GPU_SHADING_TEXTURE_ROUTE_STRIDE);
  assert.deepEqual(unpackGpuShadingTextureRoute(routeBytes), route);
  assert.throws(() => packGpuShadingTextureRoute({ ...route, textureGeneration: 0 }), /non-zero/u);
});

test("packed light database folds directional/local/shadow inputs into one buffer", () => {
  const common = {
    flags: 1,
    shadowRecord: 0,
    shadowRecordCount: 1,
    position: [0, 1, 2],
    range: 9,
    direction: [0, 0, 1],
    outerConeCos: 0.5,
    color: [1, 0.5, 0.25],
    intensity: 3,
    radius: 0.1,
    innerConeCos: 0.8
  };
  const words = packGpuSparseShadingLightDatabase({
    directional: [{ ...common, type: GPU_SPARSE_SHADING_LIGHT_TYPE.Directional }],
    local: [
      { ...common, type: GPU_SPARSE_SHADING_LIGHT_TYPE.Point },
      { ...common, type: GPU_SPARSE_SHADING_LIGHT_TYPE.Spot }
    ],
    shadowRecords: [{ projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], atlas: [0, 0, 512, 512] }]
  });
  assert.deepEqual([...words.slice(0, 6)], [1, 1, 2, 8, 80, 1]);
  assert.equal(words.length, 100);
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
    assert.throws(() => owner.encode(command, {}, 256, [], 16), /publication revision/u);
    owner.destroy();
    assert.throws(() => owner.pipelineForBin(0), /destroyed/u);
  } finally {
    globalThis.GPUShaderStage = previous;
  }
});

function materialPayload() {
  return {
    kernelClass: 0, alphaMode: 0, flags: 1, textureRef: 0xffffffff,
    baseColorFactorAlpha: 1, alphaCutoff: 0.5, textureUvSets: 0, samplerClass: 0,
    uvOffset: [0, 0], uvScale: [1, 1], rotationCos: 1, rotationSin: 0,
    baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, perceptualRoughness: 1,
    normalScale: 1, occlusionStrength: 1, emissiveFactor: [0, 0, 0, 1],
    normalTextureRef: 0xffffffff, ormTextureRef: 0xffffffff, emissiveTextureRef: 0xffffffff,
    textureSamplerClasses: 0,
    normalUvOffset: [0, 0], normalUvScale: [1, 1], normalRotationCos: 1, normalRotationSin: 0,
    ormUvOffset: [0, 0], ormUvScale: [1, 1], ormRotationCos: 1, ormRotationSin: 0,
    emissiveUvOffset: [0, 0], emissiveUvScale: [1, 1], emissiveRotationCos: 1, emissiveRotationSin: 0,
    textureBindingSetId: 2
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
