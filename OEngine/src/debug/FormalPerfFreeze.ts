/**
 * ADR-0018 Phase K formal-performance freeze contract.
 *
 * This module is deliberately renderer-neutral. The browser host supplies the
 * frozen identity and measured samples; the helper only validates provenance,
 * metric availability, and the aggregation rules used by a formal report.
 */

export const FORMAL_PERF_FREEZE_SCHEMA_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const CHROME_CHANNEL = "chrome-stable" as const;

export interface FormalPerfBrowserV1 {
  readonly channel: typeof CHROME_CHANNEL;
  readonly version: string;
  readonly executableSha256: string;
  readonly userAgent: string;
}

export interface FormalPerfAdapterV1 {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

export interface FormalPerfCapabilityV1 {
  readonly featureSet: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly timestampQuery: boolean;
}

export interface FormalPerfResolutionV1 {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly renderScale: number;
}

export interface FormalPerfCameraPathV1 {
  readonly id: string;
  readonly sha256: string;
}

export interface FormalPerfWorkloadIdentityV1 {
  readonly id: string;
  readonly sha256: string;
  readonly sourceSha256: string;
  readonly sourceTriangles: number;
}

export interface FormalPerfFreezeV1 {
  readonly schemaVersion: typeof FORMAL_PERF_FREEZE_SCHEMA_VERSION;
  readonly commit: string;
  readonly tree: string;
  readonly dirty: boolean;
  readonly browser: FormalPerfBrowserV1;
  readonly adapter: FormalPerfAdapterV1;
  readonly capability: FormalPerfCapabilityV1;
  readonly resolution: FormalPerfResolutionV1;
  readonly cameraPath: FormalPerfCameraPathV1;
  readonly featureSet: readonly string[];
  readonly workload: FormalPerfWorkloadIdentityV1;
}

export interface FormalPerfOwnerPeaksV1 {
  readonly sourceBytes: number;
  readonly wasmBytes: number;
  readonly jsBytes: number;
  readonly gpuGeometryBytes: number;
}

export interface FormalPerfPageCountersV1 {
  readonly demand: number;
  readonly churn: number;
  readonly overflow: number;
}

export interface FormalPerfCameraCutV1 {
  readonly triggered: boolean;
  readonly recoveryMs: number | null;
  readonly recoveryFrames: number | null;
}

export interface FormalPerfSampleV1 {
  readonly frameIndex: number;
  readonly cpuMs: Readonly<{
    frame: number;
    build: number;
    submit: number;
  }>;
  /** Null is allowed only when the frozen capability has no timestamp query. */
  readonly gpuMs: number | null;
  readonly ownerPeaks: FormalPerfOwnerPeaksV1;
  readonly pages: FormalPerfPageCountersV1;
  readonly cameraCut: FormalPerfCameraCutV1;
}

export interface FormalPerfRunV1 {
  readonly freeze: FormalPerfFreezeV1;
  readonly ttfmfMs: number;
  readonly gpuTimestampAvailable: boolean;
  readonly samples: readonly FormalPerfSampleV1[];
}

export interface FormalPerfSeriesV1 {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
}

export interface FormalPerfSummaryV1 {
  readonly schemaVersion: typeof FORMAL_PERF_FREEZE_SCHEMA_VERSION;
  readonly freeze: FormalPerfFreezeV1;
  readonly independentRuns: number;
  readonly ttfmfMs: FormalPerfSeriesV1;
  readonly cpuMs: Readonly<Record<"frame" | "build" | "submit", FormalPerfSeriesV1>>;
  readonly gpuMs: FormalPerfSeriesV1 | null;
  readonly ownerPeaks: FormalPerfOwnerPeaksV1;
  readonly pages: Readonly<Record<"demand" | "churn" | "overflow", FormalPerfSeriesV1>>;
  readonly cameraCutRecoveryMs: FormalPerfSeriesV1 | null;
  readonly cameraCutRecoveryFrames: FormalPerfSeriesV1 | null;
}

export interface FormalPerfValidationOptionsV1 {
  readonly requireClean?: boolean;
  readonly requireGpuTimestamps?: boolean;
  readonly minimumSamples?: number;
}

export function validateFormalPerfFreeze(
  freeze: FormalPerfFreezeV1,
  options: FormalPerfValidationOptionsV1 = {},
): readonly string[] {
  const errors: string[] = [];
  if (freeze?.schemaVersion !== FORMAL_PERF_FREEZE_SCHEMA_VERSION) errors.push("schemaVersion must be 1");
  if (!GIT_SHA.test(freeze?.commit ?? "")) errors.push("commit must be a 40-character lowercase git SHA");
  if (!GIT_SHA.test(freeze?.tree ?? "")) errors.push("tree must be a 40-character lowercase git tree SHA");
  if (options.requireClean === true && freeze?.dirty !== false)
    errors.push("formal evidence requires a clean revision");
  if (!freeze?.browser || freeze.browser.channel !== CHROME_CHANNEL)
    errors.push("browser channel must be chrome-stable");
  if (!nonEmptyString(freeze?.browser?.version)) errors.push("browser version is required");
  if (!SHA256.test(freeze?.browser?.executableSha256 ?? ""))
    errors.push("browser executable hash must be SHA-256");
  if (!nonEmptyString(freeze?.browser?.userAgent)) errors.push("browser userAgent is required");
  for (const [name, value] of Object.entries(freeze?.adapter ?? {})) {
    if (!nonEmptyString(value)) errors.push(`adapter ${name} is required`);
  }
  if (
    !freeze?.capability ||
    !Array.isArray(freeze.capability.featureSet) ||
    !sortedUniqueStrings(freeze.capability.featureSet)
  ) {
    errors.push("capability featureSet must be a sorted, unique string array");
  }
  if (!freeze?.capability || !recordOfFiniteNumbers(freeze.capability.limits)) {
    errors.push("capability limits must contain finite numeric values");
  }
  if (typeof freeze?.capability?.timestampQuery !== "boolean")
    errors.push("capability timestampQuery must be boolean");
  if (!freeze?.capability?.timestampQuery && options.requireGpuTimestamps === true) {
    errors.push("formal workload requires timestamp-query capability");
  }
  const resolution = freeze?.resolution;
  if (!positiveInteger(resolution?.width) || !positiveInteger(resolution?.height)) {
    errors.push("resolution width and height must be positive integers");
  }
  if (
    !positiveFinite(resolution?.devicePixelRatio) ||
    !positiveFinite(resolution?.renderScale) ||
    resolution.renderScale > 1
  ) {
    errors.push("resolution DPR/renderScale is invalid");
  }
  if (!nonEmptyString(freeze?.cameraPath?.id) || !SHA256.test(freeze?.cameraPath?.sha256 ?? "")) {
    errors.push("camera path id and SHA-256 are required");
  }
  if (!sortedUniqueStrings(freeze?.featureSet ?? []))
    errors.push("featureSet must be a sorted, unique string array");
  if (JSON.stringify(freeze?.featureSet ?? []) !== JSON.stringify(freeze?.capability?.featureSet ?? [])) {
    errors.push("frozen featureSet must match capability.featureSet");
  }
  const workload = freeze?.workload;
  if (
    !nonEmptyString(workload?.id) ||
    !SHA256.test(workload?.sha256 ?? "") ||
    !SHA256.test(workload?.sourceSha256 ?? "") ||
    !positiveInteger(workload?.sourceTriangles)
  ) {
    errors.push("workload identity, source hash, and source triangle count are required");
  }
  return Object.freeze(errors);
}

export function assertFormalPerfFreeze(
  freeze: FormalPerfFreezeV1,
  options: FormalPerfValidationOptionsV1 = {},
): FormalPerfFreezeV1 {
  const errors = validateFormalPerfFreeze(freeze, options);
  if (errors.length > 0) throw new Error(`Invalid formal PERF freeze:\n${errors.join("\n")}`);
  return freeze;
}

export function validateFormalPerfRun(
  run: FormalPerfRunV1,
  options: FormalPerfValidationOptionsV1 = {},
): readonly string[] {
  const errors = [...validateFormalPerfFreeze(run.freeze, options)];
  if (!positiveFinite(run?.ttfmfMs)) errors.push("TTFMF must be finite and positive");
  if (run?.gpuTimestampAvailable !== run?.freeze?.capability?.timestampQuery) {
    errors.push("run GPU timestamp availability does not match frozen capability");
  }
  const minimumSamples = options.minimumSamples ?? 1;
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples <= 0)
    errors.push("minimumSamples must be positive");
  if (!Array.isArray(run?.samples) || run.samples.length < minimumSamples) {
    errors.push(`run requires at least ${minimumSamples} measured samples`);
  }
  const frames = new Set<number>();
  for (const sample of run?.samples ?? []) {
    if (!positiveInteger(sample?.frameIndex) || frames.has(sample.frameIndex))
      errors.push("sample frameIndex must be a unique positive integer");
    frames.add(sample?.frameIndex);
    for (const [name, value] of Object.entries(sample?.cpuMs ?? {}))
      if (!nonNegativeFinite(value)) errors.push(`cpuMs.${name} must be finite and non-negative`);
    if (sample?.gpuMs !== null && !nonNegativeFinite(sample?.gpuMs))
      errors.push("gpuMs must be null or finite and non-negative");
    if (run?.gpuTimestampAvailable && sample?.gpuMs === null)
      errors.push("timestamp-enabled samples cannot omit gpuMs");
    if (!run?.gpuTimestampAvailable && sample?.gpuMs !== null)
      errors.push("timestamp-unavailable samples must omit gpuMs");
    validateOwnerPeaks(sample?.ownerPeaks, errors);
    validatePageCounters(sample?.pages, errors);
    validateCameraCut(sample?.cameraCut, errors);
  }
  return Object.freeze(errors);
}

