/**
 * probe_atlas_border：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const PROBE_ATLAS_BORDER_SETTINGS_BYTES = 20;
export const PROBE_ATLAS_BORDER_WORKGROUP_SIZE = 256;
export const PROBE_ATLAS_DEPTH_FORMAT = "rg16float" as const;
export const PROBE_ATLAS_RADIANCE_FORMAT = "r32uint" as const;

export function probeAtlasBorderTexelsPerProbe(probeResolution: number): number {
  return 4 * (probeResolution + 1);
}

export function probeAtlasBorderBufferWords(
  probeUpdateCount: number,
  probeResolution: number
): number {
  const logicalWords = probeAtlasBorderTexelsPerProbe(probeResolution);
  const alignedWords =
    Math.ceil(logicalWords / PROBE_ATLAS_BORDER_WORKGROUP_SIZE) *
    PROBE_ATLAS_BORDER_WORKGROUP_SIZE;
  return probeUpdateCount * alignedWords;
}

const PROBE_ATLAS_BORDER_COMMON_WGSL = /* wgsl */ `
struct ProbeAtlasBorderSettings {
  probe_resolution: u32,
  probe_update_count: u32,
  probe_index_offset: u32,
  probe_count: u32,
  atlas_patches_per_row: u32,
};

@group(0) @binding(0) var<uniform> settings: ProbeAtlasBorderSettings;

fn index_to_grid2d(index: u32, width: u32) -> vec2u {
  return vec2u(index % width, index / width);
}

fn probe_border_coordinate(border_index: u32, resolution: u32) -> vec2i {
  let edge_span = resolution + 1u;
  var result: vec2i;
  if (border_index < edge_span) {
    result.x = i32(border_index) - 1;
    result.y = -1;
  } else if (border_index < edge_span * 2u) {
    let edge_index = border_index - edge_span;
    result.x = i32(resolution);
    result.y = i32(edge_index) - 1;
  } else if (border_index < edge_span * 3u) {
    let edge_index = border_index - edge_span * 2u;
    result.x = i32(resolution - edge_index);
    result.y = i32(resolution);
  } else {
    let edge_index = border_index - edge_span * 3u;
    result.x = -1;
    result.y = i32(resolution - edge_index);
  }
  return result;
}

fn octahedral_wrap_texel_coordinate(
  position: vec2i,
  resolution: i32
) -> vec2u {
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

fn probe_border_addresses(linear_index: u32) -> array<vec2i, 2> {
  let resolution = settings.probe_resolution;
  let border_count = 4u * (resolution + 1u);
  let local_probe = linear_index / border_count;
  let border_index = linear_index % border_count;
  let border_coordinate = probe_border_coordinate(border_index, resolution);
  let wrapped_coordinate = octahedral_wrap_texel_coordinate(
    border_coordinate,
    i32(resolution)
  );
  let probe_index =
    (local_probe + settings.probe_index_offset) % settings.probe_count;
  let atlas_patch = index_to_grid2d(
    probe_index,
    settings.atlas_patches_per_row
  );
  let interior_origin = atlas_patch * (resolution + 2u) + vec2u(1u);
  return array<vec2i, 2>(
    vec2i(interior_origin + wrapped_coordinate),
    vec2i(interior_origin) + border_coordinate
  );
}
`;

export const PROBE_DEPTH_BORDER_EXTRACT_WGSL = /* wgsl */ `
${PROBE_ATLAS_BORDER_COMMON_WGSL}

@group(0) @binding(1) var history_at_zero: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;

@compute @workgroup_size(${PROBE_ATLAS_BORDER_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let linear_index = global_id.x;
  if (linear_index >= arrayLength(&output)) {
    return;
  }

  let border_count = 4u * (settings.probe_resolution + 1u);
  let local_probe = linear_index / border_count;
  if (local_probe >= settings.probe_update_count) {
    return;
  }

  let addresses = probe_border_addresses(linear_index);
  let source_value = textureLoad(history_at_zero, addresses[0], 0);
  output[linear_index] = pack2x16float(source_value.xy);
}
`;

export const PROBE_DEPTH_BORDER_STORE_WGSL = /* wgsl */ `
${PROBE_ATLAS_BORDER_COMMON_WGSL}

@group(0) @binding(1) var<storage, read> chunk_sample_screen_size:
  array<u32>;
@group(0) @binding(2) var history_at_zero:
  texture_storage_2d<rg16float, write>;

@compute @workgroup_size(${PROBE_ATLAS_BORDER_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let linear_index = global_id.x;
  let border_count = 4u * (settings.probe_resolution + 1u);
  let local_probe = linear_index / border_count;
  if (local_probe >= settings.probe_update_count) {
    return;
  }

  let addresses = probe_border_addresses(linear_index);
  let value = unpack2x16float(chunk_sample_screen_size[linear_index]);
  textureStore(
    history_at_zero,
    addresses[1],
    vec4f(value, 0.0, 0.0)
  );
}
`;

export const PROBE_RADIANCE_BORDER_COPY_WGSL = /* wgsl */ `
${PROBE_ATLAS_BORDER_COMMON_WGSL}

@group(0) @binding(1) var history_at_zero:
  texture_storage_2d<r32uint, read_write>;

@compute @workgroup_size(${PROBE_ATLAS_BORDER_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let linear_index = global_id.x;
  let border_count = 4u * (settings.probe_resolution + 1u);
  let local_probe = linear_index / border_count;
  if (local_probe >= settings.probe_update_count) {
    return;
  }

  let addresses = probe_border_addresses(linear_index);
  let value = textureLoad(history_at_zero, addresses[0]);
  textureStore(history_at_zero, addresses[1], value);
}
`;
