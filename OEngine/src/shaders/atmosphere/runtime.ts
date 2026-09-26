/** Runtime Bruneton/Takram sampling for the pinned Earth LUT profile. */
export const ATMOSPHERE_RUNTIME_WGSL = /* wgsl */ `
const ATMOSPHERE_BOTTOM_RADIUS: f32 = 6360.0;
const ATMOSPHERE_TOP_RADIUS: f32 = 6420.0;
const ATMOSPHERE_MIN_COS_LIGHT: f32 = -0.5;
const ATMOSPHERE_RAYLEIGH_SCATTERING: vec3f = vec3f(0.005802, 0.013558, 0.0331);
const ATMOSPHERE_MIE_SCATTERING: vec3f = vec3f(0.003996, 0.003996, 0.003996);
const ATMOSPHERE_SKY_RADIANCE_TO_LUMINANCE: vec3f = vec3f(114974.91644, 71305.954816, 65310.548555);
const ATMOSPHERE_LUMINANCE_SCALE: f32 = 0.000013207021769386792;
struct PhysicalEnvironmentParameters { sun_direction_world: vec3f, world_to_unit: f32, sun_irradiance: vec3f, generation: f32 };
struct AtmosphereScatteringSample { rayleigh: vec3f, mie: vec3f, higher_order: vec3f };
struct AtmosphereTransport { transmittance: vec3f, inscattering: vec3f };
fn atmosphere_sqrt_safe(v: f32) -> f32 { return sqrt(max(v, 0.0)); }
fn atmosphere_distance_to_top(r: f32, mu: f32) -> f32 { return max(-r * mu + atmosphere_sqrt_safe(r * r * (mu * mu - 1.0) + ATMOSPHERE_TOP_RADIUS * ATMOSPHERE_TOP_RADIUS), 0.0); }
fn atmosphere_clamp_radius(r: f32) -> f32 { return clamp(r, ATMOSPHERE_BOTTOM_RADIUS, ATMOSPHERE_TOP_RADIUS); }
fn atmosphere_ground(r: f32, mu: f32) -> bool { return mu < 0.0 && r * r * (mu * mu - 1.0) + ATMOSPHERE_BOTTOM_RADIUS * ATMOSPHERE_BOTTOM_RADIUS >= 0.0; }
fn atmosphere_unit_coord(v: f32, size: f32) -> f32 { return 0.5 / size + v * (1.0 - 1.0 / size); }
fn atmosphere_transmittance_uv(r: f32, mu: f32) -> vec2f {
  let h = atmosphere_sqrt_safe(ATMOSPHERE_TOP_RADIUS * ATMOSPHERE_TOP_RADIUS - ATMOSPHERE_BOTTOM_RADIUS * ATMOSPHERE_BOTTOM_RADIUS);
  let dh = atmosphere_sqrt_safe(r * r - ATMOSPHERE_BOTTOM_RADIUS * ATMOSPHERE_BOTTOM_RADIUS);
  let d = atmosphere_distance_to_top(r, mu);
  return vec2f(atmosphere_unit_coord((d - (ATMOSPHERE_TOP_RADIUS - r)) / (dh + h - (ATMOSPHERE_TOP_RADIUS - r)), 256.0), atmosphere_unit_coord(dh / h, 64.0));
}
fn atmosphere_scattering_coord(r: f32, mu: f32, mus: f32, nu: f32, ground: bool) -> vec4f {
  let h = atmosphere_sqrt_safe(ATMOSPHERE_TOP_RADIUS * ATMOSPHERE_TOP_RADIUS - ATMOSPHERE_BOTTOM_RADIUS * ATMOSPHERE_BOTTOM_RADIUS);
  let dh = atmosphere_sqrt_safe(r * r - ATMOSPHERE_BOTTOM_RADIUS * ATMOSPHERE_BOTTOM_RADIUS);
  let rmu = r * mu;
  let disc = rmu * rmu - r * r + ATMOSPHERE_BOTTOM_RADIUS * ATMOSPHERE_BOTTOM_RADIUS;
  var view = 0.0;
  if (ground) {
    let dg = r - ATMOSPHERE_BOTTOM_RADIUS;
    let unit = select(0.0, (-rmu - atmosphere_sqrt_safe(disc) - dg) / (dh - dg), dh != dg);
    view = (1.0 - atmosphere_unit_coord(unit, 64.0)) * 0.5;
  } else {
    let dt = ATMOSPHERE_TOP_RADIUS - r;
    let unit = select(0.0, (-rmu + atmosphere_sqrt_safe(disc + h * h) - dt) / (dh + h - dt), dh + h != dt);
    view = (atmosphere_unit_coord(unit, 64.0) + 1.0) * 0.5;
  }
  let dl = atmosphere_distance_to_top(ATMOSPHERE_BOTTOM_RADIUS, mus);
  let min_l = ATMOSPHERE_TOP_RADIUS - ATMOSPHERE_BOTTOM_RADIUS;
  let light_unit = (dl - min_l) / (h - min_l);
  let min_unit = (atmosphere_distance_to_top(ATMOSPHERE_BOTTOM_RADIUS, ATMOSPHERE_MIN_COS_LIGHT) - min_l) / (h - min_l);
  let light = atmosphere_unit_coord(max(1.0 - light_unit / max(min_unit, 1e-5), 0.0) / (light_unit + 1.0), 32.0);
  return vec4f((nu + 1.0) * 0.5, light, view, atmosphere_unit_coord(dh / h, 32.0));
}
fn atmosphere_rayleigh_phase(mu: f32) -> f32 { return 3.0 / (16.0 * 3.141592653589793) * (mu * mu + 1.0); }
fn atmosphere_mie_phase(g: f32, mu: f32) -> f32 { return (3.0 / (3.141592653589793 * 8.0) * (1.0 - g * g) / (g * g + 2.0) * (mu * mu + 1.0)) / pow(g * g - 2.0 * g * mu + 1.0, 1.5); }
fn atmosphere_extrapolated_single_mie(scattering: vec4f) -> vec3f {
  // Takram getExtrapolatedSingleMieScattering: retain the combined-Mie
  // reconstruction used by the pinned LUT profile, including its numerical
  // guard for short rays.
  if (scattering.r < 1e-5) { return vec3f(0.0); }
  return scattering.rgb * (scattering.a / scattering.r) *
    (ATMOSPHERE_RAYLEIGH_SCATTERING.r / ATMOSPHERE_MIE_SCATTERING.r) *
    (ATMOSPHERE_MIE_SCATTERING / ATMOSPHERE_RAYLEIGH_SCATTERING);
}
fn atmosphere_sample(scattering: texture_3d<f32>, higher: texture_3d<f32>, s: sampler, r: f32, mu: f32, mus: f32, nu: f32, ground: bool) -> AtmosphereScatteringSample {
  let uv = atmosphere_scattering_coord(r, mu, mus, nu, ground);
  let x = uv.x * 7.0; let x0 = floor(x); let f = x - x0;
  let a = vec3f((x0 + uv.y) / 8.0, uv.z, uv.w); let b = vec3f((x0 + 1.0 + uv.y) / 8.0, uv.z, uv.w);
  let c = mix(textureSampleLevel(scattering, s, a, 0.0), textureSampleLevel(scattering, s, b, 0.0), f);
  let h = mix(textureSampleLevel(higher, s, a, 0.0), textureSampleLevel(higher, s, b, 0.0), f).rgb;
  let mie = atmosphere_extrapolated_single_mie(c);
  return AtmosphereScatteringSample(c.rgb, mie, h);
}
fn atmosphere_segment_transmittance(lut: texture_2d<f32>, s: sampler, r: f32, mu: f32, d: f32, ground: bool) -> vec3f {
  let re = atmosphere_clamp_radius(atmosphere_sqrt_safe(d * d + 2.0 * r * mu * d + r * r));
  let mue = clamp((r * mu + d) / max(re, 1e-5), -1.0, 1.0);
  if (ground) { return min(textureSampleLevel(lut, s, atmosphere_transmittance_uv(re, -mue), 0.0).rgb / max(textureSampleLevel(lut, s, atmosphere_transmittance_uv(r, -mu), 0.0).rgb, vec3f(1e-5)), vec3f(1.0)); }
  return min(textureSampleLevel(lut, s, atmosphere_transmittance_uv(r, mu), 0.0).rgb / max(textureSampleLevel(lut, s, atmosphere_transmittance_uv(re, mue), 0.0).rgb, vec3f(1e-5)), vec3f(1.0));
}
fn atmosphere_sky(camera: vec3f, ray: vec3f, sun: vec3f, trans: texture_2d<f32>, scattering: texture_3d<f32>, higher: texture_3d<f32>, s: sampler) -> vec3f {
  var p = camera; var r = length(p); let rmu = dot(p, ray); let dtop = -rmu - atmosphere_sqrt_safe(rmu * rmu - r * r + ATMOSPHERE_TOP_RADIUS * ATMOSPHERE_TOP_RADIUS);
  if (dtop > 0.0) { p += ray * dtop; r = ATMOSPHERE_TOP_RADIUS; } if (r > ATMOSPHERE_TOP_RADIUS) { return vec3f(0.0); }
  let mu = dot(p, ray) / r; let mus = dot(p, sun) / r; let nu = dot(ray, sun); let ground = atmosphere_ground(r, mu);
  let t = select(vec3f(0.0), textureSampleLevel(trans, s, atmosphere_transmittance_uv(r, mu), 0.0).rgb, !ground);
  let a = atmosphere_sample(scattering, higher, s, r, mu, mus, nu, ground);
  return (a.rayleigh * atmosphere_rayleigh_phase(nu) + a.mie * atmosphere_mie_phase(0.8, nu) + a.higher_order) * ATMOSPHERE_SKY_RADIANCE_TO_LUMINANCE * ATMOSPHERE_LUMINANCE_SCALE + vec3f(0.0) * t;
}
fn atmosphere_to_point(camera: vec3f, point: vec3f, sun: vec3f, trans: texture_2d<f32>, scattering: texture_3d<f32>, higher: texture_3d<f32>, s: sampler) -> AtmosphereTransport {
  let delta = point - camera; let d = length(delta); if (d <= 1e-5) { return AtmosphereTransport(vec3f(1.0), vec3f(0.0)); }
  let ray = delta / d; let r = length(camera); let mu = dot(camera, ray) / max(r, 1e-5); let mus = dot(camera, sun) / max(r, 1e-5); let nu = dot(ray, sun); let ground = atmosphere_ground(r, mu);
  let re = atmosphere_clamp_radius(atmosphere_sqrt_safe(d * d + 2.0 * r * mu * d + r * r)); let mue = clamp((r * mu + d) / max(re, 1e-5), -1.0, 1.0); let muse = clamp((r * mus + d * nu) / max(re, 1e-5), -1.0, 1.0);
  let t = atmosphere_segment_transmittance(trans, s, r, mu, d, ground); let a = atmosphere_sample(scattering, higher, s, r, mu, mus, nu, ground); let b = atmosphere_sample(scattering, higher, s, re, mue, muse, nu, ground);
  let mie = (a.mie - t * b.mie) * smoothstep(0.0, 0.01, mus);
  let higher_radiance = a.higher_order - t * b.higher_order;
  let radiance = ((a.rayleigh - t * b.rayleigh) * atmosphere_rayleigh_phase(nu) + mie * atmosphere_mie_phase(0.8, nu) + higher_radiance) * ATMOSPHERE_SKY_RADIANCE_TO_LUMINANCE * ATMOSPHERE_LUMINANCE_SCALE;
  return AtmosphereTransport(t, radiance);
}
`;
