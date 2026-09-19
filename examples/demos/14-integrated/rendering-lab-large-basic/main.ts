import { startRenderingLab } from "../shared/RenderingLab.ts";

startRenderingLab("basic", {
  modelUrl: new URL("../../../assets/oengine/large.glb", import.meta.url).href,
  modelName: "large.glb",
  modelLabel: "Large model",
  comparisonExampleId: "rendering-lab-large"
});
