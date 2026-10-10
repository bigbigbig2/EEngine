import {
  hzbLevelDimensions,
  isReverseZOccluded,
  sanitizeReverseZDepth,
  type HzbLevel,
} from "./HzbReference.js";
/** Historical CPU reference only. Production uses TemporalOcclusionWork. */
export const CURRENT_HZB_LATE_RECHECK_ABI_VERSION = 1;
export const CURRENT_HZB_LATE_RECHECK_RECORD_STRIDE = 32;
export const CURRENT_HZB_LATE_RECHECK_HEADER_STRIDE = 32;
export const CURRENT_HZB_LATE_RECHECK_MAX_CAPACITY = 65_536;

export const CURRENT_HZB_LATE_RECHECK_FLAGS = Object.freeze({
  /** Candidate was uncertain in the previous-HZB traversal. */
  Uncertain: 1 << 0,
  /** Candidate has a large projected/raster cost. */
  Expensive: 1 << 1,
  /** Bounds/depth are conservative enough to preserve image parity. */
  Conservative: 1 << 2,
} as const);

export interface CurrentHzbLateRecheckCandidate {
  readonly workSlot: number;
  /** Normalized [minX, minY, maxX, maxY] in the current HZB view. */
  readonly screenRect: readonly [number, number, number, number];
  /** Reverse-Z nearest depth for the conservative candidate bounds. */
  readonly nearestDepth: number;
  /** Vertex invocations that the normal raster route would submit. */
  readonly rasterVertices: number;
  readonly flags: number;
}

export interface CurrentHzbLateRecheckView {
  readonly width: number;
  readonly height: number;
  readonly levels: readonly HzbLevel[];
}

export interface CurrentHzbLateRecheckResult {
  readonly attempted: number;
  readonly retained: number;
  readonly rejected: number;
  readonly invalid: number;
  readonly overflow: number;
  readonly rasterVerticesBefore: number;
  readonly rasterVerticesAfter: number;
  /** False means the bounded optimization must fall back to the source queue. */
  readonly published: boolean;
  readonly imageParity: "preserved" | "unknown";
  readonly records: readonly CurrentHzbLateRecheckCandidate[];
}

/**
 * CPU oracle for the GPU late-recheck policy. It is intentionally independent
 * of the runtime pass: tests can prove conservative rejection and the
 * fail-open overflow behavior without pretending to have browser PERF data.
 */
export function recheckCurrentHzbCandidates(
  candidates: readonly CurrentHzbLateRecheckCandidate[],
  view: CurrentHzbLateRecheckView,
  capacity = candidates.length,
  epsilon = 1e-6,
): CurrentHzbLateRecheckResult {
  validateView(view);
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > CURRENT_HZB_LATE_RECHECK_MAX_CAPACITY) {
    throw new RangeError("Current HZB late-recheck capacity is invalid");
  }
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new RangeError("Current HZB late-recheck epsilon is invalid");
  }

  let attempted = 0;
  let rejected = 0;
  let invalid = 0;
  let rasterVerticesBefore = 0;
  const retained: CurrentHzbLateRecheckCandidate[] = [];
  let imageParity = true;
  for (const candidate of candidates) {
    attempted++;
    rasterVerticesBefore += normalizeRasterVertices(candidate.rasterVertices);
    if (!validCandidate(candidate)) {
      invalid++;
      retained.push(candidate);
      imageParity = false;
      continue;
    }
    const eligible =
      (candidate.flags &
        (CURRENT_HZB_LATE_RECHECK_FLAGS.Uncertain | CURRENT_HZB_LATE_RECHECK_FLAGS.Expensive)) !==
      0;
    const paritySafe = (candidate.flags & CURRENT_HZB_LATE_RECHECK_FLAGS.Conservative) !== 0;
    const occluded = eligible && paritySafe && candidateOccluded(candidate, view, epsilon);
    if (occluded) {
      rejected++;
      continue;
    }
    retained.push(candidate);
  }

  const overflow = Math.max(0, retained.length - capacity);
  if (overflow > 0) {
    // Optional optimization must never publish a partial queue. The caller
    // keeps the source queue and records overflow for the pressure scheduler.
    return Object.freeze({
      attempted,
      retained: candidates.length,
      rejected: 0,
      invalid,
      overflow,
      rasterVerticesBefore,
      rasterVerticesAfter: rasterVerticesBefore,
      published: false,
      imageParity: "preserved",
      records: Object.freeze([...candidates]),
    });
  }

  const rasterVerticesAfter = retained.reduce(
    (sum, candidate) => sum + normalizeRasterVertices(candidate.rasterVertices),
    0,
  );
  return Object.freeze({
    attempted,
    retained: retained.length,
    rejected,
    invalid,
    overflow: 0,
    rasterVerticesBefore,
    rasterVerticesAfter,
    published: true,
    imageParity: imageParity ? "preserved" : "unknown",
    records: Object.freeze(retained),
  });
}

