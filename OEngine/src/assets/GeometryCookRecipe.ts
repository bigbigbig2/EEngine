/** Deterministic, device-independent inputs that affect cooked geometry bytes. */

export const GEOMETRY_COOK_RECIPE_VERSION = 1;
export const MESHOPTIMIZER_COOKER_COMMIT =
  "73583c335e541c139821d0de2bf5f12960a04941";
export const BEVY_MESHLET_REFERENCE_COMMIT =
  "5f8270f2e049f90139a503d1e930070d926f9427";

export type DegenerateTrianglePolicy = "warn" | "reject";
export type NonManifoldPolicy = "warn" | "reject";
export type MissingAttributePolicy = "preserve-optional";
export type GeometryFloatMode = "ieee754-nearest-no-fast-math";

export interface GeometryCookRecipe {
  readonly recipeVersion: 1;
  readonly meshoptimizerCommit: string;
  readonly hierarchyReferenceCommit: string;
  readonly meshletMaxVertices: number;
  readonly meshletMaxTriangles: number;
  readonly coneWeight: number;
  readonly simplificationTargetRatio: number;
  readonly simplificationErrorMode: "absolute";
  readonly simplificationErrorLimit: number;
  readonly simplificationFailureRatio: number;
  readonly hierarchyTargetFanout: number;
  readonly hierarchyMaxDepth: number;
  readonly bvhBranchingFactor: 8;
  readonly quantizeBvhBounds: false;
  readonly bvhQuantizationBits: 0;
  readonly positionFormat: "float32x3";
  readonly vertexQuantizationBits: 0;
  readonly vertexQuantizationRange: "source-bounds";
  readonly missingAttributePolicy: MissingAttributePolicy;
  readonly degenerateTrianglePolicy: DegenerateTrianglePolicy;
  readonly degenerateTriangleThreshold: number;
  readonly nonManifoldPolicy: NonManifoldPolicy;
  readonly nonManifoldEdgeThreshold: number;
  readonly deterministicSeed: number;
  readonly floatingPointMode: GeometryFloatMode;
}

export interface GeometryCookRecipeInput {
  readonly meshletMaxVertices?: number;
  readonly meshletMaxTriangles?: number;
  readonly coneWeight?: number;
  readonly simplificationTargetRatio?: number;
  readonly simplificationErrorMode?: string;
  readonly simplificationErrorLimit?: number;
  readonly simplificationFailureRatio?: number;
  readonly hierarchyTargetFanout?: number;
  readonly hierarchyMaxDepth?: number;
  readonly bvhBranchingFactor?: number;
  readonly quantizeBvhBounds?: boolean;
  readonly bvhQuantizationBits?: number;
  readonly positionFormat?: string;
  readonly vertexQuantizationBits?: number;
  readonly vertexQuantizationRange?: string;
  readonly missingAttributePolicy?: string;
  readonly degenerateTrianglePolicy?: DegenerateTrianglePolicy;
  readonly degenerateTriangleThreshold?: number;
  readonly nonManifoldPolicy?: NonManifoldPolicy;
  readonly nonManifoldEdgeThreshold?: number;
  readonly deterministicSeed?: number;
  readonly floatingPointMode?: string;
}

