import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { surfaceCellGeometrySetupWgsl } from "../../shaders/surface_cell_geometry_setup.js";
import { SURFACE_CELL_GEOMETRY_SETUP_BYTES, SURFACE_CELL_GEOMETRY_DICTIONARY_BYTES,
  SURFACE_CELL_GEOMETRY_SETTINGS_BYTES, planSurfaceCellGeometryCapacity } from "../../gpu/GpuSurfaceCellGeometryAbi.js";

export interface SurfaceCellGeometrySetupInput {
  readonly visibility: ResourceId;
  readonly meshletWork: ResourceId;
  readonly sourceHeap: ResourceId;
  readonly vertexPayload: ResourceId;
  readonly frameInstances: ResourceId;
  readonly product: Readonly<{ heap: ResourceId; banks: readonly ResourceId[] }> | null;
  readonly width: number;
  readonly height: number;
  readonly tilesX: number;
  readonly firstTile: number;
  readonly tileCount: number;
  readonly targetCapacity: number;
  readonly addressBudgetBytes?: number;
  readonly generation: number;
  readonly sourceGeometry: number;
  readonly sourceMeshlet: number;
  readonly sourceMeshletVertices: number;
  readonly sourceMeshletTriangles: number;
  readonly sourceVertexData: number;
  readonly after?: readonly ResourceId[];
}
export interface SurfaceCellGeometrySetupProducts {
  readonly arena: ResourceId;
  readonly counts: ResourceId;
  readonly indirect: ResourceId;
  readonly dictionaryCapacity: number;
  readonly setupCapacity: number;
}
type Stage = "reset_cell_geometry" | "request_cell_geometry" | "finalize_cell_geometry" | "build_cell_geometry";
const stages: readonly Stage[] = ["reset_cell_geometry", "request_cell_geometry", "finalize_cell_geometry", "build_cell_geometry"];

/** Private substage of SurfaceGeometryPass. FrameGraph owns bounded transient
 * buffers; the Surface Geometry owner owns pipelines. No resident pixel record,
 * private encoder/submit, readback or separate geometry owner is introduced. */
