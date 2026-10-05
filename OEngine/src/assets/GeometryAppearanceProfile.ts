/** Cook-only appearance metric. No textures or GPU resources are retained. */
export interface GeometryAppearanceProfile {
  /** Authored tangent basis follows this untransformed normal-map UV set. */
  readonly normalUvSet: -1 | 0 | 1;
  /** UV0.u/v, UV1.u/v weights; transform scale affects texture-space error. */
  readonly uvWeights: readonly [number, number, number, number];
}

export interface GeometryAppearanceTextureSlot {
  readonly texCoord: number;
  readonly scale: readonly [number, number];
}

export function geometryAppearanceProfile(
  slots: readonly (GeometryAppearanceTextureSlot | undefined)[],
  normal?: GeometryAppearanceTextureSlot,
): GeometryAppearanceProfile {
  // Preserve optional UVs too: a Product can later be reused with another material.
  // Rotation preserves length; translation cancels in differences. Decoded image
  // dimensions are not available in the bounded catalog, so these are NOT texels.
  const weights: [number, number, number, number] = [0.1, 0.1, 0.1, 0.1];
  for (const slot of slots) {
    if (!slot) continue;
    if (slot.texCoord !== 0 && slot.texCoord !== 1)
      throw new RangeError("Geometry cooking supports UV0/UV1 only");
    for (let axis = 0; axis < 2; axis++) {
      const weight = Math.fround(0.1 * Math.abs(slot.scale[axis]!));
      if (!Number.isFinite(weight)) throw new RangeError("Geometry texture scale is not finite");
      const at = slot.texCoord * 2 + axis;
      weights[at] = Math.max(weights[at]!, weight);
    }
  }
  const normalUvSet = normal?.texCoord ?? -1;
  if (normalUvSet !== -1 && normalUvSet !== 0 && normalUvSet !== 1)
    throw new RangeError("Normal texture requires UV0/UV1");
  return Object.freeze({ normalUvSet, uvWeights: Object.freeze(weights) });
}
