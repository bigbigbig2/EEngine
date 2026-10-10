// Frozen pre-P3 EEngine math, oracle only.
export const MANUAL_OCT_WGSL = /* wgsl */ `

override OENGINE_SURFACE_NORMAL_MAX_VALUE: f32 = 65535.0;

fn oct_sign(value: vec2f) -> vec2f {
  return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0));
}

fn oct_encode(direction: vec3f) -> vec2f {
  let denominator = abs(direction.x) + abs(direction.y) + abs(direction.z);
  var projected = direction.xy / denominator;
  if (direction.z < 0.0) {
    projected = (1.0 - abs(projected.yx)) * oct_sign(projected);
  }
  return 0.5 + 0.5 * projected;
}

fn oct_decode(encoded: vec2f) -> vec3f {
  let projected = fma(encoded, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(
    projected,
    1.0 - abs(projected.x) - abs(projected.y)
  );
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}

fn decode_surface_normal(encoded: vec2u) -> vec3f {
  return oct_decode(vec2f(encoded) * (1.0 / OENGINE_SURFACE_NORMAL_MAX_VALUE));
}

fn decode_bent_normal(encoded: vec2u) -> vec3f {
  return oct_decode(vec2f(encoded) * (1.0 / 65535.0));
}

fn oct_wrap_coordinate(position: vec2i, resolution: i32) -> vec2u {
  let wrapped = ((position % resolution) + resolution) % resolution;
  let crossings_x = abs(position.x / resolution) + i32(position.x < 0);
  let crossings_y = abs(position.y / resolution) + i32(position.y < 0);
  let flip = ((crossings_x ^ crossings_y) & 1) != 0;
  return select(
    vec2u(wrapped),
    vec2u(resolution - (wrapped + vec2i(1))),
    flip
  );
}

fn bilinear_weights(fraction: vec2f) -> vec4f {
  let inverse_x = 1.0 - fraction.x;
  let inverse_y = 1.0 - fraction.y;
  return vec4f(
    inverse_x * inverse_y,
    fraction.x * inverse_y,
    inverse_x * fraction.y,
    fraction.x * fraction.y
  );
}

fn sample_octahedral_bilinear(
  source: texture_2d<f32>,
  origin: vec2u,
  resolution: u32,
  direction: vec3f,
  lod: u32
) -> vec4f {
  let uv = oct_encode(direction);
  let texel = fma(uv, vec2f(f32(resolution)), vec2f(-0.5));
  let fraction = fract(texel);
  let base = vec2i(floor(texel));
  let c00 = oct_wrap_coordinate(base, i32(resolution));
  let c10 = oct_wrap_coordinate(base + vec2i(1, 0), i32(resolution));
  let c01 = oct_wrap_coordinate(base + vec2i(0, 1), i32(resolution));
  let c11 = oct_wrap_coordinate(base + vec2i(1, 1), i32(resolution));
  let weights = bilinear_weights(fraction);
  return textureLoad(source, vec2i(origin + c00), i32(lod)) * weights.x +
    textureLoad(source, vec2i(origin + c10), i32(lod)) * weights.y +
    textureLoad(source, vec2i(origin + c01), i32(lod)) * weights.z +
    textureLoad(source, vec2i(origin + c11), i32(lod)) * weights.w;
}

fn sample_prefiltered_environment(
  source: texture_2d<f32>,
  direction: vec3f,
  roughness: f32
) -> vec3f {
  let max_mip = textureNumLevels(source) - 1u;
  let perceptual = clamp(roughness, 0.0, 1.0);
  let lod = perceptual * (2.0 - perceptual) * f32(max_mip);
  let lower = u32(floor(lod));
  let blend = fract(lod);
  let lower_sample = sample_octahedral_bilinear(
    source,
    vec2u(0u),
    textureDimensions(source, i32(lower)).x,
    direction,
    lower
  ).rgb;
  let upper = min(lower + 1u, max_mip);
  let upper_sample = sample_octahedral_bilinear(
    source,
    vec2u(0u),
    textureDimensions(source, i32(upper)).x,
    direction,
    upper
  ).rgb;
  return mix(lower_sample, upper_sample, blend);
}
`;
export const MANUAL_DFG_WGSL = /* wgsl */ `
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