export function assertFormalPerfRun(
  run: FormalPerfRunV1,
  options: FormalPerfValidationOptionsV1 = {},
): FormalPerfRunV1 {
  const errors = validateFormalPerfRun(run, options);
  if (errors.length > 0) throw new Error(`Invalid formal PERF run:\n${errors.join("\n")}`);
  return run;
}

export function aggregateFormalPerfRuns(
  runs: readonly FormalPerfRunV1[],
  options: FormalPerfValidationOptionsV1 = {},
): FormalPerfSummaryV1 {
  if (runs.length === 0) throw new RangeError("Formal PERF requires at least one independent run");
  runs.forEach((run) => assertFormalPerfRun(run, options));
  const first = runs[0]!.freeze;
  const firstIdentity = freezeIdentity(first);
  for (const run of runs.slice(1)) {
    if (freezeIdentity(run.freeze) !== firstIdentity)
      throw new Error("independent runs do not share one frozen identity");
  }
  const samples = runs.flatMap((run) => run.samples);
  const cpuMs = {
    frame: summarize(samples.map((sample) => sample.cpuMs.frame)),
    build: summarize(samples.map((sample) => sample.cpuMs.build)),
    submit: summarize(samples.map((sample) => sample.cpuMs.submit)),
  };
  const gpuValues = samples.map((sample) => sample.gpuMs).filter((value): value is number => value !== null);
  const cameraMs = samples
    .map((sample) => sample.cameraCut.recoveryMs)
    .filter((value): value is number => value !== null);
  const cameraFrames = samples
    .map((sample) => sample.cameraCut.recoveryFrames)
    .filter((value): value is number => value !== null);
  return Object.freeze({
    schemaVersion: FORMAL_PERF_FREEZE_SCHEMA_VERSION,
    freeze: first,
    independentRuns: runs.length,
    ttfmfMs: summarize(runs.map((run) => run.ttfmfMs)),
    cpuMs: Object.freeze(cpuMs),
    gpuMs: gpuValues.length > 0 ? summarize(gpuValues) : null,
    ownerPeaks: Object.freeze({
      sourceBytes: Math.max(...samples.map((sample) => sample.ownerPeaks.sourceBytes)),
      wasmBytes: Math.max(...samples.map((sample) => sample.ownerPeaks.wasmBytes)),
      jsBytes: Math.max(...samples.map((sample) => sample.ownerPeaks.jsBytes)),
      gpuGeometryBytes: Math.max(...samples.map((sample) => sample.ownerPeaks.gpuGeometryBytes)),
    }),
    pages: Object.freeze({
      demand: summarize(samples.map((sample) => sample.pages.demand)),
      churn: summarize(samples.map((sample) => sample.pages.churn)),
      overflow: summarize(samples.map((sample) => sample.pages.overflow)),
    }),
    cameraCutRecoveryMs: cameraMs.length > 0 ? summarize(cameraMs) : null,
    cameraCutRecoveryFrames: cameraFrames.length > 0 ? summarize(cameraFrames) : null,
  });
}

