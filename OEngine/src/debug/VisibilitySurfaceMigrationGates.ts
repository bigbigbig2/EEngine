/** Evidence-only decisions for the late Visibility→Surface migration phases. */

export type SurfaceAbiDecision =
  | Readonly<{ status: "insufficient-evidence"; reason: string }>
  | Readonly<{ status: "rejected-by-evidence"; reason: string; bytesSavedPerPixel: number }>
  | Readonly<{ status: "required"; reason: string; bytesSavedPerPixel: number }>;

export interface TriangleSetupRunEvidence {
  /** Stable identity from the benchmark artifact; prevents counting duplicate captures as independent runs. */
  readonly runId?: string;
  readonly runGroupId?: string;
  readonly setupVisiblePixelHits: number;
  readonly setupVisiblePixelFallbacks: number;
  readonly setupAttempted: number;
  readonly setupWritten: number;
  readonly setupOverflow: number;
}

export type TriangleSetupDecision =
  | Readonly<{ status: "insufficient-evidence"; reason: string }>
  | Readonly<{ status: "disabled-by-evidence"; reason: string; hitRatios: readonly number[] }>
  | Readonly<{ status: "default-eligible"; reason: string; hitRatios: readonly number[] }>;

/** M5 Gate: candidate cache may become default only after three stable runs. */
export function evaluateTriangleSetupDefaultNeed(
  runs: readonly TriangleSetupRunEvidence[],
  minimumHitRatio = 0.9
): TriangleSetupDecision {
  if (!Number.isFinite(minimumHitRatio) || minimumHitRatio <= 0 || minimumHitRatio > 1) {
    return Object.freeze({ status: "insufficient-evidence", reason: "invalid minimum hit ratio" });
  }
  if (runs.length < 3) {
    return Object.freeze({ status: "insufficient-evidence", reason: "requires three independent runs" });
  }
  const identities = runs.map((run) => `${run.runGroupId ?? ""}\u0000${run.runId ?? ""}`);
  if (
    runs.some((run) => !nonEmptyIdentity(run.runId) || !nonEmptyIdentity(run.runGroupId)) ||
    new Set(identities).size !== identities.length
  ) {
    return Object.freeze({ status: "insufficient-evidence", reason: "each run requires a unique runId and runGroupId" });
  }
  const ratios: number[] = [];
  for (const run of runs) {
    const values = [
      run.setupVisiblePixelHits,
      run.setupVisiblePixelFallbacks,
      run.setupAttempted,
      run.setupWritten,
      run.setupOverflow
    ];
    if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
      return Object.freeze({ status: "insufficient-evidence", reason: "counter values must be non-negative integers" });
    }
    const visible = run.setupVisiblePixelHits + run.setupVisiblePixelFallbacks;
    if (visible <= 0) {
      return Object.freeze({ status: "insufficient-evidence", reason: "run has no visible setup evidence" });
    }
    ratios.push(run.setupVisiblePixelHits / visible);
  }
  const frozenRatios = Object.freeze(ratios);
  if (ratios.some((ratio) => ratio < minimumHitRatio)) {
    return Object.freeze({
      status: "disabled-by-evidence",
      reason: `one or more runs are below the ${minimumHitRatio * 100}% visible setup hit threshold`,
      hitRatios: frozenRatios
    });
  }
  return Object.freeze({
    status: "default-eligible",
    reason: "all independent runs meet the visible setup hit threshold",
    hitRatios: frozenRatios
  });
}

export interface SurfaceAbiEvidence {
  readonly baselineBytesPerPixel: number;
  readonly candidateBytesPerPixel: number;
  readonly conversionPassesAdded: number;
  readonly correctnessParity: boolean;
  readonly independentRuns: number;
}

/**
 * Per-run M6 evidence.  The aggregate `SurfaceAbiEvidence` shape remains
 * available for lightweight callers, while formal artifacts should use this
 * identity-bearing shape so duplicate captures cannot close the gate.
 */
export interface SurfaceAbiRunEvidence {
  readonly baselineBytesPerPixel: number;
  readonly candidateBytesPerPixel: number;
  readonly conversionPassesAdded: number;
  readonly correctnessParity: boolean;
  readonly runId?: string;
  readonly runGroupId?: string;
  readonly sessionId?: string;
  readonly baselineResidentBytes?: number;
  readonly candidateResidentBytes?: number;
  readonly baselineTransientPeakBytes?: number;
  readonly candidateTransientPeakBytes?: number;
}

