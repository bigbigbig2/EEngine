import type { GpuMaterialBindings } from "./GpuMaterialStore.js";
import type { TextureResidencyBindings } from "./TextureResidency.js";

/** Immutable view composed from two independent residency owners. */
export interface GpuPackedMaterialBindings
  extends GpuMaterialBindings, TextureResidencyBindings {}

export function composeGpuPackedMaterialBindings(
  materials: GpuMaterialBindings,
  textures: TextureResidencyBindings
): GpuPackedMaterialBindings {
  return Object.freeze({ ...materials, ...textures });
}
