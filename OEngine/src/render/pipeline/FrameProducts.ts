import type {
  FrameGraphResourceDomain,
  ResourceId
} from "../../framegraph/ResourceHandle.js";

export type ResolutionDomain = FrameGraphResourceDomain;

export interface TextureDomain<D extends ResolutionDomain = ResolutionDomain> {
  readonly domain: D;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
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

export interface SurfaceFrame {
  /** 深度由 Visibility producer 提供；Material Resolve 单独不能拥有它。 */
  readonly depth: ResourceId | null;
  readonly pbr: ResourceId;
  readonly normal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly emissive: ResourceId;
  /** 未启用时域功能时可以没有 velocity；消费者必须显式声明需要它。 */
  readonly velocity: ResourceId | null;
  /** 普通 Scene legacy 路径可能没有 Surface metadata。 */
  readonly metadata: ResourceId | null;
  readonly domain: TextureDomain<"internal-full">;
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

/** 从 producer 输出创建不可变 Surface 产品，禁止 Renderer 重新解释 attachment 顺序。 */
export function surfaceFrame(input: SurfaceFrame): SurfaceFrame {
  for (const [name, value] of Object.entries(input)) {
    if (name === "domain") continue;
    requireResourceId(value as ResourceId | null, `SurfaceFrame.${name}`);
  }
  return Object.freeze({
    ...input,
    domain: textureDomain(
      input.domain.domain,
      input.domain.width,
      input.domain.height,
      input.domain.scale
    )
  });
}

/** 为迁移中的 Surface producer 补入 velocity，返回新的 immutable product。 */
export function surfaceFrameWithVelocity(
  frame: SurfaceFrame,
  velocity: ResourceId | null
): SurfaceFrame {
  return surfaceFrame({ ...frame, velocity });
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
