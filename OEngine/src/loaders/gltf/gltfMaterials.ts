/**
 * gltfMaterials：解析 glTF 数据并转换为引擎运行时对象。
 */

import { Color } from "../../core/Color.js";
import { ShadeDrawSide, ShadeTransparencyMode } from "../../material/enums.js";
import { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../../texture/ShadeTexture.js";
import { TextureFilterType } from "../../texture/TextureFilterType.js";
import type { GltfMaterial, GltfTextureInfo } from "./GltfLoader.js";

export const MIPMAP_ALBEDO_EMISSIVE = TextureFilterType.MagicKernelSharp;

export const DIELECTRIC_F0 = Object.freeze(new Color(0.04, 0.04, 0.04, 1));

const EPS_U = 1e-6;

function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function mix(e: number, t: number, n: number): number {
  return (t - e) * n + e;
}

export function colorLumaSqrt(e: { r: number; g: number; b: number }): number {
  const t = e.r;
  const n = e.g;
  const r = e.b;
  return Math.sqrt(t * t * 0.299 + n * n * 0.587 + r * r * 0.114);
}

export function specularGlossinessToMetallicRoughness(
  diffuse: Color,
  specular: Color,
  glossiness: number
): { base_color: Color; metallic: number; roughness: number } {
  const r = 1 - Math.max(specular.r, specular.g, specular.b);
  let s: number;
  {
    const t = colorLumaSqrt(specular);
    const e = colorLumaSqrt(diffuse);
    const n = r;
    if (t < DIELECTRIC_F0.r) {
      s = 0;
    } else {
      const r0 = DIELECTRIC_F0.r;
      const sLin = (e * n) / (1 - DIELECTRIC_F0.r) + t - 2 * DIELECTRIC_F0.r;
      const a = Math.max(sLin * sLin - 4 * r0 * (DIELECTRIC_F0.r - t), 0);
      s = saturate((-sLin + Math.sqrt(a)) / (2 * r0));
    }
  }
  const a = r / (1 - DIELECTRIC_F0.r) / Math.max(1 - s, EPS_U);
  const i = s * s;
  const o = DIELECTRIC_F0.r * (1 - s);
  const invS = 1 / Math.max(s, EPS_U);
  const base = new Color(
    saturate(mix(diffuse.r * a, (specular.r - o) * invS, i)),
    saturate(mix(diffuse.g * a, (specular.g - o) * invS, i)),
    saturate(mix(diffuse.b * a, (specular.b - o) * invS, i)),
    diffuse.a
  );
  return {
    base_color: base,
    metallic: s,
    roughness: 1 - glossiness
  };
}

export const l_ = specularGlossinessToMetallicRoughness;
export const d_ = colorLumaSqrt;

export function rewriteTransparencyMode(e: StandardShadeMaterial): boolean {
  const albedoHasAlpha = (() => {
    const tex = e.texture_albedo;
    if (tex == null) return false;
    const src = (
      tex.image as { source?: { isSampler2D?: boolean; itemSize?: number } } | undefined
    )?.source;
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

export function parseGltfMaterial(
  e: GltfMaterial,
  textures: ShadeTexture[]
): StandardShadeMaterial {
  const n = new StandardShadeMaterial();
  if (e.doubleSided === true) n.draw_side = ShadeDrawSide.Double;
  if (typeof e.name === "string") n.name = e.name;

  const pbr = e.pbrMetallicRoughness;
  const unlit = e.extensions?.KHR_materials_unlit !== undefined;
  if (!unlit) validateOcclusionTextureContract(e);
  assignUvMapping(n, "base_color", normalizeUvMapping(
    pbr?.baseColorTexture, e.name, "baseColorTexture"
  ));
  if (!unlit) {
    assignUvMapping(n, "normal", normalizeUvMapping(
      e.normalTexture, e.name, "normalTexture"
    ));
    const ormUv = normalizeUvMapping(
      pbr?.metallicRoughnessTexture, e.name, "metallicRoughnessTexture"
    );
    const occlusionUv = normalizeUvMapping(
      e.occlusionTexture, e.name, "occlusionTexture"
    );
    if (
      pbr?.metallicRoughnessTexture !== undefined &&
      e.occlusionTexture !== undefined &&
      !sameUvMapping(ormUv, occlusionUv)
    ) {
      throw new Error(
        `glTF material '${e.name ?? "<unnamed>"}' uses one packed ORM texture with ` +
        "different metallicRoughnessTexture and occlusionTexture UV mappings"
      );
    }
    assignUvMapping(n, "orm", pbr?.metallicRoughnessTexture === undefined ? occlusionUv : ormUv);
    assignUvMapping(n, "emissive", normalizeUvMapping(
      e.emissiveTexture, e.name, "emissiveTexture"
    ));
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
    n.emissive_factor.setRGB(
      e.emissiveFactor[0] ?? 0,
      e.emissiveFactor[1] ?? 0,
      e.emissiveFactor[2] ?? 0
    );
  } else {
    n.emissive_factor.setRGB(0, 0, 0);
  }
  const strength = Math.max(
    0,
    e.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1
  );
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
    n.ambient_factors.a = saturate(occ.strength ?? 1);
    n.ambient_factors.b = 0;
  } else {
    n.ambient_factors.b = 1;
    n.ambient_factors.a = 0;
  }

  const c = e.extensions;
  if (c !== undefined) {
    const sg = c.KHR_materials_pbrSpecularGlossiness as
      | {
          diffuseFactor?: number[];
          specularFactor?: number[];
          glossinessFactor?: number;
        }
      | undefined;
    if (sg !== undefined) {
      const eCol = new Color();
      const rCol = new Color();
      let gloss = 0;
      if (sg.diffuseFactor !== undefined) eCol.fromArray(sg.diffuseFactor);
      if (sg.specularFactor !== undefined) {
        rCol.setRGB(
          sg.specularFactor[0] ?? 0,
          sg.specularFactor[1] ?? 0,
          sg.specularFactor[2] ?? 0
        );
      }
      if (sg.glossinessFactor !== undefined) gloss = sg.glossinessFactor;
      const conv = specularGlossinessToMetallicRoughness(eCol, rCol, gloss);
      n.diffuse_color.copy(conv.base_color);
    }

    const ior = c.KHR_materials_ior;
    if (ior !== undefined && typeof ior.ior === "number") n.ior_factor = ior.ior;

    const tr = c.KHR_materials_transmission;
    if (tr !== undefined) {
      if (typeof tr.transmissionFactor === "number") {
        n.transmission_factor = saturate(tr.transmissionFactor);
      }
      if (n.transmission_factor > 0) {
        n.transparency_mode = ShadeTransparencyMode.Transparent;
      }
    }

    const spec = c.KHR_materials_specular as
      | {
          specularFactor?: number;
          specularColorFactor?: number[];
        }
      | undefined;
    if (spec !== undefined) {
      const t = spec.specularFactor ?? 1;
      const rgb = spec.specularColorFactor ?? [1, 1, 1];
      const rCol = new Color(rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1, 1);
      rCol.multiplyScalar(t);
      const conv = specularGlossinessToMetallicRoughness(
        n.diffuse_color,
        rCol,
        1 - n.roughness_factor
      );
      if (e.pbrMetallicRoughness?.baseColorFactor === undefined) {
        n.diffuse_color.copy(conv.base_color);
      }
    }
  }

  if (rewriteTransparencyMode(n)) {
    console.warn(`Rewrote transparency mode for material '${n.name}'`);
  }
  return n;
}

function validateOcclusionTextureContract(material: GltfMaterial): void {
  const occlusion = material.occlusionTexture;
  if (occlusion === undefined) return;
  const metallicRoughness = material.pbrMetallicRoughness?.metallicRoughnessTexture;
  const name = material.name ?? "<unnamed>";
  if (metallicRoughness === undefined) {
    throw new Error(
      `glTF material '${name}' occlusionTexture requires metallicRoughnessTexture; ` +
      "OEngine MaterialRecord v2 supports only a shared ORM texture"
    );
  }
  if (occlusion.index !== metallicRoughness.index) {
    throw new Error(
      `glTF material '${name}' occlusionTexture must use the same texture index as ` +
      "metallicRoughnessTexture; separate occlusion textures are unsupported"
    );
  }
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
  role: string
): UvMapping {
  if (info === undefined) {
    return { texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 };
  }
  const transform = info.extensions?.KHR_texture_transform;
  const texCoord = transform?.texCoord ?? info.texCoord ?? 0;
  if (!Number.isInteger(texCoord) || texCoord < 0 || texCoord > 2) {
    throw new RangeError(
      `glTF material '${materialName ?? "<unnamed>"}' ${role} requests TEXCOORD_${texCoord}; ` +
      "OEngine MaterialRecord v3 supports TEXCOORD_0, TEXCOORD_1 and TEXCOORD_2"
    );
  }
  const rotation = transform?.rotation ?? 0;
  if (!Number.isFinite(rotation)) {
    throw new RangeError(
      `glTF material '${materialName ?? "<unnamed>"}' ${role} UV rotation must be finite`
    );
  }
  return {
    texCoord,
    offset: finiteVec2(transform?.offset, [0, 0]),
    scale: finiteVec2(transform?.scale, [1, 1]),
    rotation
  };
}

function sameUvMapping(a: UvMapping, b: UvMapping): boolean {
  return a.texCoord === b.texCoord &&
    a.offset[0] === b.offset[0] && a.offset[1] === b.offset[1] &&
    a.scale[0] === b.scale[0] && a.scale[1] === b.scale[1] &&
    a.rotation === b.rotation;
}

function assignUvMapping(
  material: StandardShadeMaterial,
  role: "base_color" | "normal" | "orm" | "emissive",
  mapping: UvMapping
): void {
  material[`${role}_uv_set`] = mapping.texCoord;
  material[`${role}_uv_offset`] = mapping.offset;
  material[`${role}_uv_scale`] = mapping.scale;
  material[`${role}_uv_rotation`] = mapping.rotation;
}

function finiteVec2(
  value: number[] | undefined,
  fallback: [number, number]
): [number, number] {
  const x = value?.[0];
  const y = value?.[1];
  return [
    Number.isFinite(x) ? x! : fallback[0],
    Number.isFinite(y) ? y! : fallback[1]
  ];
}
