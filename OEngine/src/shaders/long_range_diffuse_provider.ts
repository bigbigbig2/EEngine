/**
 * Receiver-local long-range GI selection.
 *
 * This is one authoritative producer: expensive Probe Volume lookup only
 * executes after Brick4 rejected the receiver, and IBL is sampled only after
 * both spatial providers reject it. Provider identity is encoded exactly in
 * selected_diffuse.a (1=Brick4, 2=Probe Volume, 3=IBL, 4=black fallback).
 */

import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import { LIGHT_PROBE_RECORD_WGSL } from "../gpu/LightProbeRecord.js";
import { BRICK4_COMMON_WGSL } from "./brick4_indirect.js";

export const LONG_RANGE_PROVIDER_FORMAT = "rgba16float" as const;

const COUNTER_BRICK4 = counterByteOffset("longRangeBrick4Receivers") / 4;
const COUNTER_PROBE = counterByteOffset("longRangeProbeReceivers") / 4;
const COUNTER_IBL = counterByteOffset("longRangeIblReceivers") / 4;
const COUNTER_BLACK = counterByteOffset("longRangeBlackReceivers") / 4;
const COUNTER_INVALID_GENERATION = counterByteOffset("longRangeInvalidGeneration") / 4;
const COUNTER_NONRESIDENT = counterByteOffset("longRangeNonresidentFallbacks") / 4;

