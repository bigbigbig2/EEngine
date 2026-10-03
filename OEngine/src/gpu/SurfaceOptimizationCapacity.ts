/** Surface V3 optimization-v1 capacity policy and production allocation contract.
 * Counts are bounded tile/target slots; GPU counters select actual work inside
 * each fixed range and overflow remains visible in the shared diagnostics. */
export const SURFACE_OPTIMIZATION_MIB = 1024 * 1024;
export const SURFACE_OPTIMIZATION_TILE_EDGE = 8;
export const SURFACE_OPTIMIZATION_DEFAULT_BATCH_PIXELS = 262144;
export const SURFACE_OPTIMIZATION_ENVELOPE_BYTES = 512 * SURFACE_OPTIMIZATION_MIB;
export const SURFACE_OPTIMIZATION_BUDGET_MIB = Object.freeze({
  plans: 4, addresses: 32, geometryHot: 16, geometryCold: 32,
  fields: 24, queues: 16, signals: 32, resolveMaps: 8,
  fieldStore: 128, signalStore: 64, variation: 32, outputs: 24
});

/** Combined masks/indices, not one independent full-rate queue per field/lobe.
 * Byte ceilings are a capacity contract, not a final encoded record ABI. */
export interface SurfaceOptimizationProfile {
  readonly addressBytesPerTarget: number;
  readonly geometryHotBytesPerTarget: number;
  readonly geometryColdBytesPerTarget: number;
  readonly fieldBytesPerTarget: number;
  readonly queueBytesPerTarget: number;
  readonly signalBytesPerTarget: number;
  readonly resolveMapBytesPerTarget: number;
}
export const SURFACE_OPTIMIZATION_DEFAULT_PROFILE: SurfaceOptimizationProfile = Object.freeze({
  addressBytesPerTarget: 128, geometryHotBytesPerTarget: 64,
  geometryColdBytesPerTarget: 128, fieldBytesPerTarget: 96,
  queueBytesPerTarget: 64, signalBytesPerTarget: 676, resolveMapBytesPerTarget: 32
});
export interface SurfaceOptimizationLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxTextureDimension2D: number;
}
export interface SurfaceOptimizationCapacity {
  readonly width: number;
  readonly height: number;
  readonly pixelCount: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly tileCount: number;
  readonly batchTileCapacity: number;
  readonly batchTargetCapacity: number;
  readonly batchCount: number;
  readonly scratchBytes: Readonly<Record<
    "plans" | "addresses" | "geometryHot" | "geometryCold" | "fields" | "queues" | "signals" | "resolveMaps", number>>;
  readonly persistentSegments: Readonly<Record<"fieldStore" | "signalStore" | "variation", readonly number[]>>;
  readonly reservedBytes: number;
  readonly envelopeHeadroomBytes: number;
  readonly queueLimits: Readonly<SurfaceOptimizationQueueLimits>;
  readonly ledger: Readonly<SurfaceOptimizationBudgetLedger>;
}
export interface SurfaceOptimizationQueueLimits {
  readonly targetPixels: number;
  readonly uniqueAddresses: number;
  readonly fieldCount: number;
  readonly signalCount: number;
  readonly programPartitions: number;
  readonly precisionSpill: number;
}
/** Explicit accounting for the optimization-v1 envelope. Shared renderer
 * products are intentionally outside this ledger and are reported by the
 * engine-wide memory evidence owner. */
export interface SurfaceOptimizationBudgetLedger {
  readonly payloadBytes: number;
  readonly metadataBytes: number;
  readonly queueBytes: number;
  readonly alignmentBytes: number;
  readonly outputBytes: number;
  readonly scratchBytes: number;
  readonly persistentBytes: number;
  readonly historyBytes: number;
  readonly retiredOverlapBytes: number;
  readonly sharedBytes: number;
  readonly surfaceEnvelopeBytes: number;
}
const integer = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};
const align = (bytes: number): number => Math.ceil(bytes / 256) * 256;
const scratchProfile = [
  ["addresses", "addressBytesPerTarget"], ["geometryHot", "geometryHotBytesPerTarget"],
  ["geometryCold", "geometryColdBytesPerTarget"], ["fields", "fieldBytesPerTarget"],
  ["queues", "queueBytesPerTarget"], ["signals", "signalBytesPerTarget"],
  ["resolveMaps", "resolveMapBytesPerTarget"]
] as const;

