/** Filament 41f996de8fcc2d6b60b73159aa1bc44a05a40700, Apache-2.0:
 * surface_light_indirect.fs::specularDFG / evaluateClearCoatIBL.
 * The production LUT stores (Fc, total visibility), not split-sum (A, B).
 * Single scattering is deliberate: no unrelated multiple-scattering profile change.
 * Manual bilinear DFG sampling adds three loads, with no new sampler/binding/pass.
 */
export const ENVIRONMENT_BRDF_WGSL = /* wgsl */ `
fn sample_environment_dfg(lut: texture_2d<f32>, no_v: f32, roughness: f32) -> vec2f {
  let dimensions = vec2i(textureDimensions(lut));
  let position = clamp(vec2f(no_v, roughness), vec2f(0.0), vec2f(1.0)) *
    vec2f(dimensions) - vec2f(0.5);
  let lower = vec2i(floor(position));
  let weight = fract(position);
  let maximum = dimensions - vec2i(1);
  let a = textureLoad(lut, clamp(lower, vec2i(0), maximum), 0).xy;
  let b = textureLoad(lut, clamp(lower + vec2i(1, 0), vec2i(0), maximum), 0).xy;
  let c = textureLoad(lut, clamp(lower + vec2i(0, 1), vec2i(0), maximum), 0).xy;
  let d = textureLoad(lut, clamp(lower + vec2i(1, 1), vec2i(0), maximum), 0).xy;
  return mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y);
}

fn environment_dfg_single_scatter(dfg: vec2f, f0: vec3f) -> vec3f {
  return mix(vec3f(dfg.x), vec3f(dfg.y), f0);
}

fn environment_clearcoat_fresnel(no_v: f32, weight: f32) -> f32 {
  return (0.04 + 0.96 * pow(1.0 - clamp(no_v, 0.0, 1.0), 5.0)) * weight;
}
`;
