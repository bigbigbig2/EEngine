/**
 * Traceable WebGPU/WGSL port of the SSGI core in three.js r186:
 * https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/jsm/tsl/display/SSGINode.js
 *
 * Upstream license: MIT. The port retains the horizon-bitfield visibility,
 * stochastic slice/step distribution, thickness/backface tests and AO/GI
 * dual output. TSL, NodeMaterial, QuadMesh and the extra TRAA owner are not
 * carried into OEngine; FrameGraph and TemporalHistoryRegistry own lifecycle.
 */

import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { GPU_SHADING_SURFACE_NORMAL_WGSL } from "../gpu/GpuComputeMaterialAbi.js";

export const THREE_SSGI_REVISION = "148ef33ecb6d2502ff796d4554abd1549c95d519" as const;
export const SSGI_TRACE_AO_FORMAT = "rgba16float" as const;
export const SSGI_TRACE_GI_FORMAT = "rgba16float" as const;
export const SSGI_VISIBILITY_FORMAT = "r8unorm" as const;
export const SSGI_BENT_NORMAL_FORMAT = "rg16uint" as const;
export const SSGI_INCIDENT_GI_FORMAT = "rgba16float" as const;
export const SSGI_CONFIDENCE_FORMAT = "r8unorm" as const;
export const SSGI_LINEAR_DEPTH_FORMAT = "r32float" as const;

const FULLSCREEN = /* wgsl */ `
const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
);
struct FullscreenVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vs_main(@builtin(vertex_index) vertex_index: u32) -> FullscreenVertexOutput {
  let ndc = FULLSCREEN_POSITIONS[vertex_index];
  var output: FullscreenVertexOutput;
  output.position = vec4f(ndc, 0.0, 1.0);
  output.uv = fma(ndc, vec2f(0.5, -0.5), vec2f(0.5));
  return output;
}
`;

const OCTAHEDRAL = /* wgsl */ `
fn sign_not_zero(v: vec2f) -> vec2f { return select(vec2f(-1.0), vec2f(1.0), v >= vec2f(0.0)); }
fn oct_encode(n: vec3f) -> vec2f {
  var p = n.xy / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6);
  if (n.z < 0.0) { p = (1.0 - abs(p.yx)) * sign_not_zero(p); }
  return p * 0.5 + 0.5;
}
fn oct_decode(e: vec2f) -> vec3f {
  let p = e * 2.0 - 1.0;
  var n = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}
`;

const RECONSTRUCTION = /* wgsl */ `
fn uv_to_ndc(uv: vec2f) -> vec2f { return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0)); }
fn position_from_depth(uv: vec2f, depth: f32) -> vec3f {
  let p = camera.view_projection_matrix_inverse * vec4f(uv_to_ndc(uv), depth, 1.0);
  return p.xyz / max(abs(p.w), 1e-6);
}
fn project_uv(position: vec3f) -> vec2f {
  let clip = camera.view_projection_matrix * vec4f(position, 1.0);
  return fma(clip.xy / max(abs(clip.w), 1e-6), vec2f(0.5, -0.5), vec2f(0.5));
}
fn in_view(uv: vec2f) -> bool { return all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)); }
`;

export const THREE_SSGI_TRACE_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_SHADING_SURFACE_NORMAL_WGSL}
${FULLSCREEN}
${OCTAHEDRAL}

struct SsgiSettings {
  frame_index: u32,
  slice_count: u32,
  step_count: u32,
  temporal_enabled: u32,
  radius_world: f32,
  thickness_world: f32,
  ao_intensity: f32,
  gi_intensity: f32,
  backface_lighting: f32,
  trace_width: u32,
  trace_height: u32,
  screen_space_radius: f32,
  // 0 = OEngine physical world-space radius, 1 = pinned Three.js screen-space radius.
  sampling_domain: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
};
@group(0) @binding(0) var depth_source: texture_depth_2d;
@group(0) @binding(1) var hzb_source: texture_2d<f32>;
@group(0) @binding(2) var normal_source: texture_2d<u32>;
@group(0) @binding(3) var radiance_source: texture_2d<f32>;
@group(0) @binding(4) var<uniform> camera: CommandEncoder;
@group(0) @binding(5) var<uniform> settings: SsgiSettings;