export function candidateOccludedByCurrentHzb(
  candidate: CurrentHzbLateRecheckCandidate,
  view: CurrentHzbLateRecheckView,
  epsilon = 1e-6,
): boolean {
  validateView(view);
  if (!validCandidate(candidate)) return false;
  return candidateOccluded(candidate, view, epsilon);
}

function candidateOccluded(
  candidate: CurrentHzbLateRecheckCandidate,
  view: CurrentHzbLateRecheckView,
  epsilon: number,
): boolean {
  const [minX, minY, maxX, maxY] = candidate.screenRect;
  const footprint = Math.max((maxX - minX) * view.width, (maxY - minY) * view.height, 1);
  const mip = Math.min(Math.max(0, Math.ceil(Math.log2(footprint))), view.levels.length - 1);
  const [levelWidth, levelHeight] = hzbLevelDimensions(view.width, view.height, mip);
  const level = view.levels[mip]!;
  const loX = Math.max(0, Math.min(levelWidth - 1, Math.floor(minX * levelWidth)));
  const loY = Math.max(0, Math.min(levelHeight - 1, Math.floor(minY * levelHeight)));
  const hiX = Math.max(0, Math.min(levelWidth - 1, Math.floor(maxX * levelWidth)));
  const hiY = Math.max(0, Math.min(levelHeight - 1, Math.floor(maxY * levelHeight)));
  if (hiX - loX > 3 || hiY - loY > 3) return false;
  let occluderFarthest = 1;
  for (let y = loY; y <= hiY; y++) {
    for (let x = loX; x <= hiX; x++) {
      const offset = (y * levelWidth + x) * 2;
      occluderFarthest = Math.min(occluderFarthest, sanitizeReverseZDepth(level.minMax[offset]!));
    }
  }
  return isReverseZOccluded(candidate.nearestDepth, occluderFarthest, epsilon);
}

function validCandidate(candidate: CurrentHzbLateRecheckCandidate): boolean {
  if (
    !Number.isSafeInteger(candidate.workSlot) ||
    candidate.workSlot < 0 ||
    candidate.workSlot > 0xffffffff ||
    !Number.isSafeInteger(candidate.flags) ||
    candidate.flags < 0 ||
    candidate.flags > 0xffffffff ||
    !Number.isFinite(candidate.nearestDepth) ||
    !Number.isFinite(candidate.rasterVertices) ||
    candidate.rasterVertices < 0
  ) {
    return false;
  }
  const [minX, minY, maxX, maxY] = candidate.screenRect;
  return (
    [minX, minY, maxX, maxY].every(Number.isFinite) &&
    minX >= 0 &&
    minY >= 0 &&
    maxX <= 1 &&
    maxY <= 1 &&
    minX < maxX &&
    minY < maxY
  );
}

function normalizeRasterVertices(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validateView(view: CurrentHzbLateRecheckView): void {
  if (
    !Number.isSafeInteger(view.width) ||
    view.width <= 0 ||
    !Number.isSafeInteger(view.height) ||
    view.height <= 0 ||
    view.levels.length === 0
  ) {
    throw new RangeError("Current HZB late-recheck view is invalid");
  }
  for (const level of view.levels) {
    if (
      !Number.isSafeInteger(level.width) ||
      level.width <= 0 ||
      !Number.isSafeInteger(level.height) ||
      level.height <= 0 ||
      level.minMax.length < level.width * level.height * 2
    ) {
      throw new RangeError("Current HZB late-recheck level is invalid");
    }
  }
}
