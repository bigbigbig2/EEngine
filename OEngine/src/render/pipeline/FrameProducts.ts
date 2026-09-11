import type {
  FrameGraphResourceDomain,
  ResourceId
} from "../../framegraph/ResourceHandle.js";
import {
  GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
  GPU_MATERIAL_TILE_WORK_ABI_VERSION
} from "../../gpu/GpuMaterialTileWorkAbi.js";
import { GPU_COMPUTE_MATERIAL_ABI_VERSION } from "../../gpu/GpuComputeMaterialAbi.js";

export type ResolutionDomain = FrameGraphResourceDomain;

export interface TextureDomain<D extends ResolutionDomain = ResolutionDomain> {
  readonly domain: D;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** Optional bounded large-triangle setup cache consumed by Surface resolve. */
export interface TriangleSetupFrame {
  readonly records: ResourceId | null;
  /** Zero when the evidence-gated TriangleSetup cache is disabled. */
  readonly capacity: number;
}

/** Frame-local logical identity table consumed by VisibilityKey V2 users. */
export interface MeshletWorkFrame {
  readonly records: ResourceId;
  readonly capacity: number;
  readonly partition: 0;
  readonly generation: "queue-header";
}

/** Final Packed visibility product. Runtime state stays in its owning feature. */
export interface VisibilityFrame {
  readonly visibilityKey: ResourceId;
  readonly depth: ResourceId;
  readonly meshletWork: MeshletWorkFrame;
  readonly triangleSetup: TriangleSetupFrame;
  readonly domain: TextureDomain<"internal-full">;
}

export function meshletWorkFrame(input: MeshletWorkFrame): MeshletWorkFrame {
  requireResourceId(input.records, "MeshletWorkFrame.records");
  if (!Number.isSafeInteger(input.capacity) || input.capacity <= 0) {
    throw new RangeError("MeshletWorkFrame.capacity must be a positive integer");
  }
  if (input.partition !== 0 || input.generation !== "queue-header") {
    throw new Error("MeshletWorkFrame requires partition 0 and queue-header generation");
  }
  return Object.freeze({ ...input });
}

/** GPU-produced ADR-0009 tile/class queues and indirect ShadeLighting work. */
export interface MaterialTileClassificationFrame {
  readonly abiVersion: number;
  readonly queues: ResourceId;
  readonly indirectArgs: ResourceId;
  readonly control: ResourceId;
  /** Uniform dimensions/generation shared by producer and indirect consumer. */
  readonly settings: ResourceId;
  /** Exactly-once claim buffer; only the authoritative shading consumer writes it. */
  readonly pixelClaims: ResourceId;
  readonly counters: ResourceId | null;
  readonly tileWidth: 8 | 16;
  readonly tileHeight: 8 | 16;
  readonly tileCount: number;
  readonly queueCapacityPerDispatchClass: number;
  readonly dispatchClassCount: number;
  readonly generation: number;
  readonly domain: TextureDomain<"internal-full">;
}

/**
 * ADR-0009 compact physical working set produced by the only full-material
 * evaluator. Consumers bind these named products directly; attachment order
 * and the deleted Surface V1 ABI are not part of the contract.
 */
export interface ComputeMaterialEvaluationFrame {
  readonly abiVersion: number;
  readonly normal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly material: ResourceId;
  readonly velocity: ResourceId | null;
  readonly fullMaterialEvaluationCountSource: "pixel-claims";
  readonly domain: TextureDomain<"internal-full">;
}

export function textureDomain<D extends ResolutionDomain>(
  domain: D,
  width: number,
  height: number,
  scale: number
): TextureDomain<D> {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("TextureDomain width and height must be positive integers");
  }
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("TextureDomain scale must be positive");
  return Object.freeze({ domain, width, height, scale });
}

export function requireDomain(
  producer: TextureDomain,
  expected: ResolutionDomain,
  conversionOwner?: string
): void {
  if (producer.domain === expected) return;
  if (conversionOwner !== undefined && conversionOwner.length > 0) return;
  throw new Error(`Resolution domain mismatch: received ${producer.domain}, expected ${expected}; declare a conversion owner`);
}

