import {
  compareBenchmarkResults,
  validateBenchmarkEvidence,
  type BenchmarkComparison,
  type BenchmarkEvidenceReport,
  type BenchmarkEnvironmentManifest,
  type BenchmarkResult
} from "../../OEngine/src/index.ts";
import type { CameraSweepCase } from "./camera-experiments.js";
import type { RenderingLabCaseId } from "./quality-profile.js";
import {
  evaluateSurfaceAbiV2RunGroupNeed,
  evaluateTileBackendRunGroupNeed,
  type SurfaceAbiDecision,
  type SurfaceAbiRunEvidence,
  type TileBackendDecision,
  type TileBackendVendorRunEvidence
} from "../../OEngine/src/debug/VisibilitySurfaceMigrationGates.js";
import {
  GPU_SURFACE_ABI_VERSION,
  GPU_SURFACE_ABI_V2_CANDIDATE_SCHEMA,
  gpuSurfaceBytesPerPixel,
  gpuSurfaceCandidateBytesPerPixel
} from "../../OEngine/src/gpu/GpuSurfaceAbi.js";
import {
  modelTileBackendCost,
  type TileBackendCostModelInput,
  type TileBackendCostModelResult
} from "../../OEngine/src/debug/TileBackendCostModel.js";

export interface RenderingLabBenchmarkReport {
  readonly schemaVersion: 1;
  readonly status: "complete" | "incomplete";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly environment: BenchmarkEnvironmentManifest;
  readonly workload: Readonly<Record<string, unknown>>;
  readonly camera: {
    readonly sweep: readonly CameraSweepCase[];
    readonly pathId: string;
    readonly segments: readonly RenderingLabCameraSegmentStats[];
  };
  readonly cases: readonly BenchmarkResult[];
  readonly comparisons: readonly BenchmarkComparison[];
  readonly evidence: Readonly<Record<string, BenchmarkEvidenceReport>>;
  readonly featureOffGates: readonly RenderingLabFeatureOffGate[];
  readonly domainEvidence: Readonly<Record<string, unknown>>;
  readonly errors: readonly string[];
  readonly measurement?: RenderingLabMeasurementProfile;
}

export interface RenderingLabMeasurementProfile {
  readonly runId: string;
  readonly runGroupId: string;
  readonly sessionId: string;
  readonly runOrdinal: number;
  readonly inspectorVisible: boolean;
  readonly gpuCounterSampleInterval: number;
  readonly readbackRingSlots: number;
  readonly cpuPassTimings: boolean;
  readonly awaitGpuEachFrame: boolean;
  readonly animateScene: boolean;
}

export interface RenderingLabCameraSegmentStats {
  readonly caseId: string;
  readonly segment: string;
  readonly sampleCount: number;
  readonly stableSampleCount: number;
  readonly cutFrameCount: number;
  readonly cpuMs: TimingStats | null;
  readonly gpuPhaseMs: TimingStats | null;
}

