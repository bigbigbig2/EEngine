/** Native primary Surface position from the already recovered triangle plane.
 * No repeated winner/instance/geometry reads or depth reconstruction. */
export const NATIVE_RESOLVED_POSITION_WGSL = /* wgsl */ `
fn native_resolved_position(resolved: GeometryResolved, pixel: vec2u) -> vec3f {
  // Intersect the camera ray with the already recovered triangle plane. This
  // is the one primary Surface position, shared by Seed, Sun and the BRDF.
  // No Depth fetch, second visibility/instance/geometry lookup or neighbour
  // reconstruction. Solve clip Z in homogeneous space: one matrix-vector
  // product and two plane dots, with no two endpoint perspective divisions.
  let ndc = (vec2f(pixel) + vec2f(0.5)) / vec2f(settings.dimensions.xy) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let base = settings.inverse_view_projection * vec4f(ndc, 0.0, 1.0);
  let direction = settings.inverse_view_projection[2];
  let denominator = dot(resolved.world_plane, direction);
  if (denominator != 0.0) {
    let clip_depth = -dot(resolved.world_plane, base) / denominator;
    let homogeneous = base + direction * clip_depth;
    if (homogeneous.w != 0.0) {
      let position = homogeneous.xyz / homogeneous.w;
      if (winner_finite3(position)) {
        return position;
      }
    }
  }
  // Exact singular ray/plane configurations retain the same resolved triangle
  // interpolation, without reloading geometry or changing winner coverage.
  let weights = winner_interpolate(resolved.coefficients, vec2f(pixel) + vec2f(0.5),
    vec2f(settings.dimensions.xy)).weights;
  return (resolved.position.p0 * weights.x + resolved.position.p1 * weights.y + resolved.position.p2 * weights.z).xyz;
}
`;
