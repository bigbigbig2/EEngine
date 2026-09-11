import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE,
  diffuseSurfaceLiteFrame,
  longRangeDiffuseFrame,
  materialTileClassificationFrame,
  opaqueColorPyramidFrame,
  preExposedOpaqueHdrBaselineFrame,
  preExposedOpaqueRadianceSourceFrame,
  preExposureContract,
  reflectionCorrectionFrame,
  screenSpaceDiffuseFrame,
  shadingSurfaceLiteFrame,
  textureDomain
} from "../.test-dist/render/pipeline/FrameProducts.js";
import { resolveMainFrameFeatureTopology } from "../.test-dist/render/MainFrameFeatureTopology.js";
import { MATERIAL_TILE_CLASSIFICATION_WGSL } from "../.test-dist/shaders/material_tile_classification.js";
import { gpuShadingBindingBudget } from "../.test-dist/gpu/GpuShadingBindingBudget.js";
import {
  GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL,
  GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL_WITHOUT_VELOCITY,
  GPU_COMPUTE_MATERIAL_FORMATS,
  GPU_COMPUTE_MATERIAL_ABI_VERSION,
  packComputeMaterialPbr,
  unpackComputeMaterialPbr
} from "../.test-dist/gpu/GpuComputeMaterialAbi.js";
import {
  GPU_HDR_BYTES_PER_PIXEL,
  GPU_HDR_FORMAT,
  GPU_HDR_PROFILE,
  GPU_HDR_REJECTED_MAIN_CANDIDATES
} from "../.test-dist/gpu/GpuHdrAbi.js";
import {
  evaluateSurfaceAbiV2RunGroupNeed
} from "../.test-dist/debug/VisibilitySurfaceMigrationGates.js";
import {
  GTAO_BENT_NORMAL_BYTES_PER_PIXEL,
  GTAO_BENT_NORMAL_FORMAT,
  GTAO_FINAL_VISIBILITY_BYTES_PER_PIXEL,
  GTAO_FINAL_VISIBILITY_FORMAT,
  GTAO_MOMENTS_BYTES_PER_PIXEL,
  GTAO_MOMENTS_FORMAT,
  GTAO_SPATIAL_WGSL,
  GTAO_TEMPORAL_WGSL,
  THREE_GTAO_RAW_WGSL,
  THREE_GTAO_REVISION
} from "../.test-dist/shaders/gtao.js";
import {
  SSGI_BENT_NORMAL_FORMAT,
  SSGI_CONFIDENCE_FORMAT,
  SSGI_INCIDENT_GI_FORMAT,
  SSGI_TRACE_AO_FORMAT,
  SSGI_TRACE_GI_FORMAT,
  SSGI_VISIBILITY_FORMAT,
  THREE_SSGI_REVISION,
  THREE_SSGI_TRACE_WGSL
} from "../.test-dist/shaders/ssgi.js";
import {
  LONG_RANGE_DIFFUSE_PROVIDER_WGSL,
  LONG_RANGE_PROVIDER_FORMAT
} from "../.test-dist/shaders/long_range_diffuse_provider.js";
import {
  BRICK4_LIGHT_MAP_SCHEMA_VERSION,
  createBrick4LightMapPackageV1,
  validateBrick4LightMapPackageV1
} from "../.test-dist/assets/Brick4LightMapPackage.js";
globalThis.GPUShaderStage = Object.freeze({ COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 });
const {
  PACKED_MATERIAL_COMPUTE_NO_VELOCITY_WGSL,
  PACKED_MATERIAL_COMPUTE_WITH_VELOCITY_WGSL
} = await import("../.test-dist/shaders/packed_material_compute.js");

