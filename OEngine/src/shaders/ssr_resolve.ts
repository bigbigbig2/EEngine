/**
 * ssr_resolve：定义对应渲染阶段使用的 WGSL 着色器代码。
 */


import {
  SSR_CAMERA_WGSL,
  SSR_FULLSCREEN_VERTEX_WGSL,
  SSR_MATH_WGSL
} from "./ssr_common.js";

export const SSR_RESOLVE_FORMAT = "rgba16float" as const;

export const SSR_RESOLVE_WGSL = /* wgsl */ `
${SSR_CAMERA_WGSL}
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}

struct SsrResolveSettings { frame_index: u32 };
struct SsrHit { position: vec2u, confidence: f32 };

@group(0) @binding(0) var valid_history_confidence: texture_2d<u32>;
@group(0) @binding(1) var gr_bucket: texture_2d<f32>;
@group(0) @binding(2) var edge: texture_2d<f32>;
@group(0) @binding(3) var ray_ws: texture_2d<u32>;
@group(0) @binding(4) var tv_y: texture_2d<f32>;
@group(0) @binding(5) var light_dir: texture_2d<f32>;
@group(0) @binding(6) var sec_radix_passes: texture_2d<f32>;
@group(0) @binding(7) var segment_height: sampler;
@group(0) @binding(8) var<uniform> settings: SsrResolveSettings;
@group(0) @binding(9) var<uniform> camera: CommandEncoder;

const NEIGHBOR_OFFSETS = array<vec2i, 48>(
  vec2i(2,-3),vec2i(3,-1),vec2i(0,-2),vec2i(1,-3),vec2i(3,0),vec2i(2,-1),
  vec2i(3,-2),vec2i(2,2),vec2i(3,1),vec2i(1,3),vec2i(3,3),vec2i(0,2),
  vec2i(2,1),vec2i(1,-1),vec2i(3,-3),vec2i(2,-2),vec2i(0,-3),vec2i(1,0),
  vec2i(-2,-1),vec2i(-3,-2),vec2i(-1,-3),vec2i(-3,1),vec2i(-2,0),vec2i(-3,-1),
  vec2i(-3,2),vec2i(-1,1),vec2i(-2,3),vec2i(0,3),vec2i(1,2),vec2i(-1,0),
  vec2i(-3,3),vec2i(-2,2),vec2i(0,1),vec2i(-1,3),vec2i(2,3),vec2i(3,2),
  vec2i(1,1),vec2i(2,0),vec2i(0,-1),vec2i(-1,2),vec2i(-2,1),vec2i(-3,0),
  vec2i(-2,-2),vec2i(-1,-1),vec2i(-3,-3),vec2i(1,-2),vec2i(-2,-3),vec2i(-1,-2)
);

fn ssr_hit_unpack(packed: vec2u) -> SsrHit {
  var hit: SsrHit;
  hit.position = vec2u(packed.x & 0xffffu, packed.x >> 16u);
  hit.confidence = f32(packed.y & 0xffu) / 255.0;
  return hit;
}

fn direction_world_to_view(direction: vec3f) -> vec3f {
  let matrix = camera.view_matrix;
  return mat3x3f(matrix[0].xyz, matrix[1].xyz, matrix[2].xyz) * direction;
}

fn screen_coordinate_to_view(position: vec2u) -> vec3f {
  let depth = textureLoad(gr_bucket, position, 0).r;
  let uv = texel_coordinate_to_uv(vec2f(position), textureDimensions(gr_bucket).xy);
  return project_position_from_depth(uv, depth, camera.projection_matrix_inverse);
}

fn get_ray_mip_level(start: vec3f, hit: vec3f, hit_normal: vec3f, roughness: f32, focal_length_px: f32) -> f32 {
  const BRDF_BIAS = 0.7;
  let ray = hit - start;
  let ray_distance = length(ray);
  let ray_direction = ray / ray_distance;
  // 保持当前运算分组；改写为 (ray_distance * roughness) * BRDF_BIAS
  // 会改变部分时域邻域模式选择的三线性 mip 权重。
  let cone_tangent = roughness * BRDF_BIAS;
  let cone_diameter = ray_distance * cone_tangent;
  let incidence = saturate(dot(-ray_direction, hit_normal));
  let hit_depth = abs(hit.z);
  let footprint = (cone_diameter * focal_length_px * incidence) / hit_depth;
  let base_mip_level = log2(max(1.0, footprint));
  return clamp(base_mip_level, 0.0, 3.0);
}

fn bake_ao(no_h: f32, no_v: f32, alpha_squared: f32) -> f32 {
  return D_GGX(alpha_squared, no_h * no_h) * no_h / max(1e-7, 4.0 * no_v);
}

fn neighbour_pdf(normal: vec3f, view_direction: vec3f, ray_direction: vec3f, roughness: f32) -> f32 {
  let half_vector = normalize(ray_direction + view_direction);
  let no_h = max(0.0, dot(normal, half_vector));
  let no_v = max(0.0, dot(view_direction, half_vector));
  // 显式执行两次 f32 乘法；GPU 上 pow(roughness, 4.0) 并不保证位级等价。
  let roughness_squared = roughness * roughness;
  let roughness_fourth = roughness_squared * roughness_squared;
  return bake_ao(no_h, no_v, roughness_fourth);
}

fn get_neighbour_weight(hit_pdf: f32, ray_direction: vec3f, view_direction: vec3f, normal: vec3f, roughness: f32) -> f32 {
  let half_vector = normalize(ray_direction + view_direction);
  let no_h = max(0.0, dot(normal, half_vector));
  let no_l = max(0.0, dot(normal, ray_direction));
  let no_v = max(0.0, dot(normal, view_direction));
  let alpha = pow2(clamp(roughness, 0.02, 1.0));
  let local_brdf = V_GGX_SmithCorrelated(alpha, no_l, no_v) * D_GGX(alpha * alpha, no_h * no_h) * no_l;
  return min(mix(2.0, 10.0, roughness), local_brdf / max(hit_pdf, 1e-5));
}

fn texture_octahedral_wrap_texel_coordinates(position: vec2i, resolution: i32) -> vec2u {
  let wrapped = ((position % resolution) + resolution) % resolution;
  let crossings_x = abs(position.x / resolution) + i32(position.x < 0);
  let crossings_y = abs(position.y / resolution) + i32(position.y < 0);
  let flip = ((crossings_x ^ crossings_y) & 1) != 0;
  return select(vec2u(wrapped), vec2u(resolution - (wrapped + vec2i(1))), flip);
}

fn uv_octahedral_unit_encode(direction: vec3f) -> vec2f {
  var projected = direction.xy / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if (direction.z < 0.0) {
    projected = (1.0 - abs(projected.yx)) * select(vec2f(1.0), vec2f(-1.0), projected < vec2f(0.0));
  }
  return 0.5 + 0.5 * projected;
}

fn get_bilinear_weights(fraction: vec2f) -> vec4f {
  let inverse = 1.0 - fraction;
  return vec4f(inverse.x * inverse.y, fraction.x * inverse.y, inverse.x * fraction.y, fraction.x * fraction.y);
}

fn texture_octahedral_sample_bilinear(source: texture_2d<f32>, resolution: u32, direction: vec3f, lod: u32) -> vec4f {
  let texel = uv_to_texel_coordinate(uv_octahedral_unit_encode(direction), vec2u(resolution));
  let fraction = fract(texel);
  let base = vec2i(floor(texel));
  let weights = get_bilinear_weights(fraction);
  return
    textureLoad(source, vec2i(texture_octahedral_wrap_texel_coordinates(base, i32(resolution))), i32(lod)) * weights.x +
    textureLoad(source, vec2i(texture_octahedral_wrap_texel_coordinates(base + vec2i(1,0), i32(resolution))), i32(lod)) * weights.y +
    textureLoad(source, vec2i(texture_octahedral_wrap_texel_coordinates(base + vec2i(0,1), i32(resolution))), i32(lod)) * weights.z +
    textureLoad(source, vec2i(texture_octahedral_wrap_texel_coordinates(base + vec2i(1,1), i32(resolution))), i32(lod)) * weights.w;
}

fn get_ibl_radiance(view_direction: vec3f, normal: vec3f, roughness: f32) -> vec3f {
  let reflected = reflect(-view_direction, normal);
  let direction = normalize(mix(reflected, normal, roughness * roughness));
  let level_count = textureNumLevels(sec_radix_passes);
  let lod = clamp(roughness, 0.0, 1.0) * f32(level_count - 1u);
  let lower = u32(floor(lod));
  let upper = min(lower + 1u, level_count - 1u);
  let lower_value = texture_octahedral_sample_bilinear(sec_radix_passes, textureDimensions(sec_radix_passes, i32(lower)).x, direction, lower).rgb;
  let upper_value = texture_octahedral_sample_bilinear(sec_radix_passes, textureDimensions(sec_radix_passes, i32(upper)).x, direction, upper).rgb;
  return mix(lower_value, upper_value, fract(lod));
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let position = vec2i(coord.xy);
  // QD carries albedo/AO in its declared resource table although the base IBL
  // body does not consume it; retain the exact binding surface.
  if (coord.x < 0.0) {
    _ = textureLoad(light_dir, position, 0);
  }
  let roughness = decode_g_buffer_roughness(textureLoad(edge, position, 0));
  let normal_world = decode_g_buffer_normal(textureLoad(ray_ws, position, 0).xy);
  let normal_view = direction_world_to_view(normal_world);
  let start_view = screen_coordinate_to_view(vec2u(position));
  let view_direction = normalize(-start_view);
  let color_size = textureDimensions(tv_y, 0).xy;
  let focal_length = f32(color_size.y) / (2.0 * camera.device_depth_to_view_space.w);
  let hit = ssr_hit_unpack(textureLoad(valid_history_confidence, position, 0).xy);
  let hit_uv = texel_coordinate_to_uv(vec2f(hit.position), color_size);
  let hit_view = screen_coordinate_to_view(hit.position);
  let hit_normal_world = decode_g_buffer_normal(textureLoad(ray_ws, hit.position, 0).xy);
  let hit_normal_view = direction_world_to_view(hit_normal_world);
  let ray_direction = normalize(hit_view - start_view);
  var weight_sum = hit.confidence;
  var maximum_confidence = hit.confidence;
  let mip = get_ray_mip_level(start_view, hit_view, hit_normal_view, roughness, focal_length);
  let traced = textureSampleLevel(tv_y, segment_height, hit_uv, mip).rgb;
  var radiance = traced * hit.confidence;
  var second_moment = pow2(rgb_to_luminance(traced));
  let hash = resolve_trigonometric_moments(vec3u(vec2u(position), settings.frame_index));
  let maximum_position = vec2i(textureDimensions(valid_history_confidence)) - vec2i(1);
  for (var sample_index = 0u; sample_index < 4u; sample_index++) {
    let offset_index = (hash + sample_index) % 48u;
    let neighbor_position = clamp(
      position + NEIGHBOR_OFFSETS[offset_index],
      vec2i(0),
      maximum_position
    );
    let neighbor_normal_view = direction_world_to_view(decode_g_buffer_normal(textureLoad(ray_ws, neighbor_position, 0).xy));
    let neighbor_roughness = decode_g_buffer_roughness(textureLoad(edge, neighbor_position, 0));
    let neighbor_hit = ssr_hit_unpack(textureLoad(valid_history_confidence, neighbor_position, 0).xy);
    let neighbor_hit_depth = textureLoad(gr_bucket, neighbor_hit.position, 0).r;
    let neighbor_hit_uv = texel_coordinate_to_uv(vec2f(neighbor_hit.position), color_size);
    let neighbor_hit_view = project_position_from_depth(neighbor_hit_uv, neighbor_hit_depth, camera.projection_matrix_inverse);
    let neighbor_ray = normalize(neighbor_hit_view - start_view);
    let neighbor_hit_normal_view = direction_world_to_view(decode_g_buffer_normal(textureLoad(ray_ws, neighbor_hit.position, 0).xy));
    let front_facing = step(0.0, dot(-neighbor_ray, neighbor_hit_normal_view));
    let source_facing = step(0.0, dot(neighbor_ray, normal_view));
    let neighbor_start_view = screen_coordinate_to_view(vec2u(neighbor_position));
    let neighbor_source_ray = normalize(neighbor_hit_view - neighbor_start_view);
    let hit_pdf = neighbour_pdf(neighbor_normal_view, view_direction, neighbor_source_ray, neighbor_roughness);
    let confidence = neighbor_hit.confidence * source_facing * front_facing;
    maximum_confidence = max(maximum_confidence, confidence);
    let weight = confidence * get_neighbour_weight(hit_pdf, neighbor_ray, view_direction, normal_view, roughness);
    weight_sum += weight;
    let neighbor_mip = get_ray_mip_level(neighbor_start_view, neighbor_hit_view, neighbor_hit_normal_view, neighbor_roughness, focal_length);
    let neighbor_color = textureSampleLevel(tv_y, segment_height, neighbor_hit_uv, neighbor_mip).rgb;
    radiance += neighbor_color * weight;
    let luminance = rgb_to_luminance(neighbor_color);
    second_moment += luminance * luminance * weight;
  }
  if (weight_sum > 1e-5) {
    radiance /= weight_sum;
    second_moment /= weight_sum;
  }
  let world_view = (camera.view_matrix_inverse * vec4f(view_direction, 0.0)).xyz;
  let environment = get_ibl_radiance(world_view, normal_world, roughness);
  let resolved = mix(environment, radiance, maximum_confidence);
  let variance = max(second_moment - pow2(rgb_to_luminance(radiance)), 0.0);
  return vec4f(resolved, variance);
}
`;
