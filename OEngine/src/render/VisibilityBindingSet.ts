/** Lightweight per-frame bindings for a persistent visibility work set. */
export interface VisibilityBindingSet {
  readonly camera: GPUBuffer;
  readonly counters: GPUBuffer;
  readonly countersEnabled: boolean;
  readonly sseThreshold: number;
}

export function visibilityBindingSet(
  input: VisibilityBindingSet
): VisibilityBindingSet {
  if (!Number.isFinite(input.sseThreshold) || input.sseThreshold < 0) {
    throw new RangeError("VisibilityBindingSet.sseThreshold must be non-negative and finite");
  }
  return Object.freeze({ ...input });
}

export function sameVisibilityBindingSet(
  left: VisibilityBindingSet,
  right: VisibilityBindingSet
): boolean {
  return left.camera === right.camera &&
    left.counters === right.counters &&
    left.countersEnabled === right.countersEnabled &&
    left.sseThreshold === right.sseThreshold;
}
