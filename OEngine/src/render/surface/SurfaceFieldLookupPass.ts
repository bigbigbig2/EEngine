import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuSurfaceFieldStore } from "../../gpu/GpuSurfaceFieldStore.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { surfaceCellWorkspaceWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceFieldLookupWgsl } from "../../shaders/surface_field_lookup.js";
import type { SurfaceResourceBinding } from "./SurfaceFrameResources.js";

export interface SurfaceFieldLookupInput {
  readonly workspace: ResourceId;
  readonly geometry: ResourceId;
  readonly referenceCapacity: number;
  readonly width: number;
  readonly height: number;
  readonly activeIndirect: ResourceId;
  readonly metadata: ResourceId;
  readonly versions: ResourceId;
  readonly publication: GpuAppearancePublication;
  readonly batchTiles: number;
  readonly tileCount: number;
  readonly viewRevision: Readonly<{ value: number }>;
  readonly diagnostics: boolean;
  readonly bind: SurfaceResourceBinding;
}

const fieldLookupStages = ["lookup_surface_fields", "finalize_field_support", "validate_field_support", "commit_field_support"] as const;
type FieldLookupStage = typeof fieldLookupStages[number];

/** Lookup owns no second material cache or record hit mask. Store and metadata
 * are imported as real graph products; the returned workspace carries the
 * independently published FieldRefs and unresolved value/certificate masks. */
export class SurfaceFieldLookupPass {
  private readonly settings: GPUBuffer;
  private readonly disabledStore: GPUBuffer;
  private readonly pipelines = new Map<number, Readonly<Record<FieldLookupStage, GPUComputePipeline>>>();
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelineLayout: GPUPipelineLayout;

  constructor(private readonly device: GPUDevice, private readonly store: GpuSurfaceFieldStore | null) {
    this.layout = device.createBindGroupLayout({ label: "Surface/Field candidate and proof layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
    ] });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.settings = device.createBuffer({
      label: "Surface/field lookup settings", size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.disabledStore = device.createBuffer({
      label: "Surface/disabled FieldStore", size: 16, usage: GPUBufferUsage.STORAGE
    });
  }

  addToGraph(graph: FrameGraph, input: SurfaceFieldLookupInput): Readonly<{ workspace: ResourceId; store: ResourceId }> {
    let pipelines = this.pipelines.get(input.batchTiles);
    if (pipelines === undefined) {
      const module = this.device.createShaderModule({ label: "Surface/Field candidates and admitted support",
        code: `${surfaceCellWorkspaceWgsl(input.batchTiles)}\n${surfaceFieldLookupWgsl(input.referenceCapacity)}` });
      const result = {} as Record<FieldLookupStage, GPUComputePipeline>;
      for (const entryPoint of fieldLookupStages) {
        result[entryPoint] = this.device.createComputePipeline({ label: `Surface/${entryPoint}`,
          layout: this.pipelineLayout, compute: { module, entryPoint } });
      }
      pipelines = Object.freeze(result);
      this.pipelines.set(input.batchTiles, pipelines);
    }
    const buffer = this.store?.buffer ?? this.disabledStore;
    let store = graph.import_resource("Surface/FieldStore", { kind: "imported", domain: "internal-full" },
      input.bind("surface-field-store", () => buffer));
    let workspace = input.workspace;
    let args!: ResourceId;
    let indirect!: ResourceId;
    for (const stage of fieldLookupStages) {
      const node = graph.add(`Surface/${stage}`, { ...input, store }, (data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        if (stage === "lookup_surface_fields") {
          command.writeBuffer(this.settings, 0, new Uint32Array([
            data.publication.surfaceMetadataOffsets.fieldIdentities,
            data.publication.surfaceMetadataOffsets.constantFields,
            data.tileCount * 64, this.store?.capacity.entries ?? 4,
            (this.store?.stats().submittedEpoch ?? 0) + 1, data.viewRevision.value,
            this.store === null ? 0 : 1, data.diagnostics ? 1 : 0, data.width, data.height, 0, 0
          ]).buffer, 0, 48);
        }
        const group = this.device.createBindGroup({ layout: this.layout, entries: [
          { binding: 0, resource: { buffer: this.settings } },
          { binding: 1, resource: { buffer: resources.get(workspace) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(data.metadata) as GPUBuffer } },
          { binding: 3, resource: { buffer: resources.get(data.versions) as GPUBuffer } },
          { binding: 4, resource: { buffer: resources.get(data.store) as GPUBuffer } },
          { binding: 5, resource: { buffer: resources.get(args) as GPUBuffer } },
          { binding: 6, resource: { buffer: resources.get(data.geometry) as GPUBuffer } }
        ] });
        const pass = command.beginComputePass({ label: `Surface/${stage}` });
        pass.setPipeline(pipelines![stage]);
        pass.setBindGroup(0, group);
        if (stage === "finalize_field_support") { pass.dispatchWorkgroups(1); }
        else { pass.dispatchWorkgroupsIndirect(resources.get(stage === "validate_field_support" ? indirect : data.activeIndirect) as GPUBuffer, 0); }
        pass.end();
      });
      if (stage === "lookup_surface_fields") {
        args = node.create("Surface/Field support argument writer", { kind: "transient_buffer", size: 16,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        indirect = node.create("Surface/Field support indirect", { kind: "transient_buffer", size: 16,
          usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
      } else {
        node.read(args);
        if (stage === "finalize_field_support") { args = node.write(args); }
      }
      node.read(workspace);
      workspace = node.write(workspace);
      node.read(input.activeIndirect);
      node.read(input.metadata);
      node.read(input.geometry);
      node.read(input.versions);
      node.read(store);
      if (stage === "lookup_surface_fields") { store = node.write(store); }
      if (stage === "validate_field_support") { node.read(indirect); }
      if (stage === "finalize_field_support") {
        const copy = graph.add("Surface/Field support publish indirect", {}, (_data, resources, context) => {
          const command = context.encoder as ShadeGPUCommandContext;
          command.gpu_encoder.copyBufferToBuffer(resources.get(args) as GPUBuffer, 0, resources.get(indirect) as GPUBuffer, 0, 16);
        });
        copy.read(args);
        copy.read(workspace);
        indirect = copy.write(indirect);
      }
    }
    return { workspace, store };
  }

  destroy(): void {
    this.settings.destroy();
    this.disabledStore.destroy();
    this.pipelines.clear();
  }
}
