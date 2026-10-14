import { SSSR_DENOISER_COMMON_WGSL } from "./sssr_denoiser_common.js";

// AMD MIT: full resolve_temporal FP32 profile. ClipAABB is Playdead MIT.
export const SSSR_RESOLVE_TEMPORAL_WGSL = /* wgsl */ `
${SSSR_DENOISER_COMMON_WGSL}
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
  if (!active_tile || !sssr_valid_pixel(vec2u(pixel))) {
    return;
  }
  var radiance = shared_radiance[sssr_shared_index(vec2i(local) + vec2i(4))].xyz;
  let receiver = sssr_receiver(sssr_index(vec2u(pixel)));
  let samples = textureLoad(history_statistics, pixel, 0).y;
  if (dot(radiance, vec3f(1.0)) < 0.0001 * current_exposure[0]) {
    textureStore(output_signal, pixel, vec4f(0.0));
    textureStore(output_statistics, pixel, vec4f(0.0, select(0.0, samples, sssr_eligible(receiver)), 0.0, 0.0));
    return;
  }
  if (!sssr_eligible(receiver)) {
    textureStore(output_signal, pixel, vec4f(sssr_to2020(radiance), 0.0));
    textureStore(output_statistics, pixel, vec4f(0.0));
    return;
  }
  var variance = textureLoad(statistics, pixel, 0).x;
  let average = sssr_average(pixel);
  let old_signal = sssr_to709(textureLoad(reprojected_signal, pixel, 0).rgb);
  let moments = sssr_local_moments(vec2i(local) + vec2i(4));
  let deviation = (sqrt(moments.variance) + vec3f(length(moments.mean - average))) * frame.settings.z * 1.4;
  let center = mix(moments.mean, average, 0.2);
  let old_clipped = sssr_clip_aabb(center - deviation, center + deviation, old_signal);
  let history_weight = 1.0 - 1.0 / max(samples, 1.0);
  radiance = mix(radiance, average, 1.0 / max(samples + 1.0, 1.0));
  radiance = sssr_clip_aabb(average - deviation, average + deviation, radiance);
  radiance = mix(radiance, old_clipped, history_weight);
  variance = mix(sssr_temporal_variance(radiance, old_clipped), variance, history_weight);
  // Retain source finite guard; validation separately rejects any finite-guard
  // activation on legal inputs, rather than treating a black output as success.
  if (!sssr_finite3(radiance) || !(abs(variance) <= 3.402823466e38)) {
    radiance = vec3f(0.0);
    variance = 0.0;
  }
  textureStore(output_signal, pixel, vec4f(sssr_to2020(radiance), 0.0));
  textureStore(output_statistics, pixel, vec4f(variance, samples, 0.0, 0.0));
}
`;
