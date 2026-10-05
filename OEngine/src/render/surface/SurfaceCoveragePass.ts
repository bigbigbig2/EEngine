import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { surfaceCoverageLayout } from "../../gpu/GpuSurfaceCoverageAbi.js";
import { SURFACE_COVERAGE_SCAN_WGSL, SURFACE_ACTIVE_RANGE_WGSL } from "../../shaders/surface_coverage.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";

export class SurfaceCoveragePass {
  private readonly scan: GPUComputePipeline;
  private readonly range: GPUComputePipeline;
  constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources) {
    this.scan = device.createComputePipeline({ label: "Surface/coverage scan", layout: "auto",
      compute: { module: device.createShaderModule({ code: SURFACE_COVERAGE_SCAN_WGSL }), entryPoint: "scan_surface_coverage" } });
    this.range = device.createComputePipeline({ label: "Surface/active range publication", layout: "auto",
      compute: { module: device.createShaderModule({ code: SURFACE_ACTIVE_RANGE_WGSL }), entryPoint: "publish_surface_active_range" } });
  }
  addToGraph(graph: FrameGraph, input: { visibility: ResourceId; meshletWork: ResourceId; metadata: ResourceId;
    publication: GpuAppearancePublication; width: number; height: number; generation: number; bind: SurfaceResourceBinding }): ResourceId {
    const tilesX = Math.ceil(input.width / 8);
    const tiles = tilesX * Math.ceil(input.height / 8);
    const layout = surfaceCoverageLayout(tiles);
    let coverage = this.scratch.importBuffer(graph, input.bind, "Surface/frame coverage and active tiles", layout.bytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const settingsId = this.scratch.importBuffer(graph, input.bind, "Surface/coverage settings", 32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const node = graph.add("Surface/single coverage and ActiveTileList", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const buffer = resources.get(coverage) as GPUBuffer;
      command.gpu_encoder.clearBuffer(buffer, 0, 16);
      const settings = resources.get(settingsId) as GPUBuffer;
      const offsets = data.publication.surfaceMetadataOffsets;
      command.writeBuffer(settings, 0, new Uint32Array([data.width, data.height, tilesX, tiles,
        offsets.materialLookup, offsets.materialLookupCount, offsets.executionProfiles, data.generation]).buffer, 0, 32);
      const group = this.scratch.obtainBindGroup(this.scan, 0, [
        { binding: 0, resource: { buffer: settings } }, { binding: 1, resource: this.scratch.resolveTextureView(resources.get(data.visibility)) },
        { binding: 2, resource: { buffer: resources.get(data.meshletWork) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(data.metadata) as GPUBuffer } }, { binding: 4, resource: { buffer } }
      ]);
      const pass = command.beginComputePass({ label: "Surface/single coverage scan" });
      pass.setPipeline(this.scan); pass.setBindGroup(0, group); pass.dispatchWorkgroups(tiles); pass.end();
    });
    node.read(input.visibility); node.read(input.meshletWork); node.read(input.metadata);
    node.write(settingsId);
    coverage = node.write(coverage);
    return coverage;
  }
  addRangeToGraph(graph: FrameGraph, input: { coverage: ResourceId; workspace: ResourceId; first: number;
    capacity: number; tiles: number; tilesX: number; after: readonly ResourceId[]; bind: SurfaceResourceBinding }):
    Readonly<{ workspace: ResourceId; indirect: ResourceId }> {
    let argumentsBuffer = this.scratch.importBuffer(graph, input.bind, "Surface/active range arguments", 16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    let indirect = this.scratch.importBuffer(graph, input.bind, "Surface/active range indirect", 16,
      GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const settingsId = this.scratch.importBuffer(graph, input.bind, "Surface/active range settings", 16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const node = graph.add("Surface/publish actual active range", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const settings = resources.get(settingsId) as GPUBuffer;
      command.writeBuffer(settings, 0, new Uint32Array([data.first, data.capacity, data.tiles, data.tilesX]).buffer, 0, 16);
      const group = this.scratch.obtainBindGroup(this.range, 0, [
        { binding: 0, resource: { buffer: settings } }, { binding: 1, resource: { buffer: resources.get(data.coverage) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(data.workspace) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(argumentsBuffer) as GPUBuffer } }
      ]);
      const pass = command.beginComputePass({ label: "Surface/publish actual active range" });
      pass.setPipeline(this.range); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(data.capacity / 64)); pass.end();
    });
    node.read(input.coverage); node.read(input.workspace);
    node.write(settingsId);
    for (const resource of input.after) { node.read(resource); }
    const workspace = node.write(input.workspace);
    argumentsBuffer = node.write(argumentsBuffer);
    const copy = graph.add("Surface/active indirect publication", {}, (_data, resources, context) => {
      (context.encoder as ShadeGPUCommandContext).gpu_encoder.copyBufferToBuffer(
        resources.get(argumentsBuffer) as GPUBuffer, 0, resources.get(indirect) as GPUBuffer, 0, 16);
    });
    copy.read(argumentsBuffer); indirect = copy.write(indirect);
    return { workspace, indirect };
  }
}