export const LONG_RANGE_DIFFUSE_PROVIDER_WGSL = /* wgsl */ `
${BRICK4_COMMON_WGSL}
${LIGHT_PROBE_RECORD_WGSL}

const BVH_NULL_NODE: u32 = 0xffffffffu;
const INVALID_TET: u32 = 1073741823u;
const PROVIDER_BRICK4: f32 = 1.0;
const PROVIDER_PROBE_VOLUME: f32 = 2.0;
const PROVIDER_IBL: f32 = 3.0;
const PROVIDER_BLACK: f32 = 4.0;

struct LpvTetra {
  vertices: vec4u,
  neighbours: vec4u,
};

struct LpvBvhNode {
  bounds: array<f32, 6>,
  child_1: u32,
  child_2: u32,
};

struct LpvBvh {
  root: u32,
  nodes: array<LpvBvhNode>,
};

struct LongRangeProviderSettings {
  brick_registered: u32,
  brick_resident: u32,
  brick_generation: u32,
  brick_expected_generation: u32,
  probe_registered: u32,
  probe_resident: u32,
  probe_generation: u32,
  probe_expected_generation: u32,
  ibl_resident: u32,
  counters_enabled: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var surface_depth: texture_depth_2d;
@group(0) @binding(1) var surface_normal: texture_2d<u32>;
@group(0) @binding(2) var surface_bent_normal: texture_2d<u32>;
@group(0) @binding(3) var surface_albedo_ao: texture_2d<f32>;
@group(0) @binding(4) var surface_material: texture_2d<u32>;
@group(0) @binding(5) var surface_metadata: texture_2d<u32>;

@group(1) @binding(0) var<uniform> camera: CommandEncoder;
@group(1) @binding(1) var<uniform> view: PipelineCacheKey;
@group(1) @binding(2) var<uniform> provider_settings: LongRangeProviderSettings;
@group(1) @binding(3) var<storage, read_write> frame_counters: array<atomic<u32>>;
@group(1) @binding(4) var environment_sampler: sampler;
@group(1) @binding(5) var replacement: texture_3d<f32>;
@group(1) @binding(6) var environment_diffuse: texture_2d<f32>;
@group(1) @binding(7) var environment_specular: texture_2d<f32>;

@group(2) @binding(0) var<storage, read> radiip: Brick4LightMapStorage;
@group(2) @binding(1) var<storage, read> lpv_bvh: LpvBvh;
@group(2) @binding(2) var<uniform> lpv_metadata: LightProbeVolumeMetadata;
@group(2) @binding(3) var<storage, read> lpv_tetrahedra: array<LpvTetra>;
@group(2) @binding(4) var<storage, read> lpv_probes: array<LightProbeData>;
@group(2) @binding(5) var lpv_depth_atlas: texture_2d<f32>;

fn record_counter(index: u32) {
  if (provider_settings.counters_enabled != 0u) {
    atomicAdd(&frame_counters[index], 1u);
  }
}

fn oct_sign(value: vec2f) -> vec2f {
  return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0));
}

fn oct_encode(direction: vec3f) -> vec2f {
  let denominator = max(1e-7, abs(direction.x) + abs(direction.y) + abs(direction.z));
  var projected = direction.xy / denominator;
  if (direction.z < 0.0) {
    projected = (1.0 - abs(projected.yx)) * oct_sign(projected);
  }
  return 0.5 + 0.5 * projected;
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

fn environment_sample(
  source: texture_2d<f32>,
  direction: vec3f,
  roughness: f32
) -> vec3f {
  let max_mip = textureNumLevels(source) - 1u;
  let lod = clamp(roughness, 0.0, 1.0) * f32(max_mip);
  let lower = u32(floor(lod));
  let upper = min(lower + 1u, max_mip);
  let blend = fract(lod);
  var samples: array<vec3f, 2>;
  for (var sample_index = 0u; sample_index < 2u; sample_index++) {
    let mip = select(lower, upper, sample_index != 0u);
    let resolution = i32(textureDimensions(source, i32(mip)).x);
    let texel = fma(oct_encode(direction), vec2f(f32(resolution)), vec2f(-0.5));
    let fraction = fract(texel);
    let base = vec2i(floor(texel));
    let c00 = oct_wrap_coordinate(base, resolution);
    let c10 = oct_wrap_coordinate(base + vec2i(1, 0), resolution);
    let c01 = oct_wrap_coordinate(base + vec2i(0, 1), resolution);
    let c11 = oct_wrap_coordinate(base + vec2i(1, 1), resolution);
    let weights = vec4f(
      (1.0 - fraction.x) * (1.0 - fraction.y),
      fraction.x * (1.0 - fraction.y),
      (1.0 - fraction.x) * fraction.y,
      fraction.x * fraction.y
    );
    samples[sample_index] =
      textureLoad(source, vec2i(c00), i32(mip)).rgb * weights.x +
      textureLoad(source, vec2i(c10), i32(mip)).rgb * weights.y +
      textureLoad(source, vec2i(c01), i32(mip)).rgb * weights.z +
      textureLoad(source, vec2i(c11), i32(mip)).rgb * weights.w;
  }
  return mix(samples[0], samples[1], blend);
}

fn lpv_probe_position(probe: u32) -> vec3f {
  let value = lpv_probes[probe].position;
  return vec3f(value[0], value[1], value[2]);
}

fn lpv_scalar_triple(a: vec3f, b: vec3f, c_value: vec3f) -> f32 {
  return dot(cross(a, b), c_value);
}

fn lpv_barycentric(cell: u32, point: vec3f) -> vec4f {
  let vertices = lpv_tetrahedra[cell].vertices;
  let a = lpv_probe_position(vertices.x);
  let b = lpv_probe_position(vertices.y);
  let c_value = lpv_probe_position(vertices.z);
  let d = lpv_probe_position(vertices.w);
  let point_a = point - a;
  let point_b = point - b;
  let ba = b - a;
  let ca = c_value - a;
  let da = d - a;
  let denominator = lpv_scalar_triple(ba, ca, da);
  if (abs(denominator) < 1e-10) { return vec4f(-1.0); }
  let inverse = 1.0 / denominator;
  let w0 = lpv_scalar_triple(point_b, d - b, c_value - b) * inverse;
  let w1 = lpv_scalar_triple(point_a, ca, da) * inverse;
  let w2 = lpv_scalar_triple(point_a, da, ba) * inverse;
  return vec4f(w0, w1, w2, 1.0 - w0 - w1 - w2);
}

fn lpv_point_in_bounds(bounds: array<f32, 6>, point: vec3f) -> bool {
  return point.x >= bounds[0] && point.x <= bounds[3] &&
    point.y >= bounds[1] && point.y <= bounds[4] &&
    point.z >= bounds[2] && point.z <= bounds[5];
}

fn lpv_lookup_cell(point: vec3f, barycentric: ptr<function, vec4f>) -> u32 {
  var stack = array<u32, 32>();
  var node = lpv_bvh.root;
  var stack_pointer = 1u;
  for (; stack_pointer > 0u && stack_pointer <= 32u;) {
    let current = lpv_bvh.nodes[node];
    if (!lpv_point_in_bounds(current.bounds, point)) {
      stack_pointer--;
      node = stack[stack_pointer];
      continue;
    }
    if (current.child_1 != BVH_NULL_NODE) {
      node = current.child_1;
      stack[stack_pointer] = current.child_2;
      stack_pointer++;
    } else {
      stack_pointer--;
      node = stack[stack_pointer];
      let cell = current.child_2;
      let weights = lpv_barycentric(cell, point);
      if (all(weights >= vec4f(0.0))) {
        *barycentric = weights;
        return cell;
      }
    }
  }
  return INVALID_TET;
}

fn lpv_depth_moments(direction: vec3f, probe: u32) -> vec2f {
  let resolution = lpv_metadata.probe_resolution;
  let padded = resolution + 2u;
  let atlas_size = textureDimensions(lpv_depth_atlas);
  let patches = atlas_size / padded;
  let patch_origin = vec2u(probe % patches.x, probe / patches.x) * padded + vec2u(1u);
  let texel = fma(oct_encode(direction), vec2f(f32(resolution)), vec2f(-0.5));
  let atlas_uv = (vec2f(patch_origin) + texel + 0.5) / vec2f(atlas_size);
  return textureSampleLevel(lpv_depth_atlas, environment_sampler, atlas_uv, 0.0).rg;
}

fn lpv_probe_visibility(point: vec3f, probe: u32) -> f32 {
  let to_point = point - lpv_probe_position(probe);
  let distance_to_point = length(to_point);
  let distance_max = lpv_probes[probe].distance_max;
  if (distance_to_point < 1e-7) { return 1.0; }
  if (distance_max <= 1e-7) { return 0.0; }
  let moments = lpv_depth_moments(to_point / distance_to_point, probe);
  let variance = max(1e-6, abs(moments.y - moments.x * moments.x));
  let delta = distance_to_point / distance_max - moments.x;
  if (delta <= 0.0) { return 1.0; }
  return variance / (variance + delta * delta);
}

fn lpv_visibility_weights(
  point: vec3f,
  normal: vec3f,
  view_direction: vec3f,
  cell: u32,
  barycentric: vec4f
) -> vec4f {
  let vertices = lpv_tetrahedra[cell].vertices;
  var weights = vec4f(0.0);
  var sum = 0.0;
  for (var corner = 0u; corner < 4u; corner++) {
    let probe = vertices[corner];
    let direction = normalize(lpv_probe_position(probe) - point);
    let normal_weight = max(0.0001, (dot(direction, normal) + 1.0) * 0.5);
    var weight = normal_weight * normal_weight + 0.2;
    let bias_distance = max(lpv_probes[probe].distance_max * 0.05, 1e-7);
    weight *= lpv_probe_visibility(
      point + mix(normal, view_direction, 0.2) * bias_distance,
      probe
    );
    weight = max(1e-6, weight);
    if (weight < 0.2) { weight *= weight * weight * 25.0; }
    weight *= barycentric[corner];
    weights[corner] = weight;
    sum += weight;
  }
  return select(vec4f(0.0), weights / sum, sum > 0.0);
}

fn lpv_probe_sh(probe: u32) -> array<vec3f, 4> {
  let coefficients = lpv_probes[probe].coefficients;
  var result: array<vec3f, 4>;
  for (var coefficient = 0u; coefficient < 4u; coefficient++) {
    for (var channel = 0u; channel < 3u; channel++) {
      result[coefficient][channel] = coefficients[coefficient * 3u + channel];
    }
  }
  return result;
}

fn lpv_irradiance(cell: u32, weights: vec4f, direction: vec3f) -> vec3f {
  let vertices = lpv_tetrahedra[cell].vertices;
  let a = lpv_probe_sh(vertices.x);
  let b = lpv_probe_sh(vertices.y);
  let c_value = lpv_probe_sh(vertices.z);
  let d = lpv_probe_sh(vertices.w);
  var sh: array<vec3f, 4>;
  for (var coefficient = 0u; coefficient < 4u; coefficient++) {
    sh[coefficient] = a[coefficient] * weights.x + b[coefficient] * weights.y +
      c_value[coefficient] * weights.z + d[coefficient] * weights.w;
  }
  var result = sh[0] * 0.8862269254527579;
  result += sh[1] * (1.0233267079464885 * direction.y);
  result += sh[2] * (1.0233267079464885 * direction.z);
  result += sh[3] * (1.0233267079464885 * direction.x);
  return max(vec3f(0.0), result);
}

struct ProviderSample {
  diffuse: vec3f,
  specular: vec3f,
  identity: f32,
};

fn sample_brick4(
  pixel: vec2u,
  position: vec3f,
  normal: vec3f,
  bent_normal: vec3f,
  spec_direction: vec3f,
  roughness: f32,
  material_ao: f32
) -> ProviderSample {
  let node = brick4_node_by_position(position);
  let meta = brick4_node_sample_probes_meta(node.bounds, position, normal);
  let pair = brick4_probe_meta_pick2(
    meta,
    node.address,
    stbn_sample_vec2(vec3u(pixel, view.frame_index))
  );
  let probe0 = brick4_load_probe(pair.global_indices.x);
  let probe1 = brick4_load_probe(pair.global_indices.y);
  let extent = node.bounds.max - node.bounds.min;
  let position0 = node.bounds.min + vec3f(brick4_probe_index_to_coord(pair.local_indices.x)) * (extent / 3.0);
  let position1 = node.bounds.min + vec3f(brick4_probe_index_to_coord(pair.local_indices.y)) * (extent / 3.0);
  let source0 = brick4_probe_compute_weight_by_normal(position0, position, normal);
  let source1 = brick4_probe_compute_weight_by_normal(position1, position, normal);
  let diffuse0 = brick4_probe_compute_weight_by_normal(position0, position, bent_normal);
  let diffuse1 = brick4_probe_compute_weight_by_normal(position1, position, bent_normal);
  let diffuse_a = (1.0 - pair.blend) * (diffuse0 / source0);
  let diffuse_b = pair.blend * (diffuse1 / source1);
  let specular0 = brick4_probe_compute_weight_by_normal(position0, position, spec_direction);
  let specular1 = brick4_probe_compute_weight_by_normal(position1, position, spec_direction);
  let specular_a = (1.0 - pair.blend) * (specular0 / source0);
  let specular_b = pair.blend * (specular1 / source1);
  let diffuse_sample = sh3_color_mix2(
    probe0, probe1, diffuse_b / max(diffuse_a + diffuse_b, 1e-6)
  );
  let specular_sample = sh3_color_mix2(
    probe0, probe1, specular_b / max(specular_a + specular_b, 1e-6)
  );
  return ProviderSample(
    sh3_color_estimate_for_cone(diffuse_sample, sqrt(1.0 - material_ao), bent_normal),
    sh3_color_get_radiance_with_ggx(specular_sample, spec_direction, roughness * roughness),
    PROVIDER_BRICK4
  );
}

fn select_provider(
  pixel: vec2u,
  uv: vec2f,
  position: vec3f,
  normal: vec3f,
  bent_normal: vec3f,
  spec_direction: vec3f,
  view_direction: vec3f,
  roughness: f32,
  material_ao: f32
) -> ProviderSample {
  if (provider_settings.brick_registered != 0u) {
    if (provider_settings.brick_generation != provider_settings.brick_expected_generation) {
      record_counter(${COUNTER_INVALID_GENERATION}u);
    } else if (provider_settings.brick_resident == 0u) {
      record_counter(${COUNTER_NONRESIDENT}u);
    } else if (brick4_receiver_valid(position)) {
      record_counter(${COUNTER_BRICK4}u);
      return sample_brick4(
        pixel, position, normal, bent_normal, spec_direction, roughness, material_ao
      );
    }
  }

  if (provider_settings.probe_registered != 0u) {
    if (provider_settings.probe_generation != provider_settings.probe_expected_generation) {
      record_counter(${COUNTER_INVALID_GENERATION}u);
    } else if (provider_settings.probe_resident == 0u) {
      record_counter(${COUNTER_NONRESIDENT}u);
    } else {
      var barycentric = vec4f(0.0);
      let cell = lpv_lookup_cell(position, &barycentric);
      if (cell != INVALID_TET) {
        let weights = lpv_visibility_weights(
          position, bent_normal, view_direction, cell, barycentric
        );
        record_counter(${COUNTER_PROBE}u);
        return ProviderSample(
          lpv_irradiance(cell, weights, bent_normal) * material_ao,
          environment_sample(environment_specular, spec_direction, roughness),
          PROVIDER_PROBE_VOLUME
        );
      }
    }
  }

  if (provider_settings.ibl_resident != 0u) {
    record_counter(${COUNTER_IBL}u);
    return ProviderSample(
      environment_sample(environment_diffuse, bent_normal, 0.0) * material_ao,
      environment_sample(environment_specular, spec_direction, roughness),
      PROVIDER_IBL
    );
  }
  record_counter(${COUNTER_BLACK}u);
  return ProviderSample(vec3f(0.0), vec3f(0.0), PROVIDER_BLACK);
}

struct ProviderOutputs {
  @location(0) selected_diffuse: vec4f,
  @location(1) selected_specular: vec4f,
};

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> ProviderOutputs {
  let pixel = vec2u(coord.xy);
  let metadata = textureLoad(surface_metadata, vec2i(pixel), 0).r;
  if (oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_UNLIT)) {
    return ProviderOutputs(vec4f(0.0), vec4f(0.0));
  }
  let depth = textureLoad(surface_depth, vec2i(pixel), 0);
  let position = project_position_from_depth(
    uv, depth, camera.view_projection_matrix_inverse
  );
  let normal = decode_surface_normal(textureLoad(surface_normal, vec2i(pixel), 0).xy);
  let bent_normal = decode_bent_normal(textureLoad(surface_bent_normal, vec2i(pixel), 0).xy);
  let material = textureLoad(surface_material, vec2i(pixel), 0);
  let roughness = max(oengine_surface_lite_roughness(material), 0.02);
  let view_direction = normalize(camera.transform[3].xyz - position);
  let reflected = reflect(-view_direction, normal);
  let spec_direction = normalize(mix(reflected, normal, roughness * roughness));
  let material_ao = textureLoad(surface_albedo_ao, vec2i(pixel), 0).a;
  let selected = select_provider(
    pixel, uv, position, normal, bent_normal, spec_direction,
    view_direction, roughness, material_ao
  );
  return ProviderOutputs(
    vec4f(selected.diffuse, selected.identity),
    vec4f(selected.specular, selected.identity)
  );
}
`;
