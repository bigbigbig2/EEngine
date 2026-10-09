/** Current representation's object-space attributes, shared by winner input
 * consumers. Absent authored attributes use their asset semantic defaults.
 * Skin deformation is a separate producer; no zero joints/weights are published
 * as evidence that deformation has run. */
export const GPU_FRAME_ATTRIBUTE_VECTORS = 6;
export const GPU_FRAME_ATTRIBUTE_STRIDE = GPU_FRAME_ATTRIBUTE_VECTORS * 16;
/** Prepared frame vertices publish only the values consumed by raster and
 * winner reconstruction: world normal/tangent/position and authored UV/color.
 * Immutable residency remains object-space; neither representation aliases it. */
// UV2 has two authored components. Its fixed zero z/w are reconstructed by
// readers, so the following vec4 world position starts at word 18.
export const GPU_FRAME_VERTEX_ATTRIBUTE_WORDS = 22;
export const GPU_FRAME_VERTEX_ATTRIBUTE_STRIDE = GPU_FRAME_VERTEX_ATTRIBUTE_WORDS * 4;
export const GPU_FRAME_VERTEX_WORLD_FIELDS = Object.freeze({ normal: 0, tangent: 1, position: 5 });
export const GPU_FRAME_ATTRIBUTE_FIELDS = Object.freeze({
  normal: 0,
  tangent: 1,
  uv01: 2,
  color: 3,
  uv2: 4,
  position: 5,
});
