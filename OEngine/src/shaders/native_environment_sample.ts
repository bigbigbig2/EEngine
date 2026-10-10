import { OCTAHEDRAL_MAPPING_WGSL } from "./environment_ibl.js";

/** Exact native bilinear support is only [-1, size] on each axis, including
 * 1x1 and NPOT mips. Preserve the original f32 weights and four loads, but
 * replace general modulo/division with bounded coordinate folding. */
export const NATIVE_ENVIRONMENT_SAMPLE_WGSL = /* wgsl */ `
${OCTAHEDRAL_MAPPING_WGSL}
fn native_oct_neighbor(position: vec2i, size: i32) -> vec2i {
  let negative = position < vec2i(0);
  let positive = position >= vec2i(size);
  let outside = position != clamp(position, vec2i(0), vec2i(size - 1));
  let wrapped = position + select(vec2i(0), vec2i(size), negative) -
    select(vec2i(0), vec2i(size), positive);
  // At size==1 all addresses map to zero even though the original integer
  // division counts the negative boundary twice. No identity is truncated.
  return select(wrapped, vec2i(size - 1) - wrapped, outside.x != outside.y);
}

fn sample_native_environment_mip(
  source: texture_2d<f32>,
  direction: vec3f,
  level: u32
) -> vec3f {
  let size = textureDimensions(source, i32(level)).x;
  let uv = oct_encode(direction);
  let texel = fma(uv, vec2f(f32(size)), vec2f(-0.5));
  let lower = vec2i(floor(texel));
  let weights = bilinear_weights(fract(texel));
  let a = native_oct_neighbor(lower, i32(size));
  let b = native_oct_neighbor(lower + vec2i(1, 0), i32(size));
  let c = native_oct_neighbor(lower + vec2i(0, 1), i32(size));
  let d = native_oct_neighbor(lower + vec2i(1, 1), i32(size));
  return (textureLoad(source, a, i32(level)) * weights.x +
    textureLoad(source, b, i32(level)) * weights.y +
    textureLoad(source, c, i32(level)) * weights.z +
    textureLoad(source, d, i32(level)) * weights.w).rgb;
}

fn sample_native_environment(
  source: texture_2d<f32>,
  direction: vec3f,
  roughness: f32
) -> vec3f {
  let max_mip = textureNumLevels(source) - 1u;
  let perceptual = clamp(roughness, 0.0, 1.0);
  let lod = perceptual * (2.0 - perceptual) * f32(max_mip);
  let lower = u32(floor(lod));
  let upper = min(lower + 1u, max_mip);
  let a = sample_native_environment_mip(source, direction, lower);
  let b = sample_native_environment_mip(source, direction, upper);
  return mix(a, b, fract(lod));
}
`;
