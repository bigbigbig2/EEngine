import type { FrameGraphResourceDomain, ResourceId } from "../../framegraph/ResourceHandle.js";
import type { VsmProfile } from "../vsm/VsmCapabilities.js";

export type ResolutionDomain = FrameGraphResourceDomain;

export interface TextureDomain<D extends ResolutionDomain = ResolutionDomain> {
  readonly domain: D;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
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
  /** Same depth winner as VisibilityKey; background is the 0xff sentinel. */
  readonly depth: ResourceId;
  readonly meshletWork: MeshletWorkFrame;
  /** GPU-selected current clip/normal transforms; Scene remains authoritative. */
  readonly frameInstances: ResourceId;
  /** Shared clip vertices and source/final directory namespaces. */
  readonly frameGeometry: ResourceId;
  readonly frameAttributes: ResourceId;
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

export function textureDomain<D extends ResolutionDomain>(
  domain: D,
  width: number,
  height: number,
  scale: number,
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
  conversionOwner?: string,
): void {
  if (producer.domain === expected) return;
  if (conversionOwner !== undefined && conversionOwner.length > 0) return;
  throw new Error(
    `Resolution domain mismatch: received ${producer.domain}, expected ${expected}; declare a conversion owner`,
  );
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

export type LongRangeDiffuseProvider = "brick4" | "probe-volume" | "ibl" | "black";

export const LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE = Object.freeze([
  "brick4",
  "probe-volume",
  "ibl",
  "black",
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

/** Historical receiver data for inactive GI planning; not a Next production product. */
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
  /** Receiver-resolved diffuse radiance after the shared BRDF/AO composition. */
  readonly radiometry: "receiver-resolved-diffuse-radiance";
  readonly receiverModulation: "applied-once";
  /** Optional materialized provider id; null means selection was fused into the producer. */
  readonly providerSelection: ResourceId | null;
  readonly counters: ResourceId | null;
  readonly selection: "receiver-validity";
  readonly precedence: typeof LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE;
  readonly generation: number;
  readonly preExposure: PreExposureContract;
  readonly domain: TextureDomain<"internal-full">;
}

/** Offline baseline for the retired color-pyramid owner; no runtime producer. */
export interface PreExposedOpaqueHdrBaselineFrame {
  readonly hdr: ResourceId;
  readonly baselineSpecular: ResourceId | null;
  readonly stage: "post-screen-space-diffuse-pre-ssr";
  readonly reflectionCorrectionExpected: boolean;
  readonly preExposure: PreExposureContract;
  readonly domain: TextureDomain<"internal-full">;
}

/** Offline color-pyramid contract; the Next SSSR owner will define its own demand. */
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

/** VSM producer output consumed by the single opaque direct-light consumer. */
export interface ShadowVisibilityFrame {
  readonly profile: VsmProfile;
  readonly virtualPageTable: ResourceId | null;
  readonly physicalAtlasDepth: ResourceId | null;
  readonly pageMeta: ResourceId | null;
  readonly lightProjection: ResourceId | null;
  readonly overflowMask: ResourceId | null;
  readonly generation: number;
  readonly fallbackPolicy: "coarse-resident" | "neutral-visibility" | "shadow-disabled";
  readonly enabled: boolean;
  readonly clipLevels: number;
  readonly pageSize: number;
  readonly border: number;
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

export function visibilityFrame(input: VisibilityFrame): VisibilityFrame {
  requireResourceId(input.visibilityKey, "VisibilityFrame.visibilityKey");
  requireResourceId(input.depth, "VisibilityFrame.depth");
  requireResourceId(input.frameInstances, "VisibilityFrame.frameInstances");
  requireResourceId(input.frameGeometry, "VisibilityFrame.frameGeometry");
  requireResourceId(input.frameAttributes, "VisibilityFrame.frameAttributes");
  if (input.domain.domain !== "internal-full") {
    throw new Error("VisibilityFrame must be produced at internal-full resolution");
  }
  return Object.freeze({
    ...input,
    meshletWork: meshletWorkFrame(input.meshletWork),
    domain: textureDomain("internal-full", input.domain.width, input.domain.height, input.domain.scale),
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
    domain: textureDomain("internal-full", input.domain.width, input.domain.height, input.domain.scale),
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
    domain: textureDomain("internal-full", input.domain.width, input.domain.height, input.domain.scale),
  });
}

/** Freeze the producer/consumer ABI for one clustered-light frame. */
export function lightClusterFrame(input: LightClusterFrame): LightClusterFrame {
  for (const name of ["parameters", "lookup", "data", "candidateLightList", "activeLightList"] as const) {
    requireResourceId(input[name], `LightClusterFrame.${name}`);
  }
  requireResourceId(input.counters, "LightClusterFrame.counters");
  if (
    !Number.isInteger(input.width) ||
    input.width <= 0 ||
    !Number.isInteger(input.height) ||
    input.height <= 0
  ) {
    throw new RangeError("LightClusterFrame dimensions must be positive integers");
  }
  if (
    !Number.isInteger(input.tileSize) ||
    input.tileSize <= 0 ||
    !Number.isInteger(input.depthSlices) ||
    input.depthSlices <= 0
  ) {
    throw new RangeError("LightClusterFrame layout must be positive integers");
  }
  return Object.freeze({ ...input });
}

/** Freeze and validate the Stage 2B shadow producer/consumer ABI. */
export function shadowVisibilityFrame(input: ShadowVisibilityFrame): ShadowVisibilityFrame {
  for (const [name, value] of [
    ["virtualPageTable", input.virtualPageTable],
    ["physicalAtlasDepth", input.physicalAtlasDepth],
    ["pageMeta", input.pageMeta],
    ["lightProjection", input.lightProjection],
    ["overflowMask", input.overflowMask],
  ] as const)
    requireResourceId(value, `ShadowVisibilityFrame.${name}`);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new RangeError("ShadowVisibilityFrame generation must be a non-negative integer");
  }
  if (
    !Number.isInteger(input.clipLevels) ||
    input.clipLevels < 0 ||
    input.clipLevels > 16 ||
    !Number.isInteger(input.pageSize) ||
    input.pageSize < 0 ||
    !Number.isInteger(input.border) ||
    input.border < 0
  ) {
    throw new RangeError("ShadowVisibilityFrame page layout is invalid");
  }
  if (
    input.enabled !== (input.profile !== "shadow-disabled") ||
    (!input.enabled &&
      (input.virtualPageTable !== null ||
        input.physicalAtlasDepth !== null ||
        input.pageMeta !== null ||
        input.lightProjection !== null))
  ) {
    throw new Error("ShadowVisibilityFrame disabled profile must expose neutral resources");
  }
  if (
    input.enabled &&
    (input.virtualPageTable === null ||
      input.physicalAtlasDepth === null ||
      input.pageMeta === null ||
      input.lightProjection === null)
  ) {
    throw new Error("ShadowVisibilityFrame enabled profile is missing a VSM resource");
  }
  if (!input.enabled && input.fallbackPolicy !== "shadow-disabled") {
    throw new Error("ShadowVisibilityFrame disabled profile requires shadow-disabled fallback");
  }
  if (!Number.isInteger(input.pcfTapCount) || input.pcfTapCount <= 0) {
    throw new RangeError("ShadowVisibilityFrame pcfTapCount must be a positive integer");
  }
  for (const [name, value] of [
    ["normalOffsetScale", input.normalOffsetScale],
    ["depthBias", input.depthBias],
    ["slopeScale", input.slopeScale],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`ShadowVisibilityFrame ${name} must be finite and non-negative`);
    }
  }
  if (
    !Number.isInteger(input.atlasWidth) ||
    input.atlasWidth <= 0 ||
    !Number.isInteger(input.atlasHeight) ||
    input.atlasHeight <= 0
  ) {
    throw new RangeError("ShadowVisibilityFrame atlas dimensions must be positive integers");
  }
  return Object.freeze({ ...input });
}

export function preExposureContract(input: PreExposureContract): PreExposureContract {
  if (!Number.isFinite(input.multiplier) || input.multiplier <= 0) {
    throw new RangeError("PreExposure multiplier must be finite and positive");
  }
  requireNonNegativeInteger(input.generation, "PreExposure generation");
  if (input.colorSpace !== "working-linear") {
    throw new Error("PreExposure color space must be working-linear");
  }
  return Object.freeze({ ...input });
}

export function shadingSurfaceLiteFrame(input: ShadingSurfaceLiteFrame): ShadingSurfaceLiteFrame {
  requireRequiredResourceId(input.normal, "ShadingSurfaceLiteFrame.normal");
  requireRequiredResourceId(input.roughnessFlags, "ShadingSurfaceLiteFrame.roughnessFlags");
  requireResourceId(input.metallicSpecular, "ShadingSurfaceLiteFrame.metallicSpecular");
  if (input.normalSpace !== "world") {
    throw new Error("ShadingSurfaceLiteFrame normal space must be world");
  }
  return Object.freeze({
    ...input,
    domain: requireInternalFullDomain(input.domain, "ShadingSurfaceLiteFrame"),
  });
}

export function diffuseSurfaceLiteFrame(input: DiffuseSurfaceLiteFrame): DiffuseSurfaceLiteFrame {
  requireRequiredResourceId(input.diffuseReflectance, "DiffuseSurfaceLiteFrame.diffuseReflectance");
  requireRequiredResourceId(input.materialAo, "DiffuseSurfaceLiteFrame.materialAo");
  requireRequiredResourceId(input.receiverFlags, "DiffuseSurfaceLiteFrame.receiverFlags");
  if (input.colorSpace !== "working-linear") {
    throw new Error("DiffuseSurfaceLiteFrame color space must be working-linear");
  }
  if (input.receiverModulation !== "unapplied") {
    throw new Error("DiffuseSurfaceLiteFrame must carry un-applied receiver modulation");
  }
  return Object.freeze({
    ...input,
    domain: requireInternalFullDomain(input.domain, "DiffuseSurfaceLiteFrame"),
  });
}

export function longRangeDiffuseFrame(input: LongRangeDiffuseFrame): LongRangeDiffuseFrame {
  requireRequiredResourceId(input.radiance, "LongRangeDiffuseFrame.radiance");
  requireResourceId(input.providerSelection, "LongRangeDiffuseFrame.providerSelection");
  requireResourceId(input.counters, "LongRangeDiffuseFrame.counters");
  if (input.selection !== "receiver-validity") {
    throw new Error("LongRangeDiffuseFrame requires receiver-validity selection");
  }
  if (input.radiometry !== "receiver-resolved-diffuse-radiance") {
    throw new Error("LongRangeDiffuseFrame requires receiver-resolved diffuse radiance");
  }
  if (input.receiverModulation !== "applied-once") {
    throw new Error("LongRangeDiffuseFrame requires receiver modulation exactly once");
  }
  if (
    input.precedence.length !== LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE.length ||
    input.precedence.some((provider, index) => provider !== LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE[index])
  ) {
    throw new Error("LongRangeDiffuseFrame provider precedence must be brick4 > probe-volume > ibl > black");
  }
  requirePositiveInteger(input.generation, "LongRangeDiffuseFrame generation");
  return Object.freeze({
    ...input,
    precedence: LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(input.domain, "LongRangeDiffuseFrame"),
  });
}

export function preExposedOpaqueHdrBaselineFrame(
  input: PreExposedOpaqueHdrBaselineFrame,
): PreExposedOpaqueHdrBaselineFrame {
  requireRequiredResourceId(input.hdr, "PreExposedOpaqueHdrBaselineFrame.hdr");
  requireResourceId(input.baselineSpecular, "PreExposedOpaqueHdrBaselineFrame.baselineSpecular");
  if (input.stage !== "post-screen-space-diffuse-pre-ssr") {
    throw new Error("Opaque HDR baseline has an invalid source stage");
  }
  if (input.reflectionCorrectionExpected !== (input.baselineSpecular !== null)) {
    throw new Error(
      "Opaque HDR baseline must materialize baseline specular iff reflection correction is expected",
    );
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(input.domain, "PreExposedOpaqueHdrBaselineFrame"),
  });
}

export function opaqueColorPyramidFrame(input: OpaqueColorPyramidFrame): OpaqueColorPyramidFrame {
  requireRequiredResourceId(input.texture, "OpaqueColorPyramidFrame.texture");
  requirePositiveInteger(input.mipLevelCount, "OpaqueColorPyramidFrame.mipLevelCount");
  requireNonNegativeInteger(input.sourceGeneration, "OpaqueColorPyramidFrame.sourceGeneration");
  if (input.stage !== "post-screen-space-diffuse-pre-ssr") {
    throw new Error("OpaqueColorPyramidFrame has an invalid source stage");
  }
  const maxMipLevelCount = Math.floor(Math.log2(Math.max(input.domain.width, input.domain.height))) + 1;
  if (input.mipLevelCount > maxMipLevelCount) {
    throw new RangeError("OpaqueColorPyramidFrame mipLevelCount exceeds the declared extent");
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(input.domain, "OpaqueColorPyramidFrame"),
  });
}

