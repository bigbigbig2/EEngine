import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "./AppearanceGraph.js";
import type { AppearanceGraph, AppearanceRef } from "./AppearanceGraph.js";
import type { CanonicalTextureSample, MaterialTextureRole } from "./CanonicalMaterial.js";
import type { StandardShadeMaterial } from "./StandardShadeMaterial.js";

/**
 * Standard/glTF fields, before target basis construction and BRDF evaluation.
 * Base color × vertex color stays in authored evaluation order. Tangent normals
 * are unnormalized: normal scale changes XY, while signed Z remains significant.
 */
export function lowerStandardAppearanceGraph(material: StandardShadeMaterial,
  samples: readonly CanonicalTextureSample[]): AppearanceGraph {
  const g = new AppearanceGraphBuilder();
  const uv = new Map<number, AppearanceRef>();
  const leaves = new Map<MaterialTextureRole, AppearanceRef>();
  for (const sample of samples) {
    let coordinate = uv.get(sample.uvSet);
    if (coordinate === undefined) {
      coordinate = g.input(`uv${sample.uvSet}`, 2, "surface", undefined, `uv${sample.uvSet}`);
      uv.set(sample.uvSet, coordinate);
    }
    const binding = snapshotAppearanceTexture(sample.texture, sample.colorDecode,
      sample.offset, sample.scale, sample.rotation, undefined,
      sample.role === "normal" || sample.role === "coatNormal" ? [0.5, 0.5, 1, 1] : [1, 1, 1, 1]);
    leaves.set(sample.role, g.texture(binding, coordinate));
  }
  const one = g.constant(1), zero = g.constant(0);
  const leaf = (role: MaterialTextureRole, fallback: readonly number[] = [1, 1, 1, 1]): AppearanceRef =>
    leaves.get(role) ?? g.constant(fallback);
  const channel = (ref: AppearanceRef, index: number): AppearanceRef => g.swizzle(ref, [index]);
  const rgb = (ref: AppearanceRef): AppearanceRef => g.swizzle(ref, [0, 1, 2]);
  const multiply = (a: AppearanceRef, b: AppearanceRef): AppearanceRef => g.operation("multiply", a, b);
  const clamp = (a: AppearanceRef): AppearanceRef => g.operation("clamp", a, zero, one);
  const finite = (value: number, name: string): number => {
    if (!Number.isFinite(Math.fround(value))) throw new RangeError(`Material '${material.name}' ${name} must be finite f32`);
    return Math.fround(value);
  };
  const factor = (value: number, name: string): AppearanceRef => g.parameter(name, finite(value, name));
  const boundedFactor = (value: number, name: string): number => Math.min(Math.max(finite(value, name), 0), 1);
  const scaleField = (scale: number, value: AppearanceRef, name: string): AppearanceRef => {
    const f = finite(scale, name);
    // These are physical fields: constant zero is independent of finite source
    // values. This is not a generic IEEE algebra rule applied to arbitrary IR.
    return f === 0 ? zero : multiply(g.parameter(name, f), value);
  };

  const base = leaf("base");
  const color = g.input("vertexColor", 3, "geometry", { low: 0, high: 1 });
  const colorFactors = [material.diffuse_color.r, material.diffuse_color.g, material.diffuse_color.b];
  const baseChannels = colorFactors.map((value, index) => {
    const constant = finite(value, `base color ${index}`);
    return constant === 0 ? zero : multiply(multiply(g.parameter(`base color ${index}`, constant), channel(color, index)), channel(base, index));
  });
  g.output("baseColor", g.combine(...baseChannels));
  g.output("alpha", scaleField(material.diffuse_color.a, channel(base, 3), "alpha"));
  if (material.is_unlit) return g.build();

  const orm = leaf("orm");
  g.output("metallic", clamp(scaleField(boundedFactor(material.metallic_factor, "metallic"), channel(orm, 2), "metallic")));
  g.output("roughness", clamp(scaleField(boundedFactor(material.roughness_factor, "roughness"), channel(orm, 1), "roughness")));
  const ao = leaves.has("occlusion") ? leaf("occlusion") : orm;
  const strength = boundedFactor(material.ambient_factors.a, "occlusion strength");
  g.output("occlusion", strength === 0 ? one : g.operation("mix", one, channel(ao, 0), g.parameter("occlusion strength", strength, { low: 0, high: 1 })));
  g.output("emissive", g.combine(...[material.emissive_factor.r, material.emissive_factor.g, material.emissive_factor.b]
    .map((value, index) => scaleField(value, channel(leaf("emissive"), index), `emissive ${index}`))));
  const mappedNormal = (role: "normal" | "coatNormal", scale: number): AppearanceRef => {
    if (!leaves.has(role)) return g.constant([0, 0, 1]);
    const normal = rgb(leaf(role));
    const signed = g.operation("subtract", multiply(normal, g.constant(2)), one);
    const xy = finite(scale, `${role} scale`) === 0 ? g.constant([0, 0]) :
      multiply(g.swizzle(signed, [0, 1]), factor(scale, `${role} scale`));
    return g.combine(xy, channel(signed, 2));
  };
  g.output("normalTS", mappedNormal("normal", material.normal_scale));
  g.output("ior", factor(material.ior_factor, "IOR"));
  g.output("specularWeight", scaleField(material.specular_factor, channel(leaf("specular"), 3), "specular weight"));
  g.output("specularColor", g.combine(...[material.specular_color_factor.r, material.specular_color_factor.g,
    material.specular_color_factor.b].map((value, index) =>
      scaleField(value, channel(leaf("specularColor"), index), `specular color ${index}`))));
  g.output("coatWeight", scaleField(material.clearcoat_factor, channel(leaf("coat"), 0), "coat weight"));
  g.output("coatRoughness", material.clearcoat_factor > 0
    ? scaleField(material.clearcoat_roughness_factor, channel(leaf("coatRoughness"), 1), "coat roughness") : zero);
  g.output("coatNormalTS", material.clearcoat_factor > 0
    ? mappedNormal("coatNormal", material.clearcoat_normal_scale) : g.constant([0, 0, 1]));
  return g.build();
}
