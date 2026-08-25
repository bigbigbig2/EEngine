/**
 * probe_sh_reduce：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { PROBE_SH_COEFFICIENT_FLOATS } from "./probe_sh_project.js";

export const PROBE_SH_REDUCE_SETTINGS_BYTES = 24;
export const PROBE_SH_REDUCE_WORKGROUP_SIZE = 16;

export const PROBE_SH_REDUCE_WGSL = /* wgsl */ `
struct ProbeShReduceSettings {
  probe_index_offset: u32,
  probe_update_count: u32,
  probe_resolution: u32,
  mip_level: u32,
  probes_per_row: u32,
  probe_count: u32,
};

@group(0) @binding(0) var<uniform> settings: ProbeShReduceSettings;
@group(1) @binding(0) var<storage, read_write> coefficients: array<f32>;

fn grid2d_to_index(position: vec2u, width: u32) -> u32 {
  return position.y * width + position.x;
}

fn coefficient_word_offset(local_probe: u32, texel: vec2u) -> u32 {
  let resolution = settings.probe_resolution;
  let texel_index = grid2d_to_index(texel, resolution);
  return (
    local_probe * resolution * resolution + texel_index
  ) * ${PROBE_SH_COEFFICIENT_FLOATS}u;
}

fn add_texel_contribution(
  accumulator: ptr<function, array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>>,
  local_probe: u32,
  texel: vec2u
) {
  let input_offset = coefficient_word_offset(local_probe, texel);
  for (
    var coefficient = 0u;
    coefficient < ${PROBE_SH_COEFFICIENT_FLOATS}u;
    coefficient++
  ) {
    (*accumulator)[coefficient] += coefficients[input_offset + coefficient];
  }
}

@compute @workgroup_size(${PROBE_SH_REDUCE_WORKGROUP_SIZE}, ${PROBE_SH_REDUCE_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let full_coordinate = global_id.xy << vec2u(settings.mip_level);
  let output_texel = full_coordinate % settings.probe_resolution;
  let local_probe = grid2d_to_index(
    full_coordinate / settings.probe_resolution,
    settings.probes_per_row
  );
  if (local_probe >= settings.probe_update_count) {
    return;
  }

  var accumulator: array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>;
  for (var child_y = 0u; child_y <= 1u; child_y++) {
    for (var child_x = 0u; child_x <= 1u; child_x++) {
      let child_texel = output_texel +
        (vec2u(child_x, child_y) << vec2u(settings.mip_level - 1u));
      if (any(child_texel >= vec2u(settings.probe_resolution))) {
        continue;
      }
      add_texel_contribution(&accumulator, local_probe, child_texel);
    }
  }

  let output_offset = coefficient_word_offset(local_probe, output_texel);
  for (
    var coefficient = 0u;
    coefficient < ${PROBE_SH_COEFFICIENT_FLOATS}u;
    coefficient++
  ) {
    coefficients[output_offset + coefficient] = accumulator[coefficient];
  }
}
`;