interface TimingStats {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface RenderingLabFeatureOffGate {
  readonly feature: string;
  readonly fullCaseId: string;
  readonly variantCaseId: string;
  readonly fullPassEvidence: readonly string[];
  readonly variantPassEvidence: readonly string[];
  readonly status: "pass" | "fail" | "insufficient-evidence";
  readonly reason: string;
}

export interface RenderingLabTriangleSetupEvidence {
  readonly schemaVersion: 1;
  readonly cases: Readonly<Record<string, RenderingLabTriangleSetupCaseEvidence>>;
  readonly workCacheBytes: number | null;
  readonly workCachePeakBytes: number | null;
}

export interface RenderingLabTriangleSetupCaseEvidence {
  /** Frames with a completed GPU counter readback, including zero-valued fields. */
  readonly counterFrames: number;
  /** Number of completed frames that actually exposed each M5 counter field. */
  readonly fieldFrames: Readonly<Record<string, number>>;
  readonly setupAttempted: number;
  readonly setupWritten: number;
  readonly setupVisiblePixelHits: number;
  readonly setupVisiblePixelFallbacks: number;
  readonly setupOverflow: number;
  readonly visiblePixelSamples: number;
  /** Null means this capture did not expose both visible-pixel counters. */
  readonly visibleHitRatio: number | null;
}

export interface RenderingLabSurfaceAbiEvidence {
  readonly schemaVersion: 1;
  readonly activeAbiVersion: number;
  readonly activeAbiProfile: "v1" | "v2-candidate" | "unknown";
  readonly candidateContractVersion: number;
  readonly promotionGate: typeof GPU_SURFACE_ABI_V2_CANDIDATE_SCHEMA.promotionGate;
  readonly cases: Readonly<Record<string, RenderingLabSurfaceAbiCaseEvidence>>;
  readonly candidateLayout: Readonly<{
    readonly schemaVersion: 2;
    readonly normalFormat: string;
    readonly normalEncodingMaxValue: number;
    readonly normalEncodingScheme: string;
    readonly baselineBytesPerPixelWithVelocity: number;
    readonly candidateBytesPerPixelWithVelocity: number;
    readonly baselineBytesPerPixelWithoutVelocity: number;
    readonly candidateBytesPerPixelWithoutVelocity: number;
  }>;
  /** M6 remains evidence-gated; absent candidate artifacts are explicit. */
  readonly v2Gate: SurfaceAbiDecision;
}

export interface RenderingLabSurfaceAbiCaseEvidence {
  readonly surfaceBytesPerPixel: BenchmarkSeriesTiming | null;
  readonly surfaceAttachmentBytes: BenchmarkSeriesTiming | null;
  readonly residentBytes: BenchmarkSeriesTiming | null;
  readonly classDepthMs: BenchmarkSeriesTiming | null;
  readonly resolveMs: BenchmarkSeriesTiming | null;
}

interface BenchmarkSeriesTiming {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly sampleCount: number;
}

export function buildRenderingLabBenchmarkReport(input: {
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly environment: BenchmarkEnvironmentManifest;
  readonly workload: Readonly<Record<string, unknown>>;
  readonly cameraSweep: readonly CameraSweepCase[];
  readonly cameraPathId: string;
  readonly cases: readonly BenchmarkResult[];
  readonly domainEvidence?: Readonly<Record<string, unknown>>;
  readonly errors?: readonly string[];
  readonly measurement?: RenderingLabMeasurementProfile;
}): RenderingLabBenchmarkReport {
  const full = input.cases.find((result) => result.case.id === "full");
  const base = input.cases.find((result) => result.case.id === "base");
  const variants = input.cases.filter((result) => result !== full);
  const comparisons: BenchmarkComparison[] = [];
  if (full !== undefined && variants.length > 0) comparisons.push(compareBenchmarkResults(full, variants));
  if (base !== undefined && full !== undefined) comparisons.push(compareBenchmarkResults(base, [full]));
  const errors = Object.freeze([...(input.errors ?? [])]);
  const evidence: Record<string, BenchmarkEvidenceReport> = {};
  for (const result of input.cases) evidence[result.case.id] = validateBenchmarkEvidence(result);
  const featureOffGates = buildFeatureOffGates(input.cases);
  const cameraSegments = input.cases.flatMap((result) => buildCameraSegmentStats(result));
  return Object.freeze({
    schemaVersion: 1,
    status: errors.length === 0 && input.cases.length > 0 ? "complete" : "incomplete",
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? new Date().toISOString(),
    environment: input.environment,
    workload: input.workload,
    camera: Object.freeze({
      sweep: Object.freeze([...input.cameraSweep]),
      pathId: input.cameraPathId,
      segments: Object.freeze(cameraSegments)
    }),
    cases: Object.freeze([...input.cases]),
    comparisons: Object.freeze(comparisons),
    evidence: Object.freeze(evidence),
    featureOffGates: Object.freeze(featureOffGates),
    domainEvidence: Object.freeze({
      ...(input.domainEvidence ?? {}),
      triangleSetup: buildTriangleSetupEvidence(input.cases, input.domainEvidence),
      surfaceAbi: buildSurfaceAbiEvidence(input.cases, input.domainEvidence),
      migrationGates: buildMigrationGates(input.domainEvidence),
      tileBackendModel: buildTileBackendModelEvidence(input.domainEvidence)
    }),
    errors,
    ...(input.measurement === undefined ? {} : { measurement: Object.freeze({ ...input.measurement }) })
  });
}

function buildTriangleSetupEvidence(
  cases: readonly BenchmarkResult[],
  domainEvidence?: Readonly<Record<string, unknown>>
): RenderingLabTriangleSetupEvidence {
  const byCase: Record<string, RenderingLabTriangleSetupCaseEvidence> = {};
  for (const result of cases) byCase[result.case.id] = summarizeTriangleSetupCase(result);
  const category = resourceCategory(domainEvidence, "work-cache");
  return Object.freeze({
    schemaVersion: 1,
    cases: Object.freeze(byCase),
    workCacheBytes: category?.bytes ?? null,
    workCachePeakBytes: category?.peakBytes ?? null
  });
}

function summarizeTriangleSetupCase(result: BenchmarkResult): RenderingLabTriangleSetupCaseEvidence {
  const names = [
    "setupAttempted",
    "setupWritten",
    "setupVisiblePixelHits",
    "setupVisiblePixelFallbacks",
    "setupOverflow"
  ] as const;
  const totals: Record<string, number> = Object.fromEntries(names.map((name) => [name, 0]));
  const fieldFrames: Record<string, number> = Object.fromEntries(names.map((name) => [name, 0]));
  let counterFrames = 0;
  for (const frame of result.frames) {
    if (!frame.gpuCounters.sampled || frame.gpuCounters.pending || frame.gpuCounters.dropped) continue;
    counterFrames++;
    const values = frame.gpuCounters.values as Record<string, unknown>;
    for (const name of names) {
      const value = values[name];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      totals[name]! += value;
      fieldFrames[name]!++;
    }
  }
  const visiblePixelSamples = totals.setupVisiblePixelHits! + totals.setupVisiblePixelFallbacks!;
  return Object.freeze({
    counterFrames,
    fieldFrames: Object.freeze(fieldFrames),
    setupAttempted: totals.setupAttempted!,
    setupWritten: totals.setupWritten!,
    setupVisiblePixelHits: totals.setupVisiblePixelHits!,
    setupVisiblePixelFallbacks: totals.setupVisiblePixelFallbacks!,
    setupOverflow: totals.setupOverflow!,
    visiblePixelSamples,
    visibleHitRatio: visiblePixelSamples > 0
      ? totals.setupVisiblePixelHits! / visiblePixelSamples
      : null
  });
}

function buildSurfaceAbiEvidence(
  cases: readonly BenchmarkResult[],
  domainEvidence?: Readonly<Record<string, unknown>>
): RenderingLabSurfaceAbiEvidence {
  const byCase: Record<string, RenderingLabSurfaceAbiCaseEvidence> = {};
  for (const result of cases) {
    const counters = result.summary.counters;
    byCase[result.case.id] = {
      surfaceBytesPerPixel: summaryTiming(counters["packed.material.surfaceBytesPerPixel"]),
      surfaceAttachmentBytes: summaryTiming(counters["packed.material.surfaceAttachmentBytes"]),
      residentBytes: summaryTiming(counters["gpu.residentBytes"]),
      classDepthMs: summaryTiming(result.summary.surfacePhaseMs.classDepth),
      resolveMs: summaryTiming(result.summary.surfacePhaseMs.resolve)
    };
  }
  const runs = readSurfaceAbiRuns(domainEvidence);
  const migration = migrationEvidence(domainEvidence);
  return Object.freeze({
    schemaVersion: 1,
    activeAbiVersion: migration?.surfaceAbiVersion ?? GPU_SURFACE_ABI_VERSION,
    activeAbiProfile: migration?.surfaceAbiProfile ?? "unknown",
    candidateContractVersion: GPU_SURFACE_ABI_V2_CANDIDATE_SCHEMA.version,
    promotionGate: GPU_SURFACE_ABI_V2_CANDIDATE_SCHEMA.promotionGate,
    cases: Object.freeze(byCase),
    candidateLayout: Object.freeze({
      schemaVersion: 2 as const,
      normalFormat: GPU_SURFACE_ABI_V2_CANDIDATE_SCHEMA.formats.normal,
      normalEncodingMaxValue: GPU_SURFACE_ABI_V2_CANDIDATE_SCHEMA.normalEncoding.maxValue,
      normalEncodingScheme: GPU_SURFACE_ABI_V2_CANDIDATE_SCHEMA.normalEncoding.scheme,
      baselineBytesPerPixelWithVelocity: gpuSurfaceBytesPerPixel({ velocity: true }),
      candidateBytesPerPixelWithVelocity: gpuSurfaceCandidateBytesPerPixel({ velocity: true }),
      baselineBytesPerPixelWithoutVelocity: gpuSurfaceBytesPerPixel({ velocity: false }),
      candidateBytesPerPixelWithoutVelocity: gpuSurfaceCandidateBytesPerPixel({ velocity: false })
    }),
    v2Gate: runs === null
      ? Object.freeze({
        status: "insufficient-evidence",
        reason: "no identity-bearing Surface ABI candidate run group was supplied"
      })
      : evaluateSurfaceAbiV2RunGroupNeed(runs)
  });
}

function migrationEvidence(
  domainEvidence?: Readonly<Record<string, unknown>>
): { readonly surfaceAbiVersion: number; readonly surfaceAbiProfile: "v1" | "v2-candidate" } | null {
  const migration = domainEvidence?.migration;
  if (typeof migration !== "object" || migration === null || Array.isArray(migration)) return null;
  const value = migration as {
    readonly surfaceAbiVersion?: unknown;
    readonly surfaceAbiProfile?: unknown;
  };
  if (
    typeof value.surfaceAbiVersion !== "number" ||
    !Number.isInteger(value.surfaceAbiVersion) ||
    value.surfaceAbiVersion <= 0 ||
    (value.surfaceAbiProfile !== "v1" && value.surfaceAbiProfile !== "v2-candidate")
  ) return null;
  return {
    surfaceAbiVersion: value.surfaceAbiVersion,
    surfaceAbiProfile: value.surfaceAbiProfile
  };
}

interface RenderingLabMigrationGates {
  readonly schemaVersion: 1;
  readonly surfaceAbiV2: SurfaceAbiDecision;
  readonly tileBackend: TileBackendDecision;
}

function buildMigrationGates(
  domainEvidence?: Readonly<Record<string, unknown>>
): RenderingLabMigrationGates {
  const surfaceRuns = readSurfaceAbiRuns(domainEvidence);
  const tileRuns = readTileBackendRuns(domainEvidence);
  return Object.freeze({
    schemaVersion: 1,
    surfaceAbiV2: surfaceRuns === null
      ? Object.freeze({
        status: "insufficient-evidence",
        reason: "M6 candidate artifacts are not present; keep Surface ABI v1"
      })
      : evaluateSurfaceAbiV2RunGroupNeed(surfaceRuns),
    tileBackend: tileRuns === null
      ? Object.freeze({
        status: "insufficient-evidence",
        reason: "M7 requires identity-bearing runs from at least two GPU vendors"
      })
      : evaluateTileBackendRunGroupNeed(tileRuns)
  });
}

function buildTileBackendModelEvidence(
  domainEvidence?: Readonly<Record<string, unknown>>
): TileBackendCostModelResult | Readonly<{ status: "not-sampled"; reason: string }> {
  const raw = domainEvidence?.tileBackendModelInput;
  if (!isTileBackendModelInput(raw)) {
    return Object.freeze({
      status: "not-sampled",
      reason: "tile backend model input was not supplied"
    });
  }
  return modelTileBackendCost(raw);
}

function isTileBackendModelInput(value: unknown): value is TileBackendCostModelInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Partial<TileBackendCostModelInput>;
  return Number.isInteger(input.width) && input.width! > 0 &&
    Number.isInteger(input.height) && input.height! > 0 &&
    (input.tileSize === 16 || input.tileSize === 32 || input.tileSize === 64) &&
    Array.isArray(input.classIds) &&
    Number.isInteger(input.tileCapacity) && input.tileCapacity! >= 0;
}

