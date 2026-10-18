import { SCGI_ABI_WGSL, SCGI_IRRADIANCE_WGSL } from "../render/gi/ScgiAbi.js";

/** Invocation-private receiver facts, existing directory binding only. SH is
 * evaluated at the shaded normal after guide tests at the geometric normal. */
export const SCGI_NATIVE_WGSL = /* wgsl */ `
${SCGI_ABI_WGSL}
${SCGI_IRRADIANCE_WGSL}
// Only the exact anchor source invocation owns this 48B record. World-only SH
// comes from that anchor, before bilinear interpolation or residual injection.
fn scgi_native_source(pixel: vec2u, diffuse: vec3f, occlusion: f32,
    emission: vec3f, underlayer: f32, normal: vec3f, flags: u32) {
  if (lighting_ranges.source.w == 0u) { return; }
  let half_pixel = pixel / 2u;
  let local = half_pixel - lighting_ranges.remap.yz;
  if (any(half_pixel < lighting_ranges.remap.yz) || local.x >= lighting_ranges.remap.w) { return; }
  let index = local.y * lighting_ranges.remap.w + local.x;
  if (index >= lighting_ranges.source.z || lighting_directory[lighting_ranges.source.x + index * 2u] == 0u) { return; }
  if (lighting_directory[lighting_ranges.source.x + index * 2u + 1u] != pixel.y * settings.dimensions.x + pixel.x + 1u) { return; }
  let field = lighting_ranges.segments.z + index * 28u;
  let state = lighting_directory[field + 11u];
  var packed: array<u32, 8>;
  for (var word = 0u; word < 8u; word++) { packed[word] = lighting_directory[field + word]; }
  var coefficients: array<f32, 12>;
  if ((state & 3u) == 3u) { coefficients = scgi_unpack_irradiance(packed, scgi_field_scale(state)); }
  var world: vec3f;
  for (var channel = 0u; channel < 3u; channel++) {
    world[channel] = 0.28209479177387814 * coefficients[channel] + 0.4886025119029199 *
      (normal.x * coefficients[3u + channel] + normal.y * coefficients[6u + channel] + normal.z * coefficients[9u + channel]);
  }
  let radiance = emission + diffuse * underlayer * occlusion * max(world, vec3f(0.0));
  let at = lighting_ranges.source.y + index * 12u;
  for (var channel = 0u; channel < 3u; channel++) {
    lighting_directory[at + channel] = bitcast<u32>(diffuse[channel] * underlayer);
    lighting_directory[at + 4u + channel] = bitcast<u32>(radiance[channel]);
    lighting_directory[at + 8u + channel] = bitcast<u32>(normal[channel]);
  }
  lighting_directory[at + 3u] = flags;
  lighting_directory[at + 7u] = bitcast<u32>(1.0);
  lighting_directory[at + 11u] = bitcast<u32>(-1.0);
}
fn scgi_native_source_sun(pixel: vec2u, value: f32, qualified: bool) {
  if (lighting_ranges.source.w == 0u || !qualified) { return; }
  let half_pixel = pixel / 2u;
  let local = half_pixel - lighting_ranges.remap.yz;
  if (any(half_pixel < lighting_ranges.remap.yz) || local.x >= lighting_ranges.remap.w) { return; }
  let index = local.y * lighting_ranges.remap.w + local.x;
  if (index >= lighting_ranges.source.z || lighting_directory[lighting_ranges.source.x + index * 2u] == 0u) { return; }
  if (lighting_directory[lighting_ranges.source.x + index * 2u + 1u] != pixel.y * settings.dimensions.x + pixel.x + 1u) { return; }
  lighting_directory[lighting_ranges.source.y + index * 12u + 11u] = bitcast<u32>(value);
}
var<private> scgi_receiver_position: vec3f;
var<private> scgi_receiver_normal: vec3f;
var<private> scgi_receiver_instance: OEngineInstanceRecord;
var<private> scgi_material_revision: u32;
var<private> scgi_receiver_slot: u32;
var<private> scgi_reactivity: f32;
var<private> scgi_world_irradiance: vec3f;
var<private> scgi_residual_irradiance: vec3f;
var<private> scgi_residual_confidence: f32;
fn scgi_oct_decode(packed: u32) -> vec3f {
  let xy = unpack2x16snorm(packed);
  var n = vec3f(xy, 1.0 - abs(xy.x) - abs(xy.y));
  if (n.z < 0.0) {
    n = vec3f((vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z);
  }
  return normalize(n);
}
fn scgi_native_irradiance(normal: vec3f, pixel: vec2u) -> vec4f {
  scgi_world_irradiance = vec3f(0.0);
  scgi_residual_irradiance = vec3f(0.0);
  scgi_residual_confidence = 0.0;
  if (lighting_ranges.gi.w == 0u) {
    return vec4f(0.0);
  }
  scgi_reactivity = f32(lighting_ranges.extent_debug.w != 0u);
  let point = (vec2f(pixel) + vec2f(0.5)) * 0.5 - vec2f(0.5);
  let base = vec2i(floor(point));
  let fraction = fract(point);
  var coefficients: array<f32, 12>;
  var total = 0.0;
  var confidence = 0.0;
  var correction: array<f32, 12>;
  for (var tap = 0u; tap < 4u; tap++) {
    let step = vec2i(i32(tap & 1u), i32(tap >> 1u));
    let half_pixel = vec2u(clamp(base + step, vec2i(0), vec2i(lighting_ranges.gi.xy) - vec2i(1)));
    let origin = lighting_ranges.remap.yz;
    let local_pixel = half_pixel - origin;
    let at = lighting_ranges.segments.z +
      (local_pixel.y * lighting_ranges.remap.w + local_pixel.x) * 28u;
    if (any(half_pixel < origin) || local_pixel.x >= lighting_ranges.remap.w ||
        at + 27u >= lighting_ranges.segments.z + lighting_ranges.segments.w) {
      continue;
    }
    let flags = lighting_directory[at + 11u];
    if ((flags & 3u) != 3u) {
      continue;
    }
    // Spatial compatibility does not require the same primitive or meshlet.
    let instance = scgi_receiver_instance;
    let virtual_geometry = oengine_instance_virtual_geometry(instance);
    if (lighting_directory[at + 13u] != instance.instance_set_generation ||
        lighting_directory[at + 16u] != select(0u, instance.product_table_slot, virtual_geometry) ||
        lighting_directory[at + 17u] != select(0u, oengine_instance_geometry_generation(instance), virtual_geometry) ||
        lighting_directory[at + 19u] != oengine_instance_geometry_generation(instance) ||
        lighting_directory[at + 21u] != instance.material_handle ||
        lighting_directory[at + 22u] != scgi_material_revision ||
        lighting_directory[at + 23u] != instance.dynamic_revision) {
      continue;
    }
    let source = lighting_directory[at + 10u];
    if (source >= settings.dimensions.x * settings.dimensions.y) {
      continue;
    }
    let source_pixel = vec2u(source % settings.dimensions.x, source / settings.dimensions.x);
    // Visibility and frame work already belong to Native. Recover the source
    // receiver's exact frame slot without adding a lineage storage binding.
    let source_key = textureLoad(visibility, vec2i(source_pixel), 0).x;
    let source_visibility = oengine_visibility_key_resolve(source_key,
      meshlet_work.header.generation, meshlet_work.header.written_count);
    if (source_visibility.valid == 0u ||
        source_visibility.meshlet_work_slot >= min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements)) ||
        meshlet_work.elements[source_visibility.meshlet_work_slot].instance_slot != scgi_receiver_slot) {
      continue;
    }
    let depth = bitcast<f32>(lighting_directory[at + 8u]);
    let guide_normal = scgi_oct_decode(lighting_directory[at + 9u]);
    let ndc = (vec2f(source_pixel) + vec2f(0.5)) / vec2f(settings.dimensions.xy) *
      vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
    let homogeneous = settings.inverse_view_projection * vec4f(ndc, 1.0, 1.0);
    let direction = homogeneous.xyz / homogeneous.w - settings.camera_position_exposure.xyz;
    let view_direction = (settings.view_matrix * vec4f(direction, 0.0)).xyz;
    if (!(depth > 0.0) || abs(view_direction.z) < 1e-20) {
      continue;
    }
    let position = settings.camera_position_exposure.xyz + direction * (depth / -view_direction.z);
    let delta = position - scgi_receiver_position;
    let tolerance = max(0.002, depth * 0.002);
    if (dot(guide_normal, scgi_receiver_normal) < 0.9 ||
        abs(dot(delta, (guide_normal + scgi_receiver_normal) * 0.5)) > tolerance) {
      continue;
    }
    let axis = select(vec2f(1.0) - fraction, fraction, step != vec2i(0));
    let weight = axis.x * axis.y;
    var packed: array<u32, 8>;
    for (var word = 0u; word < 8u; word++) {
      packed[word] = lighting_directory[at + word];
    }
    let decoded = scgi_unpack_irradiance(packed, scgi_field_scale(flags));
    for (var term = 0u; term < 12u; term++) {
      coefficients[term] += decoded[term] * weight;
    }
    if (lighting_ranges.residual.z != 0u) {
      let residual_at = lighting_ranges.residual.x +
        (local_pixel.y * lighting_ranges.remap.w + local_pixel.x) * 8u;
      if (residual_at + 7u < lighting_ranges.residual.x + lighting_ranges.residual.y) {
        let scale = bitcast<f32>(lighting_directory[residual_at + 6u]);
        let residual_confidence = clamp(bitcast<f32>(lighting_directory[residual_at + 7u]), 0.0, 1.0);
        for (var pair = 0u; pair < 6u; pair++) {
          let value = unpack2x16float(lighting_directory[residual_at + pair]) * scale;
          correction[pair * 2u] += value.x * residual_confidence * weight;
          correction[pair * 2u + 1u] += value.y * residual_confidence * weight;
        }
        scgi_residual_confidence += residual_confidence * weight;
      }
    }
    confidence += f32((flags >> 10u) & 65535u) / 65535.0 * weight;
    total += weight;
  }
  if (!(total > 0.0)) {
    return vec4f(0.0);
  }
  var irradiance = vec3f(0.0);
  // EEngine's standard real SH basis [1, x, y, z], already convolved.
  for (var channel = 0u; channel < 3u; channel++) {
    irradiance[channel] = (0.28209479177387814 * coefficients[channel] +
      0.4886025119029199 * (normal.x * coefficients[3u + channel] +
        normal.y * coefficients[6u + channel] + normal.z * coefficients[9u + channel])) / total;
    scgi_residual_irradiance[channel] = (0.28209479177387814 * correction[channel] +
      0.4886025119029199 * (normal.x * correction[3u + channel] +
        normal.y * correction[6u + channel] + normal.z * correction[9u + channel])) / total;
  }
  scgi_world_irradiance = irradiance;
  scgi_residual_confidence /= total;
  if (lighting_ranges.extent_debug.z == 3u || lighting_ranges.extent_debug.z == 7u) {
    return vec4f(max(irradiance, vec3f(0.0)), clamp(confidence, 0.0, 1.0));
  }
  return vec4f(max(irradiance + scgi_residual_irradiance, vec3f(0.0)), clamp(confidence, 0.0, 1.0));
}
`;
