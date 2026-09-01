import type { ResourceId } from "../../framegraph/ResourceHandle.js";

export type ResolutionDomain =
  | "internal-full"
  | "internal-half"
  | "output-full"
  | "tile"
  | "fixed"
  | "swapchain";

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
  readonly depth: ResourceId;
  readonly pbr: ResourceId;
  readonly normal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly emissive: ResourceId;
  readonly velocity: ResourceId;
  readonly metadata: ResourceId;
  readonly domain: TextureDomain<"internal-full">;
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
  readonly domain: TextureDomain<"internal-full">;
}

export type OpaqueTemporalSurfaceFrame = TemporalSurfaceFrame;
export type FinalTemporalSurfaceFrame = TemporalSurfaceFrame;
