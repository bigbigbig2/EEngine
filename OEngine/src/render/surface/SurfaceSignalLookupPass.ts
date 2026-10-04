import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuSurfaceSignalStore } from "../../gpu/GpuSurfaceSignalStore.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { surfaceCellWorkspaceWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { SURFACE_SIGNAL_LOOKUP_WGSL } from "../../shaders/surface_signal_lookup.js";
import type { SurfaceResourceBinding } from "./SurfaceFrameResources.js";

export interface SurfaceSignalLookupInput {
  readonly workspace: ResourceId;
  readonly activeIndirect: ResourceId;
  readonly metadata: ResourceId;
  readonly versions: ResourceId;
  readonly publication: GpuAppearancePublication;
  readonly batchTiles: number;
  readonly tileCount: number;
  readonly viewRevision: Readonly<{ value: number }>;
  readonly revisions: Readonly<{ environment: number; light: number; shadow: number; sun: number }>;
  readonly sun: ResourceId | null;
  readonly shadowVersion: ResourceId | null;
  readonly shadowEnabled: boolean;
  readonly diagnostics: boolean;
  readonly bind: SurfaceResourceBinding;
}

export class SurfaceSignalLookupPass {
  private readonly settings: GPUBuffer;
  private readonly disabledStore: GPUBuffer;
  private readonly disabledSun: GPUBuffer;
  private readonly disabledShadow: GPUBuffer;
  private readonly pipelines = new Map<number, GPUComputePipeline>();

  constructor(private readonly device: GPUDevice, private readonly store: GpuSurfaceSignalStore | null) {
    this.settings = device.createBuffer({
      label: "Surface/signal lookup settings", size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.disabledStore = device.createBuffer({ label: "Surface/disabled SignalStore", size: 16, usage: GPUBufferUsage.STORAGE });
    this.disabledSun = device.createBuffer({ label: "Surface/disabled solar witness", size: 48, usage: GPUBufferUsage.UNIFORM });
    this.disabledShadow = device.createBuffer({ label: "Surface/disabled shadow witness", size: 16, usage: GPUBufferUsage.STORAGE });
  }

  addToGraph(graph: FrameGraph, input: SurfaceSignalLookupInput): Readonly<{ workspace: ResourceId; store: ResourceId }> {
    if(input.shadowEnabled && input.shadowVersion===null) { throw new Error("Signal lookup requires the actual VSM content publication"); }
    let pipeline = this.pipelines.get(input.batchTiles);
    if (pipeline === undefined) {
      const module = this.device.createShaderModule({
        label: "Surface/exact selected-source signal lookup",
        code: `${surfaceCellWorkspaceWgsl(input.batchTiles)}\n${SURFACE_SIGNAL_LOOKUP_WGSL}`
      });
      pipeline = this.device.createComputePipeline({
        label: "Surface/exact selected-source signal lookup", layout: "auto",
        compute: { module, entryPoint: "lookup_surface_signals" }
      });
      this.pipelines.set(input.batchTiles, pipeline);
    }
    let store = graph.import_resource("Surface/SignalStore", { kind: "imported", domain: "internal-full" },
      input.bind("surface-signal-store", () => this.store?.buffers[0] ?? this.disabledStore));
    const sun = input.sun ?? graph.import_resource("Surface/disabled solar witness", { kind: "imported", domain: "internal-full" },
      input.bind("surface-disabled-solar-witness", () => this.disabledSun));
    const shadowVersion=input.shadowVersion ?? graph.import_resource("Surface/disabled shadow witness",{kind:"imported",domain:"internal-full"},
      input.bind("surface-disabled-shadow-witness",()=>this.disabledShadow));
    const node = graph.add("Surface/kind-specific signal value lookup", { ...input, store, sun, shadowVersion, sunEnabled: input.sun !== null }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(this.settings, 0, new Uint32Array([
        data.publication.surfaceMetadataOffsets.fieldIdentities, data.publication.surfaceMetadataOffsets.constantFields,
        data.tileCount * 64, this.store?.capacity.entries ?? 4,
        this.store?.nextSubmissionEpoch ?? 1, data.viewRevision.value,
        data.revisions.environment, data.revisions.light,
        data.revisions.shadow, data.revisions.sun, data.shadowEnabled ? 1 : 0, data.sunEnabled ? 1 : 0,
        this.store === null ? 0 : 1, data.diagnostics ? 1 : 0, 0, 0
      ]).buffer, 0, 64);
      const group = this.device.createBindGroup({
        layout: pipeline!.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.settings } },
          { binding: 1, resource: { buffer: resources.get(data.workspace) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(data.metadata) as GPUBuffer } },
          { binding: 3, resource: { buffer: resources.get(data.versions) as GPUBuffer } },
          { binding: 4, resource: { buffer: resources.get(data.store) as GPUBuffer } },
          { binding: 5, resource: { buffer: resources.get(data.sun) as GPUBuffer } },
          { binding: 6, resource: { buffer: resources.get(data.shadowVersion) as GPUBuffer } }
        ]
      });
      const pass = command.beginComputePass({ label: "Surface/kind-specific signal value lookup" });
      pass.setPipeline(pipeline!);pass.setBindGroup(0, group);pass.dispatchWorkgroupsIndirect(resources.get(data.activeIndirect) as GPUBuffer,0);pass.end();
    });
    node.read(input.workspace);node.read(input.metadata);node.read(input.versions);node.read(sun);node.read(store);
    node.read(input.activeIndirect);
    node.read(shadowVersion);
    store = node.write(store);
    const workspace = node.write(input.workspace);
    return { workspace, store };
  }

  destroy(): void {
    this.settings.destroy();this.disabledStore.destroy();this.disabledSun.destroy();this.disabledShadow.destroy();this.pipelines.clear();
  }
}
