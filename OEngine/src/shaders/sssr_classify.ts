import { SSSR_COMMON_WGSL } from "./sssr_common.js";
import { NATIVE_ENVIRONMENT_SAMPLE_WGSL } from "./native_environment_sample.js";

// AMD MIT, classify_tiles.h. Portable workgroup prefix replaces wave intrinsics.
export const SSSR_CLASSIFY_WGSL = /* wgsl */ `
${SSSR_COMMON_WGSL}
${NATIVE_ENVIRONMENT_SAMPLE_WGSL}
@group(1) @binding(0) var previous_statistics: texture_2d<f32>;
@group(1) @binding(1) var<storage, read_write> rays: array<vec2u>;
@group(1) @binding(2) var<storage, read_write> tiles: array<u32>;
@group(1) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;
@group(1) @binding(4) var raw: texture_storage_2d<rgba16float, write>;
@group(1) @binding(5) var next_statistics: texture_storage_2d<rg16float, write>;
@group(1) @binding(6) var average: texture_storage_2d<rgba16float, write>;
@group(1) @binding(7) var ray_length: texture_storage_2d<r32float, write>;
@group(1) @binding(8) var environment: texture_2d<f32>;
var<workgroup> eligible_lanes: array<u32, 64>;
var<workgroup> copies: array<u32, 64>;
var<workgroup> prefix: array<u32, 64>;
var<workgroup> ray_base: u32;
var<workgroup> tile_count: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let local = sssr_remap(lane);
  let pixel = group.xy * 8u + local;
  let valid = sssr_valid_pixel(pixel);
  var eligible = false;
  var alpha = 1.0;
  if (valid) {
    let receiver = sssr_receiver(sssr_index(pixel));
    eligible = sssr_eligible(receiver) && sssr_depth(vec2i(pixel)) > 0.0;
    alpha = sssr_lobe(receiver).w;
    var fallback = vec3f(0.0);
    if (!eligible && (u32(receiver.baseline.w) & 1u) != 0u && sssr_depth(vec2i(pixel)) > 0.0) {
      let uv = sssr_uv(vec2i(pixel));
      let view_ray = sssr_unproject(vec3f(uv, sssr_depth(vec2i(pixel))), frame.inv_projection);
      var normal = sssr_lobe(receiver).xyz;
      if (dot(normal, normal) < 1e-20) {
        normal = receiver.base.xyz;
      }
      let view_normal = sssr_normalize((frame.view * vec4f(normal, 0.0)).xyz);
      let reflected = reflect(normalize(view_ray), view_normal);
      let world_direction = sssr_normalize((frame.inv_view * vec4f(reflected, 0.0)).xyz);
      // This is a real denoiser halo input even when its final response is zero.
      fallback = sample_native_environment(environment, world_direction, sqrt(alpha)) * current_exposure[0];
    }
    textureStore(raw, vec2i(pixel), vec4f(sssr_to2020(fallback), 0.0));
    textureStore(next_statistics, vec2i(pixel), vec4f(0.0));
    textureStore(ray_length, vec2i(pixel), vec4f(0.0));
  }
  eligible_lanes[lane] = select(0u, 1u, eligible);
  if (lane == 0u) {
    atomicStore(&tile_count, 0u);
    textureStore(average, vec2i(group.xy), vec4f(0.0));
  }
  workgroupBarrier();
  let samples = frame.state.y;
  let base_ray = samples == 4u || (samples == 1u && (local.x & 1u) == 0u && (local.y & 1u) == 0u) ||
    (samples == 2u && (local.x & 1u) == (local.y & 1u));
  var needs_ray = eligible && (base_ray || alpha < 0.0001);
  if (eligible && !needs_ray && frame.state.z != 0u) {
    needs_ray = textureLoad(previous_statistics, vec2i(pixel), 0).x > 0.0;
  }
  // A quad's designated base can be background/rough/unlit. Promote unserved
  // receivers rather than leaving a zero-valued hole at reflective boundaries.
  var designated = local & vec2u(0xfffffffeu);
  if (samples == 2u) {
    designated = local ^ vec2u(1u, 0u);
  }
  if (eligible && !needs_ray && eligible_lanes[sssr_lane(designated)] == 0u) {
    needs_ray = true;
  }
  copies[lane] = select(0u, 1u, eligible && !needs_ray);
  prefix[lane] = select(0u, 1u, needs_ray);
  if (eligible) {
    atomicAdd(&tile_count, 1u);
  }
  workgroupBarrier();
  var flags = 0u;
  if (base_ray && needs_ray && samples != 4u) {
    flags |= copies[sssr_lane(local ^ vec2u(1u, 0u))];
    if (samples == 1u) {
      flags |= copies[sssr_lane(local ^ vec2u(0u, 1u))] << 1u;
      flags |= copies[sssr_lane(local ^ vec2u(1u, 1u))] << 2u;
    }
  }
  for (var offset = 1u; offset < 64u; offset *= 2u) {
    var neighbor = 0u;
    if (lane >= offset) {
      neighbor = prefix[lane - offset];
    }
    workgroupBarrier();
    prefix[lane] += neighbor;
    workgroupBarrier();
  }
  if (lane == 0u) {
    ray_base = 0u;
    if (prefix[63] > 0u) {
      ray_base = atomicAdd(&counts[0], prefix[63]);
    }
    if (atomicLoad(&tile_count) > 0u) {
      let slot = atomicAdd(&counts[1], 1u);
      tiles[slot] = group.y * frame.capacity.x + group.x;
    }
  }
  workgroupBarrier();
  if (needs_ray) {
    rays[ray_base + prefix[lane] - 1u] = vec2u(sssr_index(pixel), flags);
  }
}
`;
