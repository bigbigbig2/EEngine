import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GpuAppearanceCache } from "../../gpu/GpuAppearanceCache.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export interface AppearanceCacheProducts { readonly fields: ResourceId; }

/** FrameGraph owner for Appearance page state and the GPU visible-demand
 * consumer. Field layers are the only material payload exposed downstream. */
export class AppearanceCachePass {
  constructor(private readonly cache: GpuAppearanceCache) {}
  addToGraph(graph: FrameGraph, input: { readonly visibility: ResourceId; readonly meshletWork: ResourceId; readonly publication: GpuAppearancePublication; readonly frame: number; readonly width: number; readonly height: number; readonly textureBanks: readonly ResourceId[][] }): AppearanceCacheProducts {
    let fields = -1;
    const pass = graph.add("Appearance cache state and live inputs", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      data.publication.syncRuntime(command);
      this.cache.encode(command, data.publication.cache, data.frame);
      data.publication.encodeDemand(command, {
        visibility: resolveTextureView(resources.get(data.visibility)),
        meshletWork: resources.get(data.meshletWork) as GPUBuffer,
        textureBanks: data.textureBanks.flatMap(set => set.map(id => resolveTextureView(resources.get(id)))),
        width: data.width, height: data.height, fields: resolveTextureView(resources.get(fields), { dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: 13 }), frame: data.frame
      });
    });
    pass.read(input.visibility);
    pass.read(input.meshletWork);
    for (const set of input.textureBanks) for (const bank of set) pass.read(bank);
    fields = pass.create("Appearance surface fields", {
      kind: "transient_texture", label: "Appearance surface field array", width: input.width, height: input.height,
      depthOrArrayLayers: 13, dimension: "2d", format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full"
    });
    pass.write(fields);
    pass.make_side_effect();
    return { fields };
  }
}
