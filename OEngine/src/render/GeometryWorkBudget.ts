export type GeometryBudgetMode = "fixed" | "adaptive";

export interface GeometryWorkBudget {
  readonly maxTestedHierarchyNodes: number;
  readonly targetMeshletWork: number;
  readonly maxMeshletWork: number;
  readonly targetRasterVertices: number;
  readonly maxRasterVertices: number;
  readonly maxRiskyTriangles: number;
  readonly maxSetupBytes: number;
}

export interface GeometryWorkSample {
  readonly testedHierarchyNodes: number;
  readonly meshletWork: number;
  readonly rasterVertices: number;
  readonly riskyTriangles: number;
}

export interface GeometryAdaptiveSseOptions {
  readonly deadZone?: number;
  readonly overloadGain?: number;
  readonly recoveryRate?: number;
  readonly qualityFloorSse?: number;
}

export const DEFAULT_GEOMETRY_WORK_BUDGET: GeometryWorkBudget = Object.freeze({
  maxTestedHierarchyNodes: 0xffffffff,
  targetMeshletWork: 131072,
  maxMeshletWork: 0xffffff,
  targetRasterVertices: 3 * 1024 * 1024,
  maxRasterVertices: 0xffffffff,
  maxRiskyTriangles: 262144,
  maxSetupBytes: 8 * 1024 * 1024
});

export function normalizeGeometryWorkBudget(
  value: GeometryWorkBudget = DEFAULT_GEOMETRY_WORK_BUDGET
): GeometryWorkBudget {
  const fields = Object.entries(value) as [keyof GeometryWorkBudget, number][];
  for (const [name, count] of fields) {
    if (!Number.isSafeInteger(count) || count < 0 || count > 0xffffffff) {
      throw new RangeError(`GeometryWorkBudget.${name} must be a non-negative u32`);
    }
  }
  if (value.maxTestedHierarchyNodes === 0 || value.targetMeshletWork === 0 ||
      value.maxMeshletWork === 0 || value.targetRasterVertices === 0 ||
      value.maxRasterVertices === 0 || value.maxRiskyTriangles === 0) {
    throw new RangeError("GeometryWorkBudget work limits must be positive");
  }
  if (value.targetMeshletWork > value.maxMeshletWork) {
    throw new RangeError("GeometryWorkBudget targetMeshletWork exceeds maxMeshletWork");
  }
  if (value.targetRasterVertices > value.maxRasterVertices) {
    throw new RangeError("GeometryWorkBudget targetRasterVertices exceeds maxRasterVertices");
  }
  if ((value.maxSetupBytes & 3) !== 0) {
    throw new RangeError("GeometryWorkBudget maxSetupBytes must be 4-byte aligned");
  }
  return Object.freeze({ ...value });
}

/**
 * Delayed GPU samples adjust only the next frame's refinement threshold.
 * Fixed mode is intentionally pure so formal benchmarks cannot adapt quality.
 */
export class GeometryAdaptiveSseController {
  private currentSse: number;
  private readonly deadZone: number;
  private readonly overloadGain: number;
  private readonly recoveryRate: number;
  private readonly qualityFloorSse: number;

  constructor(
    private readonly baseSse: number,
    private readonly budget: GeometryWorkBudget,
    options: GeometryAdaptiveSseOptions = {}
  ) {
    if (!Number.isFinite(baseSse) || baseSse < 0) {
      throw new RangeError("Geometry adaptive SSE base must be finite and non-negative");
    }
    this.deadZone = finiteRange(options.deadZone ?? 0.1, "deadZone", 0, 0.5);
    this.overloadGain = finiteRange(options.overloadGain ?? 0.35, "overloadGain", 0.01, 2);
    this.recoveryRate = finiteRange(options.recoveryRate ?? 0.04, "recoveryRate", 0.001, 0.25);
    this.qualityFloorSse = finiteRange(
      options.qualityFloorSse ?? Math.max(baseSse, 16),
      "qualityFloorSse",
      baseSse,
      1e6
    );
    this.budget = normalizeGeometryWorkBudget(budget);
    this.currentSse = baseSse;
  }

  get value(): number { return this.currentSse; }

  resetForCameraCut(): number {
    this.currentSse = this.baseSse;
    return this.currentSse;
  }

  update(sample: GeometryWorkSample): number {
    validateSample(sample);
    const pressure = Math.max(
      sample.testedHierarchyNodes / this.budget.maxTestedHierarchyNodes,
      sample.meshletWork / this.budget.targetMeshletWork,
      sample.rasterVertices / this.budget.targetRasterVertices,
      sample.riskyTriangles / this.budget.maxRiskyTriangles
    );
    if (pressure > 1 + this.deadZone) {
      const multiplier = 1 + Math.min(pressure - 1, 2) * this.overloadGain;
      this.currentSse = Math.min(
        this.qualityFloorSse,
        Math.max(this.baseSse, this.currentSse * multiplier)
      );
    } else if (pressure < 1 - this.deadZone && this.currentSse > this.baseSse) {
      this.currentSse = Math.max(
        this.baseSse,
        this.currentSse + (this.baseSse - this.currentSse) * this.recoveryRate
      );
    }
    return this.currentSse;
  }
}

function validateSample(sample: GeometryWorkSample): void {
  for (const [name, value] of Object.entries(sample)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`GeometryWorkSample.${name} must be finite and non-negative`);
    }
  }
}

function finiteRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`Geometry adaptive SSE ${name} must be in [${minimum}, ${maximum}]`);
  }
  return value;
}