const LIGHTING_DIRECT_COMPUTE_SOURCE = readFileSync(
  new URL("../src/shaders/lighting_direct_compute.ts", import.meta.url),
  "utf8"
);
const COMPUTE_MATERIAL_SOURCE = readFileSync(
  new URL("../src/shaders/packed_material_compute.ts", import.meta.url),
  "utf8"
);
const COMPUTE_MATERIAL_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/ComputeMaterialResolvePass.ts", import.meta.url),
  "utf8"
);
const MATERIAL_OWNER_SOURCE = readFileSync(
  new URL("../src/render/passes/PackedMaterialResolvePass.ts", import.meta.url),
  "utf8"
);
const IBL_BASELINE_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/IblBaselinePass.ts", import.meta.url),
  "utf8"
);
const OPAQUE_LIGHTING_PIPELINE_SOURCE = readFileSync(
  new URL("../src/render/pipeline/OpaqueLightingPipeline.ts", import.meta.url),
  "utf8"
);
const SSGI_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/SsgiPass.ts", import.meta.url),
  "utf8"
);
const SCREEN_SPACE_DIFFUSE_RESOLVE_SOURCE = readFileSync(
  new URL("../src/shaders/screen_space_diffuse_resolve.ts", import.meta.url),
  "utf8"
);

const full = () => textureDomain("internal-full", 1920, 1080, 1);
const preExposure = () => preExposureContract({
  multiplier: 0.25,
  generation: 7,
  colorSpace: "working-linear"
});

test("ADR-0009 Step 0 freezes compact shading and conditional diffuse receiver semantics", () => {
  const shading = shadingSurfaceLiteFrame({
    normal: 1,
    roughnessFlags: 2,
    metallicSpecular: null,
    normalSpace: "world",
    domain: full()
  });
  assert.equal(shading.domain.domain, "internal-full");
  assert.equal(shading.metallicSpecular, null);

  const diffuse = diffuseSurfaceLiteFrame({
    diffuseReflectance: 3,
    materialAo: 3,
    receiverFlags: 4,
    colorSpace: "working-linear",
    receiverModulation: "unapplied",
    domain: full()
  });
  assert.equal(diffuse.diffuseReflectance, diffuse.materialAo);
  assert.throws(
    () => diffuseSurfaceLiteFrame({
      ...diffuse,
      receiverModulation: "applied"
    }),
    /un-applied receiver modulation/
  );
  assert.throws(
    () => shadingSurfaceLiteFrame({ ...shading, normalSpace: "view" }),
    /normal space/
  );
});

test("ADR-0009 Step 0 binds MaterialTileWork resources to internal-full tile capacity", () => {
  const frame = materialTileClassificationFrame({
    abiVersion: 1,
    queues: 24,
    indirectArgs: 25,
    control: 26,
    settings: 27,
    pixelClaims: 28,
    counters: 29,
    tileWidth: 16,
    tileHeight: 8,
    tileCount: 120 * 135,
    queueCapacityPerDispatchClass: 120 * 135,
    dispatchClassCount: 28,
    generation: 1,
    domain: full()
  });
  assert.equal(frame.queueCapacityPerDispatchClass, frame.tileCount);
  assert.throws(
    () => materialTileClassificationFrame({ ...frame, tileCount: frame.tileCount - 1 }),
    /does not match/
  );
  assert.throws(
    () => materialTileClassificationFrame({
      ...frame,
      queueCapacityPerDispatchClass: frame.tileCount - 1
    }),
    /capacity must equal tileCount/
  );
  assert.throws(
    () => materialTileClassificationFrame({ ...frame, dispatchClassCount: 27 }),
    /dispatchClassCount must equal 28/
  );
});

