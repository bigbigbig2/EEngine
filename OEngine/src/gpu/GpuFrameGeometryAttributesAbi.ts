/** Current representation's object-space attributes, shared by winner input
 * consumers. Absent authored attributes use their asset semantic defaults.
 * Skin deformation is a separate producer; no zero joints/weights are published
 * as evidence that deformation has run. */
export const GPU_FRAME_ATTRIBUTE_VECTORS = 6;
export const GPU_FRAME_ATTRIBUTE_STRIDE = GPU_FRAME_ATTRIBUTE_VECTORS * 16;
export const GPU_FRAME_ATTRIBUTE_FIELDS = Object.freeze({
  normal: 0, tangent: 1, uv01: 2, color: 3, uv2: 4, position: 5
});