export function finalColorPyramidFrame(input: FinalColorPyramidFrame): FinalColorPyramidFrame {
  requireRequiredResourceId(input.source, "FinalColorPyramidFrame.source");
  requireRequiredResourceId(input.texture, "FinalColorPyramidFrame.texture");
  if (input.source === input.texture) {
    throw new Error(
      "FinalColorPyramidFrame must preserve a source resource distinct from its mipmapped texture",
    );
  }
  requirePositiveInteger(input.mipLevelCount, "FinalColorPyramidFrame.mipLevelCount");
  requireNonNegativeInteger(input.sourceGeneration, "FinalColorPyramidFrame.sourceGeneration");
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
    domain,
  });
}

export function temporalReconstructionFrame(input: TemporalReconstructionFrame): TemporalReconstructionFrame {
  requireRequiredResourceId(input.hdr, "TemporalReconstructionFrame.hdr");
  requireResourceId(input.confidence, "TemporalReconstructionFrame.confidence");
  if (
    input.historyGenerationSource !== "TemporalHistoryRegistry.color" ||
    input.representationRevisionSource !== "MainHistoryRevision.representation"
  ) {
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
    inputDomain: requireInternalFullDomain(input.inputDomain, "TemporalReconstructionFrame input"),
    domain: requireOutputFullDomain(input.domain, "TemporalReconstructionFrame"),
  });
}

