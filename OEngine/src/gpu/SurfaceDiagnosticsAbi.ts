/**
 * Surface V3 diagnostic snapshot ABI.
 *
 * This is deliberately separate from GpuFrameCounters: production scheduling
 * counters are mutable indirect arguments, while these fields are immutable
 * evidence for one sampled frame.
 */
import { SURFACE_WORK_HOT_WORDS } from "./GpuSurfaceWorkAbi.js";

export const SURFACE_DIAGNOSTICS_SCHEMA_VERSION = 9;
export const SURFACE_DIAGNOSTICS_MAGIC = 0x53564433; // "SVD3"
export const SURFACE_DIAGNOSTICS_HEADER_WORDS = 16;
export const SURFACE_DIAGNOSTICS_COUNTER_WORDS = 128;
export const SURFACE_DIAGNOSTICS_WORDS = SURFACE_DIAGNOSTICS_HEADER_WORDS + SURFACE_DIAGNOSTICS_COUNTER_WORDS;
export const SURFACE_DIAGNOSTICS_BYTE_SIZE = SURFACE_DIAGNOSTICS_WORDS * 4;

export type SurfaceDiagnosticsMode = "off" | "timing" | "detailed";
export type SurfaceDiagnosticsAvailability = "available" | "pending" | "dropped" | "unavailable" | "invalid";
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
  geometryCoefficientDegenerate: 64,
  geometryPrimitiveRangeRejected: 65,
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
  reconstructWriteBytes: 77,
  fieldCacheRequests: 78,
  fieldCacheProbes: 79,
  fieldCacheUnique: 80,
  fieldCacheAdmissions: 81,
  fieldCacheQueueRejected: 82,
  signalCacheRequests: 83,
  signalCacheProbes: 84,
  signalCacheUnique: 85,
  signalCacheAdmissions: 86,
  signalCacheQueueRejected: 87,
  fieldValuesProduced: 88,
  signalValuesProduced: 89,
  candidateLeaves: 90,
  uvWitnessGroups: 91,
  uvWitnessWriteBytes: 92,
  signalWitnessLeaves: 93,
  signalWitnessWriteBytes: 94,
  proofResultWriteBytes: 95,
  proofAdmitted: 96,
  proofRejected: 97,
  geometryHotWriteBytes: 98,
  geometryColdWriteBytes: 99,
  explicitStoreRefWriteBytes: 100,
  fullDirectLightEvaluations: 101,
  sharedDirectTransportEvaluations: 102,
  transportOnlyLightEvaluations: 103,
  fieldLookupCandidates: 104,
  nonPublicationFields: 105,
  fieldLookupProbes: 106,
  transportEligibleLeaves: 107,
  residualLeaves: 108,
  geometryDescriptions: 109,
  materialDescriptions: 110,
  lightingDescriptions: 111,
  domainDescriptions: 112,
  coverageReferences: 113,
  promotedTiles: 114,
  fieldScalarWrites: 115,
  geometrySetupEvaluations: 116,
  sampleTextureQueries: 117,
  sampleProductQueries: 118,
  uniformScalarReads: 119,
} as const);

export const SURFACE_DIAGNOSTICS_COUNTERS = SURFACE_DIAGNOSTIC_COUNTERS;

export type SurfaceDiagnosticCounter = keyof typeof SURFACE_DIAGNOSTIC_COUNTERS;

/** Actual producer locations, not semantic aliases of queue lengths. Unlisted
 * counters have no current producer and must not appear as measured zeroes. */
