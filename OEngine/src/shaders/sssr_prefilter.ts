import { SSSR_DENOISER_COMMON_WGSL } from "./sssr_denoiser_common.js";

// AMD MIT: complete FP32 prefilter, including all fifteen Halton neighbors.
export const SSSR_PREFILTER_WGSL = /* wgsl */ `
${SSSR_DENOISER_COMMON_WGSL}
var<workgroup> shared_normal: array<vec4f, 256>;
var<workgroup> shared_depth_variance: array<vec2f, 256>;
const SSSR_FILTER_OFFSETS = array<vec2i, 15>(
  vec2i(0, 1), vec2i(-2, 1), vec2i(2, -3), vec2i(-3, 0), vec2i(1, 2),
  vec2i(-1, -2), vec2i(3, 0), vec2i(-3, 3), vec2i(0, -3), vec2i(-1, -1),
  vec2i(2, 1), vec2i(-2, -2), vec2i(1, 0), vec2i(0, 2), vec2i(3, -1));

fn sssr_radiance_weight(center: vec3f, neighbor: vec3f, variance: f32) -> f32 {
  return max(exp(-(0.6 + variance * 0.1) * length((center - neighbor) / current_exposure[0])), 0.01);
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(num_workgroups) groups: vec3u,
        @builtin(local_invocation_index) lane: u32) {
  let tile_index = group.y * groups.x + group.x;
  let active_tile = tile_index < counts[1];
  var tile_number = 0u;
  if (active_tile) {
    tile_number = tiles[tile_index];
  }
  let tile = vec2u(tile_number % frame.capacity.x, tile_number / frame.capacity.x) * 8u;
  let local = sssr_remap(lane);
  let pixel = vec2i(tile + local);
  for (var part = 0u; part < 4u; part++) {
    let coordinate = vec2i(local + vec2u((part & 1u) * 8u, (part >> 1u) * 8u));
    let source_pixel = sssr_clamp(vec2i(tile) + coordinate - vec2i(4));
    let slot = sssr_shared_index(coordinate);
    let receiver = sssr_receiver(sssr_index(vec2u(source_pixel)));
    shared_radiance[slot] = vec4f(sssr_load_signal(source_pixel), 0.0);
    shared_normal[slot] = vec4f(sssr_normalize(sssr_lobe(receiver).xyz), 0.0);
    // An inactive tile has no writer in this lobe's shared reprojection scratch.
    // Its noneligible pixels still supply radiance/geometry, but source variance
    // is zero; never sample the previous lobe/frame's scratch for those pixels.
    var source_variance = 0.0;
    if (sssr_eligible(receiver) && sssr_depth(source_pixel) > 0.0) {
      source_variance = textureLoad(statistics, source_pixel, 0).x;
    }
    shared_depth_variance[slot] = vec2f(
      sssr_linear_depth(sssr_uv(source_pixel), max(sssr_depth(source_pixel), 1e-20), frame.inv_projection),
      source_variance);
  }
  workgroupBarrier();
  if (!active_tile || !sssr_valid_pixel(vec2u(pixel))) {
    return;
  }
  let local_center = vec2i(local) + vec2i(4);
  let center_index = sssr_shared_index(local_center);
  let center = shared_radiance[center_index].xyz;
  let normal = shared_normal[center_index].xyz;
  let depth_variance = shared_depth_variance[center_index];
  let receiver = sssr_receiver(sssr_index(vec2u(pixel)));
  let alpha = sssr_lobe(receiver).w;
  var radiance = center;
  var variance = depth_variance.y;
  if (variance > 0.0 && sssr_eligible(receiver) && alpha >= 0.0001) {
    let average = sssr_average(pixel);
    var total_weight = sssr_radiance_weight(average, center, variance);
    var sum = center * total_weight;
    var variance_sum = variance * total_weight * total_weight;
    let variance_weight = max(0.1, 1.0 - exp(-variance * 4.4));
    for (var sample_index = 0u; sample_index < 15u; sample_index++) {
      let neighbor_index = sssr_shared_index(local_center + SSSR_FILTER_OFFSETS[sample_index]);
      let neighbor = shared_radiance[neighbor_index].xyz;
      let neighbor_normal = shared_normal[neighbor_index].xyz;
      let neighbor_depth_variance = shared_depth_variance[neighbor_index];
      var weight = pow(max(dot(normal, neighbor_normal), 0.0), 512.0);
      weight *= exp(-abs(depth_variance.x - neighbor_depth_variance.x) * frame.physical.x *
        depth_variance.x * frame.physical.x * 4.0);
      weight *= sssr_radiance_weight(average, neighbor, variance);
      weight *= variance_weight;
      total_weight += weight;
      sum += weight * neighbor;
      variance_sum += weight * weight * neighbor_depth_variance.y;
    }
    radiance = sum / total_weight;
    variance = variance_sum / (total_weight * total_weight);
  }
  textureStore(output_signal, pixel, vec4f(sssr_to2020(radiance), 0.0));
  textureStore(output_variance, pixel, vec4f(variance));
}
`;
