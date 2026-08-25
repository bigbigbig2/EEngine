/**
 * probe_sh_commit：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LIGHT_PROBE_RECORD_WGSL } from "../gpu/GPULightProbeVolume.js";
import { PROBE_SH_COEFFICIENT_FLOATS } from "./probe_sh_project.js";

export const PROBE_SH_COMMIT_SETTINGS_BYTES = 16;
export const PROBE_SH_COMMIT_WORKGROUP_SIZE = 256;
export const PROBE_SH_COMMIT_BLEND = 0.5;

export const PROBE_SH_COMMIT_WGSL = /* wgsl */ `
${LIGHT_PROBE_RECORD_WGSL}

struct ProbeShCommitSettings {
  probe_index_offset: u32,
  probe_update_count: u32,
  probe_resolution: u32,
  probe_count: u32,
};

@group(0) @binding(0) var<uniform> settings: ProbeShCommitSettings;
@group(0) @binding(1) var<storage, read> coefficients: array<f32>;
@group(0) @binding(2) var<storage, read_write> end: array<LightProbeData>;

fn reduced_coefficient_word_offset(local_probe: u32) -> u32 {
  return local_probe *
    settings.probe_resolution *
    settings.probe_resolution *
    ${PROBE_SH_COEFFICIENT_FLOATS}u;
}

fn scale_coefficients(
  value: array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>,
  scale: f32
) -> array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}> {
  var result: array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>;
  for (
    var coefficient = 0u;
    coefficient < ${PROBE_SH_COEFFICIENT_FLOATS}u;
    coefficient++
  ) {
    result[coefficient] = value[coefficient] * scale;
  }
  return result;
}

fn add_coefficients(
  a: array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>,
  b: array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>
) -> array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}> {
  var result: array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>;
  for (
    var coefficient = 0u;
    coefficient < ${PROBE_SH_COEFFICIENT_FLOATS}u;
    coefficient++
  ) {
    result[coefficient] = a[coefficient] + b[coefficient];
  }
  return result;
}

fn blend_coefficients(
  previous: array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>,
  current: array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>,
  blend: f32
) -> array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}> {
  return add_coefficients(
    scale_coefficients(previous, 1.0 - blend),
    scale_coefficients(current, blend)
  );
}

@compute @workgroup_size(${PROBE_SH_COMMIT_WORKGROUP_SIZE}, 1, 1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let local_probe = global_id.x;
  if (local_probe >= settings.probe_update_count) {
    return;
  }

  let input_offset = reduced_coefficient_word_offset(local_probe);
  var current: array<f32, ${PROBE_SH_COEFFICIENT_FLOATS}>;
  for (
    var coefficient = 0u;
    coefficient < ${PROBE_SH_COEFFICIENT_FLOATS}u;
    coefficient++
  ) {
    current[coefficient] = coefficients[input_offset + coefficient];
  }

  let probe_index =
    (local_probe + settings.probe_index_offset) % settings.probe_count;
  let previous = end[probe_index].coefficients;
  end[probe_index].coefficients = blend_coefficients(
    previous,
    current,
    ${PROBE_SH_COMMIT_BLEND}
  );
  end[probe_index].accumulated_samples += 1u;
}
`;
