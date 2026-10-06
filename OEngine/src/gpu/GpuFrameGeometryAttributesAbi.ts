/** Current representation's object-space attributes, shared by winner input
 * consumers. Absent authored attributes use their asset semantic defaults.
 * Skin deformation is a separate producer; no zero joints/weights are published
 * as evidence that deformation has run. */
export const GPU_FRAME_ATTRIBUTE_VECTORS = 6;
export const GPU_FRAME_ATTRIBUTE_STRIDE = GPU_FRAME_ATTRIBUTE_VECTORS * 16;
/** Frame vertex products retain the six object-space inputs for raster coverage
 * and append exactly transformed world normal/tangent/position for Surface.
 * Immutable residency remains six vectors; its format is unchanged. */
export const GPU_FRAME_VERTEX_ATTRIBUTE_VECTORS = GPU_FRAME_ATTRIBUTE_VECTORS + 3;
export const GPU_FRAME_VERTEX_ATTRIBUTE_STRIDE = GPU_FRAME_VERTEX_ATTRIBUTE_VECTORS * 16;
export const GPU_FRAME_VERTEX_WORLD_FIELDS = Object.freeze({ normal: 6, tangent: 7, position: 8 });
export const GPU_FRAME_ATTRIBUTE_FIELDS = Object.freeze({
  normal: 0,
  tangent: 1,
  uv01: 2,
  color: 3,
  uv2: 4,
  position: 5,
});
