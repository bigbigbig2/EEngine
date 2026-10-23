import { VSM_FILTER_MODES, type VsmFilterMode } from "../../gpu/GpuVsmFilterAbi.js";
export type { VsmFilterMode } from "../../gpu/GpuVsmFilterAbi.js";

export const VSM_DEBUG_VIEWS = { none: 0, visibility: 1, "clip-level": 2, "page-state": 3 } as const;
export type VsmDebugView = keyof typeof VSM_DEBUG_VIEWS;

/** Device-independent tuning. Bias/radius use actual shadow texels, not world units.
 * Changes apply on the next ordinary frame. Filtering never changes depth content;
 * extent changes use the existing projection epoch transaction and rebuild pages.
 * Device-negotiated capacities, page size and border stay fixed. */
export interface VsmSettings {
  /** Depth comparison offset scaled by 1-NdotL; not a normal-position offset. */
  readonly angularBiasTexels: number;
  readonly depthBiasTexels: number;
  readonly filterMode: VsmFilterMode;
  /** Diagnostic/legacy radius in shadow texels. */
  readonly filterRadiusTexels: number;
  /** Directional light source size for soft-pcss penumbra scaling. */
  readonly lightSize: number;
  readonly clipExtentScale: number;
  /** Donor distance multiplier. >=1 retains the window containment guarantee. */
  readonly clipSelectionBias: number;
  /** Fraction of the distance shell used to blend into the next ready fine clip.
   * Emergency coarse pages never participate in this transition. */
  readonly clipTransitionRatio: number;
  readonly debugView: VsmDebugView;
  /** Maximum geometric LOD error in the finest intersected selected page texels. */
  readonly shadowLodErrorTexels: number;
  /** Bounded complete shadow pages selected for raster work per frame.
   * Prevents unbounded GPU rebuild storms while streaming geometry. */
  readonly dirtyPageBudget: number;
}

export const VSM_DEFAULT_SETTINGS: Readonly<VsmSettings> = Object.freeze({
  angularBiasTexels: 1,
  depthBiasTexels: 1,
  filterMode: "stable-pcf",
  filterRadiusTexels: 1.5,
  lightSize: 1,
  clipExtentScale: 1,
  clipSelectionBias: 1,
  clipTransitionRatio: 0.16,
  debugView: "none",
  shadowLodErrorTexels: 1,
  dirtyPageBudget: 64
});

/** Return the active filter profile. */
export function effectiveVsmFilterMode(settings: VsmSettings): VsmFilterMode {
  return settings.filterMode;
}

export function resolveVsmSettings(current: VsmSettings, patch: Partial<VsmSettings>): Readonly<VsmSettings> {
  for (const key of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(VSM_DEFAULT_SETTINGS, key)) {
      throw new RangeError(`Unknown VSM setting '${key}'`);
    }
  }
  const next = { ...current, ...patch };
  if (
    !Number.isFinite(next.shadowLodErrorTexels) ||
    next.shadowLodErrorTexels <= 0 ||
    next.shadowLodErrorTexels > 8
  ) {
    throw new RangeError("VSM shadow LOD error must be finite in (0, 8] texels");
  }
  if (!Number.isFinite(next.clipSelectionBias) || next.clipSelectionBias < 1 || next.clipSelectionBias > 8) {
    throw new RangeError("VSM clip selection bias must be finite in [1, 8]");
  }
  for (const key of ["angularBiasTexels", "depthBiasTexels"] as const) {
    if (!Number.isFinite(next[key]) || next[key] < 0 || next[key] > 16) {
      throw new RangeError(`VSM ${key} must be finite in [0, 16]`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(VSM_FILTER_MODES, next.filterMode)) {
    throw new RangeError("VSM filter mode must be point, stable-pcf or soft-pcss");
  }
  if (
    !Number.isFinite(next.filterRadiusTexels) ||
    next.filterRadiusTexels < 0 ||
    next.filterRadiusTexels > 3
  ) {
    throw new RangeError("VSM filter radius must be finite in [0, 3] shadow texels");
  }
  if (
    !Number.isFinite(next.lightSize) ||
    next.lightSize < 0 ||
    next.lightSize > 16
  ) {
    throw new RangeError("VSM light size must be finite in [0, 16]");
  }
  if (!Number.isFinite(next.clipExtentScale) || next.clipExtentScale < 0.25 || next.clipExtentScale > 4) {
    throw new RangeError("VSM clip extent scale must be finite in [0.25, 4]");
  }
  if (
    !Number.isFinite(next.clipTransitionRatio) ||
    next.clipTransitionRatio < 0 ||
    next.clipTransitionRatio > 0.35
  ) {
    throw new RangeError("VSM clip transition ratio must be finite in [0, 0.35]");
  }
  if (!Object.prototype.hasOwnProperty.call(VSM_DEBUG_VIEWS, next.debugView)) {
    throw new RangeError("Unknown VSM debug view");
  }
  if (!Number.isInteger(next.dirtyPageBudget) || next.dirtyPageBudget < 1 || next.dirtyPageBudget > 2048) {
    throw new RangeError("VSM dirtyPageBudget must be an integer in [1, 2048]");
  }
  return Object.freeze(next);
}