export function reflectionCorrectionFrame(input: ReflectionCorrectionFrame): ReflectionCorrectionFrame {
  for (const name of [
    "baselineSpecular",
    "ssrSpecular",
    "resolvedSpecular",
    "confidence",
    "variance",
  ] as const) {
    requireRequiredResourceId(input[name], `ReflectionCorrectionFrame.${name}`);
  }
  if (input.composition !== "confidence-replacement") {
    throw new Error("ReflectionCorrectionFrame must replace baseline specular by confidence");
  }
  return Object.freeze({
    ...input,
    preExposure: preExposureContract(input.preExposure),
    domain: requireInternalFullDomain(input.domain, "ReflectionCorrectionFrame"),
  });
}

function requireRequiredResourceId(value: ResourceId, name: string): void {
  requireResourceId(value, name);
  if (value === null) throw new RangeError(`${name} must not be null`);
}

function requireInternalFullDomain(domain: TextureDomain, name: string): TextureDomain<"internal-full"> {
  if (domain.domain !== "internal-full") {
    throw new Error(`${name} must be produced at internal-full resolution`);
  }
  return textureDomain("internal-full", domain.width, domain.height, domain.scale);
}

function requireOutputFullDomain(domain: TextureDomain, name: string): TextureDomain<"output-full"> {
  if (domain.domain !== "output-full") {
    throw new Error(`${name} must be produced at output-full resolution`);
  }
  return textureDomain("output-full", domain.width, domain.height, domain.scale);
}

function requireMatchingDomain(producer: TextureDomain, expected: TextureDomain, name: string): void {
  if (
    producer.domain !== expected.domain ||
    producer.width !== expected.width ||
    producer.height !== expected.height ||
    producer.scale !== expected.scale
  ) {
    throw new Error(`${name} does not match the SpecializedShadingFrame domain`);
  }
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

function requireU32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a u32`);
  }
}