function readSurfaceAbiRuns(
  domainEvidence?: Readonly<Record<string, unknown>>
): readonly SurfaceAbiRunEvidence[] | null {
  const value = domainEvidence?.surfaceAbiRuns;
  return Array.isArray(value) ? value as readonly SurfaceAbiRunEvidence[] : null;
}

function readTileBackendRuns(
  domainEvidence?: Readonly<Record<string, unknown>>
): readonly TileBackendVendorRunEvidence[] | null {
  const value = domainEvidence?.tileBackendRuns;
  return Array.isArray(value) ? value as readonly TileBackendVendorRunEvidence[] : null;
}

function summaryTiming(
  value: { readonly p50: number; readonly p95: number; readonly p99: number; readonly count: number } | undefined
): BenchmarkSeriesTiming | null {
  if (value === undefined || value.count <= 0) return null;
  return Object.freeze({ p50: value.p50, p95: value.p95, p99: value.p99, sampleCount: value.count });
}

function resourceCategory(
  domainEvidence: Readonly<Record<string, unknown>> | undefined,
  name: string
): { readonly bytes: number; readonly peakBytes: number } | null {
  const accounting = domainEvidence?.resourceAccounting;
  if (typeof accounting !== "object" || accounting === null) return null;
  const categories = (accounting as { readonly categories?: unknown }).categories;
  if (typeof categories !== "object" || categories === null) return null;
  const value = (categories as Record<string, unknown>)[name];
  if (typeof value !== "object" || value === null) return null;
  const bytes = (value as { readonly bytes?: unknown }).bytes;
  const peakBytes = (value as { readonly peakBytes?: unknown }).peakBytes;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) ||
      typeof peakBytes !== "number" || !Number.isFinite(peakBytes)) return null;
  return { bytes, peakBytes };
}

