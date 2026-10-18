import type { ScgiFilterSettings } from "./ScgiFilter.js";

/** Runtime quality controls. Capacities select a complete working set; no
 * device-memory-size guess silently changes geometry or material coverage. */
export interface SurfaceCacheGiSettings {
  readonly enabled: boolean;
  readonly resolution: number;
  readonly cascades: number;
  readonly patches: number;
  readonly updates: number;
  readonly requests: number;
  readonly bounceRequests: number;
  readonly voxelSize: number;
  readonly hemisphereSamples: number;
  readonly connectionSamples: number;
  readonly lightSamples: number;
  readonly batchRays: number;
  readonly maximumLights: number;
  readonly primitiveCapacity: number;
  readonly queryMaximumBytes: number;
  readonly multiBounce: boolean;
  readonly spatial: boolean;
  readonly post: boolean;
  readonly spatialTaps: number;
  readonly lookupTaps: number;
  readonly gather: boolean;
  readonly gatherTile: number;
  readonly gatherDirections: number;
  readonly gatherBatchRays: number;
  readonly gatherDistance: number;
  /** Number of submitted frames between expensive Gather transport updates. */
  readonly gatherUpdatePeriod: number;
  readonly gatherFreeze: boolean;
  readonly debug: "off" | "irradiance" | "confidence" | "world-only" | "residual" | "gather-confidence" | "gather-source" | "appearance-world-only";
}

export const SURFACE_CACHE_GI_DEFAULTS: SurfaceCacheGiSettings = Object.freeze({
  enabled: false,
  resolution: 16,
  cascades: 3,
  patches: 16384,
  updates: 64,
  requests: 4096,
  bounceRequests: 512,
  voxelSize: 0.5,
  hemisphereSamples: 8,
  connectionSamples: 2,
  lightSamples: 64,
  batchRays: 1024,
  maximumLights: 4096,
  primitiveCapacity: 16384,
  queryMaximumBytes: 512 * 1024 * 1024,
  multiBounce: true,
  spatial: true,
  post: true,
  spatialTaps: 8,
  lookupTaps: 8,
  gather: false,
  gatherTile: 8,
  gatherDirections: 64,
  gatherBatchRays: 4096,
  gatherDistance: 3,
  gatherUpdatePeriod: 1,
  gatherFreeze: false,
  debug: "off",
});

/** Explicit quality choices, independent of advertised VRAM. Admission still
 * checks every negotiated buffer/binding/work capacity before allocation. */
export const SURFACE_CACHE_GI_PRESETS = Object.freeze({
  balanced: Object.freeze({ ...SURFACE_CACHE_GI_DEFAULTS, enabled: true }),
  quality: Object.freeze({
    ...SURFACE_CACHE_GI_DEFAULTS,
    enabled: true,
    patches: 32768,
    updates: 128,
    hemisphereSamples: 16,
    lightSamples: 128,
    batchRays: 2048,
  }),
});

export function surfaceCacheGiSettings(
  input: Partial<SurfaceCacheGiSettings>,
  base = SURFACE_CACHE_GI_DEFAULTS,
): SurfaceCacheGiSettings {
  const value = { ...base, ...input };
  for (const key of ["enabled", "multiBounce", "spatial", "post", "gather", "gatherFreeze"] as const) {
    if (typeof value[key] !== "boolean") {
      throw new TypeError(`SCGI ${key} must be boolean`);
    }
  }
  for (const key of [
    "resolution",
    "cascades",
    "patches",
    "updates",
    "requests",
    "bounceRequests",
    "hemisphereSamples",
    "connectionSamples",
    "lightSamples",
    "batchRays",
    "maximumLights",
    "primitiveCapacity",
    "queryMaximumBytes",
    "spatialTaps",
    "lookupTaps",
    "gatherTile",
    "gatherDirections",
    "gatherBatchRays",
    "gatherUpdatePeriod",
  ] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 0xfffffffd) {
      throw new RangeError(`SCGI ${key} must be a positive bounded integer`);
    }
  }
  if (
    value.cascades > 4 ||
    value.updates > value.patches ||
    value.spatialTaps > 4096 ||
    value.lookupTaps > 4096 ||
    !Number.isFinite(Math.fround(value.voxelSize)) ||
    value.voxelSize <= 0 ||
    value.gatherTile < 4 || value.gatherTile % 2 !== 0 || value.gatherDirections > 256 ||
    value.gatherBatchRays < value.gatherDirections ||
    value.gatherUpdatePeriod > 16 ||
    !Number.isFinite(Math.fround(value.gatherDistance)) || value.gatherDistance <= 0 ||
    !["off", "irradiance", "confidence", "world-only", "residual", "gather-confidence", "gather-source", "appearance-world-only"].includes(value.debug)
  ) {
    throw new RangeError("Invalid SCGI quality/representation settings");
  }
  return Object.freeze(value);
}

export function surfaceCacheGiFilter(
  settings: SurfaceCacheGiSettings,
  frame: number,
  geometryEpoch: number,
): ScgiFilterSettings {
  return {
    frame,
    geometryEpoch,
    filterEpoch: 1,
    spatial: settings.spatial,
    post: settings.post,
    spatialTaps: settings.spatialTaps,
    lookupTaps: settings.lookupTaps,
    spatialRadius: 1.5,
    lookupRadius: 1,
    normalCosine: 0.9,
    planeDistanceScale: 0.02,
    shortHysteresis: 0.5,
    longHysteresis: 0.98,
    postHysteresis: 0.9,
    driftScale: 0.25,
    maximumCount: 4096,
    maximumAge: 120,
    invalidDecay: 0.8,
    revisionDecay: 0.5,
  };
}
