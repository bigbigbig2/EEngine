/**
 * probe_depth_moments：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LIGHT_PROBE_RECORD_WGSL } from "../gpu/GPULightProbeVolume.js";

export const PROBE_DEPTH_SETTINGS_BYTES = 20;
export const PROBE_DEPTH_TARGET_FORMAT = "rg16float" as const;
export const PROBE_DEPTH_COPY_WORKGROUP_SIZE = 16;

const PROBE_DEPTH_COMMON_WGSL = /* wgsl */ `
struct ProbeDepthSettings {
  probe_resolution: u32,
  probe_update_count: u32,
  probe_index_offset: u32,
  probe_count: u32,
  atlas_patches_per_row: u32,
};

fn grid2d_to_index(position: vec2u, width: u32) -> u32 {
  return position.y * width + position.x;
}

fn index_to_grid2d(index: u32, width: u32) -> vec2u {
  return vec2u(index % width, index / width);
}
`;

export const PROBE_DEPTH_MOMENTS_WGSL = /* wgsl */ `
${LIGHT_PROBE_RECORD_WGSL}
${PROBE_DEPTH_COMMON_WGSL}

const F16_MAX: f32 = 65504.0;

@group(0) @binding(0) var<uniform> settings: ProbeDepthSettings;
@group(0) @binding(1) var child_size: texture_2d<f32>;
@group(0) @binding(2) var sp: texture_2d<f32>;
@group(0) @binding(3) var mode_u_neg: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> end: array<LightProbeData>;

fn uv_octahedral_unit_decode(encoded: vec2f) -> vec3f {
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

fn texel_coordinate_to_uv(position: vec2f, resolution: vec2u) -> vec2f {
  return (position + 0.5) / vec2f(resolution);
}

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

struct FullscreenVertexOutput {
  @builtin(position) position: vec4f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> FullscreenVertexOutput {
  var output: FullscreenVertexOutput;
  output.position = vec4f(FULLSCREEN_POSITIONS[vertex_index], 0.0, 1.0);
  return output;
}

@fragment
fn fs_main(@builtin(position) fragment_position: vec4f) -> @location(0) vec2f {
  let output_size = textureDimensions(child_size);
  let probes_per_row = output_size / vec2u(settings.probe_resolution);
  let pixel = vec2u(fragment_position.xy);
  let probe_texel = pixel % settings.probe_resolution;
  let local_probe = grid2d_to_index(
    pixel / settings.probe_resolution,
    probes_per_row.x
  );
  let probe_index =
    (local_probe + settings.probe_index_offset) % settings.probe_count;

  let position_local_sample = textureLoad(child_size, vec2i(pixel), 0);
  let position_local = position_local_sample.rgb;
  let probe = end[probe_index];
  var normalized_depth = length(position_local) / probe.distance_max;
  let missed = textureLoad(sp, vec2i(pixel), 0).a == 1.0;
  if (missed) {
    normalized_depth = 4.0;
  }
  normalized_depth = min(normalized_depth, 255.0);

  let ray_direction = normalize(position_local);
  let atlas_patch = index_to_grid2d(
    probe_index,
    settings.atlas_patches_per_row
  );
  let patch_origin = atlas_patch * (settings.probe_resolution + 2u);
  let atlas_texel = probe_texel + patch_origin + vec2u(1u);
  let history = textureLoad(mode_u_neg, vec2i(atlas_texel), 0).rg;

  let texel_direction = uv_octahedral_unit_decode(texel_coordinate_to_uv(
    vec2f(probe_texel),
    vec2u(settings.probe_resolution)
  ));
  let directional_weight = pow(
    max(0.0, dot(texel_direction, ray_direction)),
    3.0
  );
  let current = vec2f(normalized_depth, normalized_depth * normalized_depth);

  const history_factor = 0.95;
  let sample_weight = 1.0 /
    max(1.0, f32(probe.accumulated_samples));
  let temporal_weight = max(sample_weight, 1.0 - history_factor);
  let blend = max(sample_weight, temporal_weight * directional_weight);
  return mix(history, current, blend);
}
`;

export const PROBE_DEPTH_ATLAS_COPY_WGSL = /* wgsl */ `
${PROBE_DEPTH_COMMON_WGSL}

@group(0) @binding(0) var<uniform> settings: ProbeDepthSettings;
@group(0) @binding(1) var extension_hash: texture_2d<f32>;
@group(0) @binding(2) var mode_u_neg:
  texture_storage_2d<rg16float, write>;

@compute @workgroup_size(${PROBE_DEPTH_COPY_WORKGROUP_SIZE}, ${PROBE_DEPTH_COPY_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let output_size = textureDimensions(extension_hash);
  let probes_per_row = output_size / vec2u(settings.probe_resolution);
  let pixel = global_id.xy;
  let probe_texel = pixel % settings.probe_resolution;
  let local_probe = grid2d_to_index(
    pixel / settings.probe_resolution,
    probes_per_row.x
  );
  if (local_probe >= settings.probe_update_count) {
    return;
  }

  let probe_index =
    (local_probe + settings.probe_index_offset) % settings.probe_count;
  let moments = textureLoad(extension_hash, vec2i(pixel), 0);
  let atlas_patch = index_to_grid2d(
    probe_index,
    settings.atlas_patches_per_row
  );
  let patch_origin = atlas_patch * (settings.probe_resolution + 2u);
  let atlas_texel = probe_texel + patch_origin + vec2u(1u);
  textureStore(mode_u_neg, vec2i(atlas_texel), moments);
}
`;