${RECONSTRUCTION}

fn normal_at(pixel: vec2u) -> vec3f {
  return oct_decode(vec2f(textureLoad(normal_source, pixel, 0).xy) / OENGINE_SURFACE_NORMAL_MAX_VALUE);
}
fn three_rand(uv: vec2f) -> f32 {
  let sn = (dot(uv, vec2f(12.9898, 78.233)) % 3.14159265359);
  return fract(sin(sn) * 43758.5453);
}
fn interleaved_gradient_noise(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}
fn temporal_direction(frame: u32) -> f32 {
  const rotations = array<f32, 6>(60.0, 300.0, 180.0, 240.0, 120.0, 0.0);
  return select(1.0, rotations[frame % 6u] * (1.0 / 360.0), settings.temporal_enabled != 0u);
}
fn temporal_offset(frame: u32) -> f32 {
  const offsets = array<f32, 4>(0.0, 0.5, 0.25, 0.75);
  return select(1.0, offsets[frame % 4u], settings.temporal_enabled != 0u);
}
fn hierarchical_depth(uv: vec2f, footprint: f32) -> f32 {
  let level_count = textureNumLevels(hzb_source);
  let mip = min(u32(max(floor(log2(max(footprint, 1.0))), 0.0)), level_count - 1u);
  let size = textureDimensions(hzb_source, mip);
  let pixel = min(vec2u(clamp(uv, vec2f(0.0), vec2f(1.0)) * vec2f(size)), size - 1u);
  // Shared reverse-Z HZB stores nearest conservative depth in .y.
  return textureLoad(hzb_source, pixel, mip).y;
}
fn zone_mask(first: u32, last: u32) -> u32 {
  let lo = min(first, 31u);
  let hi = min(max(last, lo), 31u);
  var low_mask = 0u;
  if (lo > 0u) { low_mask = (1u << lo) - 1u; }
  var high_mask = 0xffffffffu;
  if (hi < 31u) { high_mask = (1u << (hi + 1u)) - 1u; }
  return high_mask & ~low_mask;
}
fn angular_zone(cosine: f32) -> u32 {
  return u32(clamp(floor(acos(clamp(cosine, -1.0, 1.0)) * (32.0 / 3.14159265359)), 0.0, 31.0));
}

struct TraceOutput {
  @location(0) ao_bent: vec4f,
  @location(1) gi_confidence: vec4f,
};

