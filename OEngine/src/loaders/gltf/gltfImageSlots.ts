/**
 * gltfImageSlots：解析 glTF 数据并转换为引擎运行时对象。
 */

import type { GltfDocument, GltfMaterial, GltfTextureDef } from "./GltfLoader.js";

export function collectLoadImageSources(
  materials: GltfMaterial[] | undefined,
  textures: GltfTextureDef[] | undefined,
  loadImageSlots: string[] | undefined
): Set<number> | null {
  if (!loadImageSlots) return null;
  const a = new Set<number>();
  for (const m of materials!) {
    const pbr = m.pbrMetallicRoughness as Record<
      string,
      { index: number } | undefined
    >;
    const top = m as unknown as Record<string, { index: number } | undefined>;
    for (const g of loadImageSlots) {
      const p = top[g] ?? pbr[g];
      if (p !== undefined) {
        const texture = textures![p.index]!;
        const source = texture.extensions?.KHR_texture_basisu?.source ??
          texture.extensions?.EXT_texture_webp?.source ?? texture.source;
        if (source !== undefined) a.add(source);
      }
    }
  }
  return a;
}

export function shouldLoadImageSource(
  allowed: Set<number> | null,
  sourceIndex: number
): boolean {
  if (allowed === null) return true;
  return allowed.has(sourceIndex);
}

export const DEFAULT_GLTF_IMAGE_SLOTS = Object.freeze([
  "baseColorTexture",
  "metallicRoughnessTexture",
  "normalTexture",
  "emissiveTexture",
  "occlusionTexture"
] as const);