export class SurfaceCellGeometrySetup {
  private readonly pipelines = new Map<string, Readonly<Record<Stage, GPUComputePipeline>>>();
  constructor(private readonly device: GPUDevice) {}
  addToGraph(graph: FrameGraph, input: SurfaceCellGeometrySetupInput): SurfaceCellGeometrySetupProducts {
    const hasProduct = input.product !== null;
    if (hasProduct && input.product!.banks.length !== 4) throw new RangeError("Cell Geometry requires four published Product banks");
    // Both ordinary and Product source inputs are finite resource profiles.
    if (this.device.limits.maxStorageBuffersPerShaderStage < (hasProduct ? 11 : 6)) {
      throw new RangeError("Cell Geometry source profile exceeds negotiated storage binding limit");
    }
    const capacity=planSurfaceCellGeometryCapacity(input.targetCapacity,input.addressBudgetBytes??input.targetCapacity*128,this.device.limits);
    const {setupCapacity,dictionaryCapacity}=capacity;
    const profile=`${hasProduct}:${dictionaryCapacity}`;
    let pipelines = this.pipelines.get(profile);
    if (!pipelines) {
      const module = this.device.createShaderModule({label:"SurfaceGeometry/cell setup",code:surfaceCellGeometrySetupWgsl(hasProduct,dictionaryCapacity)});
      pipelines = Object.freeze(Object.fromEntries(stages.map(entryPoint => [entryPoint,
        this.device.createComputePipeline({label:`SurfaceGeometry/${entryPoint}`,layout:"auto",compute:{module,entryPoint}})])) as Record<Stage,GPUComputePipeline>);
      this.pipelines.set(profile,pipelines);
    }
    let arena!: ResourceId,counts!: ResourceId,indirect!: ResourceId,settings!: ResourceId;
    for (const stage of stages) {
      const pipeline=pipelines[stage];
      const pass=graph.add(`SurfaceGeometry/${stage} batch ${input.firstTile}`, input, (data,resources,context)=>{
        const command=context.encoder as ShadeGPUCommandContext;
        if(stage==="reset_cell_geometry") {
          const values=new Uint32Array([data.width,data.height,data.tilesX,data.firstTile,data.tileCount,dictionaryCapacity,setupCapacity,data.generation,
            0,0,0,0,data.sourceGeometry,data.sourceMeshlet,data.sourceMeshletVertices,data.sourceMeshletTriangles,data.sourceVertexData,0,0,0]);
          command.writeBuffer(resources.get(settings) as GPUBuffer,0,values.buffer,0,values.byteLength);
        }
        const group0:GPUBindGroupEntry[]=[{binding:0,resource:{buffer:resources.get(settings) as GPUBuffer}}];
        if(stage==="build_cell_geometry") {
          for(const [binding,id] of [[1,data.meshletWork],[2,data.sourceHeap],[3,data.vertexPayload],[4,data.frameInstances]] as const)
            group0.push({binding,resource:{buffer:resources.get(id) as GPUBuffer}});
          if(data.product){group0.push({binding:5,resource:{buffer:resources.get(data.product.heap) as GPUBuffer}});
            data.product.banks.forEach((id,i)=>group0.push({binding:i+6,resource:{buffer:resources.get(id) as GPUBuffer}}));}
        }
        const group1:GPUBindGroupEntry[]=[{binding:2,resource:{buffer:resources.get(counts) as GPUBuffer}}];
        if(stage!=="finalize_cell_geometry")group1.push({binding:0,resource:{buffer:resources.get(arena) as GPUBuffer}});
        if(stage==="request_cell_geometry")group1.push({binding:3,resource:resolveTextureView(resources.get(data.visibility))});
        if(stage==="finalize_cell_geometry")group1.push({binding:4,resource:{buffer:resources.get(indirect) as GPUBuffer}});
        const compute=command.beginComputePass({label:`SurfaceGeometry/${stage}`});compute.setPipeline(pipeline);
        compute.setBindGroup(0,this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:group0}));
        compute.setBindGroup(1,this.device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:group1}));
        if(stage==="build_cell_geometry")compute.dispatchWorkgroupsIndirect(resources.get(indirect) as GPUBuffer,0);
        else compute.dispatchWorkgroups(stage==="reset_cell_geometry"?Math.ceil(dictionaryCapacity/64):stage==="request_cell_geometry"?data.tileCount:1);
        compute.end();
      });
      if(stage==="reset_cell_geometry") {
        for (const resource of input.after ?? []) { pass.read(resource); }
        const storage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC;
        arena=pass.create("Surface cell primitive setup and directory",{kind:"transient_buffer",size:dictionaryCapacity*SURFACE_CELL_GEOMETRY_DICTIONARY_BYTES+setupCapacity*SURFACE_CELL_GEOMETRY_SETUP_BYTES,usage:storage});
        counts=pass.create("Surface cell geometry counters",{kind:"transient_buffer",size:32,usage:storage});
        settings=pass.create("Surface cell geometry settings",{kind:"transient_buffer",size:SURFACE_CELL_GEOMETRY_SETTINGS_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
        indirect=pass.create("Surface cell geometry indirect",{kind:"transient_buffer",size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_SRC});
      } else {pass.read(settings);pass.read(arena);pass.read(counts);counts=pass.write(counts);
        if(stage==="request_cell_geometry"){pass.read(input.visibility);arena=pass.write(arena);}
        if(stage==="finalize_cell_geometry")indirect=pass.write(indirect);
        if(stage==="build_cell_geometry"){pass.read(indirect);arena=pass.write(arena);
          for(const id of [input.meshletWork,input.sourceHeap,input.vertexPayload,input.frameInstances])pass.read(id);
          if(input.product){pass.read(input.product.heap);for(const bank of input.product.banks)pass.read(bank);}}
      }
    }
    return {arena,counts,indirect,dictionaryCapacity,setupCapacity};
  }
  destroy(): void {this.pipelines.clear();}
}