@fragment fn fs_main(@builtin(position) coord: vec4f, @location(0) _uv: vec2f) -> TraceOutput {
  let trace_size = vec2u(settings.trace_width, settings.trace_height);
  let full_size = textureDimensions(depth_source);
  let trace_pixel = vec2u(coord.xy);
  let uv = (vec2f(trace_pixel) + 0.5) / vec2f(trace_size);
  let pixel = min(vec2u(uv * vec2f(full_size)), full_size - vec2u(1u));
  let center_depth = textureLoad(depth_source, pixel, 0);
  let center_normal = normal_at(pixel);
  var output: TraceOutput;
  if (center_depth <= 0.0) {
    output.ao_bent = vec4f(1.0, 1.0, oct_encode(center_normal));
    output.gi_confidence = vec4f(0.0);
    return output;
  }

  let center_world = position_from_depth(uv, center_depth);
  let center_view = (camera.view_matrix * vec4f(center_world, 1.0)).xyz;
  let view_direction = normalize(-center_view);
  let view_normal = normalize((camera.view_matrix * vec4f(center_normal, 0.0)).xyz);
  let radius = max(settings.radius_world, 0.001);
  let thickness = max(settings.thickness_world, 0.001);
  let slices = clamp(settings.slice_count, 1u, 4u);
  let steps = clamp(settings.step_count, 1u, 32u);
  let temporal_direction_value = temporal_direction(settings.frame_index);
  let spatial_offset = 0.25 * f32(
    (trace_pixel.y + 4u - (trace_pixel.x & 3u)) & 3u
  );
  let initial_ray_step = fract(
    spatial_offset + temporal_offset(settings.frame_index)
  ) + three_rand(
    (uv + vec2f(temporal_direction_value * 0.02)) * 2.0 - vec2f(1.0)
  );
  let half_projection_scale =
    f32(trace_size.y) * abs(camera.projection_matrix[1][1]) * 0.25;
  let world_step_radius = max(
    radius * half_projection_scale / max(-center_view.z, 1e-4),
    f32(steps)
  );
  // Preserve both upstream branches explicitly. Screen mode is the native
  // SSGINode contract; world mode is OEngine's physically-scaled extension.
  let screen_step_radius = max(settings.screen_space_radius, 1.0) *
    (f32(trace_size.x) * 0.5) / 16.0;
  let step_radius = select(
    world_step_radius,
    screen_step_radius,
    settings.sampling_domain == 1u
  ) / f32(steps + 1u);
  let radius_view = max(1.0, f32(steps - 1u)) * step_radius;
  var accumulated_occlusion = 0.0;
  var incident = vec3f(0.0);
  var evidence = 0.0;
  var bent = center_normal;

  for (var slice = 0u; slice < slices; slice++) {
    let noise_direction = interleaved_gradient_noise(vec2f(trace_pixel));
    let angle = (f32(slice) + noise_direction + temporal_direction_value) *
      (3.14159265359 / f32(slices));
    let slice_direction = vec3f(cos(angle), sin(angle), 0.0);
    let slide_direction_texel = slice_direction.xy / vec2f(trace_size);
    let plane_normal = normalize(cross(slice_direction, view_direction));
    let tangent = cross(view_direction, plane_normal);
    let projected_normal = view_normal - plane_normal * dot(view_normal, plane_normal);
    let projected_length = length(projected_normal);
    let projected_normalized = normalize(select(
      view_normal,
      projected_normal,
      projected_length > 1e-5
    ));
    let cos_n = clamp(dot(projected_normalized, view_direction), -1.0, 1.0);
    let n = -sign(dot(projected_normal, tangent)) * acos(cos_n);
    var occluded = 0u;
    for (var side = 0u; side < 2u; side++) {
      let direction_is_right = side == 0u;
      let uv_direction = select(vec2f(-1.0, 1.0), vec2f(1.0, -1.0), direction_is_right);
      let sampling_direction = select(-1.0, 1.0, direction_is_right);
      for (var step = 0u; step < steps; step++) {
        // Three SSGINode quadratic screen-step distribution with temporal phase.
        let step_index = f32(step) + initial_ray_step;
        let offset = pow(
          abs(step_radius * step_index / max(radius_view, 1e-4)),
          2.0
        ) * radius_view;
        let uv_offset = slide_direction_texel *
          max(offset, f32(step) + 1.0) * uv_direction;
        let candidate_uv = uv + uv_offset;
        // Ray offsets grow monotonically. Once a side leaves the viewport no
        // later sample can re-enter, matching SSGINode's Break contract.
        if (!in_view(candidate_uv)) { break; }
        let candidate_pixel = min(
          vec2u(candidate_uv * vec2f(full_size)), full_size - vec2u(1u)
        );
        let footprint = length(uv_offset * vec2f(full_size));
        let exact_depth = textureLoad(depth_source, candidate_pixel, 0);
        let conservative_depth = hierarchical_depth(candidate_uv, footprint);
        if (conservative_depth <= 0.0) { continue; }
        // HZB provides a conservative empty-space rejection, while the exact
        // depth preserves the pinned SSGINode horizon construction.
        let candidate_depth = exact_depth;
        if (candidate_depth <= 0.0) { continue; }
        let candidate_world = position_from_depth(candidate_uv, candidate_depth);
        let candidate_view = (camera.view_matrix * vec4f(candidate_world, 1.0)).xyz;
        let view_delta = candidate_view - center_view;
        if (length(view_delta) <= 1e-5) { continue; }
        let pixel_to_sample = normalize(view_delta);
        let pixel_to_sample_backface = normalize(
          candidate_view - view_direction * thickness - center_view
        );
        var front_back_horizon = vec2f(
          acos(clamp(dot(pixel_to_sample, view_direction), -1.0, 1.0)),
          acos(clamp(dot(pixel_to_sample_backface, view_direction), -1.0, 1.0))
        );
        front_back_horizon = clamp(
          (sampling_direction * -front_back_horizon - vec2f(n - 1.57079632679)) /
            3.14159265359,
          vec2f(0.0),
          vec2f(1.0)
        );
        if (direction_is_right) {
          front_back_horizon = front_back_horizon.yx;
        }
        let start_zone = u32(front_back_horizon.x * 32.0);
        let zone_count = u32(ceil(
          max(front_back_horizon.y - front_back_horizon.x, 0.0) * 32.0
        ));
        if (zone_count == 0u || start_zone >= 32u) { continue; }
        let mask = zone_mask(start_zone, min(31u, start_zone + zone_count - 1u));
        let newly_occluded = mask & ~occluded;
        let new_zones = countOneBits(newly_occluded);
        if (new_zones == 0u) { continue; }
        occluded |= newly_occluded;
        let horizon_zone_weight = f32(new_zones) * (1.0 / 32.0);
        // Bent normal is a geometric visibility product. Accumulate as soon
        // as a horizon zone becomes newly occluded; do not make it depend on
        // whether the sample also contributes incident radiance.
        bent -= normalize(candidate_world - center_world) * horizon_zone_weight;

        let center_facing = max(dot(view_normal, pixel_to_sample), 0.0);
        if (center_facing <= 0.0) { continue; }
        let candidate_normal_world = normal_at(candidate_pixel);
        let candidate_normal_view = normalize(
          (camera.view_matrix * vec4f(candidate_normal_world, 0.0)).xyz
        );
        let raw_emitter_facing = dot(candidate_normal_view, -pixel_to_sample);
        var emitter_facing = max(raw_emitter_facing, 0.0);
        if (
          settings.backface_lighting > 0.0 &&
          dot(candidate_normal_view, view_direction) > 0.0
        ) {
          emitter_facing = select(
            abs(raw_emitter_facing),
            abs(raw_emitter_facing) * settings.backface_lighting,
            raw_emitter_facing < 0.0
          );
        }
        incident += textureLoad(radiance_source, candidate_pixel, 0).rgb *
          center_facing * emitter_facing * horizon_zone_weight;
        evidence += horizon_zone_weight;
      }
    }
    accumulated_occlusion += f32(countOneBits(occluded)) * (1.0 / 32.0);
  }

  let visibility = pow(
    clamp(1.0 - accumulated_occlusion / f32(slices), 0.0, 1.0),
    max(settings.ao_intensity, 0.001)
  );
  var incident_gi = max(
    incident * (settings.gi_intensity / f32(slices)),
    vec3f(0.0)
  );
  let luminance = dot(incident_gi, vec3f(0.2126, 0.7152, 0.0722));
  if (luminance > 7.0) { incident_gi *= 7.0 / luminance; }
  let bent_normal = normalize(select(center_normal, bent, length(bent) > 1e-5));
  output.ao_bent = vec4f(visibility, visibility * visibility, oct_encode(bent_normal));
  output.gi_confidence = vec4f(incident_gi, clamp(evidence, 0.0, 1.0));
  return output;
}
`;

export const SSGI_SPATIAL_WGSL = /* wgsl */ `
${GPU_SHADING_SURFACE_NORMAL_WGSL}
${FULLSCREEN}
@group(0) @binding(0) var current_ao: texture_2d<f32>;
@group(0) @binding(1) var current_gi: texture_2d<f32>;
@group(0) @binding(2) var linear_depth: texture_2d<f32>;
@group(0) @binding(3) var normal_source: texture_2d<u32>;
@group(0) @binding(4) var<uniform> step_size: vec4i;
fn spatial_oct_decode(e: vec2f) -> vec3f {
  let p = e * 2.0 - 1.0; var n = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0); n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}
