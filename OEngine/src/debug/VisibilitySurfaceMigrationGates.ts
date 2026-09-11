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

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonEmptyIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