export const SURFACE_DIAGNOSTIC_PRODUCERS: Readonly<Partial<Record<SurfaceDiagnosticCounter, string>>> =
  Object.freeze({
    totalTiles: "capacity coverage tile extent",
    emptyTiles: "work_control[225]/coverage reduction",
    uniformTiles: "work_control[226]/coverage reduction",
    mixedTiles: "work_control[227]/coverage reduction",
    visiblePixels: "work_control[224]/coverage reduction",
    geometryRecordsRequested: "work_control[239]/before Geometry producer",
    geometryMissCompleted: "work_control[229]/Geometry producer completion",
    geometryRejected: "work_control[228]/Geometry producer rejection",
    geometryRecordStrideWords: "closed Geometry ABI, words",
    geometryHotWriteBytes: "work_control[243]/actual closed hot writes * 64 bytes",
    materialEvaluatorEntered: "work_control[240]/before missing closure evaluator",
    materialEvaluatorCompleted: "work_control[230]/after closure writes",
    fieldValuesProduced: "work_control[241]/actual missing field roots written",
    fieldScalarWrites: "work_control[242]/actual scalar SoA writes",
    geometrySetupEvaluations: "work_control[244]/actual primitive setup calls",
    sampleTextureQueries: "work_control[300]/actual sample-domain resident query calls",
    sampleProductQueries: "work_control[301]/actual sample-domain Product query calls",
    uniformScalarReads: "work_control[302]/actual update value scalar loads",
    lightingRecordsProcessed: "work_control[261]/closed lit sample",
    diffuseEvaluations: "work_control[256]/direct sample calls",
    specularEvaluations: "work_control[257]/direct sample calls",
    coatEvaluations: "work_control[258]/nonzero coat sample calls",
    iblEvaluations: "work_control[259]+[260]+[262]/actual environment calls",
    lightLoopIterations: "work_control[264]/actual provider BRDF calls",
    diffusePacketWrites: "work_control[276]+[277]/packet stores",
    specularPacketWrites: "work_control[278]+[279]/packet stores",
    coatPacketWrites: "work_control[280]+[281]/packet stores",
    iblPacketWrites: "work_control[277]+[279]+[281]/packet stores",
    packetWriteBytes: "actual packet stores * 16 bytes",
    signalValuesProduced: "six actual packet-store counts",
    reconstructOutputPixels: "work_control[233]/valid output writes",
    reconstructUncoveredPixels: "work_control[234]/background output writes",
    outputPixels: "output extent",
    transientBytes: "Surface scratch owner active bytes",
    diagnosticsFlags: "actual Geometry producer error flag",
    domainDescriptions: "publication interned directory count",
    coverageReferences: "work_control[32..35]/active tile references",
    promotedTiles: "work_control[232]/whole-tile optional rejection",
  });

export const SURFACE_DIAGNOSTIC_DESCRIPTORS = Object.freeze(
  Object.fromEntries(
    (Object.keys(SURFACE_DIAGNOSTICS_COUNTERS) as SurfaceDiagnosticCounter[]).map((name) => [
      name,
      Object.freeze({
        producer: SURFACE_DIAGNOSTIC_PRODUCERS[name] ?? null,
        unit: name.endsWith("Bytes")
          ? "bytes"
          : name.endsWith("Words")
            ? "u32-words"
            : name.endsWith("Pixels")
              ? "pixels"
              : "count",
        window: "one sampled frame, across disjoint physical banks",
        availability: SURFACE_DIAGNOSTIC_PRODUCERS[name] === undefined ? "unavailable" : "wired",
      }),
    ]),
  ),
);

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
  lightingPacketWritesUnknown: 1 << 9,
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
  mode: SurfaceDiagnosticsMode,
): void {
  if (target.length < SURFACE_DIAGNOSTICS_HEADER_WORDS) {
    throw new RangeError("Surface diagnostics header target is too small");
  }
  const runHash = hashRunId(identity.runId);
  target.fill(0, 0, SURFACE_DIAGNOSTICS_HEADER_WORDS);
  target.set(
    [
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
      0,
    ],
    0,
  );
}

