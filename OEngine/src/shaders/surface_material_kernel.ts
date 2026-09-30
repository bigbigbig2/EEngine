export interface SurfaceKernelProfile {
  readonly programId: number;
  readonly outputDependencyMask: number;
  readonly textureBankMask: number;
}
export { geometryWgsl } from "./surface_geometry.js";
export { lightingWgsl } from "./surface_lighting.js";
export { textureWgsl, materialEvaluationWgsl, isFastUnlitFactor } from "./surface_material_evaluation.js";
