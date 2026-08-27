/** Deterministic, device-independent inputs that affect cooked geometry bytes. */

export const GEOMETRY_COOK_RECIPE_VERSION = 1;
export const MESHOPTIMIZER_COOKER_COMMIT =
  "73583c335e541c139821d0de2bf5f12960a04941";
export const BEVY_MESHLET_REFERENCE_COMMIT =
  "5f8270f2e049f90139a503d1e930070d926f9427";

export type DegenerateTrianglePolicy = "warn" | "reject";

export interface GeometryCookRecipe {
  readonly recipeVersion: 1;
  readonly meshoptimizerCommit: string;
  readonly hierarchyReferenceCommit: string;
  readonly meshletMaxVertices: number;
  readonly meshletMaxTriangles: number;
  readonly coneWeight: number;
  readonly simplificationTargetRatio: number;
  readonly hierarchyMaxDepth: number;
  readonly bvhBranchingFactor: 8;
  readonly quantizeBvhBounds: boolean;
  readonly positionFormat: "float32x3";
  readonly degenerateTrianglePolicy: DegenerateTrianglePolicy;
  readonly deterministicSeed: number;
}

export interface GeometryCookRecipeInput {
  readonly meshletMaxVertices?: number;
  readonly meshletMaxTriangles?: number;
  readonly coneWeight?: number;
  readonly simplificationTargetRatio?: number;
  readonly hierarchyMaxDepth?: number;
  readonly bvhBranchingFactor?: number;
  readonly quantizeBvhBounds?: boolean;
  readonly positionFormat?: string;
  readonly degenerateTrianglePolicy?: DegenerateTrianglePolicy;
  readonly deterministicSeed?: number;
}

export function createGeometryCookRecipe(
  input: GeometryCookRecipeInput = {}
): GeometryCookRecipe {
  const meshletMaxVertices = input.meshletMaxVertices ?? 64;
  const meshletMaxTriangles = input.meshletMaxTriangles ?? 128;
  const coneWeight = input.coneWeight ?? 0;
  const simplificationTargetRatio = input.simplificationTargetRatio ?? 0.5;
  const hierarchyMaxDepth = input.hierarchyMaxDepth ?? 32;
  const bvhBranchingFactor = input.bvhBranchingFactor ?? 8;
  const quantizeBvhBounds = input.quantizeBvhBounds ?? false;
  const positionFormat = input.positionFormat ?? "float32x3";
  const degenerateTrianglePolicy = input.degenerateTrianglePolicy ?? "warn";
  const deterministicSeed = input.deterministicSeed ?? 0;

  assertIntegerInRange(meshletMaxVertices, 1, 256, "meshletMaxVertices");
  assertIntegerInRange(meshletMaxTriangles, 1, 512, "meshletMaxTriangles");
  assertFiniteInRange(coneWeight, 0, 1, true, "coneWeight");
  assertFiniteInRange(
    simplificationTargetRatio,
    0,
    1,
    false,
    "simplificationTargetRatio"
  );
  assertIntegerInRange(hierarchyMaxDepth, 1, 64, "hierarchyMaxDepth");
  if (bvhBranchingFactor !== 8) {
    throw new RangeError("bvhBranchingFactor must be 8 for recipe v1");
  }
  if (typeof quantizeBvhBounds !== "boolean") {
    throw new TypeError("quantizeBvhBounds must be boolean");
  }
  if (positionFormat !== "float32x3") {
    throw new RangeError("positionFormat must be 'float32x3' for recipe v1");
  }
  if (
    degenerateTrianglePolicy !== "warn" &&
    degenerateTrianglePolicy !== "reject"
  ) {
    throw new RangeError("degenerateTrianglePolicy must be 'warn' or 'reject'");
  }
  assertIntegerInRange(deterministicSeed, 0, 0xffffffff, "deterministicSeed");

  return Object.freeze({
    recipeVersion: GEOMETRY_COOK_RECIPE_VERSION,
    meshoptimizerCommit: MESHOPTIMIZER_COOKER_COMMIT,
    hierarchyReferenceCommit: BEVY_MESHLET_REFERENCE_COMMIT,
    meshletMaxVertices,
    meshletMaxTriangles,
    coneWeight,
    simplificationTargetRatio,
    hierarchyMaxDepth,
    bvhBranchingFactor: 8,
    quantizeBvhBounds,
    positionFormat: "float32x3",
    degenerateTrianglePolicy,
    deterministicSeed
  });
}

export function geometryCookRecipeKey(recipe: GeometryCookRecipe): string {
  return JSON.stringify({
    recipeVersion: recipe.recipeVersion,
    meshoptimizerCommit: recipe.meshoptimizerCommit,
    hierarchyReferenceCommit: recipe.hierarchyReferenceCommit,
    meshletMaxVertices: recipe.meshletMaxVertices,
    meshletMaxTriangles: recipe.meshletMaxTriangles,
    coneWeight: recipe.coneWeight,
    simplificationTargetRatio: recipe.simplificationTargetRatio,
    hierarchyMaxDepth: recipe.hierarchyMaxDepth,
    bvhBranchingFactor: recipe.bvhBranchingFactor,
    quantizeBvhBounds: recipe.quantizeBvhBounds,
    positionFormat: recipe.positionFormat,
    degenerateTrianglePolicy: recipe.degenerateTrianglePolicy,
    deterministicSeed: recipe.deterministicSeed
  });
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
}

function assertFiniteInRange(
  value: number,
  minimum: number,
  maximum: number,
  inclusive: boolean,
  name: string
): void {
  const inRange = inclusive
    ? value >= minimum && value <= maximum
    : value > minimum && value < maximum;
  if (!Number.isFinite(value) || !inRange) {
    const interval = inclusive ? `[${minimum}, ${maximum}]` : `(${minimum}, ${maximum})`;
    throw new RangeError(`${name} must be finite and in ${interval}`);
  }
}
