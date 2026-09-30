import { ShadeTransparencyMode } from "./enums.js";
import type { StandardShadeMaterial } from "./StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { compileAppearanceGraph } from "./AppearanceGraphCompiler.js";
import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";
import { lowerStandardAppearanceGraph } from "./StandardAppearanceGraph.js";

export const MATERIAL_CLOSURE_FAMILY = Object.freeze({
  Unlit: 0,
  Standard: 1,
  Coated: 2
} as const);

export const MATERIAL_FEATURE = Object.freeze({
  BaseTexture: 1 << 0,
  NormalTexture: 1 << 1,
  OrmTexture: 1 << 2,
  EmissiveTexture: 1 << 3,
  OcclusionTexture: 1 << 4,
  SpecularTexture: 1 << 5,
  SpecularColorTexture: 1 << 6,
  CoatTexture: 1 << 7,
  CoatRoughnessTexture: 1 << 8,
  CoatNormalTexture: 1 << 9
} as const);

export type MaterialTextureRole =
  | "base" | "normal" | "orm" | "emissive" | "occlusion"
  | "specular" | "specularColor" | "coat" | "coatRoughness" | "coatNormal";

export interface CanonicalTextureSample {
  readonly role: MaterialTextureRole;
  readonly texture: ShadeTexture;
  readonly colorDecode: "srgb-rgb" | "linear-rgb" | "linear-alpha";
  readonly uvSet: number;
  readonly offset: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
  /** Equal source + UV + sampler is one logical sample; channel extraction remains role specific. */
  readonly equivalentSample: number;
}

export interface CanonicalMaterial {
  readonly appearance: CompiledAppearanceGraph;
  readonly family: 0 | 1 | 2;
  readonly coverage: "opaque" | "masked" | "transparent";
  readonly featureMask: number;
  readonly samples: readonly CanonicalTextureSample[];
  readonly ior: number;
  readonly specularFactor: number;
  readonly specularColor: readonly [number, number, number];
  readonly coatFactor: number;
  readonly coatRoughness: number;
  readonly coatNormalScale: number;
}