/** 完整不透明 HDR 的统一产品；具体 GI/反射算法不得泄漏到消费者。 */
export interface OpaqueLightingFrame {
  readonly hdr: ResourceId;
  readonly iblSpecular: ResourceId;
  readonly indirectDiffuse: ResourceId;
  readonly domain: TextureDomain<"internal-full">;
}

/** Direct-only linear HDR product produced before GI/AO/SSR/temporal composition. */
export interface DirectLightingFrame {
  readonly hdr: ResourceId;
  readonly domain: TextureDomain<"internal-full">;
}

export type ScreenSpaceDiffuseMode = "off" | "gtao" | "ssgi";
export type LongRangeDiffuseProvider = "brick4" | "probe-volume" | "ibl" | "black";

export const LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE = Object.freeze([
  "brick4",
  "probe-volume",
  "ibl",
  "black"
] as const satisfies readonly LongRangeDiffuseProvider[]);

/** Working-linear pre-exposure identity shared by every HDR-like FrameProduct. */
export interface PreExposureContract {
  readonly multiplier: number;
  readonly generation: number;
  readonly colorSpace: "working-linear";
}

/** Compact downstream surface used by GI, SSR and temporal consumers. */
export interface ShadingSurfaceLiteFrame {
  readonly normal: ResourceId;
  readonly roughnessFlags: ResourceId;
  readonly metallicSpecular: ResourceId | null;
  readonly normalSpace: "world";
  readonly domain: TextureDomain<"internal-full">;
}

/** Conditional receiver data. It must not exist solely for disabled SSGI. */
export interface DiffuseSurfaceLiteFrame {
  readonly diffuseReflectance: ResourceId;
  readonly materialAo: ResourceId;
  readonly receiverFlags: ResourceId;
  readonly colorSpace: "working-linear";
  readonly receiverModulation: "unapplied";
  readonly domain: TextureDomain<"internal-full">;
}

/** Receiver-local authoritative long-range diffuse result. */
export interface LongRangeDiffuseFrame {
  readonly radiance: ResourceId;
  /** Optional materialized provider id; null means selection was fused into the producer. */
  readonly providerSelection: ResourceId | null;
  readonly counters: ResourceId | null;
  readonly selection: "receiver-validity";
  readonly precedence: typeof LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE;
  readonly generation: number;
  readonly preExposure: PreExposureContract;
  readonly domain: TextureDomain<"internal-full">;
}

interface ScreenSpaceDiffuseFrameBase {
  readonly bentNormal: ResourceId;
  readonly normalSpace: "world";
  readonly preExposure: PreExposureContract;
  readonly domain: TextureDomain<"internal-full">;
}

export interface ScreenSpaceDiffuseOffFrame extends ScreenSpaceDiffuseFrameBase {
  readonly mode: "off";
  /** Null means the logical constant 1 and therefore no texture allocation. */
  readonly screenAmbientVisibility: null;
  readonly incidentDiffuseGi: null;
  readonly confidence: null;
  readonly historyGeneration: null;
}

export interface ScreenSpaceDiffuseGtaoFrame extends ScreenSpaceDiffuseFrameBase {
  readonly mode: "gtao";
  readonly screenAmbientVisibility: ResourceId;
  readonly incidentDiffuseGi: null;
  readonly confidence: ResourceId | null;
  readonly historyGeneration: number | null;
}

export interface ScreenSpaceDiffuseSsgiFrame extends ScreenSpaceDiffuseFrameBase {
  readonly mode: "ssgi";
  readonly screenAmbientVisibility: ResourceId;
  readonly incidentDiffuseGi: ResourceId;
  readonly confidence: ResourceId;
  readonly historyGeneration: number;
}

export type ScreenSpaceDiffuseFrame =
  | ScreenSpaceDiffuseOffFrame
  | ScreenSpaceDiffuseGtaoFrame
  | ScreenSpaceDiffuseSsgiFrame;

/** Full-resolution SSGI source before screen-space diffuse composition. */
export interface PreExposedOpaqueRadianceSourceFrame {
  readonly radiance: ResourceId;
  readonly stage: "pre-screen-space-diffuse";
  readonly excludesCurrentFrameSsgi: true;
  readonly excludesScreenAmbientVisibility: true;
  readonly excludesSsrCorrection: true;
  readonly excludesTransparencyAndPost: true;
  readonly preExposure: PreExposureContract;
  readonly domain: TextureDomain<"internal-full">;
}

