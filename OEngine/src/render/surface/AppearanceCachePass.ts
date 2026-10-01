import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GpuAppearanceCache } from "../../gpu/GpuAppearanceCache.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { counterByteOffset } from "../../debug/GpuFrameCounters.js";

export interface AppearanceCacheProducts { readonly fields: ResourceId; }

/** FrameGraph owner for Appearance page state and the GPU visible-demand
 * consumer. Field layers are the only material payload exposed downstream. */
export class AppearanceCachePass {
  constructor(private readonly cache: GpuAppearanceCache) {}
  addToGraph(graph: FrameGraph, input: { readonly visibility: ResourceId; readonly meshletWork: ResourceId; readonly counters: ResourceId; readonly frame: Readonly<{ publication: GpuAppearancePublication; index: number; sampleCounters: boolean }>; readonly width: number; readonly height: number; readonly textureBanks: readonly ResourceId[][] }): AppearanceCacheProducts {
    let fields = -1;
    const pass = graph.add("Appearance cache state and live inputs", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const { publication, index } = data.frame;
      publication.syncRuntime(command);
      this.cache.encode(command, publication.cache, index);
      publication.encodeDemand(command, {
        visibility: resolveTextureView(resources.get(data.visibility)),
        meshletWork: resources.get(data.meshletWork) as GPUBuffer,
        textureBanks: data.textureBanks.map(set => set.map(id => resolveTextureView(resources.get(id), { dimension: "2d-array" }))),
        width: data.width, height: data.height, fields: resolveTextureView(resources.get(fields), { dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: 13 }), frame: index
      });
      if (data.frame.sampleCounters) {
        command.gpu_encoder.copyBufferToBuffer(publication.demandCounters, 12,
          resources.get(data.counters) as GPUBuffer, counterByteOffset("appearanceTasksAttempted"), 4);
        command.gpu_encoder.copyBufferToBuffer(publication.demandCounters, 4,
          resources.get(data.counters) as GPUBuffer, counterByteOffset("appearanceTasksOverflow"), 8);
      }
    });
    pass.read(input.visibility);
    pass.read(input.meshletWork);
    pass.write(input.counters);
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
