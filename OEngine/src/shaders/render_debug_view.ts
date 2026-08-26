/**
 * 统一 Render Debug View 的 authored WGSL。
 *
 * 三个 shader 都只在 debug view 启用时执行一个全屏三角形。输入只读，
 * 输出为 rgba16float；输出尺寸可与内部渲染尺寸不同，坐标按整数比例映射。
 */

import { VIS_MESH_CLEAR_SENTINEL } from "../render/VisibilityBufferContract.js";
import { SSR_FULLSCREEN_VERTEX_WGSL } from "./ssr_common.js";

export const RENDER_DEBUG_VIEW_FORMAT = "rgba16float" as const;

const DEBUG_VIEW_SETTINGS_WGSL = /* wgsl */ `
struct DebugViewSettings {
  output_size: vec2u,
};
`;

const DEBUG_VIEW_COORDINATE_WGSL = /* wgsl */ `
fn source_coordinate(position: vec2f, source_size: vec2u) -> vec2i {
  let output_size = max(settings.output_size, vec2u(1u));
  let target = vec2u(position);
  let source = min(target * source_size / output_size, source_size - vec2u(1u));
  return vec2i(source);
}
`;

export const VISIBILITY_KEY_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}

${DEBUG_VIEW_SETTINGS_WGSL}

@group(0) @binding(0) var mesh_ids: texture_2d<u32>;
@group(0) @binding(1) var triangle_ids: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;

${DEBUG_VIEW_COORDINATE_WGSL}

fn avalanche_hash(value_in: u32) -> u32 {
  var value = value_in;
  value ^= value >> 16u;
  value *= 0x7feb352du;
  value ^= value >> 15u;
  value *= 0x846ca68bu;
  value ^= value >> 16u;
  return value;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(mesh_ids));
  let mesh_id = textureLoad(mesh_ids, coordinate, 0).r;
  if (mesh_id == ${VIS_MESH_CLEAR_SENTINEL}u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let triangle_id = textureLoad(triangle_ids, coordinate, 0).r;
  let hash = avalanche_hash(mesh_id ^ avalanche_hash(triangle_id + 0x9e3779b9u));
  let color = vec3f(
    f32(hash & 255u),
    f32((hash >> 8u) & 255u),
    f32((hash >> 16u) & 255u)
  ) / 255.0;
  return vec4f(0.15 + color * 0.65, 1.0);
}
`;

export const DEPTH_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}

${DEBUG_VIEW_SETTINGS_WGSL}

@group(0) @binding(0) var reverse_z_depth: texture_depth_2d;
@group(0) @binding(1) var<uniform> settings: DebugViewSettings;

${DEBUG_VIEW_COORDINATE_WGSL}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(reverse_z_depth));
  let depth = textureLoad(reverse_z_depth, coordinate, 0);
  let enhanced = select(0.0, pow(clamp(depth, 0.0, 1.0), 0.25), depth > 0.0);
  return vec4f(vec3f(enhanced), 1.0);
}
`;

export const VELOCITY_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}

const PI: f32 = 3.141592653589793;

${DEBUG_VIEW_SETTINGS_WGSL}

@group(0) @binding(0) var velocity_texture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: DebugViewSettings;

${DEBUG_VIEW_COORDINATE_WGSL}

fn hue_to_rgb(hue: f32) -> vec3f {
  let phase = fract(hue + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0));
  return clamp(abs(phase * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = textureDimensions(velocity_texture);
  let coordinate = source_coordinate(position.xy, dimensions);
  let velocity = textureLoad(velocity_texture, coordinate, 0).rg /
    vec2f(max(dimensions, vec2u(1u)));
  let magnitude = clamp(length(velocity) * 100.0, 0.0, 1.0);
  let hue = (atan2(velocity.y, velocity.x) + PI) / (2.0 * PI);
  let direction_color = hue_to_rgb(hue);
  let background = vec3f(0.08);
  return vec4f(mix(background, direction_color, magnitude), 1.0);
}
`;
