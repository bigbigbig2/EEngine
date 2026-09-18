import type { VirtualGeometryGeometryProfile, VirtualGeometrySceneSource } from "../../gpu/GpuRenderWorld.js";
import type { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";

/**
 * Producer-neutral Scene mapper shared by the Web Runtime Cooker route and the
 * Native Offline (OEGPACK) route.
 *
 * Both producers describe the same three things - a Product asset dictionary, a
 * per-asset geometry profile and a flat instance list with column-major world
 * matrices - so the framing, bounds and instance-record emission live here and
 * stay identical no matter which producer supplied them. Neither producer may
 * own a separate scene, bounds or fitting implementation.
 */
export interface VirtualGeometrySceneSourceOptionsV1 {
  /** Uniform scale applied to instance transforms (defaults to 1). */
  readonly scale?: number;
  /** World translation applied after scale (defaults to origin). */
  readonly offset?: readonly [number, number, number];
  /**
   * When set, the model is uniformly scaled so its world height equals this
   * value and its base is aligned to `fitBase`.
   */
  readonly fitHeight?: number;
  readonly fitBase?: readonly [number, number, number];
}

export interface VirtualGeometrySceneInstanceV1 {
  /** Index into the Product asset dictionary. */
  readonly assetIndex: number;
  /** Material index; `0xffffffff` maps to material 0. */
  readonly materialIndex: number;
  /** Optional producer instance flags; all instances must declare them together. */
  readonly flags?: number;
  /** Column-major world matrix, matching glTF and Runtime instance records. */
  readonly transform: Float32Array;
}

export interface VirtualGeometrySceneSourceResultV1 {
  readonly source: VirtualGeometrySceneSource;
  readonly materials: readonly StandardShadeMaterial[];
}

const ASSET_RECORD_STRIDE = 128;

/**
 * Builds the production `VirtualGeometrySceneSource` from producer-neutral
 * inputs. It only reads the frozen Product asset table and never creates GPU
 * resources or provider state.
 */
export function buildVirtualGeometrySceneSourceV1(
  assetRecords: Uint8Array,
  profiles: readonly VirtualGeometryGeometryProfile[],
  instances: readonly VirtualGeometrySceneInstanceV1[],
  materials: readonly StandardShadeMaterial[],
  options: VirtualGeometrySceneSourceOptionsV1 = {}
): VirtualGeometrySceneSourceResultV1 {
  if (!(assetRecords instanceof Uint8Array) || assetRecords.byteLength === 0 || assetRecords.byteLength % ASSET_RECORD_STRIDE !== 0) {
    throw new RangeError("Virtual Geometry scene source requires a non-empty Product asset table");
  }
  const assetCount = assetRecords.byteLength / ASSET_RECORD_STRIDE;
  if (profiles.length !== assetCount) throw new RangeError("Virtual Geometry scene geometry profile count must match the Product asset dictionary");
  if (materials.length === 0) throw new RangeError("Virtual Geometry scene source requires at least one material");
  for (let index = 0; index < materials.length; index++) {
    if (materials[index] === undefined) throw new RangeError("Virtual Geometry scene source material dictionary must not contain holes");
  }
  const assetView = new DataView(assetRecords.buffer, assetRecords.byteOffset, assetRecords.byteLength);
  for (const instance of instances) {
    if (!Number.isInteger(instance.assetIndex) || instance.assetIndex < 0 || instance.assetIndex >= assetCount) throw new RangeError("Virtual Geometry scene instance asset index is outside the Product asset dictionary");
    if (instance.materialIndex !== 0xffffffff && (!Number.isInteger(instance.materialIndex) || instance.materialIndex < 0 || instance.materialIndex >= materials.length)) throw new RangeError("Virtual Geometry scene instance material index is outside the material dictionary");
    if (!(instance.transform instanceof Float32Array) || instance.transform.length !== 16 || !instance.transform.every(Number.isFinite)) throw new RangeError("Virtual Geometry scene instance transform must be 16 finite column-major floats");
    if (instance.flags !== undefined && (!Number.isInteger(instance.flags) || instance.flags < 0 || instance.flags > 0xffffffff)) throw new RangeError("Virtual Geometry scene instance flags must be a u32");
  }
  const declaredFlags = instances[0]!.flags !== undefined;
  if (declaredFlags && instances.some(instance => instance.flags === undefined)) throw new RangeError("Virtual Geometry scene instances must declare flags together");

  const localBounds = (assetIndex: number): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } => {
    const base = assetIndex * ASSET_RECORD_STRIDE;
    return {
      min: [assetView.getFloat32(base + 48, true), assetView.getFloat32(base + 52, true), assetView.getFloat32(base + 56, true)],
      max: [assetView.getFloat32(base + 60, true), assetView.getFloat32(base + 64, true), assetView.getFloat32(base + 68, true)]
    };
  };

  // 1. Raw world AABB from each asset's local AABB.
  const rawMin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const rawMax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const instance of instances) {
    const { min, max } = localBounds(instance.assetIndex);
    const m = instance.transform;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? max[0] : min[0], y = corner & 2 ? max[1] : min[1], z = corner & 4 ? max[2] : min[2];
      const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      rawMin[0] = Math.min(rawMin[0]!, wx); rawMin[1] = Math.min(rawMin[1]!, wy); rawMin[2] = Math.min(rawMin[2]!, wz);
      rawMax[0] = Math.max(rawMax[0]!, wx); rawMax[1] = Math.max(rawMax[1]!, wy); rawMax[2] = Math.max(rawMax[2]!, wz);
    }
  }
  if (instances.length === 0) throw new RangeError("Virtual Geometry scene source requires at least one instance");
  const rawCenter: readonly [number, number, number] = [
    (rawMin[0]! + rawMax[0]!) * 0.5,
    (rawMin[1]! + rawMax[1]!) * 0.5,
    (rawMin[2]! + rawMax[2]!) * 0.5
  ];

  // 2. Fit / explicit transform.
  let scale = options.scale ?? 1;
  let offset: readonly [number, number, number] = options.offset ?? [0, 0, 0];
  if (options.fitHeight !== undefined) {
    if (!Number.isFinite(options.fitHeight) || options.fitHeight <= 0) throw new RangeError("Virtual Geometry scene fitHeight must be positive and finite");
    const base = options.fitBase ?? [0, 0, 0];
    const height = Math.max(1e-5, rawMax[1]! - rawMin[1]!);
    scale = options.fitHeight / height;
    offset = Object.freeze([
      base[0]! - rawCenter[0] * scale,
      base[1]! + (rawCenter[1] - rawMin[1]!) * scale - rawCenter[1] * scale,
      base[2]! - rawCenter[2] * scale
    ]) as readonly [number, number, number];
  } else if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("Virtual Geometry scene scale must be positive and finite");
  }

  // 3. Emit fitted transforms + world bounds.
  const transforms: number[] = [], geometryIndices: number[] = [], materialIndices: number[] = [], bounds: number[] = [], boundsMin: number[] = [], boundsMax: number[] = [], flags: number[] = [];
  for (const instance of instances) {
    const m = instance.transform;
    const matrix = new Float32Array(16);
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) {
        matrix[column * 4 + row] = column < 3 && row < 3 ? m[column * 4 + row]! * scale : m[column * 4 + row]!;
      }
    }
    matrix[12] = m[12]! * scale + offset[0]!;
    matrix[13] = m[13]! * scale + offset[1]!;
    matrix[14] = m[14]! * scale + offset[2]!;
    transforms.push(...matrix);
    geometryIndices.push(instance.assetIndex);
    materialIndices.push(instance.materialIndex === 0xffffffff ? 0 : instance.materialIndex);
    const base = instance.assetIndex * ASSET_RECORD_STRIDE;
    const center = [assetView.getFloat32(base + 32, true), assetView.getFloat32(base + 36, true), assetView.getFloat32(base + 40, true)];
    const localRadius = assetView.getFloat32(base + 44, true);
    const worldCenter = [
      matrix[0]! * center[0]! + matrix[4]! * center[1]! + matrix[8]! * center[2]! + matrix[12]!,
      matrix[1]! * center[0]! + matrix[5]! * center[1]! + matrix[9]! * center[2]! + matrix[13]!,
      matrix[2]! * center[0]! + matrix[6]! * center[1]! + matrix[10]! * center[2]! + matrix[14]!
    ];
    const worldScale = Math.max(Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!), Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!), Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!));
    bounds.push(worldCenter[0]!, worldCenter[1]!, worldCenter[2]!, localRadius * worldScale);
    const { min, max } = localBounds(instance.assetIndex);
    const instanceMin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const instanceMax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? max[0] : min[0], y = corner & 2 ? max[1] : min[1], z = corner & 4 ? max[2] : min[2];
      const wx = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
      const wy = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
      const wz = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!;
      instanceMin[0] = Math.min(instanceMin[0]!, wx); instanceMin[1] = Math.min(instanceMin[1]!, wy); instanceMin[2] = Math.min(instanceMin[2]!, wz);
      instanceMax[0] = Math.max(instanceMax[0]!, wx); instanceMax[1] = Math.max(instanceMax[1]!, wy); instanceMax[2] = Math.max(instanceMax[2]!, wz);
    }
    boundsMin.push(instanceMin[0]!, instanceMin[1]!, instanceMin[2]!);
    boundsMax.push(instanceMax[0]!, instanceMax[1]!, instanceMax[2]!);
    if (declaredFlags) flags.push(instance.flags!);
  }
  const capacity = Math.min(65535, Math.max(256, assetCount * 16));
  return Object.freeze({
    materials: Object.freeze([...materials]),
    source: Object.freeze({
      materials,
      geometryProfiles: Object.freeze([...profiles]),
      assetCount,
      hierarchyMaxDepth: 64,
      hierarchyTraversalCapacity: capacity,
      hierarchyVisibleClusterCapacity: capacity,
      hierarchyRasterWorkCapacity: capacity,
      count: geometryIndices.length,
      geometryIndices: Uint32Array.from(geometryIndices),
      materialIndices: Uint32Array.from(materialIndices),
      currentTransforms: Float32Array.from(transforms),
      boundsSpheres: Float32Array.from(bounds),
      boundsMin: Float32Array.from(boundsMin),
      boundsMax: Float32Array.from(boundsMax),
      ...(declaredFlags ? { flags: Uint32Array.from(flags) } : {})
    })
  });
}
