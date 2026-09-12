import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE,
  diffuseSurfaceLiteFrame,
  finalColorPyramidFrame,
  longRangeDiffuseFrame,
  materialTileClassificationFrame,
  opaqueColorPyramidFrame,
  preExposedOpaqueHdrBaselineFrame,
  preExposedOpaqueRadianceSourceFrame,
  preExposureContract,
  reflectionCorrectionFrame,
  screenSpaceDiffuseFrame,
  shadingSurfaceLiteFrame,
  temporalReconstructionFrame,
  textureDomain
} from "../.test-dist/render/pipeline/FrameProducts.js";
import { TemporalHistoryRegistry } from "../.test-dist/render/TemporalHistoryRegistry.js";
import {
  DynamicResolutionScaling
} from "../.test-dist/render/DynamicResolutionScaling.js";
import { RenderSettings } from "../.test-dist/render/pipeline/RenderSettings.js";
import {
  classifyTemporalHistory
} from "../.test-dist/render/TemporalResolveContract.js";
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
  GTAO_JOINT_BILATERAL_RESOLVE_WGSL,
  GTAO_LINEAR_DEPTH_WGSL,
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
  SSGI_RESOLVE_WGSL,
  SSGI_SPATIAL_WGSL,
  SSGI_TRACE_AO_FORMAT,
  SSGI_TRACE_GI_FORMAT,
  SSGI_VISIBILITY_FORMAT,
  SSGI_TEMPORAL_WGSL,
  THREE_SSGI_REVISION,
  THREE_SSGI_TRACE_WGSL
} from "../.test-dist/shaders/ssgi.js";
import {
  LONG_RANGE_DIFFUSE_PROVIDER_WGSL,
  LONG_RANGE_PROVIDER_FORMAT
} from "../.test-dist/shaders/long_range_diffuse_provider.js";
import { OPAQUE_LIGHTING_RESOLVE_WGSL } from "../.test-dist/shaders/opaque_lighting_resolve.js";
import { THREE_SSR_REVISION } from "../.test-dist/shaders/ssr_common.js";
import { SSR_TRACE_WGSL } from "../.test-dist/shaders/ssr_trace.js";
import { SSR_RESOLVE_WGSL } from "../.test-dist/shaders/ssr_resolve.js";
import {
  SSR_RECURRENT_DENOISE_WGSL,
  SSR_TEMPORAL_WGSL,
  SSR_UPSAMPLE_WGSL
} from "../.test-dist/shaders/ssr_denoise.js";
import { SPECULAR_CORRECTION_WGSL } from "../.test-dist/shaders/specular_correction.js";
import { TAA_WGSL } from "../.test-dist/shaders/taa.js";
import { temporalEvidenceWgsl } from "../.test-dist/shaders/temporal_classification.js";
import { NSS_PREPROCESS_WGSL } from "../.test-dist/shaders/nss.js";
import { MOTION_BLUR_RESOLVE_WGSL } from "../.test-dist/shaders/motion_blur.js";
import { OCCLUSION_CONFIDENCE_WGSL } from "../.test-dist/shaders/occlusion_confidence.js";
import {
  HZB_FROM_DEPTH_COMPUTE_WGSL,
  HZB_REDUCE_COMPUTE_WGSL
} from "../.test-dist/shaders/hzb_reduce.js";
import {
  finalOutputBindingPlan
} from "../.test-dist/shaders/final_output_input.js";
import { summarizeFrameGraphResources } from "../.test-dist/framegraph/FrameResourceSummary.js";
import { tonemapSdrWgsl } from "../.test-dist/shaders/tonemap_sdr.js";
import { tonemapHdrWgsl } from "../.test-dist/shaders/tonemap_hdr.js";
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
const OPAQUE_LIGHTING_RESOLVE_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/OpaqueLightingResolvePass.ts", import.meta.url),
  "utf8"
);
const GI_SERVICE_SOURCE = readFileSync(
  new URL("../src/render/features/GIService.ts", import.meta.url),
  "utf8"
);
const SSGI_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/SsgiPass.ts", import.meta.url),
  "utf8"
);
const GTAO_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/GtaoPass.ts", import.meta.url),
  "utf8"
);
const SCREEN_SPACE_DIFFUSE_RESOLVE_SOURCE = readFileSync(
  new URL("../src/shaders/screen_space_diffuse_resolve.ts", import.meta.url),
  "utf8"
);
const MAIN_PIPELINE_SOURCE = readFileSync(
  new URL("../src/render/pipeline/MainRenderPipeline.ts", import.meta.url),
  "utf8"
);
const TONEMAP_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/TonemapPass.ts", import.meta.url),
  "utf8"
);
const BLOOM_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/BloomPass.ts", import.meta.url),
  "utf8"
);
const FRAMEGRAPH_RESOURCE_HANDLE_SOURCE = readFileSync(
  new URL("../src/framegraph/ResourceHandle.ts", import.meta.url),
  "utf8"
);
const TEMPORAL_ANTI_ALIASING_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/TemporalAntiAliasingPass.ts", import.meta.url),
  "utf8"
);
const TEMPORAL_CLASSIFICATION_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/TemporalClassificationPass.ts", import.meta.url),
  "utf8"
);
const NEURAL_SUPER_SAMPLING_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/NeuralSuperSamplingPass.ts", import.meta.url),
  "utf8"
);
const MOTION_BLUR_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/MotionBlurPass.ts", import.meta.url),
  "utf8"
);
const SSR_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/ScreenSpaceReflectionsPass.ts", import.meta.url),
  "utf8"
);
const OCCLUSION_CONFIDENCE_PASS_SOURCE = readFileSync(
  new URL("../src/render/passes/OcclusionConfidencePass.ts", import.meta.url),
  "utf8"
);
const RENDER_TARGETS_SOURCE = readFileSync(
  new URL("../src/render/RenderTargets.ts", import.meta.url),
  "utf8"
);
const SURFACE_VALIDATION_SOURCE = readFileSync(
  new URL("../../examples/validation/surface/main.ts", import.meta.url),
  "utf8"
);
const TEMPORAL_EVIDENCE_WGSL = temporalEvidenceWgsl(69, 70, 71);

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
  assert.equal(
    existsSync(new URL("../src/render/passes/IblBaselinePass.ts", import.meta.url)),
    false
  );
  assert.equal(
    existsSync(new URL("../src/render/pipeline/OpaqueLightingPipeline.ts", import.meta.url)),
    false
  );
  assert.match(OPAQUE_LIGHTING_RESOLVE_PASS_SOURCE, /options\.baselineSpecular/);
  assert.match(OPAQUE_LIGHTING_RESOLVE_PASS_SOURCE, /builder\.create\("pre-exposed-baseline-specular"/);
  assert.match(OPAQUE_LIGHTING_RESOLVE_PASS_SOURCE, /fs_main_with_baseline/);
  assert.match(OPAQUE_LIGHTING_RESOLVE_PASS_SOURCE, /fs_main_no_ao_with_baseline/);
  assert.match(
    OPAQUE_LIGHTING_RESOLVE_WGSL,
    /indirect\[1\] \* material_ao \* ambient_visibility_value/
  );
  assert.doesNotMatch(
    OPAQUE_LIGHTING_RESOLVE_WGSL,
    /fallback_diffuse_irradiance,[\s\S]{0,120}\) \* material_ao/
  );
  assert.doesNotMatch(GI_SERVICE_SOURCE, /mode: "ibl"|mode: "brick4"|mode: "lpv"/);
  assert.match(GI_SERVICE_SOURCE, /selectedSpecularRadiance: selected\.specularRadiance/);
  assert.match(GI_SERVICE_SOURCE, /baselineSpecular: resolved\.baselineSpecular/);
  assert.doesNotMatch(
    GI_SERVICE_SOURCE,
    /baselineSpecular:\s*resolved\.baselineSpecular\s*\?\?\s*selected\.specularRadiance/
  );
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
  assert.match(THREE_GTAO_RAW_WGSL, /@binding\(0\) var gr_bucket: texture_depth_2d/);
  assert.doesNotMatch(THREE_GTAO_RAW_WGSL, /textureLoad\(gr_bucket,[^\n]+\)\.r/);
  assert.match(GTAO_LINEAR_DEPTH_WGSL, /var device_depth_source: texture_depth_2d/);
  assert.match(GTAO_JOINT_BILATERAL_RESOLVE_WGSL, /var device_depth_source: texture_depth_2d/);
  assert.doesNotMatch(GTAO_LINEAR_DEPTH_WGSL, /textureLoad\(device_depth_source,[^\n]+\)\.r/);
  assert.doesNotMatch(GTAO_JOINT_BILATERAL_RESOLVE_WGSL, /textureLoad\(device_depth_source,[^\n]+\)\.r/);
  assert.match(
    GTAO_PASS_SOURCE,
    /linear\/view-depth mip group0[\s\S]*?binding: 0,[^\n]*sampleType: "depth"/
  );
  assert.match(
    GTAO_PASS_SOURCE,
    /joint bilateral resolve group0[\s\S]*?binding: 2,[^\n]*sampleType: "depth"/
  );
  assert.match(
    GTAO_PASS_SOURCE,
    /horizon trace group0[\s\S]*?binding: 0,[^\n]*sampleType: "depth"/
  );
  assert.match(GTAO_PASS_SOURCE, /velocity\?: ResourceId;/);
  assert.match(GTAO_PASS_SOURCE, /occlusionConfidence\?: ResourceId;/);
  assert.match(GTAO_PASS_SOURCE, /surfaceValidity\?: ResourceId;/);
  assert.match(
    GTAO_PASS_SOURCE,
    /GTAO temporal history and motion\/disocclusion inputs are required/
  );
  assert.match(GTAO_PASS_SOURCE, /var surface_validity_source: texture_2d<f32>/);
  assert.match(GTAO_PASS_SOURCE, /validity\.g >= 0\.5 && validity\.r < 0\.5/);
  assert.match(
    GTAO_PASS_SOURCE,
    /\(vec2f\(id\.xy\) \+ 0\.5\) \/ vec2f\(ao_dimensions\)/
  );
  assert.doesNotMatch(MAIN_PIPELINE_SOURCE, /velocity: velocityRes \?\? depthRes/);
  assert.doesNotMatch(
    MAIN_PIPELINE_SOURCE,
    /occlusionConfidence: occlusionConfidenceRes \?\? depthRes/
  );
  assert.match(THREE_GTAO_RAW_WGSL, /array<f32, 6>\(60\.0, 300\.0, 180\.0, 240\.0, 120\.0, 0\.0\)/);
  assert.match(THREE_GTAO_RAW_WGSL, /9u, 3u, 22u, 16u, 15u/);
  assert.match(THREE_GTAO_RAW_WGSL, /dot\(uv, vec2f\(12\.9898, 78\.233\)\)/);
  assert.match(THREE_GTAO_RAW_WGSL, /three_rand\(\(sample_uv \+ noise_jitter_index\) \* 2\.0 - 1\.0\)/);
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
  assert.match(THREE_SSGI_TRACE_WGSL, /return select\(1\.0, rotations\[frame % 6u\]/);
  assert.match(THREE_SSGI_TRACE_WGSL, /dot\(uv, vec2f\(12\.9898, 78\.233\)\)/);
  assert.match(THREE_SSGI_TRACE_WGSL, /temporal_direction_value \* 0\.02/);
  assert.match(THREE_SSGI_TRACE_WGSL, /screen_step_radius/);
  assert.match(THREE_SSGI_TRACE_WGSL, /settings\.sampling_domain == 1u/);
  assert.match(THREE_SSGI_TRACE_WGSL, /interleaved_gradient_noise/);
  assert.match(THREE_SSGI_TRACE_WGSL, /if \(!in_view\(candidate_uv\)\) \{ break; \}/);
  assert.match(THREE_SSGI_TRACE_WGSL, /var occluded = 0u/);
  assert.match(THREE_SSGI_TRACE_WGSL, /let newly_occluded = mask & ~occluded/);
  assert.match(THREE_SSGI_TRACE_WGSL, /Bent normal is a geometric visibility product/);
  assert.ok(
    THREE_SSGI_TRACE_WGSL.indexOf("bent -=") <
      THREE_SSGI_TRACE_WGSL.indexOf("let center_facing"),
    "bent-normal accumulation must not depend on GI emitter/receiver facing"
  );
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
  assert.match(SSGI_PASS_SOURCE, /velocity\?: ResourceId;/);
  assert.match(SSGI_PASS_SOURCE, /occlusionConfidence\?: ResourceId;/);
  assert.match(SSGI_PASS_SOURCE, /surfaceValidity\?: ResourceId;/);
  assert.match(
    SSGI_PASS_SOURCE,
    /SsgiPass temporal history and motion\/disocclusion inputs are required/
  );
  const traceEvidenceSource = SSGI_PASS_SOURCE.slice(
    SSGI_PASS_SOURCE.indexOf("const SSGI_TRACE_EVIDENCE_WGSL"),
    SSGI_PASS_SOURCE.indexOf("const SSGI_TRACE_EVIDENCE_PIPELINE")
  );
  const temporalEvidenceSource = SSGI_PASS_SOURCE.slice(
    SSGI_PASS_SOURCE.indexOf("const SSGI_TEMPORAL_EVIDENCE_WGSL"),
    SSGI_PASS_SOURCE.indexOf("const SSGI_TEMPORAL_EVIDENCE_PIPELINE")
  );
  assert.doesNotMatch(traceEvidenceSource, /velocity_source|confidence_source/);
  assert.doesNotMatch(traceEvidenceSource, /SSGI_ACCEPTED|SSGI_REJECTED/);
  assert.match(temporalEvidenceSource, /surface_validity_source/);
  assert.match(temporalEvidenceSource, /classification\.g >= 0\.5 && classification\.r < 0\.5/);
  assert.match(temporalEvidenceSource, /settings\.pre_exposure_scale > 0\.0 && in_bounds/);
  assert.doesNotMatch(temporalEvidenceSource, /length\(velocity\) < 128\.0/);
  assert.doesNotMatch(MAIN_PIPELINE_SOURCE, /velocity: velocityRes \?\? gAlbedoRes/);
  assert.doesNotMatch(
    MAIN_PIPELINE_SOURCE,
    /occlusionConfidence: occlusionConfidenceRes \?\? gAlbedoRes/
  );
  assert.match(SSGI_TEMPORAL_WGSL, /classification\.g >= 0\.5 && classification\.r < 0\.5/);
  assert.match(SSGI_TEMPORAL_WGSL, /settings\.blend \* history_validity \* confidence/);
  assert.match(SSGI_SPATIAL_WGSL, /bent_sum \+= oct_decode/);
  assert.match(SSGI_SPATIAL_WGSL, /oct_encode\(filtered_bent\)/);
  assert.match(SSGI_TEMPORAL_WGSL, /history_bent = select/);
  assert.match(SSGI_TEMPORAL_WGSL, /oct_encode\(filtered_bent\)/);
  assert.match(SSGI_RESOLVE_WGSL, /bent_sum \+= oct_decode/);
  assert.match(SSGI_RESOLVE_WGSL, /oct_encode\(bent_normal\)/);
  assert.match(SSGI_RESOLVE_WGSL, /normal_weight/);
  assert.match(SSGI_RESOLVE_WGSL, /dot\(center_normal, sample_normal\)/);
  assert.doesNotMatch(SSGI_SPATIAL_WGSL, /ao_sum \+= textureLoad\(current_ao/);
  assert.doesNotMatch(SSGI_TEMPORAL_WGSL, /mix\(currentAo, historyAo, history_weight\)/);
  assert.doesNotMatch(
    SSGI_TEMPORAL_WGSL,
    /let validity = textureLoad\(surface_validity, full_pixel, 0\)\.r/
  );
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
    debugView: "none"
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

test("ADR-0009 Step 6 pins the Three-derived SSR chain and baseline replacement", () => {
  assert.equal(THREE_SSR_REVISION, "148ef33ecb6d2502ff796d4554abd1549c95d519");
  assert.match(SSR_TRACE_WGSL, /@binding\(3\) var gr_bucket: texture_depth_2d/);
  assert.doesNotMatch(SSR_TRACE_WGSL, /textureLoad\(gr_bucket,[^\n]+\)\.x/);
  assert.match(SSR_TRACE_WGSL, /sample_ggx_vndf/);
  assert.match(SSR_TRACE_WGSL, /settings\.mirror_bias/);
  assert.match(SSR_TRACE_WGSL, /resolve_trigonometric_moments/);
  assert.match(SSR_TRACE_WGSL, /ffx_sssr_hierarchical_raymarch/);
  assert.match(SSR_TRACE_WGSL, /ssr_sample_reflection_vector/);
  assert.match(SSR_RESOLVE_WGSL, /stochastic_sample_weight/);
  assert.match(SSR_RESOLVE_WGSL, /ssr_sample_reflection_vector/);
  assert.match(SSR_RESOLVE_WGSL, /stochastic_noise/);
  assert.match(SSR_RESOLVE_WGSL, /trace_settings/);
  assert.match(SSR_RESOLVE_WGSL, /sampled_direction/);
  assert.match(SSR_RESOLVE_WGSL, /@binding\(1\) var depth_source: texture_depth_2d/);
  assert.doesNotMatch(SSR_RESOLVE_WGSL, /textureLoad\(depth_source,[^\n]+\)\.r/);
  assert.doesNotMatch(SSR_RESOLVE_WGSL, /coord\.xy \+ vec2f\(0\.5\)/);
  assert.match(SSR_RESOLVE_WGSL, /specular_dominant_factor/);
  assert.doesNotMatch(SSR_RESOLVE_WGSL, /environment|lpv/i);
  assert.match(SSR_TEMPORAL_WGSL, /history_sample_4tap/);
  assert.match(SSR_TEMPORAL_WGSL, /struct HistorySample4Tap/);
  assert.match(SSR_TEMPORAL_WGSL, /max_confidence/);
  assert.match(SSR_TEMPORAL_WGSL, /min_confidence/);
  assert.match(SSR_TEMPORAL_WGSL, /surface_history_pixel/);
  assert.match(SSR_TEMPORAL_WGSL, /hit_effect_pixel/);
  assert.match(SSR_TEMPORAL_WGSL, /hit_history_pixel/);
  assert.match(SSR_TEMPORAL_WGSL, /hit_history_pixel, hit_depth, hit_normal/);
  assert.match(SSR_TEMPORAL_WGSL, /surface_history\.rgb \* surface_weight/);
  assert.match(SSR_TEMPORAL_WGSL, /hit_history\.rgb \* hit_weight/);
  assert.doesNotMatch(SSR_TEMPORAL_WGSL, /velocity = mix\(receiver_velocity, hit_velocity/);
  assert.match(SSR_TEMPORAL_WGSL, /neighborhood_bounds/);
  assert.match(SSR_TEMPORAL_WGSL, /rgb_to_luminance\(color\) \* 10\.0/);
  assert.match(SSR_TEMPORAL_WGSL, /clip_history_to_aabb/);
  assert.match(SSR_TEMPORAL_WGSL, /variance_gamma/);
  assert.match(SSR_TEMPORAL_WGSL, /history_scale/);
  assert.match(SSR_TEMPORAL_WGSL, /clip_confidence/);
  assert.match(SSR_TEMPORAL_WGSL, /ray_length_stddev/);
  assert.match(SSR_TEMPORAL_WGSL, /screen_hit_probability/);
  assert.match(SSR_TEMPORAL_WGSL, /curvature_factor/);
  assert.match(SSR_TEMPORAL_WGSL, /reflection_edge_factor/);
  assert.match(SSR_TEMPORAL_WGSL, /surface_history_validity/);
  assert.match(SSR_TEMPORAL_WGSL, /hit_history_validity/);
  assert.match(SSR_TEMPORAL_WGSL, /hit_disocclusion/);
  assert.match(SSR_TEMPORAL_WGSL, /hit_raw_trust/);
  assert.match(SSR_TEMPORAL_WGSL, /@binding\(7\) var depth_source: texture_depth_2d/);
  assert.doesNotMatch(SSR_TEMPORAL_WGSL, /textureLoad\(depth_source,[^\n]+\)\.r/);
  assert.match(
    SSR_TEMPORAL_WGSL,
    /let current_confidence = trace_validity \* select\(0\.0, 1\.0, current\.a > 1e-5\)/
  );
  assert.doesNotMatch(
    SSR_TEMPORAL_WGSL,
    /let current_confidence = trace_validity \* disocclusion/
  );
  assert.match(SSR_TEMPORAL_WGSL, /reprojection_stretch_confidence/);
  assert.match(SSR_TEMPORAL_WGSL, /dpdx\(history_uv\)/);
  assert.match(SSR_TEMPORAL_WGSL, /minimum_singular_value/);
  assert.match(SSR_TEMPORAL_WGSL, /stretch_confidence \* stretch_confidence/);
  assert.doesNotMatch(SSR_TEMPORAL_WGSL, /camera_current/);
  assert.ok(
    SSR_TEMPORAL_WGSL.indexOf("let stretch_confidence = reprojection_stretch_confidence(") <
      SSR_TEMPORAL_WGSL.indexOf("if (current_confidence <= 0.001)")
  );
  assert.doesNotMatch(SSR_TEMPORAL_WGSL, /pack_field\(encoded_current/);
  assert.doesNotMatch(SSR_TEMPORAL_WGSL, /neighborhood_ray_length|mirror_screen_uv/);
  assert.doesNotMatch(SSR_TEMPORAL_WGSL, /camera_previous|linear_clamp/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /vogel_disk/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /ray_difference/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /mirror_screen_uv/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /raw_spatial_weight/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /center_raw_luma/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /neighborhood_ray_length/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /hit_distance_factor/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /specular_lobe_tan_half_angle/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /lobe_normal_falloff/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /kernel_difference \* history_aggressivity/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /feedback_weight/);
  assert.doesNotMatch(SSR_RECURRENT_DENOISE_WGSL, /roughness_weight|ray_weight|luma_weight/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /0\.5 \* history_aggressivity/);
  assert.doesNotMatch(SSR_RECURRENT_DENOISE_WGSL, /trusted = saturate\(weight \* 2\.0\)/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /settings\.mode_flags & 2u/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /Karis-style inverse-luminance blend/);
  assert.match(SSR_RECURRENT_DENOISE_WGSL, /@binding\(2\) var depth_source: texture_depth_2d/);
  assert.doesNotMatch(SSR_RECURRENT_DENOISE_WGSL, /textureLoad\(depth_source,[^\n]+\)\.r/);
  assert.match(SSR_UPSAMPLE_WGSL, /@binding\(1\) var depth_full: texture_depth_2d/);
  assert.doesNotMatch(SSR_UPSAMPLE_WGSL, /textureLoad\(depth_full,[^\n]+\)\.r/);
  assert.equal(
    (SSR_PASS_SOURCE.match(/resolveDepthAttachmentView\(resources\.get\((?:inputs\.)?depth\)\)/g) ?? []).length,
    5
  );
  assert.equal((SSR_PASS_SOURCE.match(/sampleType: "depth"/g) ?? []).length, 5);
  assert.match(SSR_PASS_SOURCE, /velocity\?: ResourceId;/);
  assert.match(SSR_PASS_SOURCE, /occlusionConfidence\?: ResourceId;/);
  assert.match(SSR_PASS_SOURCE, /surfaceValidity\?: ResourceId;/);
  assert.match(
    SSR_PASS_SOURCE,
    /SSR temporal history and motion\/disocclusion inputs are required/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /graphTopology\.ssrTemporal \? \{[\s\S]*?ssr-history-input[\s\S]*?ssr-history-output[\s\S]*?\} : undefined/
  );
  assert.match(SPECULAR_CORRECTION_WGSL, /\(resolved\.rgb - baseline\) \* confidence/);
  assert.equal(
    existsSync(new URL("../src/shaders/ssr_resolve_lpv.ts", import.meta.url)),
    false
  );
});

test("ADR-0009 Step 7 keeps opaque and final color pyramid semantics distinct", () => {
  const final = finalColorPyramidFrame({
    source: 30,
    texture: 31,
    mipLevelCount: 6,
    stage: "post-transparency-temporal",
    sourceGeneration: 1,
    preExposure: preExposure(),
    domain: textureDomain("output-full", 1920, 1080, 1)
  });
  assert.equal(final.domain.domain, "output-full");
  assert.equal(final.source, 30);
  assert.equal(final.texture, 31);
  assert.throws(
    () => finalColorPyramidFrame({ ...final, source: final.texture }),
    /source resource distinct from its mipmapped texture/
  );
  assert.throws(
    () => finalColorPyramidFrame({
      ...final,
      stage: "post-screen-space-diffuse-pre-ssr"
    }),
    /invalid source stage/
  );
  assert.throws(
    () => finalColorPyramidFrame({
      ...final,
      domain: full()
    }),
    /output-full/
  );
});

test("ADR-0009 Step 7 advances and invalidates histories at submission boundaries", () => {
  const registry = new TemporalHistoryRegistry([
    {
      name: "color",
      semantic: "final-temporal-color",
      resolutionDomain: "output-full",
      format: "rgba16float",
      bufferCount: 2,
      preExposure: "working-linear-rescale"
    },
    {
      name: "gtao",
      semantic: "gtao-visibility-bent-moments",
      resolutionDomain: "effect-resolution",
      format: "rgba16float",
      bufferCount: 2,
      preExposure: "none"
    }
  ]);
  const revision = {
    outputWidth: 1920,
    outputHeight: 1080,
    internalWidth: 1440,
    internalHeight: 810,
    camera: 0,
    renderScale: 0.75,
    feature: 1,
    format: 5,
    light: 2,
    scene: 3,
    representation: 1,
    device: 0,
    preExposureGeneration: 7,
    view: "camera-4"
  };
  const exposureA = preExposure();
  registry.beginFrame(0, revision, ["color", "gtao"], exposureA);
  assert.equal(registry.state("color").readValid, false);
  assert.equal(registry.state("color").writeIndex, 1);
  registry.markProduced("color");
  registry.markProduced("gtao");
  assert.equal(registry.commitFrame(0), true);
  assert.equal(registry.state("color").readIndex, 1);

  const exposureB = preExposureContract({
    multiplier: exposureA.multiplier * 2,
    generation: exposureA.generation,
    colorSpace: "working-linear"
  });
  registry.beginFrame(1, revision, ["color", "gtao"], exposureB);
  assert.equal(registry.state("color").readValid, true);
  assert.equal(registry.state("color").preExposureScale, 2);
  assert.equal(registry.state("gtao").preExposureScale, 1);
  registry.markProduced("color");
  registry.markProduced("gtao");
  registry.commitFrame(1);

  registry.beginFrame(
    2,
    { ...revision, feature: 2 },
    ["color", "gtao"],
    exposureB
  );
  assert.equal(registry.state("color").readValid, false);
  assert.equal(registry.state("color").lastInvalidationReason, "feature-toggle");
  registry.abortFrame(2);
  assert.equal(registry.state("color").valid, false);
  assert.equal(registry.state("color").lastInvalidationReason, "abort");
});

test("ADR-0009 Step 7 scopes pre-exposure discontinuity to dependent histories", () => {
  const registry = new TemporalHistoryRegistry([
    {
      name: "color",
      semantic: "final-temporal-color",
      resolutionDomain: "output-full",
      format: "rgba16float",
      bufferCount: 2,
      preExposure: "working-linear-rescale"
    },
    {
      name: "gtao",
      semantic: "gtao-visibility-bent-moments",
      resolutionDomain: "effect-resolution",
      format: "rgba16float",
      bufferCount: 2,
      preExposure: "none"
    }
  ]);
  const revision = {
    outputWidth: 1280,
    outputHeight: 720,
    internalWidth: 1280,
    internalHeight: 720,
    camera: 0,
    renderScale: 1,
    feature: 1,
    format: 5,
    light: 0,
    scene: 1,
    representation: 1,
    device: 0,
    preExposureGeneration: 0,
    view: "camera"
  };
  const exposure0 = preExposureContract({ multiplier: 1, generation: 0, colorSpace: "working-linear" });
  registry.beginFrame(0, revision, ["color", "gtao"], exposure0);
  registry.markProduced("color");
  registry.markProduced("gtao");
  registry.commitFrame(0);

  const exposure1 = preExposureContract({ multiplier: 0.5, generation: 1, colorSpace: "working-linear" });
  registry.beginFrame(
    1,
    { ...revision, preExposureGeneration: 1 },
    ["color", "gtao"],
    exposure1
  );
  assert.equal(registry.state("color").readValid, false);
  assert.equal(registry.state("color").lastInvalidationReason, "exposure-discontinuity");
  assert.equal(registry.state("gtao").readValid, true);
  assert.equal(registry.state("gtao").preExposureScale, 1);
  registry.abortFrame(1);
});

test("ADR-0009 Step 8 freezes the temporal reconstruction product domains", () => {
  const reconstructed = temporalReconstructionFrame({
    hdr: 40,
    confidence: 40,
    confidenceEncoding: "alpha-history-lock",
    owner: "taa",
    stage: "post-transparency-temporal",
    historyGenerationSource: "TemporalHistoryRegistry.color",
    representationRevisionSource: "MainHistoryRevision.representation",
    preExposure: preExposure(),
    inputDomain: textureDomain("internal-full", 1280, 720, 1),
    domain: textureDomain("output-full", 1920, 1080, 1)
  });
  assert.equal(reconstructed.owner, "taa");
  assert.equal(reconstructed.domain.domain, "output-full");
  assert.throws(
    () => temporalReconstructionFrame({
      ...reconstructed,
      confidence: null
    }),
    /HDR alpha history lock/
  );
  assert.throws(
    () => temporalReconstructionFrame({
      ...reconstructed,
      inputDomain: textureDomain("output-full", 1920, 1080, 1)
    }),
    /internal-full/
  );
});

test("ADR-0009 Step 8 makes fixed DRS inert and adaptive DRS bucketed", () => {
  let scale = 1;
  const drs = new DynamicResolutionScaling();
  drs.get_scale = () => scale;
  drs.set_scale = (next) => { scale = next; };
  drs.configure({
    mode: "fixed",
    targetFrameRate: 60,
    minimumScale: 0.67,
    maximumScale: 1,
    tolerance: 0.1,
    settleFrames: 1
  });
  assert.equal(drs.notify_gpu_timing({
    sampleFrameIndex: 0,
    currentFrameIndex: 1,
    gpuFrameTimeMs: 30
  }), false);
  assert.equal(drs.evidence().acceptedGpuSamples, 0);
  assert.equal(scale, 1);

  drs.configure({
    mode: "adaptive",
    targetFrameRate: 60,
    minimumScale: 0.67,
    maximumScale: 1,
    tolerance: 0.1,
    settleFrames: 1
  });
  for (let frame = 0; frame < 32; frame++) {
    assert.equal(drs.notify_gpu_timing({
      sampleFrameIndex: frame,
      currentFrameIndex: frame + 1,
      gpuFrameTimeMs: 30
    }), true);
  }
  const adaptive = drs.evidence();
  assert.equal(adaptive.mode, "adaptive");
  assert.deepEqual(adaptive.scaleBuckets, [0.67, 0.75, 0.8, 0.9, 1]);
  assert.ok(adaptive.scaleChanges > 0);
  assert.ok(adaptive.scaleBuckets.includes(scale));
});

test("ADR-0009 Step 8 requires temporal reconstruction for every sub-native scale", () => {
  const settings = new RenderSettings();
  assert.equal(settings.values.resolution.mode, "fixed");
  assert.equal(settings.values.resolution.internalScale, 1);
  assert.throws(
    () => settings.update({ resolution: { internalScale: 0.75 } }),
    /sub-native internal resolution requires temporal reconstruction/
  );
  assert.equal(settings.values.resolution.internalScale, 1);
  const change = settings.update({
    features: { temporalAntiAliasing: true },
    resolution: {
      mode: "adaptive",
      internalScale: 0.8,
      adaptiveMinimumScale: 0.67,
      adaptiveMaximumScale: 1,
      adaptiveTargetFrameRate: 60
    }
  });
  assert.equal(change.resolutionChanged, true);
  assert.equal(settings.values.resolution.mode, "adaptive");
  assert.throws(
    () => settings.update({
      resolution: { adaptiveMinimumScale: 0.9, internalScale: 0.8 }
    }),
    /inside its configured range/
  );
});

test("ADR-0009 Step 5 exposes both pinned SSGI radius domains without changing the physical default", () => {
  const settings = new RenderSettings();
  assert.equal(settings.values.ssgi.samplingDomain, "world");
  assert.equal(settings.values.ssgi.radiusMeters, 2);
  assert.equal(settings.values.ssgi.screenSpaceRadius, 12);
  const change = settings.update({
    ssgi: { samplingDomain: "screen", screenSpaceRadius: 16 }
  });
  assert.deepEqual(change.historiesInvalidated, ["ssgi"]);
  assert.equal(change.topologyChanged, false);
  assert.throws(
    () => settings.update({ ssgi: { screenSpaceRadius: 26 } }),
    /ssgi\.screenSpaceRadius/
  );
});

test("ADR-0009 Step 8 aligns TAAU reactive rejection and bounded reconstruction", () => {
  assert.match(MAIN_PIPELINE_SOURCE, /wgslLanguageFeatures\.has\(WGSL_EXT_TEXTURE_FORMATS_TIER1\)/);
  assert.match(HZB_FROM_DEPTH_COMPUTE_WGSL, /^\s*requires texture_formats_tier1;/);
  assert.match(HZB_REDUCE_COMPUTE_WGSL, /^\s*requires texture_formats_tier1;/);
  assert.match(NSS_PREPROCESS_WGSL, /^\s*requires texture_formats_tier1;/);
  assert.match(
    PACKED_MATERIAL_COMPUTE_WITH_VELOCITY_WGSL,
    /^\s*requires texture_formats_tier1;/
  );
  assert.doesNotMatch(
    PACKED_MATERIAL_COMPUTE_NO_VELOCITY_WGSL,
    /requires texture_formats_tier1;/
  );
  assert.match(TAA_WGSL, /nine bilinear taps/);
  assert.match(TAA_WGSL, /reactive >= settings\.reactive_threshold/);
  assert.match(TAA_WGSL, /history_pre_exposure_scale/);
  assert.match(TAA_WGSL, /@binding\(6\) var current_depth: texture_depth_2d/);
  assert.match(TAA_WGSL, /let depth = textureLoad\(current_depth, candidate, 0\);/);
  assert.doesNotMatch(TAA_WGSL, /textureLoad\(current_depth,[^\n]+\)\.r/);
  assert.match(
    TEMPORAL_ANTI_ALIASING_PASS_SOURCE,
    /binding: 6,[^\n]*texture: \{ sampleType: "depth" \}/
  );
  assert.match(TAA_WGSL, /relative_luminance_delta/);
  assert.doesNotMatch(TAA_WGSL, /for \(var y = 0; y < 4/);
  assert.match(TEMPORAL_EVIDENCE_WGSL, /closest_taa_depth_pixel/);
  assert.match(TEMPORAL_EVIDENCE_WGSL, /closest_nss_depth_pixel/);
  assert.match(TEMPORAL_EVIDENCE_WGSL, /current_pixel_f - velocity/);
  assert.match(TEMPORAL_EVIDENCE_WGSL, /nss_validity <= \(0\.5 \/ 255\.0\)/);
  assert.match(TEMPORAL_EVIDENCE_WGSL, /var current_depth: texture_depth_2d/);
  assert.match(
    TEMPORAL_CLASSIFICATION_PASS_SOURCE,
    /binding: 4,[^\n]*texture: \{ sampleType: "depth" \}/
  );
  assert.match(
    TEMPORAL_CLASSIFICATION_PASS_SOURCE,
    /reconstructionOwner === "taa"[\s\S]*?outputWidth/
  );
  assert.match(MAIN_PIPELINE_SOURCE, /reconstructionOwner: graphTopology\.nss/);
  assert.match(MAIN_PIPELINE_SOURCE, /bindings\.nssSettings!\.historyPreExposureScale > 0/);
  assert.match(MAIN_PIPELINE_SOURCE, /reuseOpaqueTemporalValidityForFinal/);
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /Number\(featureTopology\.temporal && featureTopology\.transparency\)/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /finalTemporalValidityRes = opaqueTemporalValidityRes/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /Transparent Temporal classification requires its reactive texture/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /finalConsumerCount:[\s\S]*?Bloom reconstruct from FinalColorPyramid[\s\S]*?Automatic exposure histogram eC/
  );
  assert.doesNotMatch(
    MAIN_PIPELINE_SOURCE,
    /finalConsumerCount: Number\(topology\.bloom\)/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /opaqueConsumerCount: Number\(hasLivePass\("SSR stochastic hit shading"\)\)/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /resources[\s\S]*?entry\.firstUsePass !== undefined/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /debugBypass: passes\.some\(\(name\) => name\.startsWith\("Render debug\/"\)\)/
  );
  assert.match(NSS_PREPROCESS_WGSL, /@binding\(2\) var l2: texture_depth_2d/);
  assert.match(
    NSS_PREPROCESS_WGSL,
    /depth_texture: texture_depth_2d,[\s\S]*?let depth = textureLoad\(depth_texture, sample_position, 0\);/
  );
  assert.doesNotMatch(
    NSS_PREPROCESS_WGSL,
    /textureLoad\(depth_texture,[^\n]+\)\.r/
  );
  assert.match(
    NEURAL_SUPER_SAMPLING_PASS_SOURCE,
    /textureEntry\(2, "2d", "depth"\)/
  );
  assert.match(NSS_PREPROCESS_WGSL, /var occlusion_confidence: texture_2d<f32>/);
  assert.match(NSS_PREPROCESS_WGSL, /var surface_validity: texture_2d<f32>/);
  assert.match(NSS_PREPROCESS_WGSL, /let confidence = saturate\(textureLoad\(occlusion_confidence/);
  assert.match(NSS_PREPROCESS_WGSL, /selected_validity\.g >= 0\.5/);
  assert.match(NSS_PREPROCESS_WGSL, /1\.0 - saturate\(reactive\)/);
  assert.match(NSS_PREPROCESS_WGSL, /history_in_bounds && settings\.history_pre_exposure_scale > 0\.0/);
  assert.match(NSS_PREPROCESS_WGSL, /packed_offset, history_validity/);
  assert.doesNotMatch(NSS_PREPROCESS_WGSL, /1\.0 - saturate\(disocclusion\)/);
  assert.match(NEURAL_SUPER_SAMPLING_PASS_SOURCE, /surfaceValidity: ResourceId/);
  assert.match(MAIN_PIPELINE_SOURCE, /surfaceValidity: classification\.classification/);
  assert.match(MAIN_PIPELINE_SOURCE, /inputWidth: bindings\.internalWidth/);
  assert.match(MAIN_PIPELINE_SOURCE, /outputWidth: bindings\.outputWidth/);
  assert.match(MOTION_BLUR_PASS_SOURCE, /Math\.ceil\(job\.inputWidth \/ 16\)/);
  assert.match(MOTION_BLUR_PASS_SOURCE, /job\.outputWidth, job\.outputHeight/);
  assert.match(MOTION_BLUR_RESOLVE_WGSL, /fn mb_output_to_input/);
  assert.match(MOTION_BLUR_RESOLVE_WGSL, /velocity_scale \* uStrength\.value/);
  assert.match(MOTION_BLUR_RESOLVE_WGSL, /fn mb_soft_reverse_z_compare/);
  assert.doesNotMatch(MOTION_BLUR_RESOLVE_WGSL, /textureLoad\(header, pixel_i/);
  assert.doesNotMatch(MOTION_BLUR_RESOLVE_WGSL, /textureLoad\(gr_bucket, sample_position/);
  assert.match(
    OCCLUSION_CONFIDENCE_WGSL,
    /@binding\(0\) var current_depth_source: texture_depth_2d;/
  );
  assert.match(
    OCCLUSION_CONFIDENCE_WGSL,
    /@binding\(1\) var previous_depth_source: texture_depth_2d;/
  );
  assert.match(
    OCCLUSION_CONFIDENCE_WGSL,
    /@binding\(2\) var velocity_source: texture_2d<f32>;/
  );
  assert.match(OCCLUSION_CONFIDENCE_WGSL, /source: texture_depth_2d/);
  assert.doesNotMatch(
    OCCLUSION_CONFIDENCE_WGSL,
    /textureLoad\((?:source|current_depth_source|previous_depth_source),[^\n]+\)\.r/
  );
  assert.equal(
    (OCCLUSION_CONFIDENCE_PASS_SOURCE.match(
      /resolveDepthAttachmentView\(resources\.get\(inputs\.(?:currentDepth|previousDepth)\)\)/g
    ) ?? []).length,
    2
  );
  assert.equal(
    (OCCLUSION_CONFIDENCE_PASS_SOURCE.match(/sampleType: "depth"/g) ?? []).length,
    2
  );
  assert.match(OCCLUSION_CONFIDENCE_PASS_SOURCE, /mipLevelCount: 1/);
  assert.doesNotMatch(OCCLUSION_CONFIDENCE_PASS_SOURCE, /textureMipLevelCount/);
  assert.match(
    RENDER_TARGETS_SOURCE,
    /Hierarchical depth lives in the dedicated rg16float HZB owner[\s\S]*?mipLevelCount: 1/
  );
  assert.doesNotMatch(RENDER_TARGETS_SOURCE, /mipLevelCount: 5/);
  assert.match(RENDER_TARGETS_SOURCE, /setDepthHistoryEnabled\(/);
  assert.match(RENDER_TARGETS_SOURCE, /depthHistoryEnabled \? 2 : 1/);
  assert.match(RENDER_TARGETS_SOURCE, /if \(!this\.depthHistoryEnabled\) return 0;/);
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /function requiresPreviousDepth\(topology: MainFrameFeatureTopology\): boolean \{\s*return topology\.screenSpaceDiffuseTemporal \|\| topology\.ssrTemporal \|\| topology\.temporal;\s*\}/
  );
  assert.doesNotMatch(
    MAIN_PIPELINE_SOURCE,
    /const needsOcclusionConfidence =\s*graphTopology\.screenSpaceDiffuseTemporal \|\|\s*graphTopology\.ssr \|\|/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /previousDepth: requiresPreviousDepth\(graphTopology\)[\s\S]*?\? this\._renderTargets\.depthPrevious[\s\S]*?: null/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /const previousCameraRes = needsOcclusionConfidence \? graph\.import_resource/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /setDepthHistoryEnabled\(\s*this\._graphics\.textures,\s*needsOcclusionConfidence\s*\)/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /\? graph\.import_resource\(\s*"previous_depth"[\s\S]*?\) : null;/
  );
  assert.match(MAIN_PIPELINE_SOURCE, /temporal\.previousDepthBytes/);
  assert.match(MAIN_PIPELINE_SOURCE, /temporal\.mainDepthTextureCount/);
  assert.equal(classifyTemporalHistory({
    historyValid: true,
    motionValid: true,
    reactive: 0.5,
    disocclusionConfidence: 1,
    velocityMagnitudePixels: 0,
    currentLuminance: 1,
    historyLuminance: 1,
    reprojectedInside: true
  }).rejectionReason, "reactive");
  assert.equal(classifyTemporalHistory({
    historyValid: true,
    motionValid: false,
    reactive: 0,
    disocclusionConfidence: 1,
    velocityMagnitudePixels: 0,
    currentLuminance: 1,
    historyLuminance: 1,
    reprojectedInside: true
  }).rejectionReason, "motion-invalid");
});

test("ADR-0009 Step 9 statically specializes final-output bindings", () => {
  assert.deepEqual(finalOutputBindingPlan({
    bloom: false,
    sharpening: false,
    colorGrading: false
  }), {
    source: 0,
    bloom: null,
    sampler: null,
    effects: null,
    next: 1
  });
  assert.deepEqual(finalOutputBindingPlan({
    bloom: true,
    sharpening: true,
    colorGrading: true
  }), {
    source: 0,
    bloom: 1,
    sampler: 2,
    effects: 3,
    next: 4
  });

  const plain = tonemapSdrWgsl({
    bloom: false,
    sharpening: false,
    colorGrading: false
  });
  const fused = tonemapHdrWgsl({
    bloom: true,
    sharpening: true,
    colorGrading: true
  });
  assert.doesNotMatch(plain, /final_bloom|final_grade|let north/);
  assert.match(fused, /var final_bloom/);
  assert.match(fused, /fn final_grade/);
  assert.match(fused, /let north = load_post_color/);
  assert.match(fused, /rgb = load_final_hdr/);
});

test("ADR-0009 Step 9 fuses normal post and preserves capture materialization", () => {
  assert.match(MAIN_PIPELINE_SOURCE, /composite: materializePostColor/);
  assert.match(MAIN_PIPELINE_SOURCE, /const fuseScenePost = !graphTopology\.debug && !materializePostColor/);
  assert.match(MAIN_PIPELINE_SOURCE, /colorGrading: fuseScenePost/);
  assert.doesNotMatch(MAIN_PIPELINE_SOURCE, /addSharpenToGraph\(/);
  assert.match(TONEMAP_PASS_SOURCE, /lastBloomFused/);
  assert.match(TONEMAP_PASS_SOURCE, /createFinalOutputGroupLayout/);
  assert.match(TONEMAP_PASS_SOURCE, /Final Output SDR/);
  assert.match(TONEMAP_PASS_SOURCE, /Final Output HDR/);
  assert.match(FRAMEGRAPH_RESOURCE_HANDLE_SOURCE, /\| "output-half"/);
  assert.match(
    BLOOM_PASS_SOURCE,
    /create\("Bloom reconstructed pyramid",[\s\S]*?domain: "output-half"/
  );
  assert.match(
    BLOOM_PASS_SOURCE,
    /create\("Bloom composited",[\s\S]*?domain: "output-full"/
  );
  assert.match(
    SURFACE_VALIDATION_SOURCE,
    /function liveFrameGraphResourceNames[\s\S]*?entry\.firstUsePass !== undefined/
  );
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /outputMode: this\._highDynamicRange \? "hdr" : "sdr"[\s\S]*?outputFormat: this\._format/
  );
  assert.match(
    SURFACE_VALIDATION_SOURCE,
    /fused\.outputMode === "hdr" && fused\.outputFormat === "rgba16float"[\s\S]*?fused\.outputMode === "sdr"/
  );
  assert.match(SURFACE_VALIDATION_SOURCE, /renderer\.render_debug_view = RenderDebugView\.LinearHdr/);
  assert.match(SURFACE_VALIDATION_SOURCE, /debugShared\.finalConsumerCount === 1/);
  assert.match(SURFACE_VALIDATION_SOURCE, /exposureOff\.finalConsumerCount === 0/);
  assert.match(
    SURFACE_VALIDATION_SOURCE,
    /exposureOff\.histories\.find\(\(history\) => history\.name === "exposure"\)\?\.active === false/
  );
  assert.match(
    SURFACE_VALIDATION_SOURCE,
    /!debugPasses\.includes\("Bloom reconstruct from FinalColorPyramid"\)/
  );
});

test("ADR-0009 evidence distinguishes declared and live FrameGraph resources", () => {
  const summary = summarizeFrameGraphResources({
    dump: () => ({
      resources: [
        { imported: true, transient: false, firstUsePass: 1 },
        { imported: true, transient: false },
        { imported: false, transient: true, firstUsePass: 2, description: "transient_texture" },
        { imported: false, transient: true, firstUsePass: 3, description: "transient_buffer" },
        { imported: false, transient: true, description: "transient_texture" }
      ]
    })
  });
  assert.deepEqual(summary, {
    imported: 2,
    transient: 3,
    transientTextures: 2,
    transientBuffers: 1,
    liveImported: 1,
    liveTransient: 2,
    liveTransientTextures: 1,
    liveTransientBuffers: 1,
    culledResources: 2
  });
  assert.match(
    MAIN_PIPELINE_SOURCE,
    /resource\.firstUsePass !== undefined &&[\s\S]*?pre-exposed-baseline-specular/
  );
});

test("ADR-0009 Step 10 removes single-value backend and retired zero publishers", () => {
  assert.equal(
    existsSync(new URL("../src/render/MaterialResolveBackend.ts", import.meta.url)),
    false
  );
  assert.doesNotMatch(MATERIAL_OWNER_SOURCE, /classDepthPixels|classDraws/);
  assert.doesNotMatch(MAIN_PIPELINE_SOURCE, /classDepthPixels|classDraws/);
  assert.doesNotMatch(MATERIAL_OWNER_SOURCE, /MaterialResolveBackend/);
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
