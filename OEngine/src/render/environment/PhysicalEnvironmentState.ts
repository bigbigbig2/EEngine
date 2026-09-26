/**
 * Shared Non-Geospatial environment publication. The atmosphere equations use
 * kilometres internally; scene positions remain in EEngine world units and are
 * converted by the published worldToUnit scale at the consumer boundary.
 * A generation is immutable for a frame, so Sun, Sky and aerial consumers
 * cannot observe mixed LUT/parameter versions.
 */
export interface PhysicalEnvironmentSnapshot {
  readonly generation: number;
  readonly lutGeneration: number;
  readonly worldToUnit: number;
  readonly sunDirectionWorld: readonly [number, number, number];
  readonly sunIrradiance: readonly [number, number, number];
  readonly skyLuminanceScale: number;
  readonly shadowLength: readonly [number, number];
}

export type EnvironmentPublication = Readonly<{
  readonly generation: number;
  readonly snapshot: PhysicalEnvironmentSnapshot;
  readonly lutReady: boolean;
}>;

/** Single publication point consumed by Surface, Sky and aerial work. */
export class PhysicalEnvironmentState {
  private nextGeneration = 1;
  private current: EnvironmentPublication | null = null;
  private pending: { snapshot: PhysicalEnvironmentSnapshot; lutReady: boolean } | null = null;

  get active(): EnvironmentPublication | null { return this.current; }

  stage(snapshot: Omit<PhysicalEnvironmentSnapshot, "generation">, lutReady: boolean): number {
    validateSnapshot(snapshot);
    if (!Number.isInteger(snapshot.lutGeneration) || snapshot.lutGeneration < 0) {
      throw new RangeError("Environment LUT generation must be non-negative");
    }
    this.pending = { snapshot: Object.freeze({ ...snapshot, generation: this.nextGeneration }), lutReady };
    return this.nextGeneration;
  }

  /** Publish only a complete generation; callers invoke after queue submission. */
  commit(generation: number): EnvironmentPublication {
    if (this.pending === null || this.pending.snapshot.generation !== generation) {
      throw new Error("Environment generation is stale or incomplete");
    }
    if (!this.pending.lutReady) throw new Error("Environment LUT generation is not ready");
    this.current = Object.freeze({ generation, snapshot: this.pending.snapshot, lutReady: true });
    this.pending = null;
    this.nextGeneration++;
    return this.current;
  }

  abort(generation: number): void {
    if (this.pending?.snapshot.generation !== generation) throw new Error("Environment generation is stale");
    this.pending = null;
  }
}

function validateSnapshot(snapshot: Omit<PhysicalEnvironmentSnapshot, "generation">): void {
  if (!Number.isFinite(snapshot.worldToUnit) || snapshot.worldToUnit <= 0) {
    throw new RangeError("Environment worldToUnit must be positive");
  }
  if (!Number.isFinite(snapshot.skyLuminanceScale) || snapshot.skyLuminanceScale < 0) {
    throw new RangeError("Environment sky luminance scale must be non-negative");
  }
  if (snapshot.sunDirectionWorld.length !== 3 || snapshot.sunIrradiance.length !== 3 ||
      snapshot.shadowLength.length !== 2) throw new RangeError("Environment vectors have invalid dimensions");
  for (const value of [...snapshot.sunDirectionWorld, ...snapshot.sunIrradiance, ...snapshot.shadowLength]) {
    if (!Number.isFinite(value)) throw new RangeError("Environment snapshot contains a non-finite value");
  }
  const length = Math.hypot(...snapshot.sunDirectionWorld);
  if (Math.abs(length - 1) > 1e-3) throw new RangeError("Sun direction must be normalized");
  if (snapshot.shadowLength[0] < 0 || snapshot.shadowLength[1] < 0) {
    throw new RangeError("Shadow lengths must be non-negative");
  }
}
