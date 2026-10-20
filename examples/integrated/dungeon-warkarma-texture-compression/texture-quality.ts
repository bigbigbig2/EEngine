import type { GpuRenderWorldRuntime } from "../../../OEngine/src/gpu/GpuRenderWorld.js";

/** Published programs/products are immutable. Replacement, append and resync
 * create a new runtime; release drops the cached publication and summary. */
export function createTextureQualityReader() {
  let publication: GpuRenderWorldRuntime | undefined;
  let summary: ReturnType<typeof summarize> | undefined;

  function summarize(runtime: GpuRenderWorldRuntime | undefined) {
    const leaves = new Set(
      runtime?.appearancePrograms.flatMap((program) =>
        program.samples.map((sample) => sample.binding.texture)
      ) ?? []
    );
    const products = new Map(
      [...leaves].map((texture) => [
        texture.image_source?.identity,
        texture.image_source?.directory
      ])
    );
    let allLeavesHaveSchema4 = true;
    let allFullMips = true;
    let transferFunctions = true;
    for (const texture of leaves) {
      const metadata = texture.image_source?.directory;
      allLeavesHaveSchema4 &&= metadata?.schemaVersion === 4;
      allFullMips &&= !!metadata && metadata.mipCount ===
        Math.floor(Math.log2(Math.max(metadata.width, metadata.height))) + 1;
      transferFunctions &&= !!metadata && metadata.planes.every((plane) =>
        plane.target === (plane.semantic === "exact-r" ? "r8"
          : plane.semantic === "normal-xy" ? "bc5-rg"
          : plane.semantic === "scalar-r" ? "bc4-r"
          : plane.semantic === "color-rgba" ? "bc7-rgba" : "bc7-rgb"));
    }
    return Object.freeze({
      productCount: [...products.values()].filter(Boolean).length,
      textureLeafCount: leaves.size,
      allLeavesHaveSchema4,
      allFullMips,
      transferFunctions
    });
  }

  return {
    read(runtime: GpuRenderWorldRuntime | undefined) {
      if (!summary || publication !== runtime) {
        publication = runtime;
        summary = summarize(runtime);
      }
      return summary;
    },
    clear() {
      publication = undefined;
      summary = undefined;
    }
  };
}