export function createGeometryCookRecipe(
  input: GeometryCookRecipeInput = {}
): GeometryCookRecipe {
  const meshletMaxVertices = input.meshletMaxVertices ?? 64;
  const meshletMaxTriangles = input.meshletMaxTriangles ?? 128;
  const coneWeight = input.coneWeight ?? 0;
  const simplificationTargetRatio = input.simplificationTargetRatio ?? 0.5;
  const simplificationErrorMode = input.simplificationErrorMode ?? "absolute";
  const simplificationErrorLimit = input.simplificationErrorLimit ?? 3.4028234663852886e38;
  const simplificationFailureRatio = input.simplificationFailureRatio ?? 0.6;
  const hierarchyTargetFanout = input.hierarchyTargetFanout ?? 8;
  const hierarchyMaxDepth = input.hierarchyMaxDepth ?? 32;
  const bvhBranchingFactor = input.bvhBranchingFactor ?? 8;
  const quantizeBvhBounds = input.quantizeBvhBounds ?? false;
  const bvhQuantizationBits = input.bvhQuantizationBits ?? 0;
  const positionFormat = input.positionFormat ?? "float32x3";
  const vertexQuantizationBits = input.vertexQuantizationBits ?? 0;
  const vertexQuantizationRange = input.vertexQuantizationRange ?? "source-bounds";
  const missingAttributePolicy = input.missingAttributePolicy ?? "preserve-optional";
  const degenerateTrianglePolicy = input.degenerateTrianglePolicy ?? "warn";
  const degenerateTriangleThreshold = input.degenerateTriangleThreshold ?? 1;
  const nonManifoldPolicy = input.nonManifoldPolicy ?? "warn";
  const nonManifoldEdgeThreshold = input.nonManifoldEdgeThreshold ?? 1;
  const deterministicSeed = input.deterministicSeed ?? 0;
  const floatingPointMode = input.floatingPointMode ?? "ieee754-nearest-no-fast-math";

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
  if (simplificationErrorMode !== "absolute") {
    throw new RangeError("simplificationErrorMode must be 'absolute' for recipe v1");
  }
  if (!Number.isFinite(simplificationErrorLimit) || simplificationErrorLimit < 0) {
    throw new RangeError("simplificationErrorLimit must be a non-negative finite number");
  }
  assertFiniteInRange(
    simplificationFailureRatio,
    simplificationTargetRatio,
    1,
    true,
    "simplificationFailureRatio"
  );
  assertIntegerInRange(hierarchyTargetFanout, 2, 32, "hierarchyTargetFanout");
  assertIntegerInRange(hierarchyMaxDepth, 1, 64, "hierarchyMaxDepth");
  if (bvhBranchingFactor !== 8) {
    throw new RangeError("bvhBranchingFactor must be 8 for recipe v1");
  }
  if (quantizeBvhBounds !== false) {
    throw new RangeError("quantizeBvhBounds must be false for recipe v1");
  }
  if (bvhQuantizationBits !== 0) {
    throw new RangeError("bvhQuantizationBits must be 0 while BVH bounds are unquantized in recipe v1");
  }
  if (positionFormat !== "float32x3") {
    throw new RangeError("positionFormat must be 'float32x3' for recipe v1");
  }
  if (vertexQuantizationBits !== 0 || vertexQuantizationRange !== "source-bounds") {
    throw new RangeError("recipe v1 keeps vertex positions unquantized in source bounds");
  }
  if (missingAttributePolicy !== "preserve-optional") {
    throw new RangeError("missingAttributePolicy must preserve missing optional attributes in recipe v1");
  }
  if (
    degenerateTrianglePolicy !== "warn" &&
    degenerateTrianglePolicy !== "reject"
  ) {
    throw new RangeError("degenerateTrianglePolicy must be 'warn' or 'reject'");
  }
  assertIntegerInRange(
    degenerateTriangleThreshold,
    1,
    0xffffffff,
    "degenerateTriangleThreshold"
  );
  if (nonManifoldPolicy !== "warn" && nonManifoldPolicy !== "reject") {
    throw new RangeError("nonManifoldPolicy must be 'warn' or 'reject'");
  }
  assertIntegerInRange(
    nonManifoldEdgeThreshold,
    1,
    0xffffffff,
    "nonManifoldEdgeThreshold"
  );
  assertIntegerInRange(deterministicSeed, 0, 0xffffffff, "deterministicSeed");
  if (floatingPointMode !== "ieee754-nearest-no-fast-math") {
    throw new RangeError("floatingPointMode must be 'ieee754-nearest-no-fast-math' for recipe v1");
  }

  return Object.freeze({
    recipeVersion: GEOMETRY_COOK_RECIPE_VERSION,
    meshoptimizerCommit: MESHOPTIMIZER_COOKER_COMMIT,
    hierarchyReferenceCommit: BEVY_MESHLET_REFERENCE_COMMIT,
    meshletMaxVertices,
    meshletMaxTriangles,
    coneWeight,
    simplificationTargetRatio,
    simplificationErrorMode: "absolute",
    simplificationErrorLimit,
    simplificationFailureRatio,
    hierarchyTargetFanout,
    hierarchyMaxDepth,
    bvhBranchingFactor: 8,
    quantizeBvhBounds: false,
    bvhQuantizationBits: 0,
    positionFormat: "float32x3",
    vertexQuantizationBits: 0,
    vertexQuantizationRange: "source-bounds",
    missingAttributePolicy: "preserve-optional",
    degenerateTrianglePolicy,
    degenerateTriangleThreshold,
    nonManifoldPolicy,
    nonManifoldEdgeThreshold,
    deterministicSeed,
    floatingPointMode: "ieee754-nearest-no-fast-math"
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
    simplificationErrorMode: recipe.simplificationErrorMode,
    simplificationErrorLimit: recipe.simplificationErrorLimit,
    simplificationFailureRatio: recipe.simplificationFailureRatio,
    hierarchyTargetFanout: recipe.hierarchyTargetFanout,
    hierarchyMaxDepth: recipe.hierarchyMaxDepth,
    bvhBranchingFactor: recipe.bvhBranchingFactor,
    quantizeBvhBounds: recipe.quantizeBvhBounds,
    bvhQuantizationBits: recipe.bvhQuantizationBits,
    positionFormat: recipe.positionFormat,
    vertexQuantizationBits: recipe.vertexQuantizationBits,
    vertexQuantizationRange: recipe.vertexQuantizationRange,
    missingAttributePolicy: recipe.missingAttributePolicy,
    degenerateTrianglePolicy: recipe.degenerateTrianglePolicy,
    degenerateTriangleThreshold: recipe.degenerateTriangleThreshold,
    nonManifoldPolicy: recipe.nonManifoldPolicy,
    nonManifoldEdgeThreshold: recipe.nonManifoldEdgeThreshold,
    deterministicSeed: recipe.deterministicSeed,
    floatingPointMode: recipe.floatingPointMode
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