test("ADR-0009 Step 2 closes MaterialTileWork through one compute material evaluation", () => {
  assert.match(MATERIAL_TILE_CLASSIFICATION_WGSL, /classify_material_tiles/);
  assert.match(MATERIAL_TILE_CLASSIFICATION_WGSL, /build_material_tile_indirect/);
  assert.match(COMPUTE_MATERIAL_SOURCE, /evaluate_compute_material_tiles/);
  assert.match(COMPUTE_MATERIAL_SOURCE, /perspective_barycentric_with_derivatives/);
  assert.match(COMPUTE_MATERIAL_SOURCE, /reconstruct_material_uv/);
  assert.match(COMPUTE_MATERIAL_SOURCE, /bary\.valid != 0u/);
  assert.match(COMPUTE_MATERIAL_SOURCE, /textureStore\(compute_normal_output/);
  assert.match(COMPUTE_MATERIAL_SOURCE, /atomicAdd\(&compute_pixel_claims/);
  assert.match(COMPUTE_MATERIAL_SOURCE, /COMPUTE_HEADER_CONSUMED/);
  assert.match(COMPUTE_MATERIAL_PASS_SOURCE, /dispatchWorkgroupsIndirect/);
  assert.match(COMPUTE_MATERIAL_PASS_SOURCE, /GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT/);
  assert.match(MATERIAL_OWNER_SOURCE, /return "tile-compute"/);
  assert.doesNotMatch(MATERIAL_OWNER_SOURCE, /PackedMaterialClassDepthPass/);

  assert.match(LIGHTING_DIRECT_COMPUTE_SOURCE, /shade_direct_material_tiles/);
  assert.match(LIGHTING_DIRECT_COMPUTE_SOURCE, /dispatch_class \* tile_count/);
  assert.match(LIGHTING_DIRECT_COMPUTE_SOURCE, /tile_pixel_claims/);
  assert.match(LIGHTING_DIRECT_COMPUTE_SOURCE, /validate_direct_lighting_pixels/);
  assert.match(LIGHTING_DIRECT_COMPUTE_SOURCE, /finalize_direct_lighting/);
  assert.match(LIGHTING_DIRECT_COMPUTE_SOURCE, /textureStore\(tile_hdr_output/);
  assert.match(LIGHTING_DIRECT_COMPUTE_SOURCE, /duplicate_shading_pixel_count/);
  assert.match(LIGHTING_DIRECT_COMPUTE_SOURCE, /overflow_queue_count/);
  assert.doesNotMatch(LIGHTING_DIRECT_COMPUTE_SOURCE, /atomicAdd\(&tile_pixel_claims/);
  assert.doesNotMatch(LIGHTING_DIRECT_COMPUTE_SOURCE, /HEADER_CONSUMED\)\],\s*1u/);

  assert.doesNotMatch(MATERIAL_OWNER_SOURCE, /ComputeMaterialSurfaceBridgePass/);
  assert.doesNotMatch(MATERIAL_TILE_CLASSIFICATION_WGSL, /consume_material_tiles/);
  assert.doesNotMatch(MATERIAL_TILE_CLASSIFICATION_WGSL, /textureSample\s*\(/);
});

test("ADR-0009 Step 3 freezes the 24-byte SurfaceLite working ABI", () => {
  assert.equal(GPU_COMPUTE_MATERIAL_ABI_VERSION, 2);
  assert.deepEqual(GPU_COMPUTE_MATERIAL_FORMATS, {
    normal: "rgba16uint",
    albedoAo: "rgba8unorm",
    material: "rg32uint",
    velocity: "rg16float"
  });
  assert.equal(GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL, 24);
  assert.equal(GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL_WITHOUT_VELOCITY, 20);
  for (const [metallic, roughness] of [[0, 0], [1, 1], [0.125, 0.875]]) {
    const unpacked = unpackComputeMaterialPbr(
      packComputeMaterialPbr(metallic, roughness)
    );
    assert.ok(Math.abs(unpacked[0] - metallic) <= 1 / 0xff);
    assert.ok(Math.abs(unpacked[1] - roughness) <= 1 / 0xff);
  }
});

test("ADR-0009 Step 3 physically prunes Velocity when it has no consumer", () => {
  assert.doesNotMatch(
    PACKED_MATERIAL_COMPUTE_NO_VELOCITY_WGSL,
    /compute_velocity_output/
  );
  assert.match(
    PACKED_MATERIAL_COMPUTE_WITH_VELOCITY_WGSL,
    /@group\(2\) @binding\(5\) var compute_velocity_output/
  );
  assert.match(COMPUTE_MATERIAL_PASS_SOURCE, /if \(options\.velocity\)/);
  assert.match(COMPUTE_MATERIAL_PASS_SOURCE, /OUTPUT_GROUP_NO_VELOCITY/);
  assert.match(COMPUTE_MATERIAL_PASS_SOURCE, /OUTPUT_GROUP_WITH_VELOCITY/);
});

test("ADR-0009 Step 3 freezes one pre-exposed HDR/history physical contract", () => {
  assert.equal(GPU_HDR_FORMAT, "rgba16float");
  assert.equal(GPU_HDR_BYTES_PER_PIXEL, 8);
  assert.equal(GPU_HDR_PROFILE.alpha, "preserved");
  assert.equal(GPU_HDR_PROFILE.signedValues, true);
  assert.equal(GPU_HDR_PROFILE.storageWrite, true);
  assert.equal(GPU_HDR_PROFILE.historyCompatible, true);
  assert.deepEqual(GPU_HDR_REJECTED_MAIN_CANDIDATES.rg11b10ufloat, [
    "no alpha channel",
    "unsigned-only representation",
    "not one uniform render/storage/history contract"
  ]);
});

test("ADR-0009 Step 3 deletes Surface V1 and materializes baseline specular only for SSR", () => {
  assert.equal(
    existsSync(new URL("../src/gpu/GpuSurfaceAbi.ts", import.meta.url)),
    false
  );
  assert.equal(
    existsSync(new URL("../src/render/passes/ComputeMaterialSurfaceBridgePass.ts", import.meta.url)),
    false
  );
  assert.equal(
    existsSync(new URL("../src/render/passes/IblDiffusePass.ts", import.meta.url)),
    false
  );
  assert.equal(
    existsSync(new URL("../src/render/passes/IblSpecularPass.ts", import.meta.url)),
    false
  );
  assert.match(IBL_BASELINE_PASS_SOURCE, /if \(options\.baselineSpecular\)/);
  assert.match(IBL_BASELINE_PASS_SOURCE, /builder\.create\("pre-exposed-baseline-specular"/);
  assert.match(OPAQUE_LIGHTING_PIPELINE_SOURCE, /resolveIblBaseline/);
  assert.match(OPAQUE_LIGHTING_PIPELINE_SOURCE, /resolveScreenDiffuseBaseline/);
  assert.doesNotMatch(OPAQUE_LIGHTING_PIPELINE_SOURCE, /IblDiffusePass|IblSpecularPass/);
});

test("ADR-0009 Step 3 accepts one three-context comprehensive SurfaceLite run group", () => {
  const runs = [0, 1, 2].map((ordinal) => ({
    baselineBytesPerPixel: 58,
    candidateBytesPerPixel: 24,
    expectedCandidateBytesPerPixel: 24,
    baselineAttachmentBytes: 1920 * 1080 * 58,
    candidateAttachmentBytes: 1920 * 1080 * 24,
    expectedCandidateAttachmentBytes: 1920 * 1080 * 24,
    surfaceSampleCount: 480,
    conversionPassesAdded: 0,
    correctnessParity: true,
    runId: `run-${ordinal}`,
    runGroupId: "comprehensive-full-group",
    sessionId: `session-${ordinal}`
  }));
  assert.deepEqual(evaluateSurfaceAbiV2RunGroupNeed(runs), {
    status: "required",
    reason: "all independent runs preserve parity, match the physical footprint, save bytes, and add no conversion",
    bytesSavedPerPixel: 34
  });
  assert.equal(
    evaluateSurfaceAbiV2RunGroupNeed(runs.map((run, ordinal) =>
      ordinal === 2 ? { ...run, candidateAttachmentBytes: run.candidateAttachmentBytes + 4 } : run
    )).status,
    "insufficient-evidence"
  );
});

test("ADR-0009 Step 4 pins the Three.js r186 GTAO invariants", () => {
  assert.equal(THREE_GTAO_REVISION, "148ef33ecb6d2502ff796d4554abd1549c95d519");
  assert.match(THREE_GTAO_RAW_WGSL, /array<f32, 6>\(60\.0, 300\.0, 180\.0, 240\.0, 120\.0, 0\.0\)/);
  assert.match(THREE_GTAO_RAW_WGSL, /9u, 3u, 22u, 16u, 15u/);
  assert.match(THREE_GTAO_RAW_WGSL, /let sample_distance_fraction = step_t \* step_t/);
  assert.match(THREE_GTAO_RAW_WGSL, /abs\(positive_view_delta\.z\) < thickness_world/);
  assert.match(THREE_GTAO_RAW_WGSL, /positive_falloff \* positive_falloff/);
  assert.match(THREE_GTAO_RAW_WGSL, /term_positive \+ term_negative/);
  assert.match(THREE_GTAO_RAW_WGSL, /visibility \* visibility/);
  assert.match(THREE_GTAO_RAW_WGSL, /uv_octahedral_unit_encode\(bent_normal\)/);
  assert.doesNotMatch(THREE_GTAO_RAW_WGSL, /hilbert|runtime mip|SSAO/i);
});

test("ADR-0009 Step 4 temporally filters packed AO moments and bent normals", () => {
  assert.equal(GTAO_MOMENTS_FORMAT, "rgba16float");
  assert.equal(GTAO_MOMENTS_BYTES_PER_PIXEL, 8);
  assert.equal(GTAO_FINAL_VISIBILITY_FORMAT, "r8unorm");
  assert.equal(GTAO_FINAL_VISIBILITY_BYTES_PER_PIXEL, 1);
  assert.equal(GTAO_BENT_NORMAL_FORMAT, "rg16uint");
  assert.equal(GTAO_BENT_NORMAL_BYTES_PER_PIXEL, 4);
  assert.match(GTAO_SPATIAL_WGSL, /filtered_bent \+= weight \* uv_octahedral_unit_decode\(sample_value\.ba\)/);
  assert.match(GTAO_SPATIAL_WGSL, /vec4f\(moments, encode_filtered_bent_normal\(bent\)\)/);
  assert.match(GTAO_TEMPORAL_WGSL, /let current_bent = oct_decode\(current\.ba\)/);
  assert.match(GTAO_TEMPORAL_WGSL, /let filtered_bent_sum = mix\(current_bent, history_bent, blend\)/);
  assert.match(GTAO_TEMPORAL_WGSL, /vec4f\(filtered_moments, oct_encode\(filtered_bent\)\)/);
  assert.equal(existsSync(new URL("../src/shaders/ssao.ts", import.meta.url)), false);
  assert.equal(
    existsSync(new URL("../src/render/passes/ScreenSpaceAmbientOcclusionPass.ts", import.meta.url)),
    false
  );
});

test("ADR-0009 Step 5 pins the Three.js r186 SSGI sampling invariants", () => {
  assert.equal(THREE_SSGI_REVISION, "148ef33ecb6d2502ff796d4554abd1549c95d519");
  assert.match(THREE_SSGI_TRACE_WGSL, /array<f32, 6>\(60\.0, 300\.0, 180\.0, 240\.0, 120\.0, 0\.0\)/);
  assert.match(THREE_SSGI_TRACE_WGSL, /array<f32, 4>\(0\.0, 0\.5, 0\.25, 0\.75\)/);
  assert.match(THREE_SSGI_TRACE_WGSL, /var occluded = 0u/);
  assert.match(THREE_SSGI_TRACE_WGSL, /let newly_occluded = mask & ~occluded/);
  assert.match(THREE_SSGI_TRACE_WGSL, /countOneBits\(occluded\)/);
  assert.match(THREE_SSGI_TRACE_WGSL, /initial_ray_step/);
  assert.match(THREE_SSGI_TRACE_WGSL, /settings\.backface_lighting/);
  assert.match(THREE_SSGI_TRACE_WGSL, /luminance > 7\.0/);
});

test("ADR-0009 Step 5 freezes one receiver-local long-range provider producer", () => {
  assert.equal(LONG_RANGE_PROVIDER_FORMAT, "rgba16float");
  assert.match(LONG_RANGE_DIFFUSE_PROVIDER_WGSL, /brick_registered/);
  assert.match(LONG_RANGE_DIFFUSE_PROVIDER_WGSL, /brick4_receiver_valid\(position\)/);
  assert.match(LONG_RANGE_DIFFUSE_PROVIDER_WGSL, /lpv_lookup_cell\(position/);
  assert.match(LONG_RANGE_DIFFUSE_PROVIDER_WGSL, /provider_settings\.ibl_resident/);
  assert.match(LONG_RANGE_DIFFUSE_PROVIDER_WGSL, /PROVIDER_BLACK/);
  const brick = LONG_RANGE_DIFFUSE_PROVIDER_WGSL.indexOf("brick4_receiver_valid(position)");
  const probe = LONG_RANGE_DIFFUSE_PROVIDER_WGSL.indexOf("lpv_lookup_cell(position");
  const ibl = LONG_RANGE_DIFFUSE_PROVIDER_WGSL.indexOf("provider_settings.ibl_resident");
  assert.ok(brick >= 0 && probe > brick && ibl > probe);
});

test("ADR-0009 Step 5 validates monolithic Brick4 tree/probe residency", () => {
  const storage = new Uint8Array(32 + 100 * 4);
  const view = new DataView(storage.buffer);
  view.setFloat32(0, -1, true);
  view.setFloat32(4, -2, true);
  view.setFloat32(8, -3, true);
  view.setFloat32(16, 1, true);
  view.setFloat32(20, 2, true);
  view.setFloat32(24, 3, true);
  const words = new Uint32Array(storage.buffer, 32);
  words.fill(93, 0, 64);
  const brick = createBrick4LightMapPackageV1({
    generation: 7,
    storage,
    sourceUri: "fixture://brick4/root"
  });
  assert.equal(brick.schemaVersion, BRICK4_LIGHT_MAP_SCHEMA_VERSION);
  const evidence = validateBrick4LightMapPackageV1(brick);
  assert.deepEqual(evidence, {
    generation: 7,
    byteLength: storage.byteLength,
    branchNodeCount: 1,
    leafNodeCount: 0,
    referencedProbeCount: 1
  });

  const invalid = new Uint8Array(storage);
  new Uint32Array(invalid.buffer, 32)[64] = 0x80000000;
  assert.throws(
    () => createBrick4LightMapPackageV1({
      generation: 8,
      storage: invalid,
      sourceUri: "fixture://brick4/reserved-bit"
    }),
    /reserved occupancy/
  );
});

test("ADR-0009 Step 5 keeps AO, GI, bent and confidence in one history owner", () => {
  assert.equal(SSGI_TRACE_AO_FORMAT, "rgba16float");
  assert.equal(SSGI_TRACE_GI_FORMAT, "rgba16float");
  assert.equal(SSGI_VISIBILITY_FORMAT, "r8unorm");
  assert.equal(SSGI_BENT_NORMAL_FORMAT, "rg16uint");
  assert.equal(SSGI_INCIDENT_GI_FORMAT, "rgba16float");
  assert.equal(SSGI_CONFIDENCE_FORMAT, "r8unorm");
  assert.match(SSGI_PASS_SOURCE, /historyTextureCount = this\.histories === null \? 0 : 4/);
  assert.match(SSGI_PASS_SOURCE, /SSGI unified temporal AO\+GI resolve/);
  assert.match(SSGI_PASS_SOURCE, /SSGI joint bilateral full-resolution resolve/);
});

test("ADR-0009 Step 5 composes an indirect-only energy delta", () => {
  assert.match(SCREEN_SPACE_DIFFUSE_RESOLVE_SOURCE, /resolved_diffuse \+ near_diffuse - baseline_diffuse/);
  assert.match(SCREEN_SPACE_DIFFUSE_RESOLVE_SOURCE, /albedo_ao\.rgb \* \(1\.0 - metallic\) \* remaining \* material_ao \* RECIPROCAL_PI/);
  assert.match(SCREEN_SPACE_DIFFUSE_RESOLVE_SOURCE, /resolved_screen_occlusion \/ max\(baseline_material_occlusion/);
  assert.doesNotMatch(SCREEN_SPACE_DIFFUSE_RESOLVE_SOURCE, /hdr\s*\*=|scene.*\*.*visibility/i);
});

test("ADR-0009 Step 0 freezes a legal four-group ShadeLighting binding envelope", () => {
  const budget = gpuShadingBindingBudget({
    maxBindGroups: 4,
    maxBindingsPerBindGroup: 1000,
    maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 8,
    maxStorageBuffersPerShaderStage: 10,
    maxStorageTexturesPerShaderStage: 4,
    maxUniformBuffersPerShaderStage: 4
  });
  assert.deepEqual(budget.totals, {
    sampledTextures: 16,
    samplers: 8,
    storageBuffers: 10,
    storageTextures: 4,
    uniformBuffers: 4
  });
  assert.deepEqual(budget.groups.map((group) => group.owner), [
    "frame", "scene", "material", "lighting"
  ]);
  assert.ok(budget.consolidation.includes("asset-metadata-heap"));
  assert.throws(
    () => gpuShadingBindingBudget({
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 1000,
      maxSampledTexturesPerShaderStage: 16,
      maxSamplersPerShaderStage: 8,
      maxStorageBuffersPerShaderStage: 9,
      maxStorageTexturesPerShaderStage: 4,
      maxUniformBuffersPerShaderStage: 4
    }),
    /maxStorageBuffersPerShaderStage >= 10/
  );
});

test("ADR-0009 Step 0 makes screen-space diffuse topology mutually exclusive", () => {
  const off = screenSpaceDiffuseFrame({
    mode: "off",
    screenAmbientVisibility: null,
    bentNormal: 5,
    incidentDiffuseGi: null,
    confidence: null,
    historyGeneration: null,
    normalSpace: "world",
    preExposure: preExposure(),
    domain: full()
  });
  assert.equal(off.mode, "off");

  const gtao = screenSpaceDiffuseFrame({
    mode: "gtao",
    screenAmbientVisibility: 6,
    bentNormal: 7,
    incidentDiffuseGi: null,
    confidence: 8,
    historyGeneration: 4,
    normalSpace: "world",
    preExposure: preExposure(),
    domain: full()
  });
  assert.equal(gtao.incidentDiffuseGi, null);

  const ssgi = screenSpaceDiffuseFrame({
    mode: "ssgi",
    screenAmbientVisibility: 9,
    bentNormal: 10,
    incidentDiffuseGi: 11,
    confidence: 12,
    historyGeneration: 5,
    normalSpace: "world",
    preExposure: preExposure(),
    domain: full()
  });
  assert.equal(ssgi.incidentDiffuseGi, 11);

  assert.throws(
    () => screenSpaceDiffuseFrame({
      ...off,
      screenAmbientVisibility: 99
    }),
    /off mode cannot retain/
  );
  assert.throws(
    () => screenSpaceDiffuseFrame({
      ...gtao,
      incidentDiffuseGi: 99
    }),
    /GTAO cannot publish/
  );
  assert.throws(
    () => screenSpaceDiffuseFrame({
      ...ssgi,
      confidence: null
    }),
    /confidence must not be null/
  );
});

test("ADR-0009 Step 0 normalizes one screen-space diffuse owner and history", () => {
  const topology = (screenSpaceDiffuseMode) => resolveMainFrameFeatureTopology({
    shadows: false,
    ssr: false,
    screenSpaceDiffuseMode,
    screenSpaceDiffuseTemporal: true,
    screenSpaceDiffuseHalfResolution: true,
    temporal: false,
    bloom: false,
    automaticExposure: false,
    motionBlur: false,
    sharpening: false,
    fusedIndirect: false,
    upscaleType: 0,
    debugView: "none",
    indirectLightingMode: 0
  });
  const off = topology("off");
  assert.equal(off.gtao, false);
  assert.equal(off.ssgi, false);
  assert.equal(off.screenSpaceDiffuseTemporal, false);
  assert.deepEqual(off.histories, []);

  const gtao = topology("gtao");
  assert.equal(gtao.gtao, true);
  assert.equal(gtao.ssgi, false);
  assert.deepEqual(gtao.persistentOwners, ["gtao"]);
  assert.deepEqual(gtao.histories, ["gtao-history"]);

  const ssgi = topology("ssgi");
  assert.equal(ssgi.gtao, false);
  assert.equal(ssgi.ssgi, true);
  assert.deepEqual(ssgi.persistentOwners, ["ssgi"]);
  assert.deepEqual(ssgi.histories, ["ssgi-history"]);
  assert.notEqual(gtao.enabledFeatureBits, ssgi.enabledFeatureBits);
  assert.throws(() => topology("both"), /Unknown screen-space diffuse mode/);
});

test("ADR-0009 Step 0 freezes receiver-validity GI precedence and source stages", () => {
  assert.deepEqual(LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE, [
    "brick4",
    "probe-volume",
    "ibl",
    "black"
  ]);
  const longRange = longRangeDiffuseFrame({
    radiance: 13,
    providerSelection: 14,
    counters: 15,
    selection: "receiver-validity",
    precedence: LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE,
    generation: 3,
    preExposure: preExposure(),
    domain: full()
  });
  assert.equal(longRange.selection, "receiver-validity");
  assert.throws(
    () => longRangeDiffuseFrame({
      ...longRange,
      precedence: ["probe-volume", "brick4", "ibl", "black"]
    }),
    /provider precedence/
  );

  const source = preExposedOpaqueRadianceSourceFrame({
    radiance: 16,
    stage: "pre-screen-space-diffuse",
    excludesCurrentFrameSsgi: true,
    excludesScreenAmbientVisibility: true,
    excludesSsrCorrection: true,
    excludesTransparencyAndPost: true,
    preExposure: preExposure(),
    domain: full()
  });
  assert.equal(source.excludesCurrentFrameSsgi, true);
  assert.throws(
    () => preExposedOpaqueRadianceSourceFrame({
      ...source,
      excludesCurrentFrameSsgi: false
    }),
    /source-stage exclusions/
  );
});

test("ADR-0009 Step 0 keeps post-SSGI opaque color and SSR replacement explicit", () => {
  const baseline = preExposedOpaqueHdrBaselineFrame({
    hdr: 17,
    baselineSpecular: 18,
    stage: "post-screen-space-diffuse-pre-ssr",
    reflectionCorrectionExpected: true,
    preExposure: preExposure(),
    domain: full()
  });
  assert.equal(baseline.baselineSpecular, 18);
  assert.throws(
    () => preExposedOpaqueHdrBaselineFrame({
      ...baseline,
      baselineSpecular: null
    }),
    /materialize baseline specular iff/
  );

  const pyramid = opaqueColorPyramidFrame({
    texture: 19,
    mipLevelCount: 11,
    stage: "post-screen-space-diffuse-pre-ssr",
    sourceGeneration: 12,
    preExposure: preExposure(),
    domain: full()
  });
  assert.equal(pyramid.mipLevelCount, 11);
  assert.throws(
    () => opaqueColorPyramidFrame({ ...pyramid, mipLevelCount: 12 }),
    /exceeds the declared extent/
  );

  const correction = reflectionCorrectionFrame({
    baselineSpecular: 18,
    ssrSpecular: 20,
    resolvedSpecular: 21,
    confidence: 22,
    variance: 23,
    composition: "confidence-replacement",
    preExposure: preExposure(),
    domain: full()
  });
  assert.equal(correction.composition, "confidence-replacement");
  assert.throws(
    () => reflectionCorrectionFrame({
      ...correction,
      composition: "additive"
    }),
    /replace baseline specular/
  );
});

test("ADR-0009 Step 0 rejects invalid exposure and cross-resolution products", () => {
  assert.throws(
    () => preExposureContract({
      multiplier: 0,
      generation: 0,
      colorSpace: "working-linear"
    }),
    /finite and positive/
  );
  assert.throws(
    () => shadingSurfaceLiteFrame({
      normal: 1,
      roughnessFlags: 2,
      metallicSpecular: null,
      normalSpace: "world",
      domain: textureDomain("internal-half", 960, 540, 0.5)
    }),
    /internal-full/
  );
});