function buildCameraSegmentStats(result: BenchmarkResult): readonly RenderingLabCameraSegmentStats[] {
  const bySegment = new Map<string, { frames: typeof result.frames[number][]; cutFrames: number }>();
  result.frames.forEach((frame, index) => {
    const camera = asCameraMetadata(frame.metadata);
    const segment = typeof camera?.segment === "string" ? camera.segment : "unknown";
    const entry = bySegment.get(segment) ?? { frames: [], cutFrames: 0 };
    entry.frames.push(frame);
    if (camera?.cutId !== null && camera?.cutId !== undefined) entry.cutFrames++;
    bySegment.set(segment, entry);
  });
  return Object.freeze([...bySegment.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([segment, entry]) => {
    const stable = entry.frames.filter((frame, index) => {
      const camera = asCameraMetadata(frame.metadata);
      if (camera?.cutId !== null && camera?.cutId !== undefined) return false;
      // Exclude a short post-cut settling window even when the cut marker only
      // exists on the exact cut frame. This is analysis-only; raw frames stay
      // intact in the report for replay and auditing.
      for (let offset = Math.max(0, index - 4); offset <= Math.min(entry.frames.length - 1, index + 4); offset++) {
        const nearby = asCameraMetadata(entry.frames[offset]?.metadata);
        if (nearby?.cutId !== null && nearby?.cutId !== undefined) return false;
      }
      return true;
    });
    const cpu = stable.map((frame) => frame.cpuMs.frame).filter(isFiniteNumber);
    const gpu = stable
      .filter((frame) => frame.gpu.sampled && !frame.gpu.pending && !frame.gpuCounters.sampled)
      .map((frame) => frame.gpu.segments
        .filter((segment) => segment.phase === "frame")
        .reduce((sum, segment) => sum + segment.durationMs, 0))
      .filter(isFiniteNumber);
    return {
      caseId: result.case.id,
      segment,
      sampleCount: entry.frames.length,
      stableSampleCount: stable.length,
      cutFrameCount: entry.cutFrames,
      cpuMs: summarize(cpu),
      gpuPhaseMs: summarize(gpu)
    };
  }));
}

