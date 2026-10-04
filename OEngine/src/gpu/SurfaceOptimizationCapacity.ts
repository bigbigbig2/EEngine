import { surfaceCoverageLayout } from "./GpuSurfaceCoverageAbi.js";
import { surfaceCellWorkspaceLayout } from "./GpuSurfaceCellPlanAbi.js";
import { surfaceDemandLayout } from "./GpuSurfaceDemandAbi.js";
import { SURFACE_GEOMETRY_RECORD_BYTES } from "./GpuSurfaceGeometryRecordAbi.js";
import { planSurfaceCellGeometryCapacity } from "./GpuSurfaceCellGeometryAbi.js";

/** Surface V3 optimization-v1 capacity policy and production allocation contract.
 * Counts are bounded tile/target slots; GPU counters select actual work inside
 * each fixed range and overflow remains visible in the shared diagnostics. */
export const SURFACE_OPTIMIZATION_MIB = 1024 * 1024;
export const SURFACE_OPTIMIZATION_TILE_EDGE = 8;
export const SURFACE_OPTIMIZATION_DEFAULT_BATCH_PIXELS = 262144;
export const SURFACE_OPTIMIZATION_ENVELOPE_BYTES = 512 * SURFACE_OPTIMIZATION_MIB;
export const SURFACE_OPTIMIZATION_BUDGET_MIB = Object.freeze({
  plans: 4, addresses: 32, geometryHot: 16, geometryCold: 32,
  fields: 32, queues: 64, signals: 32, resolveMaps: 8,
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
  // Address witness plus existing primitive dictionary/setup allocation.
  addressBytesPerTarget: 704, geometryHotBytesPerTarget: SURFACE_GEOMETRY_RECORD_BYTES,
  // Two independent bound products (screen leaf / canonical persistent domain)
  // and 15 f32 field values. Ref/demand and work queue storage is separate.
  geometryColdBytesPerTarget: 128, fieldBytesPerTarget: 656,
  queueBytesPerTarget: 1280, signalBytesPerTarget: 96, resolveMapBytesPerTarget: 252
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
  readonly productionAllocations: Readonly<Record<string, number>>;
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
  const workspaceFixedBytes=surfaceCellWorkspaceLayout(1).plans;
  const workspaceTileBytes=surfaceCellWorkspaceLayout(1).bytes-workspaceFixedBytes;
  batchTiles=Math.min(batchTiles,Math.floor((bindingLimit-workspaceFixedBytes)/workspaceTileBytes));
  for (const [pool, field] of scratchProfile) {
    const stride = integer(profile[field], field);
    if (stride % 4 !== 0) throw new RangeError(`${field} must be word aligned`);
    const poolLimit = Math.min(bindingLimit, SURFACE_OPTIMIZATION_BUDGET_MIB[pool] * SURFACE_OPTIMIZATION_MIB);
    batchTiles = Math.min(batchTiles, Math.floor(poolLimit / (stride * 64)));
  }
  // Physical arenas are checked as well as category ceilings. The request
  // dictionary rounds to powers of two and therefore cannot be budgeted by an
  // invented fixed stride. Reserve 256 PSO counters before publication is known.
  while(batchTiles>0 && surfaceDemandLayout(batchTiles*64,256).bytes>
    Math.min(bindingLimit,SURFACE_OPTIMIZATION_BUDGET_MIB.queues*SURFACE_OPTIMIZATION_MIB)) {
    batchTiles--;
  }
  while (batchTiles > 0) {
    try {
      const candidate = planSurfaceCellGeometryCapacity(batchTiles * 64, batchTiles * 64 * 1280, limits);
      if (candidate.setupCapacity >= batchTiles * 64) { break; }
    } catch {
      // Reduce the negotiated extent until the complete local setup contract fits.
    }
    batchTiles--;
  }
  if (batchTiles < 1) throw new RangeError("Surface profile cannot fit one complete tile in negotiated limits");
  const batchTargetCapacity = batchTiles * 64;
  const setup=planSurfaceCellGeometryCapacity(batchTargetCapacity,batchTargetCapacity*1280,limits);
  const productionAllocations=Object.freeze({
    workspace:surfaceCellWorkspaceLayout(batchTiles).bytes,
    geometrySetup:setup.setupBytes+setup.dictionaryBytes+setup.memoBytes+512,
    geometryRecords:batchTargetCapacity*SURFACE_GEOMETRY_RECORD_BYTES,
    fieldValues:batchTargetCapacity*15*16,
    signalValues:batchTargetCapacity*6*16,
    demand:surfaceDemandLayout(batchTargetCapacity,256).bytes,
    demandIndirect:512+256*32,
    controlAndSettings:64*1024,
    coverage:surfaceCoverageLayout(tileCount).bytes,
    activeRange:32,
    dependencyOwners:256*15*4
  });
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
  const scratchTotalBytes = Object.values(productionAllocations).reduce((sum, bytes) => sum + bytes, 0);
  const persistentBytes = [...persistentSegments.fieldStore, ...persistentSegments.signalStore,
    ...persistentSegments.variation].reduce((sum, bytes) => sum + bytes, 0);
  const alignmentBytes = Math.max(0, scratchTotalBytes - rawScratchBytes);
  const payloadBytes = productionAllocations.geometryRecords+productionAllocations.fieldValues+productionAllocations.signalValues;
  const metadataBytes = productionAllocations.workspace+productionAllocations.geometrySetup+productionAllocations.dependencyOwners+productionAllocations.coverage;
  const queueBytes = productionAllocations.demand+productionAllocations.demandIndirect+productionAllocations.activeRange+productionAllocations.controlAndSettings;
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
    fieldCount: batchTargetCapacity*15,
    signalCount: batchTargetCapacity*6,
    programPartitions: 256,
    precisionSpill: batchTargetCapacity*6 });
  return Object.freeze({ width, height, pixelCount, tilesX, tilesY, tileCount,
    batchTileCapacity: batchTiles, batchTargetCapacity, batchCount: Math.ceil(tileCount / batchTiles),
    scratchBytes: Object.freeze(scratchBytes), persistentSegments, reservedBytes,
    envelopeHeadroomBytes: SURFACE_OPTIMIZATION_ENVELOPE_BYTES - reservedBytes, queueLimits, ledger,productionAllocations });
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
