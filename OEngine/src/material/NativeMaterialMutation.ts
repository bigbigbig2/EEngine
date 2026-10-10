import type { StandardShadeMaterial } from "./StandardShadeMaterial.js";

/** Material owns direct field/component notifications. Each scene subscribes
 * once and detaches on retirement, without replacing the authored accessors. */
export function observeNativeMaterial(material: StandardShadeMaterial, changed: () => void): () => void {
  material.onChanged.add(changed);
  return () => {
    material.onChanged.remove(changed);
  };
}
