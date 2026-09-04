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
