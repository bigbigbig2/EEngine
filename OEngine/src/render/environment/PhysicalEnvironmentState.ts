export const PHYSICAL_LIGHTING_DIAGNOSTICS = Object.freeze({
  all: 0,
  "background-only": 1,
  "diffuse-only": 2,
  "specular-only": 3,
  "direct-only": 4,
  "aerial-only": 5,
});
export type PhysicalLightingDiagnostic = keyof typeof PHYSICAL_LIGHTING_DIAGNOSTICS;

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
  /** Unit vector from a world point toward the sun, not light travel direction. */
  readonly sunDirectionWorld: readonly [number, number, number];
  readonly sunIrradiance: readonly [number, number, number];
  readonly skyLuminanceScale: number;
  readonly lightingDiagnostic: PhysicalLightingDiagnostic;
  readonly aerialPerspectiveEnabled: boolean;
  readonly shadowLength: readonly [number, number];
}

/** Authoritative scene/world input for the pinned Earth atmosphere profile. */
export class PhysicalEnvironmentInput {
  readonly profile = "takram-earth-default" as const;
  worldToUnit = 0.001;
  sunDirectionWorld: [number, number, number] = [0.39036003, 0.8922514, 0.22306285];
  sunIrradiance: [number, number, number] = [1.474, 1.8504, 1.91198];
  skyLuminanceScale = 1;
  lightingDiagnostic: PhysicalLightingDiagnostic = "all";
  aerialPerspectiveEnabled = true;
  shadowLength: [number, number] = [0, 0];
  revision = 0;

  setSun(direction: readonly [number, number, number], irradiance: readonly [number, number, number]): void {
    this.sunDirectionWorld = [...direction] as [number, number, number];
    this.sunIrradiance = [...irradiance] as [number, number, number];
    this.revision++;
  }

  setWorldScale(worldToUnit: number): void {
    if (!Number.isFinite(worldToUnit) || worldToUnit <= 0)
      throw new RangeError("worldToUnit must be positive");
    this.worldToUnit = worldToUnit;
    this.revision++;
  }

  setSkyLuminanceScale(scale: number): void {
    if (!Number.isFinite(scale) || scale < 0)
      throw new RangeError("sky luminance scale must be non-negative");
    this.skyLuminanceScale = scale;
    this.revision++;
  }

  /** Diagnostic lobe isolation; normal rendering is "all" with aerial enabled.
   * Does not alter sky radiance, material parameters or IBL cache identity. */
  setLightingDiagnostic(mode: PhysicalLightingDiagnostic, aerialPerspectiveEnabled = true): void {
    if (
      !Object.hasOwn(PHYSICAL_LIGHTING_DIAGNOSTICS, mode) ||
      typeof aerialPerspectiveEnabled !== "boolean"
    ) {
      throw new RangeError("Invalid physical lighting diagnostic");
    }
    this.lightingDiagnostic = mode;
    this.aerialPerspectiveEnabled = aerialPerspectiveEnabled;
    this.revision++;
  }

  setShadowLength(length: readonly [number, number]): void {
    if (length.length !== 2 || length.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new RangeError("shadow lengths must be finite and non-negative");
    }
    if (length[0] !== 0 || length[1] !== 0) {
      throw new RangeError("Nonzero atmosphere shadow length requires the Phase 4 VSM producer");
    }
    this.shadowLength = [...length] as [number, number];
    this.revision++;
  }

  snapshot(): Omit<PhysicalEnvironmentSnapshot, "generation"> {
    return Object.freeze({
      lutGeneration: 1,
      worldToUnit: this.worldToUnit,
      sunDirectionWorld: Object.freeze([...this.sunDirectionWorld]) as readonly [number, number, number],
      sunIrradiance: Object.freeze([...this.sunIrradiance]) as readonly [number, number, number],
      skyLuminanceScale: this.skyLuminanceScale,
      lightingDiagnostic: this.lightingDiagnostic,
      aerialPerspectiveEnabled: this.aerialPerspectiveEnabled,
      shadowLength: Object.freeze([...this.shadowLength]) as readonly [number, number],
    });
  }
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

  get active(): EnvironmentPublication | null {
    return this.current;
  }

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
  if (
    !Object.hasOwn(PHYSICAL_LIGHTING_DIAGNOSTICS, snapshot.lightingDiagnostic) ||
    typeof snapshot.aerialPerspectiveEnabled !== "boolean"
  ) {
    throw new RangeError("Invalid physical lighting diagnostic snapshot");
  }
  if (!Number.isFinite(snapshot.worldToUnit) || snapshot.worldToUnit <= 0) {
    throw new RangeError("Environment worldToUnit must be positive");
  }
  if (!Number.isFinite(snapshot.skyLuminanceScale) || snapshot.skyLuminanceScale < 0) {
    throw new RangeError("Environment sky luminance scale must be non-negative");
  }
  if (
    snapshot.sunDirectionWorld.length !== 3 ||
    snapshot.sunIrradiance.length !== 3 ||
    snapshot.shadowLength.length !== 2
  )
    throw new RangeError("Environment vectors have invalid dimensions");
  for (const value of [...snapshot.sunDirectionWorld, ...snapshot.sunIrradiance, ...snapshot.shadowLength]) {
    if (!Number.isFinite(value)) throw new RangeError("Environment snapshot contains a non-finite value");
  }
  const length = Math.hypot(...snapshot.sunDirectionWorld);
  if (Math.abs(length - 1) > 1e-3) throw new RangeError("Sun direction must be normalized");
  if (snapshot.shadowLength[0] < 0 || snapshot.shadowLength[1] < 0) {
    throw new RangeError("Shadow lengths must be non-negative");
  }
  if (snapshot.shadowLength[0] !== 0 || snapshot.shadowLength[1] !== 0) {
    throw new RangeError("Nonzero atmosphere shadow length requires the Phase 4 VSM producer");
  }
}