/** Complete opaque HDR after GTAO/SSGI composition and before SSR correction. */
export interface PreExposedOpaqueHdrBaselineFrame {
  readonly hdr: ResourceId;
  readonly baselineSpecular: ResourceId | null;
  readonly stage: "post-screen-space-diffuse-pre-ssr";
  readonly reflectionCorrectionExpected: boolean;
  readonly preExposure: PreExposureContract;
  readonly domain: TextureDomain<"internal-full">;
}

/** Mipmapped post-screen-space-diffuse color used by reflection/refraction. */
export interface OpaqueColorPyramidFrame {
  readonly texture: ResourceId;
  readonly mipLevelCount: number;
  readonly stage: "post-screen-space-diffuse-pre-ssr";
  readonly sourceGeneration: number;
  readonly preExposure: PreExposureContract;
  readonly domain: TextureDomain<"internal-full">;
}

/** Output-domain HDR after transparency/temporal and before exposure/bloom. */
export interface FinalColorPyramidFrame {
  /** Exact full-resolution source retained for consumers that need mip 0 unfiltered. */
  readonly source: ResourceId;
  readonly texture: ResourceId;
  readonly mipLevelCount: number;
  readonly stage: "post-transparency-temporal";
  readonly sourceGeneration: number;
  readonly preExposure: PreExposureContract;
  readonly domain: TextureDomain<"output-full">;
}

/** Authoritative output-resolution HDR produced by the temporal owner. */
export interface TemporalReconstructionFrame {
  readonly hdr: ResourceId;
  /** TAA packs lock confidence in HDR alpha; NSS keeps confidence in feedback history. */
  readonly confidence: ResourceId | null;
  readonly confidenceEncoding: "alpha-history-lock" | "nss-feedback-history";
  readonly owner: "taa" | "nss";
  readonly stage: "post-transparency-temporal";
  readonly historyGenerationSource: "TemporalHistoryRegistry.color";
  readonly representationRevisionSource: "MainHistoryRevision.representation";
  readonly preExposure: PreExposureContract;
  readonly inputDomain: TextureDomain<"internal-full">;
  readonly domain: TextureDomain<"output-full">;
}

/** SSR correction product; composition replaces the declared baseline specular. */
export interface ReflectionCorrectionFrame {
  readonly baselineSpecular: ResourceId;
  readonly ssrSpecular: ResourceId;
  readonly resolvedSpecular: ResourceId;
  readonly confidence: ResourceId;
  readonly variance: ResourceId;
  readonly composition: "confidence-replacement";
  readonly preExposure: PreExposureContract;
  readonly domain: TextureDomain<"internal-full">;
}

/** GPU-produced clustered-light products consumed by direct lighting. */
export interface LightClusterFrame {
  readonly parameters: ResourceId;
  readonly lookup: ResourceId;
  readonly data: ResourceId;
  readonly candidateLightList: ResourceId;
  readonly activeLightList: ResourceId;
  readonly counters: ResourceId | null;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly depthSlices: number;
}

/**
 * Shadow producer output consumed by opaque lighting.
 *
 * The product intentionally contains visibility resources and sampling
 * parameters only; it cannot carry an HDR/color target. This keeps CSM,
 * spot/point atlas and future contact-shadow producers on the same seam.
 */
export interface ShadowVisibilityFrame {
  readonly atlas: ResourceId;
  readonly contactVisibility: ResourceId | null;
  readonly cascadeCount: number;
  readonly pcfTapCount: number;
  readonly normalOffsetScale: number;
  readonly depthBias: number;
  readonly slopeScale: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
}

/** SSR/Local Probe 输出的镜面结果，供 correction consumer 使用。 */
export interface ReflectionFrame {
  readonly resolvedSpecular: ResourceId;
  readonly confidence: ResourceId;
  readonly variance: ResourceId;
  readonly domain: TextureDomain<"internal-full" | "internal-half">;
}

export interface AmbientOcclusionFrame {
  readonly visibility: ResourceId;
  readonly bentNormal: ResourceId;
  readonly domain: TextureDomain<"internal-full">;
}

export interface TemporalSurfaceFrame {
  readonly velocity: ResourceId;
  readonly historyConfidence: ResourceId;
  readonly reactive: ResourceId;
  readonly classification: ResourceId;
  readonly domain: TextureDomain<"internal-full">;
}

