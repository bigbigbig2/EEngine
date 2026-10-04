import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuSurfaceFieldStore } from "../../gpu/GpuSurfaceFieldStore.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { surfaceCellWorkspaceWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { SURFACE_FIELD_LOOKUP_WGSL } from "../../shaders/surface_field_lookup.js";
import type { SurfaceResourceBinding } from "./SurfaceFrameResources.js";

export interface SurfaceFieldLookupInput {
  readonly workspace: ResourceId;
  readonly metadata: ResourceId;
  readonly versions: ResourceId;
  readonly publication: GpuAppearancePublication;
  readonly batchTiles: number;
  readonly tileCount: number;
  readonly viewRevision: Readonly<{ value: number }>;
  readonly diagnostics: boolean;
  readonly bind: SurfaceResourceBinding;
}

/** Lookup owns no second material cache or record hit mask. Store and metadata
 * are imported as real graph products; the returned workspace carries the
 * independently published FieldRefs and unresolved value/certificate masks. */
export class SurfaceFieldLookupPass {
  private readonly settings: GPUBuffer;
  private readonly disabledStore: GPUBuffer;
  private readonly pipelines = new Map<number, GPUComputePipeline>();

  constructor(private readonly device: GPUDevice, private readonly store: GpuSurfaceFieldStore | null) {
    this.settings = device.createBuffer({
      label: "Surface/field lookup settings", size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.disabledStore = device.createBuffer({
      label: "Surface/disabled FieldStore", size: 16, usage: GPUBufferUsage.STORAGE
    });
  }

  addToGraph(graph: FrameGraph, input: SurfaceFieldLookupInput): Readonly<{ workspace: ResourceId; store: ResourceId }> {
    let pipeline = this.pipelines.get(input.batchTiles);
    if (pipeline === undefined) {
      const module = this.device.createShaderModule({
        label: "Surface/published field lookup",
        code: `${surfaceCellWorkspaceWgsl(input.batchTiles)}\n${SURFACE_FIELD_LOOKUP_WGSL}`
      });
      pipeline = this.device.createComputePipeline({
        label: "Surface/published field lookup", layout: "auto",
        compute: { module, entryPoint: "lookup_surface_fields" }
      });
      this.pipelines.set(input.batchTiles, pipeline);
    }
    const buffer = this.store?.buffer ?? this.disabledStore;
    let store = graph.import_resource("Surface/FieldStore", { kind: "imported", domain: "internal-full" },
      input.bind("surface-field-store", () => buffer));
    const node = graph.add("Surface/field value and certificate lookup", { ...input, store }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(this.settings, 0, new Uint32Array([
        data.publication.surfaceMetadataOffsets.fieldIdentities,
        data.publication.surfaceMetadataOffsets.constantFields,
        data.tileCount * 64, this.store?.capacity.entries ?? 4,
        (this.store?.stats().submittedEpoch ?? 0) + 1, data.viewRevision.value,
        this.store === null ? 0 : 1, data.diagnostics ? 1 : 0
      ]).buffer, 0, 32);
      const group = this.device.createBindGroup({
        layout: pipeline!.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.settings } },
          { binding: 1, resource: { buffer: resources.get(data.workspace) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(data.metadata) as GPUBuffer } },
          { binding: 3, resource: { buffer: resources.get(data.versions) as GPUBuffer } },
          { binding: 4, resource: { buffer: resources.get(data.store) as GPUBuffer } }
        ]
      });
      const pass = command.beginComputePass({ label: "Surface/field value and certificate lookup" });
      pass.setPipeline(pipeline!);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(data.tileCount);
      pass.end();
    });
    node.read(input.workspace);
    node.read(input.metadata);
    node.read(input.versions);
    node.read(store);
    store = node.write(store);
    const workspace = node.write(input.workspace);
    return { workspace, store };
  }

  destroy(): void {
    this.settings.destroy();
    this.disabledStore.destroy();
    this.pipelines.clear();
  }
}