struct SpatialOutput { @location(0) ao: vec4f, @location(1) gi: vec4f };
@fragment fn fs_main(@builtin(position) coord: vec4f) -> SpatialOutput {
  let p = vec2i(coord.xy);
  let dimensions = vec2i(textureDimensions(current_ao));
  let full_dimensions = vec2i(textureDimensions(normal_source));
  let center_full = min(vec2i((vec2f(p) + 0.5) / vec2f(dimensions) * vec2f(full_dimensions)), full_dimensions - 1);
  let center_depth = textureLoad(linear_depth, p, 0).r;
  let center_normal = spatial_oct_decode(vec2f(textureLoad(normal_source, center_full, 0).xy) / OENGINE_SURFACE_NORMAL_MAX_VALUE);
  var ao_sum = vec4f(0.0); var gi_sum = vec4f(0.0); var weight_sum = 0.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let q = clamp(p + vec2i(x, y) * step_size.x, vec2i(0), dimensions - 1);
    let q_full = min(vec2i((vec2f(q) + 0.5) / vec2f(dimensions) * vec2f(full_dimensions)), full_dimensions - 1);
    let depth_weight = exp(-abs(textureLoad(linear_depth, q, 0).r - center_depth) / max(abs(center_depth) * 0.02, 1e-3));
    let sample_normal = spatial_oct_decode(vec2f(textureLoad(normal_source, q_full, 0).xy) / OENGINE_SURFACE_NORMAL_MAX_VALUE);
    let normal_weight = pow(max(dot(center_normal, sample_normal), 0.0), 8.0);
    let kernel = select(1.0, 2.0, x == 0) * select(1.0, 2.0, y == 0);
    let w = max(depth_weight * normal_weight * kernel, 1e-4);
    ao_sum += textureLoad(current_ao, q, 0) * w;
    gi_sum += textureLoad(current_gi, q, 0) * w;
    weight_sum += w;
  }}
  return SpatialOutput(ao_sum / weight_sum, gi_sum / weight_sum);
}
`;

export const SSGI_TEMPORAL_WGSL = /* wgsl */ `
${FULLSCREEN}
@group(0) @binding(0) var current_ao: texture_2d<f32>;
@group(0) @binding(1) var current_gi: texture_2d<f32>;
@group(0) @binding(2) var history_ao: texture_2d<f32>;
@group(0) @binding(3) var history_gi: texture_2d<f32>;
@group(0) @binding(4) var velocity_source: texture_2d<f32>;
@group(0) @binding(5) var occlusion_confidence: texture_2d<f32>;
@group(0) @binding(6) var surface_validity: texture_2d<f32>;
@group(0) @binding(7) var linear_sampler: sampler;
struct TemporalSettings {
  history_valid: u32,
  blend: f32,
  pre_exposure_scale: f32,
  _padding: f32,
};
@group(0) @binding(8) var<uniform> settings: TemporalSettings;
struct TemporalOutput { @location(0) ao: vec4f, @location(1) gi: vec4f };
@fragment fn fs_main(@builtin(position) coord: vec4f) -> TemporalOutput {
  let size = vec2f(textureDimensions(current_ao));
  let full_size = vec2f(textureDimensions(velocity_source));
  let uv = coord.xy / size;
  let full_pixel = min(vec2i(uv * full_size), vec2i(full_size) - 1);
  let velocity = textureLoad(velocity_source, full_pixel, 0).rg;
  let history_uv = uv - velocity / full_size;
  let in_bounds = all(history_uv >= vec2f(0.0)) && all(history_uv <= vec2f(1.0));
  let validity = textureLoad(surface_validity, full_pixel, 0).r;
  let confidence = textureLoad(occlusion_confidence, full_pixel, 0).r;
  let history_weight = select(0.0, settings.blend * validity * confidence,
    settings.history_valid != 0u && settings.pre_exposure_scale > 0.0 && in_bounds);
  let pixel = vec2i(coord.xy);
  let currentAo = textureLoad(current_ao, pixel, 0);
  let currentGi = textureLoad(current_gi, pixel, 0);
  var historyAo = currentAo;
  var historyGi = currentGi;
  if (history_weight > 0.0) {
    let clamped_history_uv = clamp(history_uv, vec2f(0.0), vec2f(1.0));
    historyAo = textureSampleLevel(history_ao, linear_sampler, clamped_history_uv, 0.0);
    historyGi = textureSampleLevel(history_gi, linear_sampler, clamped_history_uv, 0.0);
    historyGi = vec4f(historyGi.rgb * settings.pre_exposure_scale, historyGi.a);
  }
  // Clamp radiance history around current luminance to reject disocclusion fireflies.
  let extent = max(currentGi.rgb * 0.5 + vec3f(0.05), vec3f(0.05));
  let clippedGi = clamp(historyGi.rgb, currentGi.rgb - extent, currentGi.rgb + extent);
  return TemporalOutput(
    mix(currentAo, historyAo, history_weight),
    vec4f(mix(currentGi.rgb, clippedGi, history_weight), mix(currentGi.a, historyGi.a, history_weight))
  );
}
`;

export const SSGI_RESOLVE_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_SHADING_SURFACE_NORMAL_WGSL}
${FULLSCREEN}
${OCTAHEDRAL}
@group(0) @binding(0) var filtered_ao: texture_2d<f32>;
@group(0) @binding(1) var filtered_gi: texture_2d<f32>;
@group(0) @binding(2) var linear_depth: texture_2d<f32>;
@group(0) @binding(3) var depth_source: texture_depth_2d;
@group(0) @binding(4) var normal_source: texture_2d<u32>;
@group(0) @binding(5) var<uniform> camera: CommandEncoder;
${RECONSTRUCTION}
struct ResolveOutput {
  @location(0) visibility: f32,
  @location(1) bent_normal: vec2u,
  @location(2) incident_gi: vec4f,
  @location(3) confidence: f32,
};
@fragment fn fs_main(@builtin(position) coord: vec4f) -> ResolveOutput {
  let pixel = vec2i(coord.xy);
  let full_size = vec2f(textureDimensions(depth_source));
  let low_size = vec2f(textureDimensions(filtered_ao));
  let uv = coord.xy / full_size;
  let low_position = uv * low_size - 0.5;
  let base = vec2i(floor(low_position));
  let center_depth = textureLoad(depth_source, pixel, 0);
  let center_position = position_from_depth(uv, center_depth);
  let center_view_depth = abs((camera.view_matrix * vec4f(center_position, 1.0)).z);
  var ao = vec4f(0.0); var gi = vec4f(0.0); var weight_sum = 0.0;
  for (var y = 0; y <= 1; y++) { for (var x = 0; x <= 1; x++) {
    let q = clamp(base + vec2i(x, y), vec2i(0), vec2i(low_size) - 1);
    let bilinear = vec2f(1.0) - abs((vec2f(q) + 0.5) - low_position);
    let depth_weight = exp(-abs(textureLoad(linear_depth, q, 0).r - center_view_depth) / max(center_view_depth * 0.02, 1e-3));
    let w = max(bilinear.x * bilinear.y * depth_weight, 1e-4);
    ao += textureLoad(filtered_ao, q, 0) * w;
    gi += textureLoad(filtered_gi, q, 0) * w;
    weight_sum += w;
  }}
  ao /= weight_sum; gi /= weight_sum;
  return ResolveOutput(
    clamp(ao.r, 0.0, 1.0),
    vec2u(round(clamp(ao.ba, vec2f(0.0), vec2f(1.0)) * 65535.0)),
    vec4f(max(gi.rgb, vec3f(0.0)), clamp(gi.a, 0.0, 1.0)),
    clamp(gi.a, 0.0, 1.0)
  );
}
`;

export const SSGI_LINEAR_DEPTH_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${FULLSCREEN}
@group(0) @binding(0) var depth_source: texture_depth_2d;
@group(0) @binding(1) var<uniform> camera: CommandEncoder;
@fragment fn fs_main(@builtin(position) coord: vec4f, @location(0) uv: vec2f) -> @location(0) f32 {
  let full_size = textureDimensions(depth_source);
  let pixel = min(vec2u(uv * vec2f(full_size)), full_size - vec2u(1u));
  let depth = textureLoad(depth_source, pixel, 0);
  let conversion = camera.device_depth_to_view_space;
  return select(0.0, abs(conversion.y / (depth + conversion.x)), depth > 0.0);
}
`;