export type OpaqueTemporalSurfaceFrame = TemporalSurfaceFrame;
export type FinalTemporalSurfaceFrame = TemporalSurfaceFrame;

function requireResourceId(value: ResourceId | null, name: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative resource id or null`);
  }
}

export function triangleSetupFrame(input: TriangleSetupFrame): TriangleSetupFrame {
  requireResourceId(input.records, "TriangleSetupFrame.records");
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 0) {
    throw new RangeError("TriangleSetupFrame.capacity must be a non-negative integer");
  }
  return Object.freeze({ ...input });
}

export function visibilityFrame(input: VisibilityFrame): VisibilityFrame {
  requireResourceId(input.visibilityKey, "VisibilityFrame.visibilityKey");
  requireResourceId(input.depth, "VisibilityFrame.depth");
  if (input.domain.domain !== "internal-full") {
    throw new Error("VisibilityFrame must be produced at internal-full resolution");
  }
  return Object.freeze({
    ...input,
    meshletWork: meshletWorkFrame(input.meshletWork),
    triangleSetup: triangleSetupFrame(input.triangleSetup),
    domain: textureDomain(
      "internal-full",
      input.domain.width,
      input.domain.height,
      input.domain.scale
    )
  });
}

export function materialTileClassificationFrame(
  input: MaterialTileClassificationFrame
): MaterialTileClassificationFrame {
  if (input.abiVersion !== GPU_MATERIAL_TILE_WORK_ABI_VERSION) {
    throw new Error(
      `MaterialTileClassificationFrame ABI ${input.abiVersion} does not match ${GPU_MATERIAL_TILE_WORK_ABI_VERSION}`
    );
  }
  requireRequiredResourceId(input.queues, "MaterialTileClassificationFrame.queues");
  requireRequiredResourceId(
    input.indirectArgs,
    "MaterialTileClassificationFrame.indirectArgs"
  );
  requireRequiredResourceId(input.control, "MaterialTileClassificationFrame.control");
  requireRequiredResourceId(input.settings, "MaterialTileClassificationFrame.settings");
  requireRequiredResourceId(
    input.pixelClaims,
    "MaterialTileClassificationFrame.pixelClaims"
  );
  requireResourceId(input.counters, "MaterialTileClassificationFrame.counters");
  const validTileShape =
    (input.tileWidth === 8 && input.tileHeight === 8) ||
    (input.tileWidth === 16 && input.tileHeight === 8) ||
    (input.tileWidth === 16 && input.tileHeight === 16);
  if (!validTileShape) {
    throw new RangeError(
      "MaterialTileClassificationFrame tile shape must be 8x8, 16x8 or 16x16"
    );
  }
  const domain = requireInternalFullDomain(
    input.domain,
    "MaterialTileClassificationFrame"
  );
  const expectedTileCount =
    Math.ceil(domain.width / input.tileWidth) *
    Math.ceil(domain.height / input.tileHeight);
  if (input.tileCount !== expectedTileCount) {
    throw new RangeError(
      `MaterialTileClassificationFrame tileCount ${input.tileCount} does not match ${expectedTileCount}`
    );
  }
  if (input.queueCapacityPerDispatchClass !== input.tileCount) {
    throw new RangeError(
      "MaterialTileClassificationFrame queue capacity must equal tileCount"
    );
  }
  if (input.dispatchClassCount !== GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT) {
    throw new RangeError(
      `MaterialTileClassificationFrame dispatchClassCount must equal ${GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT}`
    );
  }
  requirePositiveInteger(input.generation, "MaterialTileClassificationFrame generation");
  return Object.freeze({ ...input, domain });
}

export function computeMaterialEvaluationFrame(
  input: ComputeMaterialEvaluationFrame
): ComputeMaterialEvaluationFrame {
  if (input.abiVersion !== GPU_COMPUTE_MATERIAL_ABI_VERSION) {
    throw new Error(
      `ComputeMaterialEvaluationFrame ABI ${input.abiVersion} does not match ${GPU_COMPUTE_MATERIAL_ABI_VERSION}`
    );
  }
  for (const name of [
    "normal",
    "albedoAo",
    "material"
  ] as const) {
    requireRequiredResourceId(input[name], `ComputeMaterialEvaluationFrame.${name}`);
  }
  requireResourceId(input.velocity, "ComputeMaterialEvaluationFrame.velocity");
  if (input.fullMaterialEvaluationCountSource !== "pixel-claims") {
    throw new Error(
      "ComputeMaterialEvaluationFrame count source must be pixel-claims"
    );
  }
  return Object.freeze({
    ...input,
    domain: requireInternalFullDomain(input.domain, "ComputeMaterialEvaluationFrame")
  });
}

/** 创建统一的 Opaque HDR 产品，并在 composition seam 处验证 internal-full 域。 */
export function opaqueLightingFrame(input: OpaqueLightingFrame): OpaqueLightingFrame {
  requireResourceId(input.hdr, "OpaqueLightingFrame.hdr");
  requireResourceId(input.iblSpecular, "OpaqueLightingFrame.iblSpecular");
  requireResourceId(input.indirectDiffuse, "OpaqueLightingFrame.indirectDiffuse");
  if (input.domain.domain !== "internal-full") {
    throw new Error("OpaqueLightingFrame must be produced at internal-full resolution");
  }
  return Object.freeze({
    ...input,
    domain: textureDomain(
      "internal-full",
      input.domain.width,
      input.domain.height,
      input.domain.scale
    )
  });
}

/** Validate the Stage 2A direct-lighting seam without implying GI ownership. */
export function directLightingFrame(input: DirectLightingFrame): DirectLightingFrame {
  requireResourceId(input.hdr, "DirectLightingFrame.hdr");
  if (input.domain.domain !== "internal-full") {
    throw new Error("DirectLightingFrame must be produced at internal-full resolution");
  }
  return Object.freeze({
    ...input,
    domain: textureDomain(
      "internal-full",
      input.domain.width,
      input.domain.height,
      input.domain.scale
    )
  });
}

/** Freeze the producer/consumer ABI for one clustered-light frame. */
export function lightClusterFrame(input: LightClusterFrame): LightClusterFrame {
  for (const name of [
    "parameters", "lookup", "data", "candidateLightList", "activeLightList"
  ] as const) {
    requireResourceId(input[name], `LightClusterFrame.${name}`);
  }
  requireResourceId(input.counters, "LightClusterFrame.counters");
  if (!Number.isInteger(input.width) || input.width <= 0 ||
      !Number.isInteger(input.height) || input.height <= 0) {
    throw new RangeError("LightClusterFrame dimensions must be positive integers");
  }
  if (!Number.isInteger(input.tileSize) || input.tileSize <= 0 ||
      !Number.isInteger(input.depthSlices) || input.depthSlices <= 0) {
    throw new RangeError("LightClusterFrame layout must be positive integers");
  }
  return Object.freeze({ ...input });
}

/** Freeze and validate the Stage 2B shadow producer/consumer ABI. */
export function shadowVisibilityFrame(input: ShadowVisibilityFrame): ShadowVisibilityFrame {
  requireResourceId(input.atlas, "ShadowVisibilityFrame.atlas");
  requireResourceId(input.contactVisibility, "ShadowVisibilityFrame.contactVisibility");
  if (!Number.isInteger(input.cascadeCount) || input.cascadeCount < 0 || input.cascadeCount > 3) {
    throw new RangeError("ShadowVisibilityFrame cascadeCount must be an integer in [0, 3]");
  }
  if (!Number.isInteger(input.pcfTapCount) || input.pcfTapCount <= 0) {
    throw new RangeError("ShadowVisibilityFrame pcfTapCount must be a positive integer");
  }
  for (const [name, value] of [
    ["normalOffsetScale", input.normalOffsetScale],
    ["depthBias", input.depthBias],
    ["slopeScale", input.slopeScale]
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`ShadowVisibilityFrame ${name} must be finite and non-negative`);
    }
  }
  if (!Number.isInteger(input.atlasWidth) || input.atlasWidth <= 0 ||
      !Number.isInteger(input.atlasHeight) || input.atlasHeight <= 0) {
    throw new RangeError("ShadowVisibilityFrame atlas dimensions must be positive integers");
  }
  return Object.freeze({ ...input });
}

/** Freeze the independent GTAO visibility/bent-normal product. */
export function ambientOcclusionFrame(input: AmbientOcclusionFrame): AmbientOcclusionFrame {
  requireResourceId(input.visibility, "AmbientOcclusionFrame.visibility");
  requireResourceId(input.bentNormal, "AmbientOcclusionFrame.bentNormal");
  if (input.domain.domain !== "internal-full") {
    throw new Error("AmbientOcclusionFrame must be resolved at internal-full resolution");
  }
  return Object.freeze({
    ...input,
    domain: textureDomain(
      "internal-full",
      input.domain.width,
      input.domain.height,
      input.domain.scale
    )
  });
}

export function preExposureContract(
  input: PreExposureContract
): PreExposureContract {
  if (!Number.isFinite(input.multiplier) || input.multiplier <= 0) {
    throw new RangeError("PreExposure multiplier must be finite and positive");
  }
  requireNonNegativeInteger(input.generation, "PreExposure generation");
  if (input.colorSpace !== "working-linear") {
    throw new Error("PreExposure color space must be working-linear");
  }
  return Object.freeze({ ...input });
}

export function shadingSurfaceLiteFrame(
  input: ShadingSurfaceLiteFrame
): ShadingSurfaceLiteFrame {
  requireRequiredResourceId(input.normal, "ShadingSurfaceLiteFrame.normal");
  requireRequiredResourceId(
    input.roughnessFlags,
    "ShadingSurfaceLiteFrame.roughnessFlags"
  );
  requireResourceId(
    input.metallicSpecular,
    "ShadingSurfaceLiteFrame.metallicSpecular"
  );
  if (input.normalSpace !== "world") {
    throw new Error("ShadingSurfaceLiteFrame normal space must be world");
  }
  return Object.freeze({
    ...input,
    domain: requireInternalFullDomain(input.domain, "ShadingSurfaceLiteFrame")
  });
}

export function diffuseSurfaceLiteFrame(
  input: DiffuseSurfaceLiteFrame
): DiffuseSurfaceLiteFrame {
  requireRequiredResourceId(
    input.diffuseReflectance,
    "DiffuseSurfaceLiteFrame.diffuseReflectance"
  );
  requireRequiredResourceId(input.materialAo, "DiffuseSurfaceLiteFrame.materialAo");
  requireRequiredResourceId(
    input.receiverFlags,
    "DiffuseSurfaceLiteFrame.receiverFlags"
  );
  if (input.colorSpace !== "working-linear") {
    throw new Error("DiffuseSurfaceLiteFrame color space must be working-linear");
  }
  if (input.receiverModulation !== "unapplied") {
    throw new Error(
      "DiffuseSurfaceLiteFrame must carry un-applied receiver modulation"
    );
  }
  return Object.freeze({
    ...input,
    domain: requireInternalFullDomain(input.domain, "DiffuseSurfaceLiteFrame")
  });
}

export function longRangeDiffuseFrame(
  input: LongRangeDiffuseFrame
): LongRangeDiffuseFrame {
  requireRequiredResourceId(input.radiance, "LongRangeDiffuseFrame.radiance");
  requireResourceId(
    input.providerSelection,
    "LongRangeDiffuseFrame.providerSelection"
  );
  requireResourceId(input.counters, "LongRangeDiffuseFrame.counters");
  if (input.selection !== "receiver-validity") {
    throw new Error("LongRangeDiffuseFrame requires receiver-validity selection");
  }
  if (
    input.precedence.length !== LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE.length ||
    input.precedence.some(
      (provider, index) => provider !== LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE[index]
    )
  ) {
    throw new Error(
      "LongRangeDiffuseFrame provider precedence must be brick4 > probe-volume > ibl > black"
    );
  }
  requirePositiveInteger(input.generation, "LongRangeDiffuseFrame generation");
  return Object.freeze({
    ...input,
    precedence: LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(input.domain, "LongRangeDiffuseFrame")
  });
}

export function screenSpaceDiffuseFrame(
  input: ScreenSpaceDiffuseFrame
): ScreenSpaceDiffuseFrame {
  requireRequiredResourceId(input.bentNormal, "ScreenSpaceDiffuseFrame.bentNormal");
  if (input.normalSpace !== "world") {
    throw new Error("ScreenSpaceDiffuseFrame normal space must be world");
  }
  switch (input.mode) {
    case "off":
      if (
        input.screenAmbientVisibility !== null ||
        input.incidentDiffuseGi !== null ||
        input.confidence !== null ||
        input.historyGeneration !== null
      ) {
        throw new Error(
          "ScreenSpaceDiffuseFrame off mode cannot retain textures or history"
        );
      }
      break;
    case "gtao":
      requireRequiredResourceId(
        input.screenAmbientVisibility,
        "ScreenSpaceDiffuseFrame.screenAmbientVisibility"
      );
      if (input.incidentDiffuseGi !== null) {
        throw new Error("GTAO cannot publish incident diffuse GI");
      }
      requireResourceId(input.confidence, "ScreenSpaceDiffuseFrame.confidence");
      if (input.historyGeneration !== null) {
        requireNonNegativeInteger(
          input.historyGeneration,
          "ScreenSpaceDiffuseFrame historyGeneration"
        );
      }
      break;
    case "ssgi":
      requireRequiredResourceId(
        input.screenAmbientVisibility,
        "ScreenSpaceDiffuseFrame.screenAmbientVisibility"
      );
      requireRequiredResourceId(
        input.incidentDiffuseGi,
        "ScreenSpaceDiffuseFrame.incidentDiffuseGi"
      );
      requireRequiredResourceId(
        input.confidence,
        "ScreenSpaceDiffuseFrame.confidence"
      );
      requireNonNegativeInteger(
        input.historyGeneration,
        "ScreenSpaceDiffuseFrame historyGeneration"
      );
      break;
    default:
      throw new Error(
        `Unknown ScreenSpaceDiffuseFrame mode '${String((input as { mode?: unknown }).mode)}'`
      );
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(input.domain, "ScreenSpaceDiffuseFrame")
  });
}

export function preExposedOpaqueRadianceSourceFrame(
  input: PreExposedOpaqueRadianceSourceFrame
): PreExposedOpaqueRadianceSourceFrame {
  requireRequiredResourceId(
    input.radiance,
    "PreExposedOpaqueRadianceSourceFrame.radiance"
  );
  if (
    input.stage !== "pre-screen-space-diffuse" ||
    input.excludesCurrentFrameSsgi !== true ||
    input.excludesScreenAmbientVisibility !== true ||
    input.excludesSsrCorrection !== true ||
    input.excludesTransparencyAndPost !== true
  ) {
    throw new Error(
      "PreExposedOpaqueRadianceSourceFrame source-stage exclusions are invalid"
    );
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(
      input.domain,
      "PreExposedOpaqueRadianceSourceFrame"
    )
  });
}

export function preExposedOpaqueHdrBaselineFrame(
  input: PreExposedOpaqueHdrBaselineFrame
): PreExposedOpaqueHdrBaselineFrame {
  requireRequiredResourceId(input.hdr, "PreExposedOpaqueHdrBaselineFrame.hdr");
  requireResourceId(
    input.baselineSpecular,
    "PreExposedOpaqueHdrBaselineFrame.baselineSpecular"
  );
  if (input.stage !== "post-screen-space-diffuse-pre-ssr") {
    throw new Error("Opaque HDR baseline has an invalid source stage");
  }
  if (input.reflectionCorrectionExpected !== (input.baselineSpecular !== null)) {
    throw new Error(
      "Opaque HDR baseline must materialize baseline specular iff reflection correction is expected"
    );
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(
      input.domain,
      "PreExposedOpaqueHdrBaselineFrame"
    )
  });
}

export function opaqueColorPyramidFrame(
  input: OpaqueColorPyramidFrame
): OpaqueColorPyramidFrame {
  requireRequiredResourceId(input.texture, "OpaqueColorPyramidFrame.texture");
  requirePositiveInteger(input.mipLevelCount, "OpaqueColorPyramidFrame.mipLevelCount");
  requireNonNegativeInteger(
    input.sourceGeneration,
    "OpaqueColorPyramidFrame.sourceGeneration"
  );
  if (input.stage !== "post-screen-space-diffuse-pre-ssr") {
    throw new Error("OpaqueColorPyramidFrame has an invalid source stage");
  }
  const maxMipLevelCount = Math.floor(
    Math.log2(Math.max(input.domain.width, input.domain.height))
  ) + 1;
  if (input.mipLevelCount > maxMipLevelCount) {
    throw new RangeError(
      "OpaqueColorPyramidFrame mipLevelCount exceeds the declared extent"
    );
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(input.domain, "OpaqueColorPyramidFrame")
  });
}

export function finalColorPyramidFrame(
  input: FinalColorPyramidFrame
): FinalColorPyramidFrame {
  requireRequiredResourceId(input.source, "FinalColorPyramidFrame.source");
  requireRequiredResourceId(input.texture, "FinalColorPyramidFrame.texture");
  requirePositiveInteger(input.mipLevelCount, "FinalColorPyramidFrame.mipLevelCount");
  requireNonNegativeInteger(
    input.sourceGeneration,
    "FinalColorPyramidFrame.sourceGeneration"
  );
  if (input.stage !== "post-transparency-temporal") {
    throw new Error("FinalColorPyramidFrame has an invalid source stage");
  }
  const domain = requireOutputFullDomain(input.domain, "FinalColorPyramidFrame");
  const maxMipLevelCount = Math.floor(Math.log2(Math.max(domain.width, domain.height))) + 1;
  if (input.mipLevelCount > maxMipLevelCount) {
    throw new RangeError("FinalColorPyramidFrame mipLevelCount exceeds the declared extent");
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    domain
  });
}

export function temporalReconstructionFrame(
  input: TemporalReconstructionFrame
): TemporalReconstructionFrame {
  requireRequiredResourceId(input.hdr, "TemporalReconstructionFrame.hdr");
  requireResourceId(input.confidence, "TemporalReconstructionFrame.confidence");
  if (input.historyGenerationSource !== "TemporalHistoryRegistry.color" ||
      input.representationRevisionSource !== "MainHistoryRevision.representation") {
    throw new Error("TemporalReconstructionFrame must use authoritative history revision sources");
  }
  if (input.stage !== "post-transparency-temporal") {
    throw new Error("TemporalReconstructionFrame has an invalid source stage");
  }
  if (input.owner === "taa") {
    if (input.confidence !== input.hdr || input.confidenceEncoding !== "alpha-history-lock") {
      throw new Error("TAA reconstruction confidence must be the HDR alpha history lock");
    }
  } else if (input.owner === "nss") {
    if (input.confidence !== null || input.confidenceEncoding !== "nss-feedback-history") {
      throw new Error("NSS reconstruction confidence must remain in its feedback history");
    }
  } else {
    throw new Error(`Unknown TemporalReconstructionFrame owner '${String(input.owner)}'`);
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    inputDomain: requireInternalFullDomain(
      input.inputDomain,
      "TemporalReconstructionFrame input"
    ),
    domain: requireOutputFullDomain(input.domain, "TemporalReconstructionFrame")
  });
}

export function reflectionCorrectionFrame(
  input: ReflectionCorrectionFrame
): ReflectionCorrectionFrame {
  for (const name of [
    "baselineSpecular",
    "ssrSpecular",
    "resolvedSpecular",
    "confidence",
    "variance"
  ] as const) {
    requireRequiredResourceId(input[name], `ReflectionCorrectionFrame.${name}`);
  }
  if (input.composition !== "confidence-replacement") {
    throw new Error(
      "ReflectionCorrectionFrame must replace baseline specular by confidence"
    );
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(input.domain, "ReflectionCorrectionFrame")
  });
}

function requireRequiredResourceId(value: ResourceId, name: string): void {
  requireResourceId(value, name);
  if (value === null) throw new RangeError(`${name} must not be null`);
}

function requireInternalFullDomain(
  domain: TextureDomain,
  name: string
): TextureDomain<"internal-full"> {
  if (domain.domain !== "internal-full") {
    throw new Error(`${name} must be produced at internal-full resolution`);
  }
  return textureDomain("internal-full", domain.width, domain.height, domain.scale);
}

function requireOutputFullDomain(
  domain: TextureDomain,
  name: string
): TextureDomain<"output-full"> {
  if (domain.domain !== "output-full") {
    throw new Error(`${name} must be produced at output-full resolution`);
  }
  return textureDomain("output-full", domain.width, domain.height, domain.scale);
}

function requirePositiveInteger(value: number, name: string): void {
  requireNonNegativeInteger(value, name);
  if (value === 0) throw new RangeError(`${name} must be positive`);
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
