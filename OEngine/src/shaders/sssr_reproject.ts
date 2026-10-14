import { SSSR_DENOISER_COMMON_WGSL } from "./sssr_denoiser_common.js";

// AMD MIT: complete FP32 reproject branch, including both candidates, search,
// qualified bilinear repair, sample statistics and tile-average reduction.
export const SSSR_REPROJECT_WGSL = /* wgsl */ `
${SSSR_DENOISER_COMMON_WGSL}
struct SssrHistory {
  radiance: vec3f,
  normal: vec3f,
  linear_depth: f32,
  alpha: f32,
  statistics: vec2f,
  valid: u32,
}
struct SssrReprojection {
  uv: vec2f,
  radiance: vec3f,
  acceptance: f32,
  surface: u32,
}
fn sssr_disocclusion(normal: vec3f, history_normal_value: vec3f, depth: f32, previous_depth: f32) -> f32 {
  if (depth <= 0.0 || previous_depth <= 0.0) {
    return 0.0;
  }
  return exp(-abs(1.0 - max(0.0, dot(normal, history_normal_value))) * 1.4) *
    exp(-abs(previous_depth - depth) / depth);
}

// All historical geometry and identities are checked per tap BEFORE mixing.
// repair uses the source half-disocclusion threshold, otherwise every tap must
// be valid for a regular bilinear candidate. R32F depth needs no filter feature.
fn sssr_history(uv: vec2f, current_id: vec4u, surface: bool,
                normal: vec3f, depth: f32, repair: bool) -> SssrHistory {
  var result: SssrHistory;
  result.alpha = -1.0;
  if (!sssr_inside(uv)) {
    return result;
  }
  let texel = uv * vec2f(frame.dimensions.xy) - vec2f(0.5);
  let lower = vec2i(floor(texel));
  let weights = sssr_bilinear_weights(fract(texel));
  var total_weight = 0.0;
  var complete = true;
  var alpha_sum = 0.0;
  let ratio = current_exposure[0] / previous_exposure[0];
  for (var tap = 0u; tap < 4u; tap++) {
    let raw_pixel = lower + vec2i(i32(tap & 1u), i32(tap >> 1u));
    let pixel = sssr_clamp(raw_pixel);
    let geometry = textureLoad(history_normal, pixel, i32(frame.dimensions.w), 0);
    let z = textureLoad(history_depth, pixel, 0).x;
    var previous_depth = 0.0;
    if (z > 0.0) {
      previous_depth = sssr_linear_depth(sssr_uv(pixel), z, frame.previous_inv_projection);
    }
    let rgb = textureLoad(history_signal, pixel, 0).rgb * ratio;
    var valid = geometry.w >= 0.0 && z > 0.0 && sssr_finite3(rgb) && all(abs(rgb) <= vec3f(65504.0));
    if (surface) {
      valid = valid && all(textureLoad(previous_identity, pixel, 0) == current_id);
    }
    if (repair) {
      valid = valid && sssr_disocclusion(normal, geometry.xyz, depth, previous_depth) > 0.45;
    }
    let weight = select(0.0, weights[tap], valid);
    if (!valid && weights[tap] > 0.0) {
      complete = false;
    }
    total_weight += weight;
    if (valid) {
      result.radiance += sssr_to709(rgb) * weight;
      result.normal += geometry.xyz * weight;
      result.linear_depth += previous_depth * weight;
      alpha_sum += geometry.w * weight;
      result.statistics += textureLoad(history_statistics, pixel, 0).xy * weight;
    }
  }
  let divisor = max(total_weight, 0.001);
  result.radiance /= divisor;
  result.normal /= divisor;
  result.linear_depth /= divisor;
  result.alpha = alpha_sum / divisor;
  result.statistics /= divisor;
  result.valid = select(0u, 1u, total_weight > 0.0 && (complete || repair));
  return result;
}

fn sssr_pick_reprojection(pixel: vec2i, local: vec2i, alpha: f32, distance: f32) -> SssrReprojection {
  var result: SssrReprojection;
  let response = textureLoad(temporal_response, pixel, 0);
  if (frame.state.z == 0u || response.y < 0.5 || (u32(round(response.w * 255.0)) & 16u) != 0u) {
    return result;
  }
  let uv = sssr_uv(pixel);
  let z = sssr_depth(pixel);
  let depth = sssr_linear_depth(uv, z, frame.inv_projection);
  let normal = sssr_normalize(sssr_lobe(sssr_receiver(sssr_index(vec2u(pixel)))).xyz);
  let current_id = textureLoad(identity, pixel, 0);
  // Seed stores current_uv - previous_uv. Source callback expects the opposite.
  let surface_uv = uv - textureLoad(temporal_seed, pixel, 0).xy;
  let surface = sssr_history(surface_uv, current_id, true, normal, depth, false);
  var view_ray = sssr_unproject(vec3f(uv, z), frame.inv_projection);
  let surface_distance = length(view_ray);
  view_ray *= (surface_distance + distance) / max(surface_distance, 1e-20);
  let virtual_world = (frame.inv_view * vec4f(view_ray, 1.0)).xyz;
  let hit_uv = sssr_project(virtual_world, frame.previous_view_projection).xy;
  let hit = sssr_history(hit_uv, current_id, false, normal, depth, false);
  let hit_similarity = dot(sssr_normalize(hit.normal), normal);
  let surface_similarity = dot(sssr_normalize(surface.normal), normal);
  var selected = surface;
  let moments = sssr_local_moments(local);
  if (distance > 0.0 && hit.valid != 0u && hit_similarity > 0.9999 &&
      hit_similarity + 0.001 > surface_similarity && abs(hit.alpha - alpha) < abs(surface.alpha - alpha) + 0.001) {
    selected = hit;
    result.uv = hit_uv;
  } else {
    let difference = surface.radiance - moments.mean;
    if (!sssr_inside(surface_uv) || (surface.valid != 0u && dot(difference, difference) >= 1.5 * length(moments.variance))) {
      return result;
    }
    result.uv = surface_uv;
    result.surface = 1u;
  }
  result.radiance = selected.radiance;
  result.acceptance = select(0.0, sssr_disocclusion(normal, selected.normal, depth, selected.linear_depth), selected.valid != 0u);
  if (result.acceptance < 0.9) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let candidate_uv = result.uv + vec2f(f32(x), f32(y)) / vec2f(frame.dimensions.xy);
        let candidate = sssr_history(candidate_uv, current_id, result.surface != 0u, normal, depth, false);
        let weight = sssr_disocclusion(normal, candidate.normal, depth, candidate.linear_depth);
        if (candidate.valid != 0u && weight > result.acceptance) {
          result.acceptance = weight;
          result.uv = candidate_uv;
          result.radiance = candidate.radiance;
        }
      }
    }
  }
  if (result.acceptance < 0.9) {
    let repaired = sssr_history(result.uv, current_id, result.surface != 0u, normal, depth, true);
    result.radiance = repaired.radiance;
    result.acceptance = select(0.0,
      sssr_disocclusion(normal, repaired.normal, depth, repaired.linear_depth), repaired.valid != 0u);
  }
  if (result.acceptance < 0.9) {
    result.acceptance = 0.0;
  }
  return result;
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
  sssr_load_halo(tile, local);
  workgroupBarrier();
  var radiance = sssr_load_signal(pixel);
  if (active_tile && sssr_valid_pixel(vec2u(pixel))) {
    let receiver = sssr_receiver(sssr_index(vec2u(pixel)));
    if (sssr_eligible(receiver)) {
      let reprojection = sssr_pick_reprojection(pixel, vec2i(local) + vec2i(4),
        sssr_lobe(receiver).w, textureLoad(ray_length, pixel, 0).x);
      var variance = 1.0;
      var samples = 1.0;
      var reprojected = vec3f(0.0);
      if (reprojection.acceptance >= 0.9 && sssr_inside(reprojection.uv)) {
        let normal = sssr_normalize(sssr_lobe(receiver).xyz);
        let depth = sssr_linear_depth(sssr_uv(pixel), sssr_depth(pixel), frame.inv_projection);
        let old = sssr_history(reprojection.uv, textureLoad(identity, pixel, 0),
          reprojection.surface != 0u, normal, depth, true);
        let maximum_samples = max(8.0, 32.0 * (1.0 - exp(-sssr_lobe(receiver).w * 100.0)));
        samples = min(maximum_samples, old.statistics.y * reprojection.acceptance + 1.0);
        variance = mix(sssr_temporal_variance(radiance, reprojection.radiance), old.statistics.x, 1.0 / samples);
        reprojected = reprojection.radiance;
        radiance = mix(radiance, reprojected, 0.3);
      }
      textureStore(output_signal, pixel, vec4f(sssr_to2020(reprojected), 0.0));
      textureStore(output_statistics, pixel, vec4f(variance, samples, 0.0, 0.0));
      if (frame.state.w == 2u && frame.capacity.w == frame.dimensions.w) {
        debug_values[sssr_index(vec2u(pixel))] = reprojection.acceptance;
      }
    } else {
      textureStore(output_signal, pixel, vec4f(0.0));
      textureStore(output_statistics, pixel, vec4f(0.0));
    }
  }
  // No lane can replace shared halo values until all reprojection readers finish.
  workgroupBarrier();
  var weight = max(exp(-sssr_luma(radiance) * 0.3), 0.01);
  if (!active_tile || !sssr_valid_pixel(vec2u(pixel)) || !sssr_finite3(radiance)) {
    weight = 0.0;
    radiance = vec3f(0.0);
  }
  shared_radiance[sssr_shared_index(vec2i(local))] = vec4f(radiance * weight, weight);
  workgroupBarrier();
  for (var step = 2u; step <= 8u; step *= 2u) {
    let origin = local * step;
    let neighbor = origin + vec2u(step / 2u);
    if (all(neighbor < vec2u(8u))) {
      let a = shared_radiance[sssr_shared_index(vec2i(origin))];
      let b = shared_radiance[sssr_shared_index(vec2i(vec2u(origin.x, neighbor.y)))];
      let c = shared_radiance[sssr_shared_index(vec2i(vec2u(neighbor.x, origin.y)))];
      let d = shared_radiance[sssr_shared_index(vec2i(neighbor))];
      shared_radiance[sssr_shared_index(vec2i(origin))] = a + b + c + d;
    }
    workgroupBarrier();
  }
  if (active_tile && lane == 0u) {
    let sum = shared_radiance[0];
    textureStore(output_average, vec2i(tile / 8u), vec4f(sssr_to2020(sum.xyz / max(sum.w, 0.001)), 0.0));
  }
}
`;