/**
 * Formal M6 gate over independent run artifacts.  A candidate is accepted
 * only when every run preserves parity, saves attachment bytes, adds no
 * conversion pass, and does not increase resident/transient peaks.  Missing
 * optional memory fields are treated as missing evidence rather than as zero.
 */
export function evaluateSurfaceAbiV2RunGroupNeed(
  runs: readonly SurfaceAbiRunEvidence[],
  minimumRuns = 3
): SurfaceAbiDecision {
  if (!Number.isInteger(minimumRuns) || minimumRuns <= 0) {
    return Object.freeze({ status: "insufficient-evidence", reason: "invalid minimum run count" });
  }
  if (runs.length < minimumRuns) {
    return Object.freeze({
      status: "insufficient-evidence",
      reason: `requires ${minimumRuns} independent runs`
    });
  }

  if (runs.some((run) => !isSurfaceAbiRunShape(run))) {
    return Object.freeze({
      status: "insufficient-evidence",
      reason: "Surface ABI run artifact has missing or invalid fields"
    });
  }

  const identities = runs.map((run) => `${run.runGroupId ?? ""}\u0000${run.runId ?? ""}`);
  const sessions = runs.map((run) => run.sessionId ?? "");
  if (
    runs.some((run) => !nonEmptyIdentity(run.runId) || !nonEmptyIdentity(run.runGroupId)) ||
    new Set(identities).size !== identities.length ||
    sessions.some((session) => session.length === 0) ||
    new Set(sessions).size !== sessions.length
  ) {
    return Object.freeze({
      status: "insufficient-evidence",
      reason: "each run requires unique runId/runGroupId and sessionId"
    });
  }
  const firstGroup = runs[0]?.runGroupId;
  if (runs.some((run) => run.runGroupId !== firstGroup)) {
    return Object.freeze({
      status: "insufficient-evidence",
      reason: "all runs must belong to one runGroupId"
    });
  }

  const savedPerRun: number[] = [];
  for (const run of runs) {
    if (!validSurfaceAbiNumbers(run)) {
      return Object.freeze({ status: "insufficient-evidence", reason: "invalid Surface ABI run evidence" });
    }
    if (
      !Number.isFinite(run.baselineResidentBytes) ||
      !Number.isFinite(run.candidateResidentBytes) ||
      !Number.isFinite(run.baselineTransientPeakBytes) ||
      !Number.isFinite(run.candidateTransientPeakBytes) ||
      run.baselineResidentBytes! < 0 ||
      run.candidateResidentBytes! < 0 ||
      run.baselineTransientPeakBytes! < 0 ||
      run.candidateTransientPeakBytes! < 0
    ) {
      return Object.freeze({
        status: "insufficient-evidence",
        reason: "each M6 run must report finite resident/transient peaks"
      });
    }
    savedPerRun.push(run.baselineBytesPerPixel - run.candidateBytesPerPixel);
  }

  const averageSaved = savedPerRun.reduce((sum, value) => sum + value, 0) / savedPerRun.length;
  if (runs.some((run) => !run.correctnessParity)) {
    return Object.freeze({
      status: "insufficient-evidence",
      reason: "all independent runs must prove correctness parity"
    });
  }
  if (runs.some((run) => run.conversionPassesAdded > 0)) {
    return Object.freeze({
      status: "rejected-by-evidence",
      reason: "candidate adds a conversion pass",
      bytesSavedPerPixel: averageSaved
    });
  }
  if (runs.some((run) => run.baselineBytesPerPixel <= run.candidateBytesPerPixel)) {
    return Object.freeze({
      status: "rejected-by-evidence",
      reason: "candidate does not reduce attachment bytes in every run",
      bytesSavedPerPixel: averageSaved
    });
  }
  if (runs.some((run) =>
    run.candidateResidentBytes! > run.baselineResidentBytes! ||
    run.candidateTransientPeakBytes! > run.baselineTransientPeakBytes!
  )) {
    return Object.freeze({
      status: "rejected-by-evidence",
      reason: "candidate increases resident or transient peak memory",
      bytesSavedPerPixel: averageSaved
    });
  }
  return Object.freeze({
    status: "required",
    reason: "all independent runs preserve parity, save bytes, add no conversion, and stay within memory peaks",
    bytesSavedPerPixel: averageSaved
  });
}

