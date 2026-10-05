import { surfaceCoverageLayout } from "./GpuSurfaceCoverageAbi.js";
import { surfaceCellWorkspaceLayout } from "./GpuSurfaceCellPlanAbi.js";
import { surfaceDemandLayout } from "./GpuSurfaceDemandAbi.js";
import {
  SURFACE_GEOMETRY_RECORD_HOT_BYTES,
  SURFACE_GEOMETRY_RECORD_COLD_MAX_BYTES,
} from "./GpuSurfaceGeometryRecordAbi.js";
import { planSurfaceCellGeometryCapacity } from "./GpuSurfaceCellGeometryAbi.js";

/** Surface V3 optimization-v1 capacity policy and production allocation contract.
 * Counts are bounded tile/target slots; GPU counters select actual work inside
 * each fixed range and overflow remains visible in the shared diagnostics. */
export const SURFACE_OPTIMIZATION_MIB = 1024 * 1024;
export const SURFACE_OPTIMIZATION_TILE_EDGE = 8;
export const SURFACE_OPTIMIZATION_DEFAULT_BATCH_PIXELS = 262144;
export const SURFACE_OPTIMIZATION_ENVELOPE_BYTES = 512 * SURFACE_OPTIMIZATION_MIB;
export const SURFACE_OPTIMIZATION_SCRATCH_ENVELOPE_BYTES = 240 * SURFACE_OPTIMIZATION_MIB;
export const SURFACE_OPTIMIZATION_BUDGET_MIB = Object.freeze({
  plans: 8,
  addresses: 32,
  geometryHot: 8,
  geometryCold: 48,
  fields: 16,
  demandAndRefs: 32,
  signals: 8,
  setup: 48,
  fieldStore: 128,
  signalStore: 64,
  variation: 32,
  outputs: 24,
  retirementHeadroom: 64,
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
  // Candidate identity is separate from lazily admitted detailed witness.
  addressBytesPerTarget: 24 * 4 + 18 * 4 + 12 * 4,
  geometryHotBytesPerTarget: SURFACE_GEOMETRY_RECORD_HOT_BYTES,
  // Cold maximum is reserved independently; production writes it only for the
  // actual Geometry union. It is not charged to hot stride.
  geometryColdBytesPerTarget: SURFACE_GEOMETRY_RECORD_COLD_MAX_BYTES,
  fieldBytesPerTarget: 240,
  // 2R/R cache requests, bounded pow2 dictionaries and actual target masks/queues.
  queueBytesPerTarget: 192,
  signalBytesPerTarget: 96,
  resolveMapBytesPerTarget: 21 * 8 + 8,
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
  readonly scratchBytes: Readonly<
    Record<
      | "plans"
      | "addresses"
      | "geometryHot"
      | "geometryCold"
      | "fields"
      | "queues"
      | "signals"
      | "resolveMaps",
      number
    >
  >;
  readonly persistentSegments: Readonly<
    Record<"fieldStore" | "signalStore" | "variation", readonly number[]>
  >;
  readonly reservedBytes: number;
  readonly envelopeHeadroomBytes: number;
  readonly queueLimits: Readonly<SurfaceOptimizationQueueLimits>;
  readonly ledger: Readonly<SurfaceOptimizationBudgetLedger>;
  readonly productionAllocations: Readonly<Record<string, number>>;
  readonly limitingPools: readonly string[];
  readonly physicalPoolBytes: Readonly<Record<string, number | boolean>>;
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
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};
const scratchProfile = [
  ["addresses", "addressBytesPerTarget"],
  ["geometryHot", "geometryHotBytesPerTarget"],
  ["geometryCold", "geometryColdBytesPerTarget"],
  ["fields", "fieldBytesPerTarget"],
  ["demandAndRefs", "queueBytesPerTarget"],
  ["signals", "signalBytesPerTarget"],
  ["demandAndRefs", "resolveMapBytesPerTarget"],
] as const;

export function planSurfaceOptimizationCapacity(
  width: number,
  height: number,
  limits: SurfaceOptimizationLimits,
  profile: SurfaceOptimizationProfile = SURFACE_OPTIMIZATION_DEFAULT_PROFILE,
): SurfaceOptimizationCapacity {
  integer(width, "width");
  integer(height, "height");
  const maxTexture = integer(limits.maxTextureDimension2D, "maxTextureDimension2D");
  const bindingLimit =
    Math.floor(
      Math.min(
        integer(limits.maxBufferSize, "maxBufferSize"),
        integer(limits.maxStorageBufferBindingSize, "maxStorageBufferBindingSize"),
      ) / 256,
    ) * 256;
  if (width > maxTexture || height > maxTexture)
    throw new RangeError("Surface extent exceeds device texture limit");
  const pixelCount = width * height;
  const tilesX = Math.ceil(width / 8),
    tilesY = Math.ceil(height / 8),
    tileCount = tilesX * tilesY;
  if (!Number.isSafeInteger(pixelCount) || tileCount * 64 > 0xffffffff) {
    throw new RangeError("Surface target addresses exceed u32 capacity");
  }
  const controlBytes = 64 * 1024;
  let batchTiles = Math.min(tileCount, SURFACE_OPTIMIZATION_DEFAULT_BATCH_PIXELS / 64);
  for (const [pool, field] of scratchProfile) {
    const stride = integer(profile[field], field);
    if (stride % 4 !== 0) throw new RangeError(`${field} must be word aligned`);
    const poolLimit = Math.min(
      bindingLimit,
      SURFACE_OPTIMIZATION_BUDGET_MIB[pool] * SURFACE_OPTIMIZATION_MIB,
    );
    batchTiles = Math.min(batchTiles, Math.floor(poolLimit / (stride * 64)));
  }
  const physicalFor = (tiles: number) => {
    const targets = tiles * 64;
    const workspace = surfaceCellWorkspaceLayout(tiles);
    const setup = planSurfaceCellGeometryCapacity(targets, targets * 1280, limits);
    const coverage = surfaceCoverageLayout(tileCount).bytes;
    const geometryHot =
      targets * Math.max(SURFACE_GEOMETRY_RECORD_HOT_BYTES, profile.geometryHotBytesPerTarget);
    const geometryCold =
      targets * Math.max(SURFACE_GEOMETRY_RECORD_COLD_MAX_BYTES, profile.geometryColdBytesPerTarget);
    const fields = targets * 240,
      signals = targets * 96;
    const demand = surfaceDemandLayout(targets, 256).bytes;
    // Proof families consume one separate seven-record indirect dispatch
    // buffer. Keep it in the physical queue ledger rather than hiding it in
    // the workspace allocation.
    const proofIndirect = 7 * 16;
    const plans = workspace.maps + coverage + controlBytes + 32 + 512 + 256 * 32;
    const addressProof =
      workspace.fieldReferences - workspace.proofResults + workspace.bytes - workspace.proofs;
    const refs = workspace.proofs - workspace.fieldReferences + workspace.proofResults - workspace.maps;
    const setupBytes = setup.setupBytes + setup.referenceBytes + setup.memoBytes + 512;
    const scratch =
      workspace.bytes +
      setupBytes +
      geometryHot +
      geometryCold +
      fields +
      signals +
      demand +
      proofIndirect +
      512 +
      256 * 32 +
      controlBytes +
      coverage +
      32 +
      256 * 15 * 4;
    return {
      workspace: workspace.bytes,
      plans,
      addressProof,
      refs,
      setup: setupBytes,
      setupArena: setup.setupBytes + setup.referenceBytes,
      setupMemo: setup.memoBytes,
      geometryHot,
      geometryCold,
      fields,
      signals,
      demand,
      proofIndirect,
      demandAndRefs: demand + refs + proofIndirect,
      scratch,
      envelope: scratch * 2 + 224 * SURFACE_OPTIMIZATION_MIB + 48 * SURFACE_OPTIMIZATION_MIB,
      completeSetup: setup.setupCapacity === targets,
    };
  };
  const failures = (physical: ReturnType<typeof physicalFor>): string[] => {
    const result: string[] = [];
    const categories = [
      ["plans", 8],
      ["addressProof", 32],
      ["setup", 48],
      ["geometryHot", 8],
      ["geometryCold", 48],
      ["fields", 16],
      ["signals", 8],
      ["demandAndRefs", 32],
    ] as const;
    for (const [name, budget] of categories)
      if (physical[name] > budget * SURFACE_OPTIMIZATION_MIB) result.push(name);
    for (const name of ["workspace", "setupArena", "setupMemo", "demand", "fields", "signals"] as const)
      if (physical[name] > bindingLimit) result.push(`${name}Binding`);
    if (physical.geometryHot + physical.geometryCold > bindingLimit) result.push("geometryBinding");
    if (!physical.completeSetup) result.push("completeSetup");
    if (physical.envelope > SURFACE_OPTIMIZATION_ENVELOPE_BYTES) result.push("retirementEnvelope");
    return result;
  };
  let limitingPools: readonly string[] = [];
  while (batchTiles > 0) {
    try {
      const rejected = failures(physicalFor(batchTiles));
      if (rejected.length === 0) break;
      limitingPools = rejected;
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }
      limitingPools = ["setupBinding"];
    }
    batchTiles--;
  }
  if (batchTiles < 1)
    throw new RangeError("Surface profile cannot fit one complete tile in negotiated limits");
  const batchTargetCapacity = batchTiles * 64;
  const setup = planSurfaceCellGeometryCapacity(batchTargetCapacity, batchTargetCapacity * 1280, limits);
  const physicalPoolBytes = physicalFor(batchTiles);
  const productionAllocations = Object.freeze({
    workspace: surfaceCellWorkspaceLayout(batchTiles).bytes,
    geometrySetup: setup.setupBytes + setup.referenceBytes + setup.memoBytes + 512,
    geometryHot: physicalPoolBytes.geometryHot,
    geometryCold: physicalPoolBytes.geometryCold,
    fieldValues: batchTargetCapacity * 15 * 16,
    signalValues: batchTargetCapacity * 6 * 16,
    demand: surfaceDemandLayout(batchTargetCapacity, 256).bytes,
    proofIndirect: 7 * 16,
    demandIndirect: 512 + 256 * 32,
    controlAndSettings: 64 * 1024,
    coverage: surfaceCoverageLayout(tileCount).bytes,
    activeRange: 32,
    dependencyOwners: 256 * 15 * 4,
  });
  const scratchBytes = {
    plans: physicalPoolBytes.plans,
    addresses: physicalPoolBytes.addressProof,
    geometryHot: physicalPoolBytes.geometryHot,
    geometryCold: physicalPoolBytes.geometryCold,
    fields: physicalPoolBytes.fields,
    queues: physicalPoolBytes.demand,
    signals: physicalPoolBytes.signals,
    resolveMaps: physicalPoolBytes.refs,
  };
  // Pools may be physically segmented. Every segment fits a legal storage binding;
  // a future consumer must select segments without unnegotiated binding arrays.
  const segment = (pool: "fieldStore" | "signalStore" | "variation"): readonly number[] => {
    let remaining = SURFACE_OPTIMIZATION_BUDGET_MIB[pool] * SURFACE_OPTIMIZATION_MIB;
    const result: number[] = [];
    while (remaining > 0) {
      const bytes = Math.min(remaining, bindingLimit);
      result.push(bytes);
      remaining -= bytes;
    }
    return Object.freeze(result);
  };
  const persistentSegments = Object.freeze({
    fieldStore: segment("fieldStore"),
    signalStore: segment("signalStore"),
    variation: segment("variation"),
  });
  const requiredOutputBytes = pixelCount * 12; // HDR rgba16float + reactive r32float.
  const reservedOutputBytes = SURFACE_OPTIMIZATION_BUDGET_MIB.outputs * SURFACE_OPTIMIZATION_MIB;
  if (requiredOutputBytes > reservedOutputBytes) {
    throw new RangeError("Surface output extent exceeds configured output budget");
  }
  const scratchTotalBytes = Object.values(productionAllocations).reduce((sum, bytes) => sum + bytes, 0);
  const persistentBytes = [
    ...persistentSegments.fieldStore,
    ...persistentSegments.signalStore,
    ...persistentSegments.variation,
  ].reduce((sum, bytes) => sum + bytes, 0);
  const alignmentBytes =
    productionAllocations.demand -
    (surfaceDemandLayout(batchTargetCapacity, 256).offsets.ordered_material_queue! + batchTargetCapacity * 4);
  const payloadBytes =
    productionAllocations.geometryHot +
    productionAllocations.geometryCold +
    productionAllocations.fieldValues +
    productionAllocations.signalValues;
  const metadataBytes =
    productionAllocations.workspace +
    productionAllocations.geometrySetup +
    productionAllocations.dependencyOwners +
    productionAllocations.coverage;
  const queueBytes =
    productionAllocations.demand +
    productionAllocations.demandIndirect +
    productionAllocations.proofIndirect +
    productionAllocations.activeRange +
    productionAllocations.controlAndSettings;
  const historyBytes = 0;
  const retiredOverlapBytes = scratchTotalBytes;
  const outputBytes = SURFACE_OPTIMIZATION_BUDGET_MIB.outputs * SURFACE_OPTIMIZATION_MIB;
  const reservedBytes = scratchTotalBytes + retiredOverlapBytes + persistentBytes + outputBytes * 2;
  if (reservedBytes > SURFACE_OPTIMIZATION_ENVELOPE_BYTES) throw new RangeError("Surface envelope exceeded");
  const ledger = Object.freeze({
    payloadBytes,
    metadataBytes,
    queueBytes,
    alignmentBytes,
    outputBytes,
    scratchBytes: scratchTotalBytes,
    persistentBytes,
    historyBytes,
    retiredOverlapBytes,
    sharedBytes: 0,
    surfaceEnvelopeBytes: SURFACE_OPTIMIZATION_ENVELOPE_BYTES,
  });
  const queueLimits = Object.freeze({
    targetPixels: batchTargetCapacity,
    uniqueAddresses: batchTargetCapacity,
    fieldCount: batchTargetCapacity * 15,
    signalCount: batchTargetCapacity * 6,
    programPartitions: 256,
    precisionSpill: batchTargetCapacity * 6,
  });
  return Object.freeze({
    width,
    height,
    pixelCount,
    tilesX,
    tilesY,
    tileCount,
    batchTileCapacity: batchTiles,
    batchTargetCapacity,
    batchCount: Math.ceil(tileCount / batchTiles),
    scratchBytes: Object.freeze(scratchBytes),
    persistentSegments,
    reservedBytes,
    envelopeHeadroomBytes: SURFACE_OPTIMIZATION_ENVELOPE_BYTES - reservedBytes,
    queueLimits,
    ledger,
    productionAllocations,
    limitingPools: Object.freeze(limitingPools),
    physicalPoolBytes: Object.freeze(physicalPoolBytes),
  });
}

/** CPU encodes all fixed ranges; GPU coverage/counts select work inside each range. */
export function surfaceOptimizationBatchRange(
  plan: SurfaceOptimizationCapacity,
  batch: number,
): Readonly<{
  firstTile: number;
  tileCount: number;
  paddedTargetCapacity: number;
}> {
  if (!Number.isSafeInteger(batch) || batch < 0 || batch >= plan.batchCount)
    throw new RangeError("Invalid Surface batch");
  const firstTile = batch * plan.batchTileCapacity;
  const tileCount = Math.min(plan.batchTileCapacity, plan.tileCount - firstTile);
  return Object.freeze({ firstTile, tileCount, paddedTargetCapacity: tileCount * 64 });
}