export function planSurfaceOptimizationCapacity(width: number, height: number,
  limits: SurfaceOptimizationLimits,
  profile: SurfaceOptimizationProfile = SURFACE_OPTIMIZATION_DEFAULT_PROFILE): SurfaceOptimizationCapacity {
  integer(width, "width"); integer(height, "height");
  const maxTexture = integer(limits.maxTextureDimension2D, "maxTextureDimension2D");
  const bindingLimit = Math.floor(Math.min(integer(limits.maxBufferSize, "maxBufferSize"),
    integer(limits.maxStorageBufferBindingSize, "maxStorageBufferBindingSize")) / 256) * 256;
  if (width > maxTexture || height > maxTexture) throw new RangeError("Surface extent exceeds device texture limit");
  const pixelCount = width * height;
  const tilesX = Math.ceil(width / 8), tilesY = Math.ceil(height / 8), tileCount = tilesX * tilesY;
  if (!Number.isSafeInteger(pixelCount) || tileCount * 64 > 0xffffffff) {
    throw new RangeError("Surface target addresses exceed u32 capacity");
  }
  // Plans include a 64 KiB control/indirect envelope and <=1008 bytes/tile.
  const controlBytes = 64 * 1024, bytesPerTile = 1008;
  const planLimit = Math.min(bindingLimit, SURFACE_OPTIMIZATION_BUDGET_MIB.plans * SURFACE_OPTIMIZATION_MIB);
  let batchTiles = Math.min(SURFACE_OPTIMIZATION_DEFAULT_BATCH_PIXELS / 64,
    Math.floor((planLimit - controlBytes) / bytesPerTile));
  for (const [pool, field] of scratchProfile) {
    const stride = integer(profile[field], field);
    if (stride % 4 !== 0) throw new RangeError(`${field} must be word aligned`);
    const poolLimit = Math.min(bindingLimit, SURFACE_OPTIMIZATION_BUDGET_MIB[pool] * SURFACE_OPTIMIZATION_MIB);
    batchTiles = Math.min(batchTiles, Math.floor(poolLimit / (stride * 64)));
  }
  if (batchTiles < 1) throw new RangeError("Surface profile cannot fit one complete tile in negotiated limits");
  const batchTargetCapacity = batchTiles * 64;
  const scratchBytes = { plans: align(controlBytes + batchTiles * bytesPerTile), addresses: 0,
    geometryHot: 0, geometryCold: 0, fields: 0, queues: 0, signals: 0, resolveMaps: 0 };
  for (const [pool, field] of scratchProfile) scratchBytes[pool] = align(batchTargetCapacity * profile[field]);
  // Pools may be physically segmented. Every segment fits a legal storage binding;
  // a future consumer must select segments without unnegotiated binding arrays.
  const segment = (pool: "fieldStore" | "signalStore" | "variation"): readonly number[] => {
    let remaining = SURFACE_OPTIMIZATION_BUDGET_MIB[pool] * SURFACE_OPTIMIZATION_MIB;
    const result: number[] = [];
    while (remaining > 0) { const bytes = Math.min(remaining, bindingLimit); result.push(bytes); remaining -= bytes; }
    return Object.freeze(result);
  };
  const persistentSegments = Object.freeze({ fieldStore: segment("fieldStore"),
    signalStore: segment("signalStore"), variation: segment("variation") });
  const requiredOutputBytes = pixelCount * 12; // HDR rgba16float + reactive r32float.
  const reservedOutputBytes = SURFACE_OPTIMIZATION_BUDGET_MIB.outputs * SURFACE_OPTIMIZATION_MIB;
  if (requiredOutputBytes > reservedOutputBytes) {
    throw new RangeError("Surface output extent exceeds configured output budget");
  }
  const rawScratchBytes = batchTargetCapacity * scratchProfile.reduce((sum, [, field]) => sum + profile[field], 0)
    + controlBytes;
  const scratchTotalBytes = Object.values(scratchBytes).reduce((sum, bytes) => sum + bytes, 0);
  const persistentBytes = [...persistentSegments.fieldStore, ...persistentSegments.signalStore,
    ...persistentSegments.variation].reduce((sum, bytes) => sum + bytes, 0);
  const alignmentBytes = Math.max(0, scratchTotalBytes - rawScratchBytes);
  const payloadBytes = scratchBytes.addresses + scratchBytes.geometryCold + scratchBytes.fields +
    scratchBytes.signals + scratchBytes.resolveMaps;
  const metadataBytes = scratchBytes.plans + scratchBytes.geometryHot;
  const queueBytes = scratchBytes.queues;
  const historyBytes = 0;
  const retiredOverlapBytes = scratchTotalBytes;
  const outputBytes = SURFACE_OPTIMIZATION_BUDGET_MIB.outputs * SURFACE_OPTIMIZATION_MIB;
  const reservedBytes = scratchTotalBytes + persistentBytes + outputBytes;
  if (reservedBytes > SURFACE_OPTIMIZATION_ENVELOPE_BYTES) throw new RangeError("Surface envelope exceeded");
  const ledger = Object.freeze({ payloadBytes, metadataBytes, queueBytes, alignmentBytes, outputBytes,
    scratchBytes: scratchTotalBytes, persistentBytes, historyBytes, retiredOverlapBytes,
    sharedBytes: 0, surfaceEnvelopeBytes: SURFACE_OPTIMIZATION_ENVELOPE_BYTES });
  const queueLimits = Object.freeze({ targetPixels: batchTargetCapacity,
    uniqueAddresses: Math.floor(scratchBytes.addresses / profile.addressBytesPerTarget),
    fieldCount: Math.floor(scratchBytes.fields / profile.fieldBytesPerTarget),
    signalCount: Math.floor(scratchBytes.signals / profile.signalBytesPerTarget),
    programPartitions: Math.floor(scratchBytes.plans / 256),
    precisionSpill: Math.floor(scratchBytes.signals / 16) });
  return Object.freeze({ width, height, pixelCount, tilesX, tilesY, tileCount,
    batchTileCapacity: batchTiles, batchTargetCapacity, batchCount: Math.ceil(tileCount / batchTiles),
    scratchBytes: Object.freeze(scratchBytes), persistentSegments, reservedBytes,
    envelopeHeadroomBytes: SURFACE_OPTIMIZATION_ENVELOPE_BYTES - reservedBytes, queueLimits, ledger });
}

/** CPU encodes all fixed ranges; GPU coverage/counts select work inside each range. */
export function surfaceOptimizationBatchRange(plan: SurfaceOptimizationCapacity, batch: number): Readonly<{
  firstTile: number; tileCount: number; paddedTargetCapacity: number;
}> {
  if (!Number.isSafeInteger(batch) || batch < 0 || batch >= plan.batchCount) throw new RangeError("Invalid Surface batch");
  const firstTile = batch * plan.batchTileCapacity;
  const tileCount = Math.min(plan.batchTileCapacity, plan.tileCount - firstTile);
  return Object.freeze({ firstTile, tileCount, paddedTargetCapacity: tileCount * 64 });
}