/** Keep Surface v1 unless a measured, parity-safe layout change pays for itself. */
export function evaluateSurfaceAbiV2Need(input: SurfaceAbiEvidence): SurfaceAbiDecision {
  if (!Number.isFinite(input.baselineBytesPerPixel) || !Number.isFinite(input.candidateBytesPerPixel) ||
      input.baselineBytesPerPixel <= 0 || input.candidateBytesPerPixel < 0 ||
      !Number.isInteger(input.conversionPassesAdded) || input.conversionPassesAdded < 0 ||
      !Number.isInteger(input.independentRuns) || input.independentRuns < 0 ||
      typeof input.correctnessParity !== "boolean") {
    return Object.freeze({ status: "insufficient-evidence", reason: "invalid Surface ABI evidence" });
  }
  if (!input.correctnessParity || input.independentRuns < 3) {
    return Object.freeze({ status: "insufficient-evidence", reason: "requires parity and three independent runs" });
  }
  const bytesSavedPerPixel = input.baselineBytesPerPixel - input.candidateBytesPerPixel;
  if (bytesSavedPerPixel <= 0 || input.conversionPassesAdded > 0) {
    return Object.freeze({
      status: "rejected-by-evidence",
      reason: input.conversionPassesAdded > 0
        ? "candidate adds a conversion pass"
        : "candidate does not reduce attachment bytes",
      bytesSavedPerPixel
    });
  }
  return Object.freeze({
    status: "required",
    reason: "candidate reduces attachment bytes without conversion or parity loss",
    bytesSavedPerPixel
  });
}

export interface TileBackendVendorEvidence {
  readonly vendor: string;
  readonly classDepthP50Ms: number;
  readonly classDepthP95Ms: number;
  readonly tilePrototypeP50Ms: number;
  readonly tilePrototypeP95Ms: number;
}

/** Identity-bearing M7 artifact shape; summaries remain vendor-scoped. */
export interface TileBackendVendorRunEvidence extends TileBackendVendorEvidence {
  readonly runId?: string;
  readonly runGroupId?: string;
  readonly sessionId?: string;
  readonly sampleCount?: number;
}

export type TileBackendDecision =
  | Readonly<{ status: "insufficient-evidence"; reason: string }>
  | Readonly<{ status: "not-needed-by-evidence"; reason: string; vendorCount: number }>
  | Readonly<{ status: "required"; reason: string; vendorCount: number }>;

/** M7 gate: two vendors must show a >=10% class-depth disadvantage. */
export function evaluateTileBackendNeed(
  evidence: readonly TileBackendVendorEvidence[]
): TileBackendDecision {
  const vendors = new Map<string, TileBackendVendorEvidence>();
  for (const sample of evidence) {
    if (!isTileBackendVendorShape(sample) ||
        sample.vendor.length === 0 ||
        ![sample.classDepthP50Ms, sample.classDepthP95Ms, sample.tilePrototypeP50Ms, sample.tilePrototypeP95Ms]
          .every((value) => Number.isFinite(value) && value > 0)) {
      return Object.freeze({ status: "insufficient-evidence", reason: "invalid vendor evidence" });
    }
    vendors.set(sample.vendor, sample);
  }
  if (vendors.size < 2) {
    return Object.freeze({ status: "insufficient-evidence", reason: "requires two GPU vendors" });
  }
  const overThreshold = [...vendors.values()].filter((sample) =>
    sample.classDepthP50Ms > sample.tilePrototypeP50Ms * 1.1 ||
    sample.classDepthP95Ms > sample.tilePrototypeP95Ms * 1.1
  );
  if (overThreshold.length >= 2) {
    return Object.freeze({
      status: "required",
      reason: "class-depth exceeds validated tile evidence by at least 10% on two vendors",
      vendorCount: overThreshold.length
    });
  }
  return Object.freeze({
    status: "not-needed-by-evidence",
    reason: "available vendor evidence does not cross the 10% trigger",
    vendorCount: vendors.size
  });
}

/**
 * Formal M7 entry gate.  It validates independent vendor artifacts before
 * reducing them to one summary per vendor; no tile runtime is created here.
 */
