/** Shared UV, clip and positive-depth convention for Native Seed and GI.
 * Matrices include their actual jitter. Motion is current UV - previous UV. */
export const PRIMARY_SURFACE_MOTION_WGSL = /* wgsl */ `
struct PrimarySurfaceMotion {
  previous_world: vec3f,
  previous_clip: vec4f,
  previous_uv: vec2f,
  motion: vec2f,
  expected_depth: f32,
  current_depth: f32,
  valid: bool,
}
fn primary_surface_motion(position: vec3f, previous_world: vec3f,
  pixel: vec2u, extent: vec2u, current_view: mat4x4f,
  previous_view: mat4x4f, previous_projection: mat4x4f, available: bool) -> PrimarySurfaceMotion {
  var result: PrimarySurfaceMotion;
  result.previous_world = previous_world;
  let previous = previous_view * vec4f(previous_world, 1.0);
  let clip = previous_projection * previous;
  result.previous_clip = clip;
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(extent);
  result.expected_depth = max(-previous.z, 0.0);
  result.current_depth = max(-(current_view * vec4f(position, 1.0)).z, 0.0);
  if available && all(abs(clip) <= vec4f(3.402823466e38)) && clip.w > 1e-6 &&
    clip.z >= 0.0 && clip.z <= clip.w && result.expected_depth > 0.0 && result.current_depth > 0.0 {
    result.previous_uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
    result.motion = uv - result.previous_uv;
    result.valid = all(result.previous_uv >= vec2f(0.0)) && all(result.previous_uv < vec2f(1.0)) &&
      all(abs(result.motion) < vec2f(2.0));
  }
  return result;
}
`;
