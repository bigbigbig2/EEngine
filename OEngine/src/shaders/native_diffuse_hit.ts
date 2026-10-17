import type { NativeMaterialProgram } from "./native_material.js";

/** Native Surface's Lambert/metallic and coat-underlayer response in unexposed
 * linear Rec.709. Authored view inputs have already been evaluated using the
 * actual camera. Only physical outgoing response uses transport_direction. */
export function nativeDiffuseHitEvaluationWgsl(program: NativeMaterialProgram, unlit = false): string {
  const scalar = (name: string, fallback: string) => {
    const slots = program.outputs[name];
    return slots === undefined ? fallback : `values[${slots[0]}u]`;
  };
  const vector = (name: string, fallback: string) => {
    const slots = program.outputs[name];
    if (slots === undefined) {
      return fallback;
    }
    if (slots.length !== 3) {
      throw new RangeError(`Native diffuse-hit output '${name}' requires three channels`);
    }
    return `vec3f(${slots.map((slot) => `values[${slot}u]`).join(", ")})`;
  };
  return /* wgsl */ `
struct NativeDiffuseHit {
  diffuse: vec3f,
  occlusion: f32,
  emission: vec3f,
  underlayer: f32,
  normal: vec3f,
  valid: u32,
}
fn native_diffuse_safe_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let length2 = dot(value, value);
  if (length2 > 1e-20) {
    return value * inverseSqrt(length2);
  }
  return fallback;
}
fn native_diffuse_hit(material_base: u32, inputs: NativeMaterialInputs,
    basis: mat3x3f, transport_direction: vec3f) -> NativeDiffuseHit {
  let values = native_material_evaluate(material_base, inputs);
  let base = max(${vector("baseColor", "vec3f(1.0)")}, vec3f(0.0));
  ${unlit ? /* wgsl */ `
  return NativeDiffuseHit(vec3f(0.0), 1.0, base, 1.0, basis[2], 1u);` : /* wgsl */ `
  let metallic = clamp(${scalar("metallic", "0.0")}, 0.0, 1.0);
  let normal = select(basis[2], native_diffuse_safe_normal(
    basis * ${vector("normalTS", "vec3f(0.0, 0.0, 1.0)")}, basis[2]),
    ${scalar("normalTSValidity", "1.0")} > 0.5);
  let coat_normal = select(basis[2], native_diffuse_safe_normal(
    basis * ${vector("coatNormalTS", "vec3f(0.0, 0.0, 1.0)")}, basis[2]),
    ${scalar("coatNormalTSValidity", "1.0")} > 0.5);
  let outgoing = native_diffuse_safe_normal(transport_direction, normal);
  let coat_weight = clamp(${scalar("coatWeight", "0.0")}, 0.0, 1.0);
  let fresnel = (0.04 + 0.96 * pow(1.0 - clamp(dot(coat_normal, outgoing), 0.0, 1.0), 5.0)) * coat_weight;
  return NativeDiffuseHit(base * (1.0 - metallic) * 0.3183098861837907,
    clamp(${scalar("occlusion", "1.0")}, 0.0, 1.0),
    ${vector("emissive", "vec3f(0.0)")}, 1.0 - fresnel, normal, 1u);`}
}
`;
}