function asCameraMetadata(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | null {
  if (value === undefined || typeof value.camera !== "object" || value.camera === null) return null;
  return value.camera as Readonly<Record<string, unknown>>;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function summarize(values: readonly number[]): TimingStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

function buildFeatureOffGates(
  cases: readonly BenchmarkResult[]
): readonly RenderingLabFeatureOffGate[] {
  const full = cases.find((result) => result.case.id === "full");
  if (full === undefined) return Object.freeze([]);
  const variants: readonly [string, string][] = [
    ["shadow", "full-minus-shadow"],
    ["gtao", "full-minus-gtao"],
    ["ssr", "full-minus-ssr"],
    ["transparency", "full-minus-transparency"],
    ["temporal", "full-minus-temporal"],
    ["bloom", "full-minus-bloom"],
    ["automatic-exposure", "full-minus-exposure"],
    ["motion-blur", "full-minus-motion-blur"],
    ["sharpening", "full-minus-sharpen"]
  ];
  return Object.freeze(variants.map(([feature, variantCaseId]): RenderingLabFeatureOffGate => {
    const variant = cases.find((result) => result.case.id === variantCaseId);
    if (variant === undefined) {
      return {
        feature, fullCaseId: full.case.id, variantCaseId,
        fullPassEvidence: [], variantPassEvidence: [],
        status: "insufficient-evidence",
        reason: "variant case was not completed"
      };
    }
    const fullPassEvidence = passLabels(full);
    const variantPassEvidence = passLabels(variant);
    const needles = featurePassNeedles(feature);
    const fullActive = fullPassEvidence.some((label) => needles.some((needle) => label.includes(needle)));
    const variantActive = variantPassEvidence.some((label) => needles.some((needle) => label.includes(needle)));
    const status = fullActive && !variantActive ? "pass" : fullActive && variantActive ? "fail" : "insufficient-evidence";
    return {
      feature, fullCaseId: full.case.id, variantCaseId,
      fullPassEvidence, variantPassEvidence, status,
      reason: status === "pass"
        ? "full has feature-owned GPU labels and the minus case has none"
        : status === "fail"
          ? "feature-owned GPU labels remain in the minus case"
          : "full feature labels were not observed in the sampled frames"
    };
  }));
}

function passLabels(result: BenchmarkResult): readonly string[] {
  return Object.freeze([...new Set(result.frames.flatMap((frame) => frame.gpu.segments.map((segment) => segment.label)))].sort());
}

function featurePassNeedles(feature: string): readonly string[] {
  switch (feature) {
    case "shadow": return ["FX-04", "Shadow"];
    case "gtao": return ["GTAO", "SSAO"];
    case "ssr": return ["SSR"];
    case "transparency": return ["FX-05", "MBOIT", "Transparent"];
    case "temporal": return ["FX-06B", "TAA", "Temporal sampled"];
    case "bloom": return ["Bloom"];
    case "automatic-exposure": return ["Automatic exposure"];
    case "motion-blur": return ["Motion blur"];
    case "sharpening": return ["Sharpen"];
    default: return [feature];
  }
}

export function serializeRenderingLabBenchmarkReport(report: RenderingLabBenchmarkReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function downloadRenderingLabBenchmarkReport(report: RenderingLabBenchmarkReport): void {
  const blob = new Blob([serializeRenderingLabBenchmarkReport(report)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `oengine-rendering-lab-${report.status}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function caseLabel(caseId: RenderingLabCaseId): string {
  return caseId.replaceAll("-", " ");
}
