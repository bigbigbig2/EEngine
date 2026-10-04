/**
 * Surface V3 diagnostic snapshot ABI.
 *
 * This is deliberately separate from GpuFrameCounters: production scheduling
 * counters are mutable indirect arguments, while these fields are immutable
 * evidence for one sampled frame.
 */
import { SURFACE_GEOMETRY_RECORD_VECTORS } from "./GpuSurfaceGeometryRecordAbi.js";

export const SURFACE_DIAGNOSTICS_SCHEMA_VERSION = 4;
export const SURFACE_DIAGNOSTICS_MAGIC = 0x53564433; // "SVD3"
export const SURFACE_DIAGNOSTICS_HEADER_WORDS = 16;
export const SURFACE_DIAGNOSTICS_COUNTER_WORDS = 96;
export const SURFACE_DIAGNOSTICS_WORDS =
  SURFACE_DIAGNOSTICS_HEADER_WORDS + SURFACE_DIAGNOSTICS_COUNTER_WORDS;
export const SURFACE_DIAGNOSTICS_BYTE_SIZE = SURFACE_DIAGNOSTICS_WORDS * 4;

export type SurfaceDiagnosticsMode = "off" | "timing" | "detailed";
export type SurfaceDiagnosticsAvailability =
  | "available"
  | "pending"
  | "dropped"
  | "unavailable"
  | "invalid";
export type SurfaceCoverageStatus = "pass" | "fail" | "unknown";

export const SURFACE_DIAGNOSTIC_COUNTERS = Object.freeze({
  totalTiles: 0,
  emptyTiles: 1,
  uniformTiles: 2,
  mixedTiles: 3,
  visiblePixels: 4,
  sampleRequested: 5,
  sampleAccepted: 6,
  sampleOverflow: 7,
  exceptionRequested: 8,
  exceptionAccepted: 9,
  materialLookup: 10,
  materialHit: 11,
  materialMissRequested: 12,
  materialMissQueued: 13,
  materialRejected: 14,
  materialEvaluatorEntered: 15,
  materialEvaluatorCompleted: 16,
  materialFieldsPublished: 17,
  materialEvaluatorSkippedOrRejected: 18,
  geometryRecordsRequested: 19,
  geometryCacheHit: 20,
  geometryMissQueued: 21,
  geometryMissCompleted: 22,
  geometryRecordsValid: 23,
  geometryRejected: 24,
  lightingRecordsProcessed: 25,
  lightingRecordsRejected: 26,
  diffuseEvaluations: 27,
  specularEvaluations: 28,
  coatEvaluations: 29,
  iblEvaluations: 30,
  diffusePacketWrites: 31,
  specularPacketWrites: 32,
  coatPacketWrites: 33,
  iblPacketWrites: 34,
  reconstructOutputPixels: 35,
  reconstructUncoveredPixels: 36,
  historyReusePixels: 37,
  historyRejectPixels: 38,
  identityRejectPixels: 39,
  queueOverflowFlags: 40,
  diagnosticsFlags: 41,
  geometryProducerBaseWords: 42,
  geometryConsumerBaseWords: 43,
  geometryRecordStrideWords: 44,
  materialQueueRangeErrors: 45,
  lightLoopIterations: 46,
  clusterFallbackIterations: 47,
  shadowVisibilityCalls: 48,
  environmentSampleCalls: 49,
  allocatedBytes: 50,
  transientBytes: 51,
  residentBytes: 52,
  outputPixels: 53,
  validPacketPixels: 54,
  reserved: 55,
  geometryKeyInvalid: 56,
  geometryKeyOutOfRange: 57,
  geometrySourceRejected: 58,
  geometryInterpolationRejected: 59,
  geometryKeyZero: 60,
  geometryDirectoryRejected: 61,
  geometryTriangleRangeRejected: 62,
  geometryVertexRangeRejected: 63,
  geometryCoefficientDegenerate: 64
  ,geometryPrimitiveRangeRejected: 65,
  geometryBaseRangeRejected: 66,
  geometrySpanRangeRejected: 67,
  geometryFirstTriangleCount: 68,
  geometryFirstPrimitive: 69,
  geometryFirstDirectoryTriangles: 70,
  geometryFirstTriangleBase: 71,
  geometryRecordWriteBytes: 72,
  packetWriteBytes: 73,
  reconstructHistoryLoads: 74,
  reconstructMappedPixels: 75,
  reconstructReadBytes: 76,
  reconstructWriteBytes: 77
} as const);

