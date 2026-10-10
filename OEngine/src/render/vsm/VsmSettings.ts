import {
  SHADOW_NORMAL_OFFSET_SCALE,
  SHADOW_DEPTH_BIAS,
  SHADOW_DEPTH_SLOPE_SCALE
} from "../../gpu/ShadowContract.js";

export const VSM_DEBUG_VIEWS = { none: 0, visibility: 1, "clip-level": 2, "page-state": 3 } as const;
export type VsmDebugView = keyof typeof VSM_DEBUG_VIEWS;

/** Device-independent tuning. Bias/radius use actual shadow texels, not world units.
 * Changes apply on the next ordinary frame. Filtering never changes depth content;
 * extent changes use the existing projection epoch transaction and rebuild pages.
 * Device-negotiated capacities, page size, border and maximum tap count stay fixed. */
export interface VsmSettings {
  readonly normalBiasTexels: number;
  readonly depthBiasTexels: number;
  readonly slopeBiasTexels: number;
  readonly pcfTapsPerAxis: number;
  readonly filterRadiusTexels: number;
  readonly clipExtentScale: number;
  readonly debugView: VsmDebugView;
}

export const VSM_DEFAULT_SETTINGS: Readonly<VsmSettings> = Object.freeze({
  normalBiasTexels: SHADOW_NORMAL_OFFSET_SCALE,
  depthBiasTexels: SHADOW_DEPTH_BIAS,
  slopeBiasTexels: SHADOW_DEPTH_SLOPE_SCALE,
  pcfTapsPerAxis: 4,
  filterRadiusTexels: 0.75,
  clipExtentScale: 1,
  debugView: "none"
});

export function resolveVsmSettings(current: VsmSettings, patch: Partial<VsmSettings>): Readonly<VsmSettings> {
  const next = { ...current, ...patch };
  for (const key of ["normalBiasTexels", "depthBiasTexels", "slopeBiasTexels"] as const) {
    if (!Number.isFinite(next[key]) || next[key] < 0 || next[key] > 16) {
      throw new RangeError(`VSM ${key} must be finite in [0, 16]`);
    }
  }
  if (!Number.isInteger(next.pcfTapsPerAxis) || next.pcfTapsPerAxis < 1 || next.pcfTapsPerAxis > 4) {
    throw new RangeError("VSM PCF taps per axis must be an integer in [1, 4]");
  }
  // Radius 3 keeps every rounded tap inside the existing four-texel gutter.
  if (
    !Number.isFinite(next.filterRadiusTexels) ||
    next.filterRadiusTexels < 0 ||
    next.filterRadiusTexels > 3
  ) {
    throw new RangeError("VSM filter radius must be finite in [0, 3] shadow texels");
  }
  if (!Number.isFinite(next.clipExtentScale) || next.clipExtentScale < 0.25 || next.clipExtentScale > 4) {
    throw new RangeError("VSM clip extent scale must be finite in [0.25, 4]");
  }
  if (!Object.prototype.hasOwnProperty.call(VSM_DEBUG_VIEWS, next.debugView)) {
    throw new RangeError("Unknown VSM debug view");
  }
  return Object.freeze(next);
}
