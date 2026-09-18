import type { VirtualGeometryGeometryProfile, VirtualGeometrySceneSource } from "../../gpu/GpuRenderWorld.js";
import { ShadeDrawSide, ShadeTransparencyMode } from "../../material/enums.js";
import { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import type { GeometryProductDescriptorV1 } from "../geometry-product/GeometryProductV1.js";
import type { WebCookSceneCatalogSnapshot } from "./WebCookClient.js";

export interface WebCookSceneSourceOptions {
  /** Uniform scale applied to instance transforms (defaults to 1). */
  readonly scale?: number;
  /** World translation applied after scale (defaults to origin). */
  readonly offset?: readonly [number, number, number];
  /**
   * When set, the model is uniformly scaled so its world height equals this
   * value and its base is aligned to `fitBase`, matching the Runtime Asset
   * `fitPackedTransforms` framing used by the V2 scene path.
   */
  readonly fitHeight?: number;
  readonly fitBase?: readonly [number, number, number];
}

export interface WebCookSceneSourceResult {
  readonly source: VirtualGeometrySceneSource;
  readonly materials: readonly StandardShadeMaterial[];
}

interface WebCookInstance {
  readonly assetIndex: number;
  readonly materialIndex: number;
  readonly transform: Float32Array;
}

/**
 * Maps a Web Cook catalog revision + Product descriptor into the production
 * Virtual Geometry scene source.
 *
 * The Web cooker emits exactly one Product asset per canonical material domain
 * in the catalog's stable primitive order, so `assetIndex` addresses
 * `catalog.primitives[assetIndex]`. The mapper stays producer-neutral: it only
 * reads the catalog snapshot and the immutable descriptor tables, and never
 * creates GPU resources.
 */
export function createWebCookSceneSource(
  catalog: WebCookSceneCatalogSnapshot,
  descriptor: Readonly<Pick<GeometryProductDescriptorV1, "assetRecords">>,
  options: WebCookSceneSourceOptions = {}
): WebCookSceneSourceResult {
  const assetCount = descriptor.assetRecords.byteLength / 128;
  if (assetCount === 0 || catalog.primitives.length !== assetCount) {
    throw new Error("The Web Cook Product asset dictionary must match the GLB primitive order");
  }
  const instanceByNode = new Map(catalog.instances.map(item => [item.nodeIndex, item]));
  const materials: StandardShadeMaterial[] = [];
  const materialForIndex = new Map<number, StandardShadeMaterial>();
  const materialFor = (index: number, value: Readonly<Record<string, unknown>>): number => {
    const key = index === 0xffffffff ? 0 : index;
    if (!materialForIndex.has(key)) {
      const material = new StandardShadeMaterial();
      const base = finiteTuple(value.baseColorFactor, 4, [1, 1, 1, 1]);
      material.diffuse_color.set(base[0]!, base[1]!, base[2]!, base[3]!);
      material.metallic_factor = finiteScalar(value.metallicFactor, 0);
      material.roughness_factor = finiteScalar(value.roughnessFactor, 1);
      const emissive = finiteTuple(value.emissiveFactor, 3, [0, 0, 0]);
      material.emissive_factor.set(emissive[0]!, emissive[1]!, emissive[2]!);
      material.alpha_cutoff = finiteScalar(value.alphaCutoff, 0.5);
      material.is_unlit = value.unlit === true;
      material.draw_side = value.doubleSided === true ? ShadeDrawSide.Double : ShadeDrawSide.Front;
      material.transparency_mode = value.alphaMode === "MASK" ? ShadeTransparencyMode.AlphaTested : value.alphaMode === "BLEND" ? ShadeTransparencyMode.Transparent : ShadeTransparencyMode.Opaque;
      materialForIndex.set(key, material); materials[key] = material;
    }
    return key;
  };
  const assetView = new DataView(descriptor.assetRecords.buffer, descriptor.assetRecords.byteOffset, descriptor.assetRecords.byteLength);
  const geometryProfiles: VirtualGeometryGeometryProfile[] = [];
  const instances: WebCookInstance[] = [];
  for (let assetIndex = 0; assetIndex < catalog.primitives.length; assetIndex++) {
    const primitive = catalog.primitives[assetIndex]!;
    const materialIndex = materialFor(primitive.materialIndex, primitive.material);
    geometryProfiles.push({
      hasAuthoredVertexColor: primitive.attributeSemantics.includes("COLOR_0"),
      hasUv0: primitive.attributeSemantics.includes("TEXCOORD_0"),
      hasUv1: primitive.attributeSemantics.includes("TEXCOORD_1"),
      hasUv2: false,
      hasNormal: true,
      hasTangent: primitive.attributeSemantics.includes("TANGENT")
    });
    for (const nodeIndex of primitive.instanceNodeIndices) {
      const instance = instanceByNode.get(nodeIndex);
      if (!instance) throw new Error(`Web Cook Product instance node ${nodeIndex} is missing from the GLB catalog`);
      instances.push({ assetIndex, materialIndex, transform: Float32Array.from(instance.worldMatrix) });
    }
  }

  // 1. Raw world AABB from each asset's local AABB so the fit matches the V2 path.
  const rawMin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const rawMax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const localBounds = (assetIndex: number): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } => {
    const base = assetIndex * 128;
    return {
      min: [assetView.getFloat32(base + 48, true), assetView.getFloat32(base + 52, true), assetView.getFloat32(base + 56, true)],
      max: [assetView.getFloat32(base + 60, true), assetView.getFloat32(base + 64, true), assetView.getFloat32(base + 68, true)]
    };
  };
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
  const rawCenter: readonly [number, number, number] = [
    (rawMin[0]! + rawMax[0]!) * 0.5,
    (rawMin[1]! + rawMax[1]!) * 0.5,
    (rawMin[2]! + rawMax[2]!) * 0.5
  ];

  // 2. Fit / explicit transform.
  let scale = options.scale ?? 1;
  let offset: readonly [number, number, number] = options.offset ?? [0, 0, 0];
  if (options.fitHeight !== undefined) {
    if (!Number.isFinite(options.fitHeight) || options.fitHeight <= 0) throw new RangeError("Web Cook fitHeight must be positive and finite");
    const base = options.fitBase ?? [0, 0, 0];
    const height = Math.max(1e-5, rawMax[1]! - rawMin[1]!);
    scale = options.fitHeight / height;
    offset = Object.freeze([
      base[0]! - rawCenter[0] * scale,
      base[1]! + (rawCenter[1] - rawMin[1]!) * scale - rawCenter[1] * scale,
      base[2]! - rawCenter[2] * scale
    ]) as readonly [number, number, number];
  } else if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("Web Cook scene scale must be positive and finite");
  }

  // 3. Emit fitted transforms + world bounds.
  const transforms: number[] = [], geometryIndices: number[] = [], materialIndices: number[] = [], bounds: number[] = [], boundsMin: number[] = [], boundsMax: number[] = [];
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
    materialIndices.push(instance.materialIndex);
    const base = instance.assetIndex * 128;
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
  }
  for (let index = 0; index < materials.length; index++) if (!materials[index]) materials[index] = new StandardShadeMaterial();
  const capacity = Math.min(65535, Math.max(256, assetCount * 16));
  return Object.freeze({
    materials: Object.freeze(materials),
    source: Object.freeze({
      materials,
      geometryProfiles,
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
      boundsMax: Float32Array.from(boundsMax)
    })
  });
}

function finiteScalar(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function finiteTuple(value: unknown, length: number, fallback: readonly number[]): readonly number[] { return Array.isArray(value) && value.length === length && value.every(item => typeof item === "number" && Number.isFinite(item)) ? value : fallback; }
