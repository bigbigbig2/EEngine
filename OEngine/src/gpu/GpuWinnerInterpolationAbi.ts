/** Internal frame-only ABI. A VisibilityKey never supplies a persistent surface identity. */
export const WINNER_COEFFICIENT_STRIDE = 48;
export const WINNER_DICTIONARY_STRIDE = 8;
export const WINNER_CONTROL_STRIDE = 32;
export const WINNER_INDIRECT_STRIDE = 16;
export const WINNER_INTERPOLATION_FLAGS = Object.freeze({ value: 1, dx: 2, dy: 4 });

export const WINNER_COEFFICIENT_WGSL = /* wgsl */ `
struct WinnerCoefficients {
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
}
struct WinnerInterpolation {
  weights: vec3f,
  dx: vec3f,
  dy: vec3f,
  flags: u32,
}
const WINNER_VALUE_VALID: u32 = ${WINNER_INTERPOLATION_FLAGS.value}u;
const WINNER_DX_VALID: u32 = ${WINNER_INTERPOLATION_FLAGS.dx}u;
const WINNER_DY_VALID: u32 = ${WINNER_INTERPOLATION_FLAGS.dy}u;
`;

/** Shared frame producer contract: vertices are transformed once and raster and
 * interpolation read these exact clip positions. Triangles contain 3 local u8
 * indices; original corner order is preserved, including mirrored instances.
 * The owner retains all buffers until the last frame consumer completes. */
export const FRAME_GEOMETRY_MESHLET_STRIDE = 24;
export const FRAME_GEOMETRY_WGSL = /* wgsl */ `
struct FrameGeometryMeshlet {
  vertex_base: u32,
  triangle_base: u32,
  vertex_count: u32,
  triangle_count: u32,
  resident_address: u32,
  vertex_indices: u32,
}
struct FrameGeometryDirectory {
  work_count: u32,
  generation: u32,
  vertex_count: u32,
  triangle_count: u32,
  meshlets: array<FrameGeometryMeshlet>,
}
`;

export const WINNER_HASH_WGSL = /* wgsl */ `
fn winner_hash(key: u32) -> u32 {
  var v = key ^ (key >> 16u);
  v *= 0x7feb352du;
  v ^= v >> 15u;
  v *= 0x846ca68bu;
  return v ^ (v >> 16u);
}
`;
export const WINNER_DICTIONARY_WGSL = /* wgsl */ `
struct WinnerDictionaryEntry {
  key: atomic<u32>,
  coefficient_slot: u32,
}
struct WinnerControl {
  unique_count: atomic<u32>,
  request_failures: atomic<u32>,
  built_count: atomic<u32>,
  invalid_count: atomic<u32>,
  dispatch_x: u32,
  dispatch_y: u32,
  dispatch_z: u32,
  reserved: u32,
}
${WINNER_HASH_WGSL}
`;
