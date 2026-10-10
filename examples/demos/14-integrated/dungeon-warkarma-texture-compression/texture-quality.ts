import type { GpuRenderWorldRuntime } from "../../../../OEngine/src/gpu/GpuRenderWorld.js";

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
      [...leaves].map((texture) => [texture.texture_product?.identity, texture.texture_product])
    );
    let allLeavesHaveSchema3 = true;
    let allFullMips = true;
    let transferFunctions = true;
    for (const texture of leaves) {
      const metadata = texture.texture_product?.metadata;
      allLeavesHaveSchema3 &&= metadata?.schemaVersion === 3;
      allFullMips &&=
        !!metadata &&
        metadata.planes.every(
          (plane) =>
            plane.mips.length ===
            Math.floor(Math.log2(Math.max(metadata.storageWidth, metadata.storageHeight))) + 1
        );
      const srgb = metadata?.semantic === "base-color-srgb" || metadata?.semantic === "emissive-srgb";
      const expected = srgb
        ? "bc7-rgba-unorm-srgb"
        : metadata?.semantic === "occlusion-linear"
          ? "bc4-r-unorm"
          : metadata?.semantic === "alpha-mask"
            ? "r8unorm"
            : "bc7-rgba-unorm";
      transferFunctions &&= !!metadata && metadata.planes[0]?.format === expected;
    }
    return Object.freeze({
      productCount: [...products.values()].filter(Boolean).length,
      textureLeafCount: leaves.size,
      allLeavesHaveSchema3,
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
