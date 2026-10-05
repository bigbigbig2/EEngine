import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { surfaceCellGeometrySetupWgsl } from "../../shaders/surface_cell_geometry_setup.js";
import { SURFACE_CELL_GEOMETRY_SETUP_BYTES, SURFACE_CELL_GEOMETRY_REFERENCE_BYTES,
  SURFACE_CELL_GEOMETRY_SETTINGS_BYTES, planSurfaceCellGeometryCapacity } from "../../gpu/GpuSurfaceCellGeometryAbi.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";

export interface SurfaceCellGeometrySetupInput {
  readonly resourceBinding?: SurfaceResourceBinding;
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
  readonly workspace: ResourceId;
  readonly activeIndirect: ResourceId;
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
  /** Separate bounded memo storage; mandatory local setup never borrows it. */
  readonly memo: ResourceId;
  readonly memoCapacity: number;
  readonly referenceCapacity: number;
  readonly setupCapacity: number;
}
type Stage = "reset_cell_geometry" | "request_cell_geometry" | "finalize_cell_geometry" | "build_cell_geometry" | "publish_cell_geometry_memo" | "commit_cell_geometry_memo";
const stages: readonly Stage[] = ["reset_cell_geometry", "request_cell_geometry", "finalize_cell_geometry", "build_cell_geometry", "publish_cell_geometry_memo", "commit_cell_geometry_memo"];

/** Private substage of SurfaceGeometryPass. FrameGraph owns bounded transient
 * buffers; the Surface Geometry owner owns pipelines. No resident pixel record,
 * private encoder/submit, readback or separate geometry owner is introduced. */
