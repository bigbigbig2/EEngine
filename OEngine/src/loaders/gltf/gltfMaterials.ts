/**
 * gltfMaterials：解析 glTF 数据并转换为引擎运行时对象。
 */

import { ShadeDrawSide, ShadeTransparencyMode } from "../../material/enums.js";
import { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../../texture/ShadeTexture.js";
import { TextureFilterType } from "../../texture/TextureFilterType.js";
import type { GltfMaterial, GltfTextureInfo } from "./GltfLoader.js";

export const MIPMAP_ALBEDO_EMISSIVE = TextureFilterType.MagicKernelSharp;

function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function rewriteTransparencyMode(e: StandardShadeMaterial): boolean {
  const albedoHasAlpha = (() => {
    const tex = e.texture_albedo;
    if (tex == null) return false;
    const src = (tex.image as { source?: { isSampler2D?: boolean; itemSize?: number } } | undefined)?.source;
    return src !== undefined && !(src.isSampler2D && src.itemSize! <= 3);
  })();

  if (
    e.transparency_mode !== ShadeTransparencyMode.Transparent ||
    e.diffuse_color.a !== 1 ||
    albedoHasAlpha ||
    e.transmission_factor !== 0
  ) {
    if (
      e.transparency_mode === ShadeTransparencyMode.AlphaTested &&
      !albedoHasAlpha &&
      e.diffuse_color.a === 1
    ) {
      e.transparency_mode = ShadeTransparencyMode.Opaque;
      return true;
    }
    return false;
  }
  e.transparency_mode = ShadeTransparencyMode.Opaque;
  return true;
}

export function parseGltfMaterial(e: GltfMaterial, textures: ShadeTexture[]): StandardShadeMaterial {
  for (const extension of Object.keys(e.extensions ?? {})) {
    if (
      extension.startsWith("KHR_materials_") &&
      ![
        "KHR_materials_unlit",
        "KHR_materials_emissive_strength",
        "KHR_materials_ior",
        "KHR_materials_specular",
        "KHR_materials_clearcoat",
        "KHR_materials_transmission",
      ].includes(extension)
    ) {
      throw new Error(`glTF material '${e.name ?? "<unnamed>"}' uses unsupported ${extension}`);
    }
  }
  const n = new StandardShadeMaterial();
  if (e.doubleSided === true) n.draw_side = ShadeDrawSide.Double;
  if (typeof e.name === "string") n.name = e.name;

  const pbr = e.pbrMetallicRoughness;
  const unlit = e.extensions?.KHR_materials_unlit !== undefined;
  assignUvMapping(n, "base_color", normalizeUvMapping(pbr?.baseColorTexture, e.name, "baseColorTexture"));
  if (!unlit) {
    assignUvMapping(n, "normal", normalizeUvMapping(e.normalTexture, e.name, "normalTexture"));
    const ormUv = normalizeUvMapping(pbr?.metallicRoughnessTexture, e.name, "metallicRoughnessTexture");
    const occlusionUv = normalizeUvMapping(e.occlusionTexture, e.name, "occlusionTexture");
    assignUvMapping(n, "orm", ormUv);
    assignUvMapping(n, "occlusion", occlusionUv);
    assignUvMapping(n, "emissive", normalizeUvMapping(e.emissiveTexture, e.name, "emissiveTexture"));
  }

  n.is_unlit = unlit;
  const r = unlit ? undefined : e.normalTexture;
  if (r !== undefined) {
    const tex = textures[r.index]!;
    tex.mipmapGenerationFilter = TextureFilterType.LinearNormal;
    n.texture_normal = tex;
    n.normal_scale = Number.isFinite(r.scale) ? r.scale! : 1;
  }
  const s = unlit ? undefined : e.emissiveTexture;
  if (s !== undefined) {
    const tex = textures[s.index]!;
    const img = tex.image as { color_space?: number };
    img.color_space = 1;
    tex.mipmapGenerationFilter = MIPMAP_ALBEDO_EMISSIVE;
    n.texture_emissive = tex;
  }

  if (e.emissiveFactor !== undefined) {
    n.emissive_factor.setRGB(e.emissiveFactor[0] ?? 0, e.emissiveFactor[1] ?? 0, e.emissiveFactor[2] ?? 0);
  } else {
    n.emissive_factor.setRGB(0, 0, 0);
  }
  const strength = Math.max(0, e.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1);
  n.emissive_factor.multiplyScalar(strength);

  const i = pbr;
  if (i !== undefined) {
    const base = i.baseColorFactor;
    if (base !== undefined) n.diffuse_color.fromArray(base);
    const baseTex = i.baseColorTexture;
    if (baseTex !== undefined) {
      const tex = textures[baseTex.index]!;
      const img = tex.image as { color_space?: number };
      img.color_space = 1;
      tex.mipmapGenerationFilter = MIPMAP_ALBEDO_EMISSIVE;
      n.texture_albedo = tex;
    }
    const orm = unlit ? undefined : i.metallicRoughnessTexture;
    if (orm !== undefined) {
      n.texture_orm = textures[orm.index]!;
    }
    n.roughness_factor = saturate(i.roughnessFactor ?? 1);
    n.metallic_factor = saturate(i.metallicFactor ?? 1);
  }

  const o = e.alphaMode;
  if (o === undefined || o === "OPAQUE") {
    n.transparency_mode = ShadeTransparencyMode.Opaque;
  } else if (o === "MASK") {
    n.transparency_mode = ShadeTransparencyMode.AlphaTested;
    n.alpha_cutoff = saturate(e.alphaCutoff ?? 0.5);
  } else if (o === "BLEND") {
    n.transparency_mode = ShadeTransparencyMode.Transparent;
  } else {
    console.warn(`Unknown alphaMode: ${o}, defaulting to opaque`);
    n.transparency_mode = ShadeTransparencyMode.Opaque;
  }

  const occ = unlit ? undefined : e.occlusionTexture;
  if (occ !== undefined) {
    const orm = pbr?.metallicRoughnessTexture;
    const sharesOrmSample =
      orm !== undefined &&
      orm.index === occ.index &&
      sameUvMapping(
        normalizeUvMapping(orm, e.name, "metallicRoughnessTexture"),
        normalizeUvMapping(occ, e.name, "occlusionTexture"),
      );
    if (!sharesOrmSample) n.texture_occlusion = textures[occ.index]!;
    n.ambient_factors.a = saturate(occ.strength ?? 1);
    n.ambient_factors.b = 0;
  } else {
    n.ambient_factors.b = 1;
    n.ambient_factors.a = 0;
  }

  const c = e.extensions;
  if (c !== undefined) {
    const ior = c.KHR_materials_ior;
    if (ior !== undefined && typeof ior.ior === "number") n.ior_factor = ior.ior;

    const tr = c.KHR_materials_transmission;
    if (tr !== undefined) {
      if (typeof tr.transmissionFactor === "number") {
        n.transmission_factor = saturate(tr.transmissionFactor);
      }
      if (n.transmission_factor > 0) {
        throw new Error(`glTF material '${e.name ?? "<unnamed>"}' requires a transmission provider`);
      }
    }

    const spec = c.KHR_materials_specular;
    if (spec !== undefined) {
      n.specular_factor = saturate(spec.specularFactor ?? 1);
      const rgb = spec.specularColorFactor ?? [1, 1, 1];
      n.specular_color_factor.setRGB(saturate(rgb[0] ?? 1), saturate(rgb[1] ?? 1), saturate(rgb[2] ?? 1));
      for (const [role, info] of [
        ["specular", spec.specularTexture],
        ["specular_color", spec.specularColorTexture],
      ] as const) {
        assignUvMapping(n, role, normalizeUvMapping(info, e.name, role));
        if (info !== undefined) {
          const tex = textures[info.index];
          if (tex === undefined) throw new RangeError(`Material '${e.name}' ${role} texture is missing`);
          if (role === "specular_color") {
            (tex.image as { color_space?: number }).color_space = 1;
            tex.mipmapGenerationFilter = MIPMAP_ALBEDO_EMISSIVE;
          }
          n[`texture_${role}`] = tex;
        }
      }
    }

    const coat = c.KHR_materials_clearcoat;
    if (coat !== undefined) {
      n.clearcoat_factor = saturate(coat.clearcoatFactor ?? 0);
      n.clearcoat_roughness_factor = saturate(coat.clearcoatRoughnessFactor ?? 0);
      n.clearcoat_normal_scale = Number.isFinite(coat.clearcoatNormalTexture?.scale)
        ? coat.clearcoatNormalTexture!.scale!
        : 1;
      for (const [role, info] of [
        ["clearcoat", coat.clearcoatTexture],
        ["clearcoat_roughness", coat.clearcoatRoughnessTexture],
        ["clearcoat_normal", coat.clearcoatNormalTexture],
      ] as const) {
        assignUvMapping(n, role, normalizeUvMapping(info, e.name, role));
        if (info !== undefined) {
          const tex = textures[info.index];
          if (tex === undefined) throw new RangeError(`Material '${e.name}' ${role} texture is missing`);
          if (role === "clearcoat_normal") tex.mipmapGenerationFilter = TextureFilterType.LinearNormal;
          n[`texture_${role}`] = tex;
        }
      }
    }
  }

  if (rewriteTransparencyMode(n)) {
    console.warn(`Rewrote transparency mode for material '${n.name}'`);
  }
  return n;
}

interface UvMapping {
  readonly texCoord: number;
  readonly offset: [number, number];
  readonly scale: [number, number];
  readonly rotation: number;
}

function normalizeUvMapping(
  info: GltfTextureInfo | undefined,
  materialName: string | undefined,
  role: string,
): UvMapping {
  if (info === undefined) {
    return { texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 };
  }
  const transform = info.extensions?.KHR_texture_transform;
  const texCoord = transform?.texCoord ?? info.texCoord ?? 0;
  if (!Number.isInteger(texCoord) || texCoord < 0 || texCoord > 2) {
    throw new RangeError(
      `glTF material '${materialName ?? "<unnamed>"}' ${role} requests TEXCOORD_${texCoord}; ` +
        "OEngine MaterialRecord v3 supports TEXCOORD_0, TEXCOORD_1 and TEXCOORD_2",
    );
  }
  const rotation = transform?.rotation ?? 0;
  if (!Number.isFinite(rotation)) {
    throw new RangeError(`glTF material '${materialName ?? "<unnamed>"}' ${role} UV rotation must be finite`);
  }
  return {
    texCoord,
    offset: finiteVec2(transform?.offset, [0, 0]),
    scale: finiteVec2(transform?.scale, [1, 1]),
    rotation,
  };
}

function sameUvMapping(a: UvMapping, b: UvMapping): boolean {
  return (
    a.texCoord === b.texCoord &&
    a.offset[0] === b.offset[0] &&
    a.offset[1] === b.offset[1] &&
    a.scale[0] === b.scale[0] &&
    a.scale[1] === b.scale[1] &&
    a.rotation === b.rotation
  );
}

function assignUvMapping(
  material: StandardShadeMaterial,
  role:
    | "base_color"
    | "normal"
    | "orm"
    | "occlusion"
    | "emissive"
    | "specular"
    | "specular_color"
    | "clearcoat"
    | "clearcoat_roughness"
    | "clearcoat_normal",
  mapping: UvMapping,
): void {
  material[`${role}_uv_set`] = mapping.texCoord;
  material[`${role}_uv_offset`] = mapping.offset;
  material[`${role}_uv_scale`] = mapping.scale;
  material[`${role}_uv_rotation`] = mapping.rotation;
}

function finiteVec2(value: number[] | undefined, fallback: [number, number]): [number, number] {
  const x = value?.[0];
  const y = value?.[1];
  return [Number.isFinite(x) ? x! : fallback[0], Number.isFinite(y) ? y! : fallback[1]];
}
