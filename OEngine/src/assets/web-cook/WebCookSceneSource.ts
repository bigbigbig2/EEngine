import { ShadeDrawSide, ShadeTransparencyMode } from "../../material/enums.js";
import { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import type { GeometryProductDescriptorV1 } from "../geometry-product/GeometryProductV1.js";
import {
  buildVirtualGeometrySceneSourceV1,
  type VirtualGeometrySceneInstanceV1,
  type VirtualGeometrySceneSourceOptionsV1,
  type VirtualGeometrySceneSourceResultV1
} from "../geometry-product/VirtualGeometrySceneSourceV1.js";
import type { WebCookSceneCatalogSnapshot } from "./WebCookClient.js";
import type { VirtualGeometryGeometryProfile } from "../../gpu/GpuRenderWorld.js";
import { OEGPACK_V3_ASSET_STRIDE } from "../GeometryAbiV3.js";

export type WebCookSceneSourceOptions = VirtualGeometrySceneSourceOptionsV1 & {
  /** Catalog primitive indices represented by the Product asset table. */
  readonly sceneAssetIndices?: readonly number[];
};
export type WebCookSceneSourceResult = VirtualGeometrySceneSourceResultV1;

/**
 * Web Runtime Cooker producer adapter: maps a Cook catalog revision plus the
 * Product asset dictionary onto the producer-neutral Scene source builder.
 *
 * The Web cooker emits one Product asset per canonical domain. A subset
 * bootstrap carries an explicit catalog-index mapping; the mapping is metadata
 * only and never changes the immutable Product binary ABI.
 */
export function createWebCookSceneSource(
  catalog: WebCookSceneCatalogSnapshot,
  descriptor: Readonly<Pick<GeometryProductDescriptorV1, "assetRecords">>,
  options: WebCookSceneSourceOptions = {}
): WebCookSceneSourceResult {
  const assetCount = descriptor.assetRecords.byteLength / OEGPACK_V3_ASSET_STRIDE;
  if (assetCount === 0) throw new Error("The Web Cook Product asset dictionary must not be empty");
  const catalogIndices = options.sceneAssetIndices === undefined
    ? Array.from({ length: assetCount }, (_, index) => index)
    : [...options.sceneAssetIndices];
  if (catalogIndices.length !== assetCount || new Set(catalogIndices).size !== catalogIndices.length || catalogIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= catalog.primitives.length)) {
    throw new Error("The Web Cook Product sceneAssetIndices do not identify a unique catalog subset");
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
  const profiles: VirtualGeometryGeometryProfile[] = [];
  const instances: VirtualGeometrySceneInstanceV1[] = [];
  for (let assetIndex = 0; assetIndex < assetCount; assetIndex++) {
    const primitive = catalog.primitives[catalogIndices[assetIndex]!]!;
    const materialIndex = materialFor(primitive.materialIndex, primitive.material);
    profiles.push({
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
  for (let index = 0; index < materials.length; index++) if (!materials[index]) materials[index] = new StandardShadeMaterial();
  return buildVirtualGeometrySceneSourceV1(descriptor.assetRecords, profiles, instances, materials, options);
}

function finiteScalar(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function finiteTuple(value: unknown, length: number, fallback: readonly number[]): readonly number[] { return Array.isArray(value) && value.length === length && value.every(item => typeof item === "number" && Number.isFinite(item)) ? value : fallback; }