export class SurfaceCellGeometrySetup {
  private readonly memoByGraph = new WeakMap<FrameGraph, { resource: ResourceId; bytes: number }>();
  private readonly pipelines = new Map<string, Readonly<Record<Stage, GPUComputePipeline>>>();
  constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources | null = null) {}
  addToGraph(graph: FrameGraph, input: SurfaceCellGeometrySetupInput): SurfaceCellGeometrySetupProducts {
    if (!Number.isSafeInteger(input.tileCount) || input.tileCount < 0 || input.tileCount * 64 > input.targetCapacity) {
      throw new RangeError("Geometry target capacity must cover every lane in the bounded tile range");
    }
    const hasProduct = input.product !== null;
    if (hasProduct && input.product!.banks.length !== 4) throw new RangeError("Cell Geometry requires four published Product banks");
    // Both ordinary and Product source inputs are finite resource profiles.
    if (this.device.limits.maxStorageBuffersPerShaderStage < (hasProduct ? 12 : 7)) {
      throw new RangeError("Cell Geometry source profile exceeds negotiated storage binding limit");
    }
    const capacity=planSurfaceCellGeometryCapacity(input.targetCapacity,input.addressBudgetBytes??input.targetCapacity*1280,this.device.limits);
    const {setupCapacity,referenceCapacity}=capacity;
    if (setupCapacity < input.targetCapacity) {
      throw new RangeError("Surface Geometry local setup capacity must cover the complete bounded target range");
    }
    const profile=`${hasProduct}:${referenceCapacity}:${setupCapacity}:${capacity.memoCapacity}`;
    let pipelines = this.pipelines.get(profile);
    if (!pipelines) {
      const module = this.device.createShaderModule({label:"SurfaceGeometry/cell setup",code:surfaceCellGeometrySetupWgsl(hasProduct,referenceCapacity)});
      pipelines = Object.freeze(Object.fromEntries(stages.map(entryPoint => [entryPoint,
        this.device.createComputePipeline({label:`SurfaceGeometry/${entryPoint}`,layout:"auto",compute:{module,entryPoint}})])) as Record<Stage,GPUComputePipeline>);
      this.pipelines.set(profile,pipelines);
    }
    let arena!: ResourceId,counts!: ResourceId,indirect!: ResourceId,settings!: ResourceId;
    const bind: SurfaceResourceBinding = input.resourceBinding ?? ((_name, resolve) => resolve());
    let frameMemo = this.memoByGraph.get(graph);
    if (frameMemo === undefined && this.scratch !== null) {
      frameMemo = { resource: this.scratch.importBuffer(graph, bind, "Surface/frame geometry memo", capacity.memoBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST), bytes: capacity.memoBytes };
    }
    if (frameMemo !== undefined && frameMemo.bytes !== capacity.memoBytes) {
      throw new RangeError("Geometry memo shape changed within one frame");
    }
    let memo = frameMemo?.resource;
    for (const stage of stages) {
      const pipeline=pipelines[stage];
      const pass=graph.add(`SurfaceGeometry/${stage} batch ${input.firstTile}`, input, (data,resources,context)=>{
        const command=context.encoder as ShadeGPUCommandContext;
        if(stage==="reset_cell_geometry") {
          const values=new Uint32Array([data.width,data.height,data.tilesX,data.firstTile,data.tileCount,referenceCapacity,setupCapacity,data.generation,
            data.firstTile,0,capacity.memoCapacity,data.generation,data.sourceGeometry,data.sourceMeshlet,data.sourceMeshletVertices,data.sourceMeshletTriangles,data.sourceVertexData,0,0,0]);
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
        if(stage==="request_cell_geometry") {
          group1.push({binding:3,resource:this.scratch?.resolveTextureView(resources.get(data.visibility)) ?? resolveTextureView(resources.get(data.visibility))});
          group1.push({binding:5,resource:{buffer:resources.get(data.workspace) as GPUBuffer}});
        }
        if (stage === "reset_cell_geometry" || stage === "build_cell_geometry" ||
          stage === "publish_cell_geometry_memo" || stage === "commit_cell_geometry_memo") {
          group1.push({ binding: 6, resource: { buffer: resources.get(memo!) as GPUBuffer } });
        }
        if(stage==="finalize_cell_geometry")group1.push({binding:4,resource:{buffer:resources.get(indirect) as GPUBuffer}});
        const compute=command.beginComputePass({label:`SurfaceGeometry/${stage}`});compute.setPipeline(pipeline);
        if (this.scratch !== null) {
          compute.setBindGroup(0, this.scratch.obtainBindGroup(pipeline, 0, group0));
          compute.setBindGroup(1, this.scratch.obtainBindGroup(pipeline, 1, group1));
        } else {
          compute.setBindGroup(0,this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:group0}));
          compute.setBindGroup(1,this.device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:group1}));
        }
        if(stage==="build_cell_geometry" || stage==="publish_cell_geometry_memo" || stage==="commit_cell_geometry_memo")compute.dispatchWorkgroupsIndirect(resources.get(indirect) as GPUBuffer,0);
        else if(stage==="request_cell_geometry") { compute.dispatchWorkgroupsIndirect(resources.get(data.activeIndirect) as GPUBuffer,0); }
        else compute.dispatchWorkgroups(stage==="reset_cell_geometry"?Math.ceil(referenceCapacity/64):1);
        compute.end();
      });
      if(stage==="reset_cell_geometry") {
        for (const resource of input.after ?? []) { pass.read(resource); }
        if (memo === undefined) {
          memo = pass.create("Surface/frame geometry memo", { kind: "transient_buffer", size: capacity.memoBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        } else {
          pass.read(memo);
          memo = pass.write(memo);
        }
        const storage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC;
        if (this.scratch !== null) {
          arena=this.scratch.importBuffer(graph,bind,"Surface/cell primitive setups and explicit references",
            capacity.referenceBytes+setupCapacity*SURFACE_CELL_GEOMETRY_SETUP_BYTES,storage);
          counts=this.scratch.importBuffer(graph,bind,"Surface/cell geometry counters",32,storage);
          settings=this.scratch.importBuffer(graph,bind,"Surface/cell geometry settings",SURFACE_CELL_GEOMETRY_SETTINGS_BYTES,
            GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
          indirect=this.scratch.importBuffer(graph,bind,"Surface/cell geometry indirect",16,
            GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_SRC);
          arena=pass.write(arena);counts=pass.write(counts);settings=pass.write(settings);indirect=pass.write(indirect);
        } else {
          arena=pass.create("Surface cell primitive setups and explicit references",{kind:"transient_buffer",size:capacity.referenceBytes+setupCapacity*SURFACE_CELL_GEOMETRY_SETUP_BYTES,usage:storage});
          counts=pass.create("Surface cell geometry counters",{kind:"transient_buffer",size:32,usage:storage});
          settings=pass.create("Surface cell geometry settings",{kind:"transient_buffer",size:SURFACE_CELL_GEOMETRY_SETTINGS_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
          indirect=pass.create("Surface cell geometry indirect",{kind:"transient_buffer",size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_SRC});
        }
      } else {pass.read(settings);pass.read(arena);pass.read(counts);pass.read(memo!);counts=pass.write(counts);
        if(stage==="request_cell_geometry"){pass.read(input.visibility);pass.read(input.workspace);pass.read(input.activeIndirect);arena=pass.write(arena);}
        if(stage==="finalize_cell_geometry")indirect=pass.write(indirect);
        if (stage === "publish_cell_geometry_memo" || stage === "commit_cell_geometry_memo") {
          pass.read(indirect);
          if (stage === "publish_cell_geometry_memo") { arena = pass.write(arena); }
          memo = pass.write(memo!);
        }
        if(stage==="build_cell_geometry"){pass.read(indirect);arena=pass.write(arena);
          for(const id of [input.meshletWork,input.sourceHeap,input.vertexPayload,input.frameInstances])pass.read(id);
          if(input.product){pass.read(input.product.heap);for(const bank of input.product.banks)pass.read(bank);}}
      }
    }
    this.memoByGraph.set(graph, { resource: memo!, bytes: capacity.memoBytes });
    return {arena,counts,indirect,memo: memo!,memoCapacity:capacity.memoCapacity,referenceCapacity,setupCapacity};
  }
  destroy(): void {this.pipelines.clear();}
}
