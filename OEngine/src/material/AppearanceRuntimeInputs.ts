import type { StandardShadeMaterial } from "./StandardShadeMaterial.js";

export type AppearanceDynamicValue = readonly [number, number?, number?, number?];

/** Frame inputs are numeric data. Mutation does not change program topology,
 * allocate GPU resources or require Scene resync. */
export class AppearanceRuntimeInputs {
  private readonly values = new Map<string, Float32Array>();
  private readonly versions = new Map<string, number>();
  set(name: string, value: AppearanceDynamicValue): void {
    if (!name || value.length > 4 || !value.every(v => v !== undefined && Number.isFinite(Math.fround(v)))) {
      throw new RangeError("Appearance dynamic input must be a named finite vector");
    }
    const previous = this.values.get(name);
    const next = Float32Array.from(value as readonly number[]);
    if (previous?.length === next.length && previous.every((v, i) => Object.is(v, next[i]))) return;
    this.values.set(name, next);
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
  }
  get(name: string): Float32Array | undefined { return this.values.get(name); }
  version(name: string): number { return this.versions.get(name) ?? 0; }
  copy(other: AppearanceRuntimeInputs): void {
    this.values.clear(); this.versions.clear();
    for (const [name, value] of other.values) this.values.set(name, value.slice());
    for (const [name, version] of other.versions) this.versions.set(name, version);
  }
}

/** Named Standard parameters match StandardAppearanceGraph's authoritative
 * publication names. Values are read once at the frame boundary. */
export function standardAppearanceParameters(material: StandardShadeMaterial): ReadonlyMap<string, number> {
  const p = new Map<string, number>();
  [material.diffuse_color.r, material.diffuse_color.g, material.diffuse_color.b]
    .forEach((v, i) => p.set(`base color ${i}`, v));
  [material.emissive_factor.r, material.emissive_factor.g, material.emissive_factor.b]
    .forEach((v, i) => p.set(`emissive ${i}`, v));
  [material.specular_color_factor.r, material.specular_color_factor.g, material.specular_color_factor.b]
    .forEach((v, i) => p.set(`specular color ${i}`, v));
  for (const [name, value] of [
    ["alpha", material.diffuse_color.a], ["metallic", material.metallic_factor],
    ["roughness", material.roughness_factor], ["occlusion strength", material.ambient_factors.a],
    ["normal scale", material.normal_scale], ["coatNormal scale", material.clearcoat_normal_scale],
    ["IOR", material.ior_factor], ["specular weight", material.specular_factor],
    ["coat weight", material.clearcoat_factor], ["coat roughness", material.clearcoat_roughness_factor]
  ] as const) p.set(name, value);
  return p;
}