export const SURFACE_DIAGNOSTICS_COUNTERS = SURFACE_DIAGNOSTIC_COUNTERS;

export type SurfaceDiagnosticCounter = keyof typeof SURFACE_DIAGNOSTIC_COUNTERS;

export const SURFACE_DIAGNOSTIC_FLAGS = Object.freeze({
  sampleOverflow: 1 << 0,
  exceptionOverflow: 1 << 1,
  geometryOverflow: 1 << 2,
  materialOverflow: 1 << 3,
  invalidGeometryBase: 1 << 4,
  materialQueueRangeError: 1 << 5,
  completionAuditMissing: 1 << 6,
  snapshotDropped: 1 << 7,
  incompleteProducerCounters: 1 << 8,
  lightingPacketWritesUnknown: 1 << 9
} as const);

export interface SurfaceDiagnosticsIdentity {
  readonly runId: string;
  readonly deviceEpoch: number;
  readonly frameId: number;
}

export interface SurfaceDiagnosticsValues {
  readonly [name: string]: number;
}

export interface SurfaceCoverageReport {
  readonly status: SurfaceCoverageStatus;
  readonly violations: readonly string[];
}

export interface SurfaceDiagnosticsSnapshot extends SurfaceDiagnosticsIdentity {
  readonly schemaVersion: number;
  readonly mode: SurfaceDiagnosticsMode;
  readonly availability: SurfaceDiagnosticsAvailability;
  readonly values: SurfaceDiagnosticsValues;
  readonly coverage: SurfaceCoverageReport;
  readonly reconstructLogicalBytes: number | null;
}

export function surfaceDiagnosticsByteOffset(counter: SurfaceDiagnosticCounter): number {
  const index = SURFACE_DIAGNOSTICS_COUNTERS[counter];
  return (SURFACE_DIAGNOSTICS_HEADER_WORDS + index) * 4;
}

export function writeSurfaceDiagnosticsHeader(
  target: Uint32Array,
  identity: SurfaceDiagnosticsIdentity,
  mode: SurfaceDiagnosticsMode
): void {
  if (target.length < SURFACE_DIAGNOSTICS_HEADER_WORDS) {
    throw new RangeError("Surface diagnostics header target is too small");
  }
  const runHash = hashRunId(identity.runId);
  target.fill(0, 0, SURFACE_DIAGNOSTICS_HEADER_WORDS);
  target.set([
    SURFACE_DIAGNOSTICS_MAGIC,
    SURFACE_DIAGNOSTICS_SCHEMA_VERSION,
    runHash,
    identity.deviceEpoch >>> 0,
    identity.frameId >>> 0,
    mode === "off" ? 0 : mode === "timing" ? 1 : 2,
    SURFACE_DIAGNOSTICS_COUNTER_WORDS,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
  ], 0);
}

export function decodeSurfaceDiagnostics(
  data: ArrayBuffer,
  identity: SurfaceDiagnosticsIdentity,
  mode: SurfaceDiagnosticsMode
): SurfaceDiagnosticsSnapshot {
  if (data.byteLength < SURFACE_DIAGNOSTICS_BYTE_SIZE) {
    return unavailableSnapshot(identity, mode, "snapshot-too-small");
  }
  const words = new Uint32Array(data, 0, SURFACE_DIAGNOSTICS_WORDS);
  if (words[0] !== SURFACE_DIAGNOSTICS_MAGIC || words[1] !== SURFACE_DIAGNOSTICS_SCHEMA_VERSION) {
    return unavailableSnapshot(identity, mode, "snapshot-schema-mismatch");
  }
  const values: Record<string, number> = {};
  for (const [name, index] of Object.entries(SURFACE_DIAGNOSTICS_COUNTERS) as [SurfaceDiagnosticCounter, number][]) {
    values[name] = words[SURFACE_DIAGNOSTICS_HEADER_WORDS + index] ?? 0;
  }
  const coverage = evaluateSurfaceCoverage(values);
  return {
    ...identity,
    schemaVersion: words[1]!,
    mode,
    availability: "available",
    values,
    coverage,
    reconstructLogicalBytes: reconstructLogicalBytes(values)
  };
}

