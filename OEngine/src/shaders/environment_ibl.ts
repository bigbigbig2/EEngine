/**
 * environment_ibl：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const ENVIRONMENT_BACKGROUND_FORMAT = "rgba16float" as const;
export const IBL_DIFFUSE_FORMAT = "rgba16float" as const;

const OCTAHEDRAL_SAMPLE_WGSL = /* wgsl */ `
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

fn decode_g_buffer_normal(encoded: vec2u) -> vec3f {
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
  let lod = clamp(roughness, 0.0, 1.0) * f32(max_mip);
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

const FULLSCREEN_TRIANGLE_WGSL = /* wgsl */ `
const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

struct FullscreenVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> FullscreenVertexOutput {
  let ndc = FULLSCREEN_POSITIONS[vertex_index];
  var output: FullscreenVertexOutput;
  output.position = vec4f(ndc, 0.0, 1.0);
  output.uv = fma(ndc, vec2f(0.5, -0.5), vec2f(0.5));
  return output;
}
`;

export const ENVIRONMENT_BACKGROUND_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}

struct PipelineCacheKey {
  projection_matrix: mat4x4f,
  upscale_ratio: vec2f,
  jitter: vec2f,
  width: u32,
  height: u32,
  frame_index: u32,
};

@group(0) @binding(0) var<uniform> camera: CommandEncoder;
@group(0) @binding(1) var<uniform> view: PipelineCacheKey;
@group(0) @binding(2) var sec_radix_passes: texture_2d<f32>;
@group(0) @binding(3) var segment_height: sampler;

${OCTAHEDRAL_SAMPLE_WGSL}
${FULLSCREEN_TRIANGLE_WGSL}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let clip = vec4f(uv_to_ndc(uv), 0.0, 1.0);
  let world = camera.view_projection_matrix_inverse * clip;
  let direction = normalize(world.xyz);
  let resolution = textureDimensions(sec_radix_passes, 0).x;
  let color = sample_octahedral_bilinear(
    sec_radix_passes,
    vec2u(0u),
    resolution,
    direction,
    0u
  ).rgb;
  return vec4f(color, 1.0);
}
`;

export const IBL_DIFFUSE_WGSL = /* wgsl */ `
@group(0) @binding(0) var count: texture_2d<u32>;
@group(0) @binding(1) var radix: texture_2d<f32>;
@group(0) @binding(2) var sec_radix_passes: texture_2d<f32>;

${OCTAHEDRAL_SAMPLE_WGSL}
${FULLSCREEN_TRIANGLE_WGSL}

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let pixel = vec2i(coord.xy);
  let normal = decode_g_buffer_normal(textureLoad(count, pixel, 0).rg);
  let occlusion = textureLoad(radix, pixel, 0).a;
  let irradiance = sample_prefiltered_environment(
    sec_radix_passes,
    normal,
    0.0
  );
  return vec4f(irradiance * occlusion, 0.0);
}
`;