export function evaluateTileBackendRunGroupNeed(
  evidence: readonly TileBackendVendorRunEvidence[],
  minimumRunsPerVendor = 3
): TileBackendDecision {
  if (!Number.isInteger(minimumRunsPerVendor) || minimumRunsPerVendor <= 0) {
    return Object.freeze({ status: "insufficient-evidence", reason: "invalid minimum run count" });
  }
  if (evidence.length === 0) {
    return Object.freeze({ status: "insufficient-evidence", reason: "requires two GPU vendors" });
  }
  if (evidence.some((run) => !isTileBackendVendorRunShape(run))) {
    return Object.freeze({
      status: "insufficient-evidence",
      reason: "tile backend run artifact has missing or invalid fields"
    });
  }
  const identities = evidence.map((run) => `${run.runGroupId ?? ""}\u0000${run.runId ?? ""}`);
  const sessions = evidence.map((run) => run.sessionId ?? "");
  if (
    evidence.some((run) => !nonEmptyIdentity(run.runId) || !nonEmptyIdentity(run.runGroupId)) ||
    new Set(identities).size !== identities.length ||
    sessions.some((session) => session.length === 0) ||
    new Set(sessions).size !== sessions.length
  ) {
    return Object.freeze({ status: "insufficient-evidence", reason: "each vendor run requires unique runId/runGroupId and sessionId" });
  }
  const firstGroup = evidence[0]?.runGroupId;
  if (evidence.some((run) => run.runGroupId !== firstGroup)) {
    return Object.freeze({ status: "insufficient-evidence", reason: "all vendor runs must belong to one runGroupId" });
  }
  const byVendor = new Map<string, TileBackendVendorRunEvidence[]>();
  for (const run of evidence) {
    if (!Number.isInteger(run.sampleCount) || run.sampleCount! <= 0) {
      return Object.freeze({ status: "insufficient-evidence", reason: "vendor run sampleCount must be a positive integer" });
    }
    const list = byVendor.get(run.vendor) ?? [];
    list.push(run);
    byVendor.set(run.vendor, list);
  }
  if ([...byVendor.values()].some((runs) => runs.length < minimumRunsPerVendor)) {
    return Object.freeze({
      status: "insufficient-evidence",
      reason: `requires ${minimumRunsPerVendor} independent runs per GPU vendor`
    });
  }
  const summaries: TileBackendVendorEvidence[] = [...byVendor.entries()].map(([vendor, runs]) => ({
    vendor,
    classDepthP50Ms: median(runs.map((run) => run.classDepthP50Ms)),
    classDepthP95Ms: median(runs.map((run) => run.classDepthP95Ms)),
    tilePrototypeP50Ms: median(runs.map((run) => run.tilePrototypeP50Ms)),
    tilePrototypeP95Ms: median(runs.map((run) => run.tilePrototypeP95Ms))
  }));
  return evaluateTileBackendNeed(summaries);
}

function validSurfaceAbiNumbers(input: Pick<SurfaceAbiEvidence, "baselineBytesPerPixel" | "candidateBytesPerPixel" | "conversionPassesAdded" | "correctnessParity">): boolean {
  return Number.isFinite(input.baselineBytesPerPixel) &&
    Number.isFinite(input.candidateBytesPerPixel) &&
    input.baselineBytesPerPixel > 0 &&
    input.candidateBytesPerPixel >= 0 &&
    Number.isInteger(input.conversionPassesAdded) &&
    input.conversionPassesAdded >= 0 &&
    typeof input.correctnessParity === "boolean";
}

function isSurfaceAbiRunShape(value: unknown): value is SurfaceAbiRunEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const run = value as Partial<SurfaceAbiRunEvidence>;
  return validSurfaceAbiNumbers({
    baselineBytesPerPixel: run.baselineBytesPerPixel as number,
    candidateBytesPerPixel: run.candidateBytesPerPixel as number,
    conversionPassesAdded: run.conversionPassesAdded as number,
    correctnessParity: run.correctnessParity as boolean
  }) &&
    finiteNonNegative(run.baselineResidentBytes) &&
    finiteNonNegative(run.candidateResidentBytes) &&
    finiteNonNegative(run.baselineTransientPeakBytes) &&
    finiteNonNegative(run.candidateTransientPeakBytes);
}

function isTileBackendVendorShape(value: unknown): value is TileBackendVendorEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const sample = value as Partial<TileBackendVendorEvidence>;
  return typeof sample.vendor === "string" &&
    [sample.classDepthP50Ms, sample.classDepthP95Ms, sample.tilePrototypeP50Ms, sample.tilePrototypeP95Ms]
      .every((metric) => typeof metric === "number" && Number.isFinite(metric) && metric > 0);
}

function isTileBackendVendorRunShape(value: unknown): value is TileBackendVendorRunEvidence {
  return isTileBackendVendorShape(value) &&
    typeof (value as Partial<TileBackendVendorRunEvidence>).sampleCount === "number" &&
    Number.isInteger((value as Partial<TileBackendVendorRunEvidence>).sampleCount) &&
    (value as Partial<TileBackendVendorRunEvidence>).sampleCount! > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonEmptyIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.5)]!;
}
