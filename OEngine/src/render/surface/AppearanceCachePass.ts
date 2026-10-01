import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { counterByteOffset } from "../../debug/GpuFrameCounters.js";
import { WinnerPrimitiveInterpolation, type WinnerInterpolationAllocation } from "./WinnerPrimitiveInterpolation.js";
import type { FrameGeometryArena, PreparedFrameGeometryArena } from "../FrameGeometryArena.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GpuSparseShadingAssetHeapBindings } from "../../gpu/GpuAssetStore.js";
import { APPEARANCE_SURFACE_LAYER_COUNT } from "../../gpu/GpuAppearanceCacheAbi.js";

export interface AppearanceCacheProducts { readonly fields: ResourceId; readonly geometry: ResourceId; }

/** FrameGraph owner for Appearance page state and the GPU visible-demand
 * consumer. Field layers are the only material payload exposed downstream. */
export class AppearanceCachePass {
  private readonly winners = new Map<PreparedFrameGeometryArena, { allocation: WinnerInterpolationAllocation;
    visibility: GPUTextureView; directory: number; width: number; height: number; unsubscribe: () => void }>();
  private constructor(private readonly winnerOwner: WinnerPrimitiveInterpolation,
    private readonly arenaOwner: FrameGeometryArena) {}
  static async create(graphics: GraphicsContext): Promise<AppearanceCachePass> {
    const winner = await WinnerPrimitiveInterpolation.create(graphics.device, { accounting: graphics.resource_accounting });
    return new AppearanceCachePass(winner, graphics.frame_geometry_arena);
  }
  addToGraph(graph: FrameGraph, input: { readonly visibility: ResourceId; readonly meshletWork: ResourceId; readonly geometry: ResourceId; readonly attributes: ResourceId; readonly counters: ResourceId;
    readonly frameInstances: ResourceId; readonly vertexPayload: ResourceId; readonly camera: ResourceId;
    readonly productMetadata?: ResourceId; readonly productBanks?: readonly ResourceId[]; readonly frame: Readonly<{
    publication: GpuAppearancePublication; index: number; sampleCounters: boolean;
    arena: PreparedFrameGeometryArena; filtered: boolean; source: GpuSparseShadingAssetHeapBindings;
  }>; readonly width: number; readonly height: number; readonly textureBanks: readonly ResourceId[][] }): AppearanceCacheProducts {
    let fields = -1;
    const pass = graph.add("Appearance cache state and live inputs", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const { publication, index } = data.frame;
      const visibility = resolveTextureView(resources.get(data.visibility));
      const { arena } = data.frame;
      const directory = data.frame.filtered ? arena.filteredDirectory : arena.sourceDirectory;
      let winner = this.winners.get(arena);
      if (winner && (winner.visibility !== visibility || winner.width !== data.width || winner.height !== data.height)) {
        this.winnerOwner.rebind(command, winner.allocation, visibility, data.width, data.height);
        winner.visibility = visibility; winner.width = data.width; winner.height = data.height;
      }
      if (!winner) {
        const allocation = this.winnerOwner.prepare({ visibility, width: data.width, height: data.height,
          geometry: { directory, clips: arena.clips, triangles: arena.triangles },
          storage: { dictionary: arena.dictionary, coefficients: arena.coefficients, work: arena.work, control: arena.control },
          budget: { dictionaryCapacity: arena.budget.dictionaryCapacity, coefficientCapacity: arena.budget.coefficientCapacity,
            probeLimit: arena.budget.probeLimit, maxBytes: arena.budget.maxBytes } });
        winner = { allocation, visibility, directory: directory.offset, width: data.width, height: data.height,
          unsubscribe: this.arenaOwner.onReleased(arena, () => {
            const entry = this.winners.get(arena);
            if (entry?.allocation === allocation) { this.winners.delete(arena); this.winnerOwner.release(allocation); }
          }) };
        this.winners.set(arena, winner);
      }
      this.winnerOwner.encode(command.gpu_encoder, winner.allocation);
      publication.encodeDemand(command, {
        visibility,
        meshletWork: resources.get(data.meshletWork) as GPUBuffer,
        geometry: resources.get(data.geometry) as GPUBuffer, attributes: resources.get(data.attributes) as GPUBuffer,
        frameInstances: resources.get(data.frameInstances) as GPUBuffer,
        camera: resources.get(data.camera) as GPUBuffer,
        vertexPayload: resources.get(data.vertexPayload) as GPUBuffer, source: data.frame.source,
        productMetadata: data.productMetadata === undefined ? undefined : resources.get(data.productMetadata) as GPUBuffer,
        productBanks: data.productBanks?.map(id => resources.get(id) as GPUBuffer),
        frameHeaderWord: arena.layout.header.offset / 4, frameDirectoryWord: directory.offset / 4,
        textureBanks: data.textureBanks.map(set => set.map(id => resolveTextureView(resources.get(id), { dimension: "2d-array" }))),
        width: data.width, height: data.height, fields: resolveTextureView(resources.get(fields), { dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: APPEARANCE_SURFACE_LAYER_COUNT }), frame: index
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
    const geometry = pass.write(input.geometry);
    pass.read(input.attributes);
    pass.read(input.frameInstances); pass.read(input.vertexPayload); pass.read(input.camera);
    if (input.productMetadata !== undefined) pass.read(input.productMetadata);
    for (const bank of input.productBanks ?? []) pass.read(bank);
    pass.write(input.counters);
    for (const set of input.textureBanks) for (const bank of set) pass.read(bank);
    fields = pass.create("Appearance surface fields", {
      kind: "transient_texture", label: "Appearance surface field array", width: input.width, height: input.height,
      depthOrArrayLayers: APPEARANCE_SURFACE_LAYER_COUNT, dimension: "2d", format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full"
    });
    pass.write(fields);
    pass.make_side_effect();
    return { fields, geometry };
  }
  destroy(): void {
    for (const entry of this.winners.values()) entry.unsubscribe();
    this.winners.clear(); this.winnerOwner.destroy();
  }
}
