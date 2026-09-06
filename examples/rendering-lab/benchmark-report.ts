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
  readonly inspectorVisible: boolean;
  readonly gpuCounterSampleInterval: number;
  readonly readbackRingSlots: number;
  readonly awaitGpuEachFrame: boolean;
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
    domainEvidence: input.domainEvidence ?? Object.freeze({}),
    errors,
    ...(input.measurement === undefined ? {} : { measurement: Object.freeze({ ...input.measurement }) })
  });
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
