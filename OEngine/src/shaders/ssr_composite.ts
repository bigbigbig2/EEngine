/**
 * ssr_composite：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import {
  SSR_CAMERA_WGSL,
  SSR_FULLSCREEN_VERTEX_WGSL,
  SSR_MATH_WGSL
} from "./ssr_common.js";

export const SSR_COMPOSITE_FORMAT = "rgba16float" as const;

export const SSR_COMPOSITE_WGSL = /* wgsl */ `
${SSR_CAMERA_WGSL}
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}
@group(0) @binding(0) var tv_y: texture_2d<f32>;
@group(0) @binding(1) var gr_bucket: texture_2d<f32>;
@group(0) @binding(2) var light_dir: texture_2d<f32>;
@group(0) @binding(3) var ray_ws: texture_2d<u32>;
@group(0) @binding(4) var device: texture_2d<f32>;
@group(0) @binding(5) var edge: texture_2d<f32>;
@group(0) @binding(6) var<uniform> camera: CommandEncoder;

fn gpu_memory_usage(no_v: f32, roughness: f32) -> vec2f {
  const c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  const c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * no_v)) * r.x + r.y;
  return vec2f(-1.04, 1.04) * a004 + r.zw;
}

fn scenes(specular: vec3f, roughness: f32, no_v: f32) -> vec3f {
  let split = gpu_memory_usage(no_v, roughness);
  return specular * split.x + saturate(50.0 * specular.g) * split.y;
}

fn compute_specular_occlusion(no_v: f32, ao: f32, roughness: f32) -> f32 {
  return saturate(pow(no_v + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
}

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let position = vec2u(coord.xy);
  let depth = textureLoad(gr_bucket, position, 0).r;
  let scene_color = textureLoad(tv_y, position, 0).rgb;
  if (is_background(depth)) { return vec4f(scene_color, 1.0); }
  let reflection = textureLoad(device, position, 0).rgb;
  let normal = decode_g_buffer_normal(textureLoad(ray_ws, position, 0).xy);
  let albedo_ao = textureLoad(light_dir, position, 0);
  let world_position = project_position_from_depth(uv, depth, camera.view_projection_matrix_inverse);
  let view_direction = normalize(mat4_extract_position(camera.transform) - world_position);
  let no_v = saturate(dot(normal, view_direction));
  let pbr = textureLoad(edge, position, 0);
  let roughness = decode_g_buffer_roughness(pbr);
  let metalness = decode_g_buffer_metalness(pbr);
  let specular = metalness_to_specular_color(metalness, albedo_ao.rgb);
  let brdf = scenes(specular, roughness, no_v);
  let specular_occlusion = compute_specular_occlusion(no_v, albedo_ao.a, roughness);
  return vec4f(scene_color + reflection * brdf * specular_occlusion, 1.0);
}
`;