/** Publication-time lowering of the fixed Standard/Coated material graph. */
export function compileCanonicalMaterial(material: StandardShadeMaterial): CanonicalMaterial {
  const bounded = (value: number, label: string, min: number, max: number): number => {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new RangeError(`Material '${material.name}' ${label} must be in [${min}, ${max}]`);
    }
    return value;
  };
  const ior = bounded(material.ior_factor, "ior", 1, Number.MAX_VALUE);
  const transmission = bounded(material.transmission_factor, "transmission factor", 0, 1);
  if (transmission > 0) {
    throw new Error(`Material '${material.name}' needs the independent transmission provider`);
  }
  const specularFactor = bounded(material.specular_factor, "specular factor", 0, 1);
  const specularColor: [number, number, number] = [
    bounded(material.specular_color_factor.r, "specular red", 0, 1),
    bounded(material.specular_color_factor.g, "specular green", 0, 1),
    bounded(material.specular_color_factor.b, "specular blue", 0, 1)
  ];
  const coatFactor = bounded(material.clearcoat_factor, "clearcoat factor", 0, 1);
  const coatRoughness = bounded(material.clearcoat_roughness_factor, "clearcoat roughness", 0, 1);
  const coatNormalScale = bounded(material.clearcoat_normal_scale, "clearcoat normal scale",
    -Number.MAX_VALUE, Number.MAX_VALUE);
  if (material.is_unlit && (coatFactor > 0 || specularFactor !== 1 ||
      specularColor.some((value) => value !== 1) || material.texture_specular !== undefined ||
      material.texture_specular_color !== undefined)) {
    throw new RangeError(`Material '${material.name}' cannot combine unlit with a lit closure extension`);
  }
  const family = material.is_unlit
    ? MATERIAL_CLOSURE_FAMILY.Unlit
    : coatFactor > 0 ? MATERIAL_CLOSURE_FAMILY.Coated : MATERIAL_CLOSURE_FAMILY.Standard;
  const coverage = material.transparency_mode === ShadeTransparencyMode.AlphaTested
    ? "masked" : material.transparency_mode === ShadeTransparencyMode.Transparent
      ? "transparent" : "opaque";
  if (coverage === "transparent" && (coatFactor > 0 || specularFactor !== 1 ||
      ior !== 1.5 || specularColor.some((value) => value !== 1) ||
      material.texture_specular !== undefined || material.texture_specular_color !== undefined)) {
    throw new Error(`Material '${material.name}' needs the independent transparent closure provider`);
  }

  // The graph is a finite set of typed texture leaves and factor nodes. Constant
  // zero coat removes its leaves; unlit removes all lighting-only leaves.
  const leaves: readonly [MaterialTextureRole, ShadeTexture | undefined, number,
    readonly [number, number], readonly [number, number], number, number][] = [
    ["base", material.texture_albedo, material.base_color_uv_set, material.base_color_uv_offset,
      material.base_color_uv_scale, material.base_color_uv_rotation, MATERIAL_FEATURE.BaseTexture],
    ["normal", material.is_unlit ? undefined : material.texture_normal, material.normal_uv_set,
      material.normal_uv_offset, material.normal_uv_scale, material.normal_uv_rotation, MATERIAL_FEATURE.NormalTexture],
    ["orm", material.is_unlit ? undefined : material.texture_orm, material.orm_uv_set,
      material.orm_uv_offset, material.orm_uv_scale, material.orm_uv_rotation, MATERIAL_FEATURE.OrmTexture],
    ["emissive", material.is_unlit ? undefined : material.texture_emissive, material.emissive_uv_set,
      material.emissive_uv_offset, material.emissive_uv_scale, material.emissive_uv_rotation, MATERIAL_FEATURE.EmissiveTexture],
    ["occlusion", material.is_unlit ? undefined : material.texture_occlusion, material.occlusion_uv_set,
      material.occlusion_uv_offset, material.occlusion_uv_scale, material.occlusion_uv_rotation, MATERIAL_FEATURE.OcclusionTexture],
    ["specular", material.is_unlit ? undefined : material.texture_specular, material.specular_uv_set,
      material.specular_uv_offset, material.specular_uv_scale, material.specular_uv_rotation, MATERIAL_FEATURE.SpecularTexture],
    ["specularColor", material.is_unlit ? undefined : material.texture_specular_color, material.specular_color_uv_set,
      material.specular_color_uv_offset, material.specular_color_uv_scale, material.specular_color_uv_rotation, MATERIAL_FEATURE.SpecularColorTexture],
    ["coat", coatFactor > 0 ? material.texture_clearcoat : undefined, material.clearcoat_uv_set,
      material.clearcoat_uv_offset, material.clearcoat_uv_scale, material.clearcoat_uv_rotation, MATERIAL_FEATURE.CoatTexture],
    ["coatRoughness", coatFactor > 0 ? material.texture_clearcoat_roughness : undefined,
      material.clearcoat_roughness_uv_set, material.clearcoat_roughness_uv_offset,
      material.clearcoat_roughness_uv_scale, material.clearcoat_roughness_uv_rotation,
      MATERIAL_FEATURE.CoatRoughnessTexture],
    ["coatNormal", coatFactor > 0 ? material.texture_clearcoat_normal : undefined,
      material.clearcoat_normal_uv_set, material.clearcoat_normal_uv_offset,
      material.clearcoat_normal_uv_scale, material.clearcoat_normal_uv_rotation,
      MATERIAL_FEATURE.CoatNormalTexture]
  ];
  const samples: CanonicalTextureSample[] = [];
  let featureMask = 0;
  for (const [role, texture, uvSet, offset, scale, rotation, flag] of leaves) {
    if (texture === undefined) continue;
    if (!Number.isInteger(uvSet) || uvSet < 0 || uvSet > 2 ||
        ![...offset, ...scale, rotation].every(Number.isFinite)) {
      throw new RangeError(`Material '${material.name}' ${role} has an invalid UV mapping`);
    }
    featureMask |= flag;
    const colorDecode = role === "base" || role === "emissive" || role === "specularColor"
      ? "srgb-rgb" : role === "specular" ? "linear-alpha" : "linear-rgb";
    const equal = samples.findIndex((prior) => prior.texture === texture && prior.uvSet === uvSet &&
      prior.offset[0] === offset[0] && prior.offset[1] === offset[1] &&
      prior.scale[0] === scale[0] && prior.scale[1] === scale[1] &&
      prior.rotation === rotation && prior.colorDecode === colorDecode);
    samples.push(Object.freeze({ role, texture, colorDecode, uvSet,
      offset: Object.freeze([...offset]) as readonly [number, number],
      scale: Object.freeze([...scale]) as readonly [number, number], rotation,
      equivalentSample: equal < 0 ? samples.length : samples[equal]!.equivalentSample }));
  }
  const appearance = compileAppearanceGraph(lowerStandardAppearanceGraph(material, samples));
  return Object.freeze({ family, coverage, featureMask, samples: Object.freeze(samples), appearance,
    ior, specularFactor, specularColor: Object.freeze(specularColor), coatFactor, coatRoughness, coatNormalScale });
}
