/** Geometry-owned conservative source bounds. */
export const SHADOW_BOUNDS_HEADER_BYTES = 16;
export const SHADOW_BOUNDS_STRIDE = 32;
export const SHADOW_BOUNDS_WGSL = /* wgsl */ `
struct ShadowBoundsHeader {
  count: u32,
  invalid: u32,
  capacity: u32,
  generation: u32,
}
struct ShadowMeshletBounds {
  light_xy: vec4f,
  triangle_count: u32,
  valid: u32,
  reserved: vec2u,
}
struct ShadowBoundsQueue {
  header: ShadowBoundsHeader,
  elements: array<ShadowMeshletBounds>,
}
`;
export const SHADOW_BOUNDS_WRITE_WGSL = SHADOW_BOUNDS_WGSL.replace("invalid: u32", "invalid: atomic<u32>");
