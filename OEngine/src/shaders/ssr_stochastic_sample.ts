/**
 * Shared Three.js r186-derived stochastic GGX sampling contract.
 *
 * Trace and hit shading both embed this source so the latter can replay the
 * exact per-pixel VNDF direction instead of inferring it from a quantized HZB
 * hit coordinate.
 */

export const SSR_TRACE_SETTINGS_WGSL = /* wgsl */ `
struct SsrTraceSettings {
  max_distance: f32,
  frame_index: u32,
  edge_fade: f32,
  max_steps: u32,
  base_thickness: f32,
  distance_thickness_scale: f32,
  max_roughness: f32,
  mirror_bias: f32,
};
`;

export const SSR_STOCHASTIC_SAMPLE_WGSL = /* wgsl */ `
fn ssr_stbn_sample_vec4(noise_rg: vec2f, value: vec3u) -> vec4f {
  // The shared production asset is STBN vec2. Deterministically derive the
  // two independent channels required by Three's mirror-bias/retry contract.
  let hash = resolve_trigonometric_moments(
    value ^ vec3u(0x68bc21ebu, 0x02e5be93u, 0x967a889bu)
  );
  return vec4f(
    noise_rg,
    f32(hash & 0xffffu) * (1.0 / 65536.0),
    f32(hash >> 16u) * (1.0 / 65536.0)
  );
}

fn ssr_ggx_basis(normal: vec3f) -> mat3x3f {
  var tangent = cross(vec3f(0.0, 0.0, 1.0), normal);
  if (dot(tangent, tangent) < 1e-6) {
    tangent = cross(vec3f(0.0, 1.0, 0.0), normal);
  }
  tangent = normalize(tangent);
  let bitangent = normalize(cross(normal, tangent));
  return mat3x3f(tangent, bitangent, normal);
}

// three.js r186 SpecularHelpers.js bounded GGX VNDF spherical-cap sampler.
fn sample_ggx_vndf(view_local: vec3f, alpha: f32, xi: vec2f) -> vec3f {
  let wi_std = normalize(vec3f(alpha * view_local.x, alpha * view_local.y, view_local.z));
  let s = 1.0 + length(view_local.xy);
  let alpha2 = alpha * alpha;
  let s2 = s * s;
  let k = (1.0 - alpha2) * s2 /
    max(s2 + alpha2 * view_local.z * view_local.z, 1e-6);
  let cap = wi_std.z * k;
  let phi = 2.0 * PI * xi.x;
  let z = (1.0 - xi.y) * (1.0 + cap) - cap;
  let sin_theta = sqrt(max(0.0, 1.0 - z * z));
  let sampled_cap = vec3f(sin_theta * cos(phi), sin_theta * sin(phi), z);
  let micro_std = sampled_cap + wi_std;
  return normalize(vec3f(
    alpha * micro_std.x,
    alpha * micro_std.y,
    max(0.0, micro_std.z)
  ));
}

fn ssr_sample_reflection_vector(
  view_direction: vec3f,
  normal: vec3f,
  roughness: f32,
  sample_value: vec4f,
  mirror_bias: f32
) -> vec3f {
  // A delta-like lobe gains no useful information from stochastic GGX
  // sampling. Keeping it deterministic avoids turning sub-pixel HZB crossing
  // sensitivity into visible salt-and-pepper holes on polished mirrors; the
  // stochastic Three r186 path remains authoritative above this threshold.
  if (roughness <= 0.04) {
    return normalize(reflect(-view_direction, normal));
  }
  let basis = ssr_ggx_basis(normal);
  let local_view = vec3f(
    dot(basis[0], view_direction),
    dot(basis[1], view_direction),
    dot(basis[2], view_direction)
  );
  let alpha = max(roughness * roughness, 0.001);
  let biased_sample = vec2f(
    sample_value.x,
    mix(sample_value.y, 0.0, mirror_bias * sqrt(sample_value.w))
  );
  var micro_normal = sample_ggx_vndf(local_view, alpha, biased_sample);
  var local_reflection = reflect(-local_view, micro_normal);
  if (local_reflection.z < 0.0) {
    let retry = fract(biased_sample + biased_sample * 7.0);
    micro_normal = sample_ggx_vndf(local_view, alpha, retry);
    local_reflection = reflect(-local_view, micro_normal);
  }
  return normalize(basis * local_reflection);
}

fn ssr_smith_g(ndotx: f32, alpha: f32) -> f32 {
  let alpha2 = alpha * alpha;
  let ndotx2 = ndotx * ndotx;
  return 2.0 * ndotx /
    max(ndotx + sqrt(alpha2 + (1.0 - alpha2) * ndotx2), 1e-6);
}

fn ssr_fresnel_schlick(f0: vec3f, theta: f32) -> vec3f {
  let one_minus = 1.0 - theta;
  let one_minus2 = one_minus * one_minus;
  let one_minus5 = one_minus2 * one_minus2 * one_minus;
  return f0 + (vec3f(1.0) - f0) * one_minus5;
}

// BRDF*cos/pdf invariant of Three.js r186 ggxReflectionSample. The direction
// must be the exact replayed VNDF sample, not a direction reconstructed from
// the quantized hit position.
fn stochastic_sample_weight(
  normal: vec3f,
  view_direction: vec3f,
  sampled_direction: vec3f,
  roughness: f32,
  metalness: f32,
  albedo: vec3f
) -> vec3f {
  let half_vector = normalize(view_direction + sampled_direction);
  let no_v = max(0.0, dot(normal, view_direction));
  let no_l = max(0.0, dot(normal, sampled_direction));
  let vo_h = max(0.0, dot(view_direction, half_vector));
  let alpha = max(roughness * roughness, 0.001);
  let f0 = mix(vec3f(0.04), albedo, metalness);
  let fresnel = ssr_fresnel_schlick(f0, vo_h);
  let geometry = ssr_smith_g(no_v, alpha) * ssr_smith_g(no_l, alpha);
  let sin_v2 = max(0.0, 1.0 - no_v * no_v);
  let cap_s = 1.0 + sqrt(sin_v2);
  let cap_s2 = cap_s * cap_s;
  let alpha2 = alpha * alpha;
  let cap_k = (1.0 - alpha2) * cap_s2 /
    max(cap_s2 + alpha2 * no_v * no_v, 1e-6);
  let stretched_length = sqrt(alpha2 * sin_v2 + no_v * no_v);
  return fresnel * geometry * (cap_k * no_v + stretched_length) /
    max(2.0 * no_v, 1e-4);
}
`;