export function formalPerfFreezeIdentity(freeze: FormalPerfFreezeV1): string {
  return freezeIdentity(freeze);
}

export function summarizeFormalSeries(values: readonly number[]): FormalPerfSeriesV1 {
  return summarize(values);
}

function freezeIdentity(freeze: FormalPerfFreezeV1): string {
  return JSON.stringify({
    schemaVersion: freeze.schemaVersion,
    commit: freeze.commit,
    tree: freeze.tree,
    dirty: freeze.dirty,
    browser: freeze.browser,
    adapter: freeze.adapter,
    capability: freeze.capability,
    resolution: freeze.resolution,
    cameraPath: freeze.cameraPath,
    featureSet: freeze.featureSet,
    workload: freeze.workload,
  });
}

function summarize(values: readonly number[]): FormalPerfSeriesV1 {
  if (values.length === 0) throw new RangeError("Cannot summarize an empty formal PERF series");
  const sorted = [...values].sort((left, right) => left - right);
  return Object.freeze({
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  });
}

function percentile(sorted: readonly number[], quantile: number): number {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower));
}

function validateOwnerPeaks(value: FormalPerfOwnerPeaksV1 | undefined, errors: string[]): void {
  for (const [name, bytes] of Object.entries(value ?? {}))
    if (!nonNegativeFinite(bytes) || !Number.isInteger(bytes))
      errors.push(`ownerPeaks.${name} must be a non-negative integer`);
  for (const name of ["sourceBytes", "wasmBytes", "jsBytes", "gpuGeometryBytes"])
    if (!(name in (value ?? {}))) errors.push(`ownerPeaks.${name} is required`);
}

