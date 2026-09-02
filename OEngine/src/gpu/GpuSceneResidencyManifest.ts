import type { GeometryAssetPackage } from "../assets/GeometryAssetPackage.js";
import { computeIndexedPackedHierarchyWorkCapacity } from "../geometry/GeometryHierarchy.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { PackedSceneSource } from "./GpuPackedSceneRegistry.js";
import { visibilityRasterWorkBufferByteLength } from "./GpuVisibilityKeyAbi.js";

export const SCENE_RESIDENCY_MANIFEST_SCHEMA_VERSION = 1;

export interface SceneResidencyTotals {
  readonly packageCount: number;
  readonly uniquePackageCount: number;
  readonly materialCount: number;
  readonly instanceCount: number;
  readonly sourceTriangles: number;
  readonly meshlets: number;
  readonly clusters: number;
  readonly packageBytes: number;
  readonly maxSelectedClusterCut: number;
  readonly maxRasterTriangleCut: number;
}

/**
 * Immutable, device-independent proof consumed by the cold-load transaction.
 * It describes references and capacity only; no GPU resource is owned here.
 */
export interface SceneResidencyManifest {
  readonly schemaVersion: typeof SCENE_RESIDENCY_MANIFEST_SCHEMA_VERSION;
  readonly source: PackedSceneSource;
  readonly packages: readonly GeometryAssetPackage[];
  readonly materials: readonly StandardShadeMaterial[];
  readonly packageContentHashes: readonly string[];
  readonly totals: SceneResidencyTotals;
}

export interface SceneResidencyManifestLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
}

/** Validates every scene reference before any GPU reservation or write. */
export function createSceneResidencyManifest(
  source: PackedSceneSource,
  limits: SceneResidencyManifestLimits
): SceneResidencyManifest {
  validateSourceShape(source);
  validateLimits(limits);
  let sourceTriangles = 0;
  let meshlets = 0;
  let clusters = 0;
  let packageBytes = 0;
  const hashes: string[] = [];
  for (let index = 0; index < source.geometries.length; index++) {
    const geometry = source.geometries[index]!;
    const report = geometry.validate();
    if (!report.valid) {
      const issue = report.issues.find((candidate) => candidate.severity === "error");
      throw new Error(
        `SceneResidencyManifest geometry ${index} is invalid: ${issue?.message ?? "unknown package error"}`
      );
    }
    if (geometry.package.manifest.contentHash.length === 0) {
      throw new Error(`SceneResidencyManifest geometry ${index} has no content hash`);
    }
    sourceTriangles = safeAdd(sourceTriangles, geometry.directory.sourceTriangleCount, "source triangles");
    meshlets = safeAdd(meshlets, geometry.meshlets.length, "meshlets");
    clusters = safeAdd(clusters, Math.max(geometry.clusters.length, 1), "clusters");
    packageBytes = safeAdd(
      packageBytes,
      geometry.package.manifest.totalByteLength,
      "package bytes"
    );
    hashes.push(geometry.package.manifest.contentHash);
  }
  const hierarchy = computeIndexedPackedHierarchyWorkCapacity(
    source.geometries,
    source.geometryIndices
  );
  const rasterBytes = visibilityRasterWorkBufferByteLength(
    hierarchy.rasterWorkCapacity
  );
  const bindingLimit = Math.min(
    limits.maxBufferSize,
    limits.maxStorageBufferBindingSize
  );
  if (rasterBytes > bindingLimit) {
    throw new RangeError(
      `SceneResidencyManifest exact RasterWork requires ${rasterBytes} bytes but the adapter limit is ${bindingLimit}`
    );
  }
  return Object.freeze({
    schemaVersion: SCENE_RESIDENCY_MANIFEST_SCHEMA_VERSION,
    source,
    packages: Object.freeze([...source.geometries]),
    materials: Object.freeze([...source.materials]),
    packageContentHashes: Object.freeze(hashes),
    totals: Object.freeze({
      packageCount: source.geometries.length,
      uniquePackageCount: new Set(hashes).size,
      materialCount: source.materials.length,
      instanceCount: source.count,
      sourceTriangles,
      meshlets,
      clusters,
      packageBytes,
      maxSelectedClusterCut: hierarchy.visibleClusterCapacity,
      maxRasterTriangleCut: hierarchy.rasterWorkCapacity
    })
  });
}

function validateSourceShape(source: PackedSceneSource): void {
  if (!Number.isSafeInteger(source.count) || source.count <= 0) {
    throw new RangeError("SceneResidencyManifest instance count must be positive");
  }
  if (source.geometries.length === 0) {
    throw new RangeError("SceneResidencyManifest requires geometry packages");
  }
  if (source.materials.length === 0) {
    throw new RangeError("SceneResidencyManifest requires materials");
  }
  assertLength(source.geometryIndices, source.count, "geometryIndices");
  assertLength(source.materialIndices, source.count, "materialIndices");
  assertLength(source.currentTransforms, source.count * 16, "currentTransforms");
  if (source.previousTransforms !== undefined) {
    assertLength(source.previousTransforms, source.count * 16, "previousTransforms");
  }
  assertLength(source.boundsSpheres, source.count * 4, "boundsSpheres");
  if (source.boundsMin !== undefined) assertLength(source.boundsMin, source.count * 3, "boundsMin");
  if (source.boundsMax !== undefined) assertLength(source.boundsMax, source.count * 3, "boundsMax");
  if (source.flags !== undefined) assertLength(source.flags, source.count, "flags");
  if (source.debugIds !== undefined) assertLength(source.debugIds, source.count, "debugIds");
  for (let index = 0; index < source.count; index++) {
    if (source.geometryIndices[index]! >= source.geometries.length) {
      throw new RangeError(`geometryIndices[${index}] is outside the package dictionary`);
    }
    if (source.materialIndices[index]! >= source.materials.length) {
      throw new RangeError(`materialIndices[${index}] is outside the material dictionary`);
    }
  }
}

function validateLimits(limits: SceneResidencyManifestLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`SceneResidencyManifest ${name} must be a positive safe integer`);
    }
  }
}

function assertLength(value: ArrayLike<unknown>, expected: number, label: string): void {
  if (value.length !== expected) {
    throw new RangeError(`${label} length ${value.length} does not match ${expected}`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} exceeds safe integer range`);
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} exceeds safe integer range`);
  return result;
}