export function evaluateSurfaceCoverage(values: SurfaceDiagnosticsValues): SurfaceCoverageReport {
  const violations: string[] = [];
  const incomplete = ((values.diagnosticsFlags ?? 0) & SURFACE_DIAGNOSTIC_FLAGS.incompleteProducerCounters) !== 0;
  if (!incomplete) {
    sumEquals(values, "totalTiles", ["emptyTiles", "uniformTiles", "mixedTiles"], violations);
    sumEquals(values, "sampleRequested", ["sampleAccepted", "sampleOverflow"], violations);
    sumEquals(values, "materialLookup", ["materialHit", "materialMissRequested", "materialRejected"], violations);
    sumEquals(values, "geometryRecordsRequested", ["geometryCacheHit", "geometryMissQueued", "geometryRejected"], violations);
    if (counterValue(values, "materialMissQueued") < counterValue(values, "materialEvaluatorCompleted") + counterValue(values, "materialEvaluatorSkippedOrRejected")) {
      violations.push("material queued less than completed plus skipped/rejected");
    }
    if (counterValue(values, "geometryMissCompleted") > counterValue(values, "geometryMissQueued")) violations.push("geometry miss completed exceeds queued");
    if (counterValue(values, "reconstructOutputPixels") + counterValue(values, "reconstructUncoveredPixels") !== counterValue(values, "outputPixels")) {
      violations.push("reconstruct output coverage mismatch");
    }
  }
  if (values.geometryProducerBaseWords !== values.geometryConsumerBaseWords) {
    violations.push("geometry producer/consumer base mismatch");
  }
  if (values.geometryRecordStrideWords !== SURFACE_GEOMETRY_RECORD_VECTORS && values.geometryRecordStrideWords !== 0) {
    violations.push("geometry record stride mismatch");
  }
  const status = violations.length !== 0 ? "fail" : incomplete ? "unknown" : "pass";
  return { status, violations };
}

function counterValue(values: SurfaceDiagnosticsValues, counter: SurfaceDiagnosticCounter): number {
  return values[counter] ?? 0;
}

export function reconstructLogicalBytes(values: SurfaceDiagnosticsValues): number | null {
  const read = finiteCounter(values.reconstructReadBytes);
  const write = finiteCounter(values.reconstructWriteBytes);
  return read === null || write === null ? null : read + write;
}

function sumEquals(
  values: SurfaceDiagnosticsValues,
  total: SurfaceDiagnosticCounter,
  terms: readonly SurfaceDiagnosticCounter[],
  violations: string[]
): void {
  const expected = terms.reduce((sum, name) => sum + (values[name] ?? 0), 0);
  if (values[total] !== expected) {
    violations.push(`${total} != ${terms.join(" + ")}`);
  }
}

function finiteCounter(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function hashRunId(runId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < runId.length; index++) {
    hash ^= runId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unavailableSnapshot(
  identity: SurfaceDiagnosticsIdentity,
  mode: SurfaceDiagnosticsMode,
  reason: string
): SurfaceDiagnosticsSnapshot {
  return {
    ...identity,
    schemaVersion: SURFACE_DIAGNOSTICS_SCHEMA_VERSION,
    mode,
    availability: "invalid",
    values: {},
    coverage: { status: "unknown", violations: [reason] },
    reconstructLogicalBytes: null
  };
}