function validatePageCounters(value: FormalPerfPageCountersV1 | undefined, errors: string[]): void {
  for (const [name, count] of Object.entries(value ?? {}))
    if (!nonNegativeFinite(count) || !Number.isInteger(count))
      errors.push(`pages.${name} must be a non-negative integer`);
  for (const name of ["demand", "churn", "overflow"])
    if (!(name in (value ?? {}))) errors.push(`pages.${name} is required`);
}

function validateCameraCut(value: FormalPerfCameraCutV1 | undefined, errors: string[]): void {
  if (value === undefined) {
    errors.push("cameraCut is required");
    return;
  }
  if (typeof value.triggered !== "boolean") errors.push("cameraCut.triggered must be boolean");
  if (value.recoveryMs !== null && !nonNegativeFinite(value.recoveryMs))
    errors.push("cameraCut.recoveryMs must be null or non-negative");
  if (
    value.recoveryFrames !== null &&
    (!Number.isSafeInteger(value.recoveryFrames) || value.recoveryFrames < 0)
  )
    errors.push("cameraCut.recoveryFrames must be null or a non-negative integer");
  if (value.triggered && (value.recoveryMs === null || value.recoveryFrames === null))
    errors.push("camera-cut samples must record recovery metrics");
  if (!value.triggered && (value.recoveryMs !== null || value.recoveryFrames !== null))
    errors.push("non-cut samples cannot record camera-cut recovery");
}

function sortedUniqueStrings(value: readonly string[] | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => nonEmptyString(item)) &&
    value.every((item, index) => index === 0 || value[index - 1]! < item)
  );
}

function recordOfFiniteNumbers(value: Readonly<Record<string, number>> | undefined): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => Number.isFinite(item) && item >= 0)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function round(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}
