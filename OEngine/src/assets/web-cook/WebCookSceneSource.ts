import { ShadeDrawSide, ShadeTransparencyMode } from "../../material/enums.js";
import { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import { ShadeImage, ShadeTexture } from "../../texture/ShadeTexture.js";
import { TextureFilterType } from "../../texture/TextureFilterType.js";
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
export type WebCookImageReader = (imageIndex: number, signal?: AbortSignal) => Promise<{ readonly bytes: ArrayBuffer; readonly mimeType?: string }>;

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

/**
 * Async Web route mapper. Image bytes are fetched/decoded before the caller
 * enters the existing GpuRenderWorld transaction; no partially textured
 * material can become an active Product revision.
 */
export async function createWebCookSceneSourceAsync(
  catalog: WebCookSceneCatalogSnapshot,
  descriptor: Readonly<Pick<GeometryProductDescriptorV1, "assetRecords">>,
  readImage: WebCookImageReader,
  signal?: AbortSignal,
  options: WebCookSceneSourceOptions = {}
): Promise<WebCookSceneSourceResult> {
  const assetCount = descriptor.assetRecords.byteLength / OEGPACK_V3_ASSET_STRIDE;
  if (assetCount === 0) throw new Error("The Web Cook Product asset dictionary must not be empty");
  const catalogIndices = sceneAssetIndices(catalog, assetCount, options.sceneAssetIndices);
  const materialByIndex = new Map<number, StandardShadeMaterial>();
  const textureByIndex = new Map<number, Promise<ShadeTexture>>();
  const textureFor = (textureIndex: number): Promise<ShadeTexture> => {
    let pending = textureByIndex.get(textureIndex);
    if (!pending) {
      const info = catalog.textures.find(value => value.textureIndex === textureIndex);
      if (!info) throw new Error(`Web Cook material references missing texture ${textureIndex}`);
      const imageInfo = catalog.images.find(value => value.imageIndex === info.sourceIndex);
      if (!imageInfo) throw new Error(`Web Cook texture ${textureIndex} references missing image ${info.sourceIndex}`);
      pending = readImage(info.sourceIndex, signal).then(async payload => {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
        const blob = new Blob([payload.bytes], { type: payload.mimeType ?? imageInfo.mimeType ?? "application/octet-stream" });
        if (typeof createImageBitmap !== "function") throw new Error("Web Cook authored textures require createImageBitmap support");
        const bitmap = await createImageBitmap(blob);
        const image = ShadeImage.fromImageBitmap(bitmap);
        const texture = ShadeTexture.from(image);
        texture.magFilter = filterValue(info.sampler.magFilter, false);
        texture.minFilter = filterValue(info.sampler.minFilter, false);
        texture.mipmapFilter = filterValue(info.sampler.minFilter, true);
        texture.wrapS = wrapValue(info.sampler.wrapS);
        texture.wrapT = wrapValue(info.sampler.wrapT);
        return texture;
      });
      textureByIndex.set(textureIndex, pending);
    }
    return pending;
  };
  const materialFor = async (index: number, value: Readonly<Record<string, unknown>>): Promise<number> => {
    const key = index === 0xffffffff ? 0 : index;
    if (materialByIndex.has(key)) return key;
    const material = createMaterial(value);
    materialByIndex.set(key, material);
    if (value.baseColorTexture && typeof value.baseColorTexture === "object") {
      const slot = value.baseColorTexture as Readonly<Record<string, unknown>>;
      material.texture_albedo = await textureFor(requireTextureIndex(slot, "baseColorTexture"));
      applyUv(material, "base_color", slot);
      material.texture_albedo.image!.color_space = 1;
    }
    if (!material.is_unlit) {
      const normal = value.normalTexture;
      if (normal && typeof normal === "object") { const slot = normal as Readonly<Record<string, unknown>>; material.texture_normal = await textureFor(requireTextureIndex(slot, "normalTexture")); applyUv(material, "normal", slot); material.normal_scale = finiteScalar(slot.normalScale, 1); material.texture_normal.mipmapGenerationFilter = TextureFilterType.LinearNormal; }
      const orm = value.metallicRoughnessTexture;
      if (orm && typeof orm === "object") { const slot = orm as Readonly<Record<string, unknown>>; material.texture_orm = await textureFor(requireTextureIndex(slot, "metallicRoughnessTexture")); applyUv(material, "orm", slot); }
      const occlusion = value.occlusionTexture;
      if (occlusion && typeof occlusion === "object") { const slot = occlusion as Readonly<Record<string, unknown>>; material.texture_occlusion = await textureFor(requireTextureIndex(slot, "occlusionTexture")); applyUv(material, "occlusion", slot); material.ambient_factors.a = finiteScalar(slot.occlusionStrength, 1); }
      const emissive = value.emissiveTexture;
      if (emissive && typeof emissive === "object") { const slot = emissive as Readonly<Record<string, unknown>>; material.texture_emissive = await textureFor(requireTextureIndex(slot, "emissiveTexture")); applyUv(material, "emissive", slot); material.texture_emissive.image!.color_space = 1; }
    } else if (value.emissiveTexture && typeof value.emissiveTexture === "object") {
      const slot = value.emissiveTexture as Readonly<Record<string, unknown>>; material.texture_emissive = await textureFor(requireTextureIndex(slot, "emissiveTexture")); applyUv(material, "emissive", slot); material.texture_emissive.image!.color_space = 1;
    }
    return key;
  };
  const materials: StandardShadeMaterial[] = [];
  const materialIndices: number[] = [];
  for (const catalogIndex of catalogIndices) {
    const primitive = catalog.primitives[catalogIndex]!;
    const materialIndex = await materialFor(primitive.materialIndex, primitive.material);
    materialIndices.push(materialIndex);
  }
  for (const [index, material] of materialByIndex) materials[index] = material;
  for (let index = 0; index < materials.length; index++) if (!materials[index]) materials[index] = new StandardShadeMaterial();
  const { profiles, instances } = buildProfilesAndInstances(catalog, catalogIndices, materialIndices);
  return buildVirtualGeometrySceneSourceV1(descriptor.assetRecords, profiles, instances, materials, options);
}

function sceneAssetIndices(catalog: WebCookSceneCatalogSnapshot, assetCount: number, requested?: readonly number[]): number[] {
  const values = requested === undefined ? Array.from({ length: assetCount }, (_, index) => index) : [...requested];
  if (values.length !== assetCount || new Set(values).size !== values.length || values.some(index => !Number.isSafeInteger(index) || index < 0 || index >= catalog.primitives.length)) throw new Error("The Web Cook Product sceneAssetIndices do not identify a unique catalog subset");
  return values;
}

function createMaterial(value: Readonly<Record<string, unknown>>): StandardShadeMaterial {
  const material = new StandardShadeMaterial();
  const base = finiteTuple(value.baseColorFactor, 4, [1, 1, 1, 1]); material.diffuse_color.set(base[0]!, base[1]!, base[2]!, base[3]!);
  material.metallic_factor = finiteScalar(value.metallicFactor, 0); material.roughness_factor = finiteScalar(value.roughnessFactor, 1);
  const emissive = finiteTuple(value.emissiveFactor, 3, [0, 0, 0]); material.emissive_factor.set(emissive[0]!, emissive[1]!, emissive[2]!);
  material.alpha_cutoff = finiteScalar(value.alphaCutoff, 0.5); material.is_unlit = value.unlit === true;
  material.draw_side = value.doubleSided === true ? ShadeDrawSide.Double : ShadeDrawSide.Front;
  material.transparency_mode = value.alphaMode === "MASK" ? ShadeTransparencyMode.AlphaTested : value.alphaMode === "BLEND" ? ShadeTransparencyMode.Transparent : ShadeTransparencyMode.Opaque;
  return material;
}

function buildProfilesAndInstances(catalog: WebCookSceneCatalogSnapshot, catalogIndices: readonly number[], materialIndices: readonly number[]): { profiles: VirtualGeometryGeometryProfile[]; instances: VirtualGeometrySceneInstanceV1[] } {
  const instanceByNode = new Map(catalog.instances.map(item => [item.nodeIndex, item]));
  const profiles: VirtualGeometryGeometryProfile[] = []; const instances: VirtualGeometrySceneInstanceV1[] = [];
  for (let assetIndex = 0; assetIndex < catalogIndices.length; assetIndex++) {
    const primitive = catalog.primitives[catalogIndices[assetIndex]!]!;
    profiles.push({ hasAuthoredVertexColor: primitive.attributeSemantics.includes("COLOR_0"), hasUv0: primitive.attributeSemantics.includes("TEXCOORD_0"), hasUv1: primitive.attributeSemantics.includes("TEXCOORD_1"), hasUv2: false, hasNormal: true, hasTangent: primitive.attributeSemantics.includes("TANGENT") });
    for (const nodeIndex of primitive.instanceNodeIndices) { const instance = instanceByNode.get(nodeIndex); if (!instance) throw new Error(`Web Cook Product instance node ${nodeIndex} is missing from the GLB catalog`); instances.push({ assetIndex, materialIndex: materialIndices[assetIndex]!, transform: Float32Array.from(instance.worldMatrix) }); }
  }
  return { profiles, instances };
}

function requireTextureIndex(slot: Readonly<Record<string, unknown>>, role: string): number { const value = slot.textureIndex; if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Web Cook ${role} texture index is invalid`); return value as number; }
function applyUv(material: StandardShadeMaterial, role: "base_color" | "normal" | "orm" | "occlusion" | "emissive", slot: Readonly<Record<string, unknown>>): void { const texCoord = Number.isSafeInteger(slot.texCoord) ? slot.texCoord as number : 0; const offset = finiteTuple(slot.offset, 2, [0, 0]); const scale = finiteTuple(slot.scale, 2, [1, 1]); const rotation = finiteScalar(slot.rotation, 0); material[`${role}_uv_set`] = texCoord; material[`${role}_uv_offset`] = [offset[0]!, offset[1]!]; material[`${role}_uv_scale`] = [scale[0]!, scale[1]!]; material[`${role}_uv_rotation`] = rotation; }
function filterValue(value: number | undefined, mipmap: boolean): number { if (value === 9728 || value === 9984 || value === 9986) return TextureFilterType.Nearest; return TextureFilterType.Linear; }
function wrapValue(value: number | undefined): number { return value === 33071 ? 0 : value === 33648 ? 2 : 1; }

function finiteScalar(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function finiteTuple(value: unknown, length: number, fallback: readonly number[]): readonly number[] { return Array.isArray(value) && value.length === length && value.every(item => typeof item === "number" && Number.isFinite(item)) ? value : fallback; }
