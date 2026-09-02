// Keep Storybook's Node-flavoured type graph separate from OEngine's browser
// type graph. OEngineRuntime.d.ts describes only the public API used by stories;
// Vite still resolves this module to the real OEngine source at runtime.
export {
  BoxGeometry,
  DirectionalLight,
  Mesh,
  OrbitControls,
  OrbitalCameraController,
  PerspectiveCamera,
  Renderer,
  Scene,
  ShadeDataType,
  ShadeImage,
  ShadeTexture,
  StandardShadeMaterial
} from "../../../OEngine/src/index.ts";
