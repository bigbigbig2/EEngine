/** Shared exact raster CXY material semantics for Native and SCGI source projection. */
export const NATIVE_GEOMETRY_INPUTS_WGSL = /* wgsl */ `
fn native_safe_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let length2 = dot(value, value);
  if length2 > 1e-20 {
    return value * inverseSqrt(length2);
  }
  return fallback;
}
fn native_attribute(corners: GeometryCorners, weights: vec3f) -> vec4f {
  return corners.p0 * weights.x + corners.p1 * weights.y + corners.p2 * weights.z;
}
fn native_geometry_input(corners: GeometryCompletion, weights: vec3f, kind: u32) -> vec4f {
  let position = native_attribute(corners.position, weights);
  let geometric = native_safe_normal(corners.world_plane.xyz, vec3f(0.0, 0.0, 1.0));
  let raw = native_attribute(corners.normal, weights);
  let unflipped = native_safe_normal(raw.xyz, geometric);
  let flip = (corners.flags & 16u) != 0u && dot(unflipped, settings.camera_position_exposure.xyz - position.xyz) < 0.0;
  let normal = select(unflipped, -unflipped, flip);
  let raw_tangent = native_attribute(corners.tangent, weights);
  let fallback = native_safe_normal(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(unflipped.z) > 0.99), unflipped), vec3f(1.0, 0.0, 0.0));
  let tangent = native_safe_normal(raw_tangent.xyz - unflipped * dot(unflipped, raw_tangent.xyz), fallback);
  switch kind {
    case 1u: { return vec4f(native_attribute(corners.uv, weights).xy, 0.0, 0.0); }
    case 2u: { return vec4f(native_attribute(corners.uv, weights).zw, 0.0, 0.0); }
    case 3u: { return native_attribute(corners.uv2, weights); }
    case 4u: { return native_attribute(corners.color, weights); }
    case 5u, 11u: { return vec4f(normal, raw.w); }
    case 6u, 12u: { return vec4f(select(tangent, -tangent, flip), raw_tangent.w); }
    case 7u, 10u: { return position; }
    case 8u: { return vec4f(native_safe_normal(settings.camera_position_exposure.xyz - position.xyz, normal), 0.0); }
    case 9u: { return vec4f(settings.camera_position_exposure.xyz, 1.0); }
    case 13u: { return settings.view_matrix * position; }
    case 14u: { return vec4f((settings.view_matrix * vec4f(normal, 0.0)).xyz, raw.w); }
    default: { return vec4f(0.0); }
  }
}
`;
