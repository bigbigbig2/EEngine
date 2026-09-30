import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { SurfaceMaterialInputs } from "./SurfaceMaterialPass.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { GPU_SURFACE_PROBE_WORKGROUP_STORAGE_BYTES } from "../../gpu/GpuSparseShadingCapability.js";
import { surfaceProbeWgsl } from "../../shaders/surface_probe.js";
import { EXACT_SURFACE_PROBE_BUDGET, packSurfaceProbeBudget, SURFACE_PROBE_COUNTER_BYTES, SURFACE_PROBE_LIGHTING_WORKGROUP_STORAGE_BYTES,
  type SurfaceProbeBudget } from "./SurfaceProbe.js";

export class SurfaceProbePass {
  private readonly programs = new Map<string, {
    readonly pipeline: GPUComputePipeline;
    readonly layouts: readonly GPUBindGroupLayout[];
  }>();
  private readonly budget: SurfaceProbeBudget;
  constructor(private readonly device: GPUDevice, budget: SurfaceProbeBudget = EXACT_SURFACE_PROBE_BUDGET) {
    packSurfaceProbeBudget(budget);
    this.budget = Object.freeze({ ...budget });
  }
  addToGraph(graph: FrameGraph, input: SurfaceMaterialInputs, view: ResourceId): {
    readonly candidates: ResourceId; readonly counters: ResourceId;
  } {
    if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) ||
        input.width <= 0 || input.height <= 0) throw new RangeError("SurfaceProbe requires positive integer dimensions");
    const width = Math.ceil(input.width / 2), height = Math.ceil(input.height / 2);
    const bankCount = input.virtualBanks?.length ?? 1;
    const storageCount = 8 + (input.virtualGeometry ? 1 + bankCount : 0);
    if (this.device.limits.maxComputeWorkgroupStorageSize < (input.hasLit ? SURFACE_PROBE_LIGHTING_WORKGROUP_STORAGE_BYTES : GPU_SURFACE_PROBE_WORKGROUP_STORAGE_BYTES) ||
        this.device.limits.maxComputeInvocationsPerWorkgroup < 64 ||
        this.device.limits.maxComputeWorkgroupSizeX < 8 || this.device.limits.maxComputeWorkgroupSizeY < 8 ||
        storageCount > this.device.limits.maxStorageBuffersPerShaderStage ||
        width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D ||
        Math.ceil(input.width / 8) > this.device.limits.maxComputeWorkgroupsPerDimension ||
        Math.ceil(input.height / 8) > this.device.limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError("SurfaceProbe exceeds negotiated storage/dispatch limits");
    }
    const key = `${input.virtualGeometry}:${bankCount}:${input.hasLit}`;
    let program = this.programs.get(key);
    if (!program) {
      const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
        ...[2, 3, 4, 6, 7, 8, 9].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as const } })),
        ...[5, 10].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" as const } })),
        { binding: 11, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32uint" } },
        { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ];
      const layouts = [this.device.createBindGroupLayout({ entries })];
      if (input.virtualGeometry) layouts.push(this.device.createBindGroupLayout({ entries:
        Array.from({ length: bankCount + 1 }, (_, binding) => ({ binding,
          visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" as const } })) }));
      const pipeline = this.device.createComputePipeline({ label: "Surface/probe candidates",
        layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
        compute: { module: this.device.createShaderModule({ label: "Surface/bounded four-corner probe",
          code: surfaceProbeWgsl(input.virtualGeometry, bankCount, input.hasLit) }), entryPoint: "probe" } });
      program = { pipeline, layouts }; this.programs.set(key, program);
    }
    const selected = program;
    const node = graph.add("Surface/PBR candidate facts", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const budget = command.allocateTransientBufferAndLoad(packSurfaceProbeBudget(this.budget).buffer, GPUBufferUsage.UNIFORM);
      command.clearBuffer(resources.get(counters) as GPUBuffer);
      const buffers = [input.meshletWork, input.materialRecords, input.instances, view,
        input.geometryMetadata, input.vertexPayload, input.textureRoutes, input.textureResidencyVersions];
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: resolveTextureView(resources.get(input.visibilityKey)) },
        { binding: 1, resource: resolveTextureView(resources.get(input.depth)) },
        ...buffers.map((id, index) => ({ binding: index + 2, resource: { buffer: resources.get(id) as GPUBuffer } })),
        { binding: 10, resource: { buffer: budget } },
        { binding: 11, resource: resolveTextureView(resources.get(candidates)) },
        { binding: 12, resource: { buffer: resources.get(counters) as GPUBuffer } }
      ];
      const group = this.device.createBindGroup({ layout: selected.layouts[0]!, entries });
      const pass = command.beginComputePass({ label: "Surface/PBR candidate facts" });
      pass.setPipeline(selected.pipeline); pass.setBindGroup(0, group);
      if (input.virtualGeometry) {
        const ids = [input.virtualMetadata!, ...input.virtualBanks!];
        pass.setBindGroup(1, this.device.createBindGroup({ layout: selected.layouts[1]!, entries:
          ids.map((id, binding) => ({ binding, resource: { buffer: resources.get(id) as GPUBuffer } })) }));
      }
      pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8)); pass.end();
    });
    for (const id of [input.visibilityKey, input.depth, input.meshletWork, input.materialRecords,
      input.instances, view, input.geometryMetadata, input.vertexPayload, input.textureRoutes,
      input.textureResidencyVersions, ...(input.virtualGeometry ? [input.virtualMetadata!, ...input.virtualBanks!] : [])]) node.read(id);
    const candidates = node.create("Surface/PBR candidate rates", {
      kind: "transient_texture", width, height, format: "r32uint",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const counters = node.create("Surface/probe counters", { kind: "transient_buffer",
      size: SURFACE_PROBE_COUNTER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    return { candidates, counters };
  }
}
