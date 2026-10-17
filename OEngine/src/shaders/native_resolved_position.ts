/** Shared primary world position. Native and GI use the same homogeneous
 * ray/plane intersection and resolved-triangle singular fallback. */
export const PRIMARY_SURFACE_POSITION_WGSL = /* wgsl */ `
fn primary_surface_position(plane: vec4f, inverse_view_projection: mat4x4f,
  pixel: vec2u, extent: vec2u, p0: vec4f, p1: vec4f, p2: vec4f,
  coefficients: WinnerCoefficients) -> vec3f {
  let ndc = (vec2f(pixel) + vec2f(0.5)) / vec2f(extent) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let base = inverse_view_projection * vec4f(ndc, 0.0, 1.0);
  let direction = inverse_view_projection[2];
  let denominator = dot(plane, direction);
  if denominator != 0.0 {
    let homogeneous = base - direction * (dot(plane, base) / denominator);
    if homogeneous.w != 0.0 {
      let position = homogeneous.xyz / homogeneous.w;
      if winner_finite3(position) {
        return position;
      }
    }
  }
  let weights = winner_interpolate(coefficients, vec2f(pixel) + vec2f(0.5), vec2f(extent)).weights;
  return (p0 * weights.x + p1 * weights.y + p2 * weights.z).xyz;
}
`;

export const NATIVE_RESOLVED_POSITION_WGSL = /* wgsl */ `
${PRIMARY_SURFACE_POSITION_WGSL}
fn native_resolved_position(resolved: GeometryResolved, pixel: vec2u) -> vec3f {
  return primary_surface_position(resolved.world_plane, settings.inverse_view_projection,
    pixel, settings.dimensions.xy, resolved.position.p0, resolved.position.p1,
    resolved.position.p2, resolved.coefficients);
}
`;