export function decodeSurfaceDiagnostics(
  data: ArrayBuffer,
  identity: SurfaceDiagnosticsIdentity,
  mode: SurfaceDiagnosticsMode,
): SurfaceDiagnosticsSnapshot {
  if (data.byteLength < SURFACE_DIAGNOSTICS_BYTE_SIZE) {
    return unavailableSnapshot(identity, mode, "snapshot-too-small");
  }
  const words = new Uint32Array(data, 0, SURFACE_DIAGNOSTICS_WORDS);
  if (words[0] !== SURFACE_DIAGNOSTICS_MAGIC || words[1] !== SURFACE_DIAGNOSTICS_SCHEMA_VERSION) {
    return unavailableSnapshot(identity, mode, "snapshot-schema-mismatch");
  }
  const values: Record<string, number> = {};
  if (words[4] !== identity.frameId >>> 0) {
    return unavailableSnapshot(identity, mode, "snapshot-frame-mismatch");
  }
  for (const [name, index] of Object.entries(SURFACE_DIAGNOSTICS_COUNTERS) as [
    SurfaceDiagnosticCounter,
    number,
  ][]) {
    if (
      ((words[8 + (index >>> 5)]! >>> (index & 31)) & 1) !== 0 &&
      SURFACE_DIAGNOSTIC_PRODUCERS[name] !== undefined
    ) {
      values[name] = words[SURFACE_DIAGNOSTICS_HEADER_WORDS + index]!;
    }
  }
  const coverage = evaluateSurfaceCoverage(values);
  return {
    ...identity,
    schemaVersion: words[1]!,
    mode,
    availability: "available",
    values,
    coverage,
    reconstructLogicalBytes: reconstructLogicalBytes(values),
  };
}

export function evaluateSurfaceCoverage(values: SurfaceDiagnosticsValues): SurfaceCoverageReport {
  const violations: string[] = [];
  const required: SurfaceDiagnosticCounter[] = [
    "totalTiles", "emptyTiles", "uniformTiles", "mixedTiles", "visiblePixels",
    "geometryRecordsRequested", "geometryMissCompleted", "geometryRejected",
    "materialEvaluatorEntered", "materialEvaluatorCompleted",
    "reconstructOutputPixels", "reconstructUncoveredPixels", "outputPixels",
  ];
  const incomplete = required.some((name) => values[name] === undefined);
  if (!incomplete) {
    sumEquals(values, "totalTiles", ["emptyTiles", "uniformTiles", "mixedTiles"], violations);
    sumEquals(values, "geometryRecordsRequested", ["geometryMissCompleted", "geometryRejected"], violations);
    if (values.geometryRejected !== 0) { violations.push("visible Geometry producer rejected source"); }
    if (values.materialEvaluatorEntered !== values.materialEvaluatorCompleted) { violations.push("Appearance evaluator completion mismatch"); }
    if (values.visiblePixels !== values.reconstructOutputPixels) { violations.push("visible coverage lost before output"); }
    if (values.reconstructOutputPixels! + values.reconstructUncoveredPixels! !== values.outputPixels) { violations.push("reconstruct output coverage mismatch"); }
  }
  if (
    values.geometryProducerBaseWords !== undefined &&
    values.geometryConsumerBaseWords !== undefined &&
    values.geometryProducerBaseWords !== values.geometryConsumerBaseWords
  ) {
    violations.push("geometry producer/consumer base mismatch");
  }
  if (
    values.geometryRecordStrideWords !== undefined &&
    values.geometryRecordStrideWords !== SURFACE_WORK_HOT_WORDS &&
    values.geometryRecordStrideWords !== 0
  ) {
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
  violations: string[],
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
  reason: string,
): SurfaceDiagnosticsSnapshot {
  return {
    ...identity,
    schemaVersion: SURFACE_DIAGNOSTICS_SCHEMA_VERSION,
    mode,
    availability: "invalid",
    values: {},
    coverage: { status: "unknown", violations: [reason] },
    reconstructLogicalBytes: null,
  };
}
