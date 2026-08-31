/**
 * FX-03 environment convolution. The mathematical invariants come from
 * Filament CubemapIBL.cpp; octahedral storage is an OEngine/WebGPU adaptation.
 */
export const ENVIRONMENT_PREFILTER_WORKGROUP_SIZE = 8;
export const ENVIRONMENT_SPECULAR_SAMPLE_COUNT = 128;
export const ENVIRONMENT_DIFFUSE_SAMPLE_COUNT = 256;

export const ENVIRONMENT_PREFILTER_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265358979323846;
struct FilterParameters { roughness: f32, sample_count: u32, source_resolution: u32, _padding: u32, };
@group(0) @binding(0) var<uniform> parameters: FilterParameters;
@group(0) @binding(1) var source_environment: texture_2d<f32>;
@group(0) @binding(2) var output_environment: texture_storage_2d<rgba16float, write>;

fn saturate(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }
fn radical_inverse_vdc(value: u32) -> f32 { return f32(reverseBits(value)) * 2.3283064365386963e-10; }
fn hammersley(index: u32, count: u32) -> vec2f { return vec2f(f32(index) / f32(count), radical_inverse_vdc(index)); }

fn build_basis(normal: vec3f) -> mat3x3f {
  let sign = select(-1.0, 1.0, normal.z >= 0.0);
  let a = -1.0 / (sign + normal.z);
  let b = normal.x * normal.y * a;
  return mat3x3f(
    vec3f(1.0 + sign * normal.x * normal.x * a, sign * b, -sign * normal.x),
    vec3f(b, sign + normal.y * normal.y * a, -normal.y), normal);
}

fn importance_sample_ggx(sample: vec2f, normal: vec3f, alpha: f32) -> vec3f {
  let phi = 2.0 * PI * sample.x;
  let alpha2 = alpha * alpha;
  let cos_theta = sqrt((1.0 - sample.y) / max(1.0 + (alpha2 - 1.0) * sample.y, 1e-6));
  let sin_theta = sqrt(max(1.0 - cos_theta * cos_theta, 0.0));
  return normalize(build_basis(normal) * vec3f(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta));
}

fn cosine_sample_hemisphere(sample: vec2f, normal: vec3f) -> vec3f {
  let radius = sqrt(sample.x);
  let phi = 2.0 * PI * sample.y;
  return normalize(build_basis(normal) * vec3f(radius * cos(phi), radius * sin(phi), sqrt(max(1.0 - sample.x, 0.0))));
}

fn oct_sign(value: vec2f) -> vec2f { return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0)); }
fn oct_decode(uv: vec2f) -> vec3f {
  let projected = uv * 2.0 - 1.0;
  var direction = vec3f(projected, 1.0 - abs(projected.x) - abs(projected.y));
  let fold = max(-direction.z, 0.0);
  direction.x += select(fold, -fold, direction.x > 0.0);
  direction.y += select(fold, -fold, direction.y > 0.0);
  return normalize(direction);
}
fn oct_encode(direction: vec3f) -> vec2f {
  var projected = direction.xy / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if direction.z < 0.0 { projected = (1.0 - abs(projected.yx)) * oct_sign(projected); }
  return projected * 0.5 + 0.5;
}
fn oct_wrap(position: vec2i, resolution: i32) -> vec2u {
  let wrapped = ((position % resolution) + resolution) % resolution;
  let crossings_x = abs(position.x / resolution) + i32(position.x < 0);
  let crossings_y = abs(position.y / resolution) + i32(position.y < 0);
  let flip = ((crossings_x ^ crossings_y) & 1) != 0;
  return select(vec2u(wrapped), vec2u(resolution - (wrapped + vec2i(1))), flip);
}
fn sample_source(direction: vec3f) -> vec3f {
  let resolution = max(parameters.source_resolution, 1u);
  let texel = oct_encode(direction) * f32(resolution) - 0.5;
  let base = vec2i(floor(texel));
  let fraction = fract(texel);
  let c00 = textureLoad(source_environment, vec2i(oct_wrap(base, i32(resolution))), 0).rgb;
  let c10 = textureLoad(source_environment, vec2i(oct_wrap(base + vec2i(1, 0), i32(resolution))), 0).rgb;
  let c01 = textureLoad(source_environment, vec2i(oct_wrap(base + vec2i(0, 1), i32(resolution))), 0).rgb;
  let c11 = textureLoad(source_environment, vec2i(oct_wrap(base + vec2i(1, 1), i32(resolution))), 0).rgb;
  return mix(mix(c00, c10, fraction.x), mix(c01, c11, fraction.x), fraction.y);
}
fn output_direction(id: vec2u) -> vec3f {
  return oct_decode((vec2f(id) + 0.5) / vec2f(textureDimensions(output_environment)));
}

@compute @workgroup_size(8, 8, 1)
fn prefilter_specular(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output_environment);
  if any(id.xy >= size) { return; }
  let normal = output_direction(id.xy);
  let alpha = max(parameters.roughness * parameters.roughness, 1e-4);
  var radiance = vec3f(0.0);
  var weight = 0.0;
  for (var index = 0u; index < parameters.sample_count; index++) {
    let half_vector = importance_sample_ggx(hammersley(index, parameters.sample_count), normal, alpha);
    let light = normalize(2.0 * dot(normal, half_vector) * half_vector - normal);
    let no_l = saturate(dot(normal, light));
    if no_l > 0.0 { radiance += sample_source(light) * no_l; weight += no_l; }
  }
  textureStore(output_environment, id.xy, vec4f(radiance / max(weight, 1e-5), 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn convolve_diffuse(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output_environment);
  if any(id.xy >= size) { return; }
  let normal = output_direction(id.xy);
  var radiance = vec3f(0.0);
  for (var index = 0u; index < parameters.sample_count; index++) {
    radiance += sample_source(cosine_sample_hemisphere(hammersley(index, parameters.sample_count), normal));
  }
  textureStore(output_environment, id.xy, vec4f(PI * radiance / f32(parameters.sample_count), 1.0));
}
`;
