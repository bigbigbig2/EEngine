import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import type { CachedRenderPipelineDescriptor } from "../gpu/GPUDescriptorCaches.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import type { GpuRenderWorldRuntime } from "../gpu/GpuRenderWorld.js";
import type { AppearancePublishedCoverage } from "../gpu/GpuAppearancePublication.js";
import { meshletBucketVisibilityWgsl, productMeshletVisibilityWgsl } from "../shaders/meshlet_bucket_visibility.js";
import { COVERAGE_BUFFER_BINDINGS } from "../shaders/appearance_coverage.js";
import { RASTER_PARTITIONS_PER_PROGRAM, RASTER_PARTITION_SETTINGS_STRIDE, RASTER_PARTITION_INDIRECT_STRIDE } from "../shaders/raster_work_partitions.js";
import { gpuShadingBinVisibilityRenderPassAttachments, gpuVisibilityKeyRenderPassAttachments } from "../gpu/GpuShadingBinVisibilityContract.js";
import { PACKED_CAMERA_TYPE } from "../shaders/packed_camera.js";
import type { PreparedMeshletWorkCandidate } from "./MeshletWorkCandidate.js";
import type { GpuShadingExecutionMode } from "../gpu/GpuShadingExecutionMode.js";
import type { PreparedFrameVertices } from "./FrameGeometryVertices.js";
import type { PreparedRasterWorkPartitions } from "./RasterWorkPartitions.js";
import { publishedRasterPrograms, coverageRasterResourceGroups } from "./CoverageRasterBindings.js";

function rasterGroup(product: boolean, coverage?: AppearancePublishedCoverage): GPUBindGroupLayoutDescriptor {
  const vertex=GPUShaderStage.VERTEX, fragment=GPUShaderStage.FRAGMENT;
  const buffer=(binding: number, visibility=vertex): GPUBindGroupLayoutEntry=>({binding,visibility,buffer:{type:"read-only-storage"}});
  return { label:`Geometry/compiled coverage/${product ? "Product" : "ordinary"}/${coverage ? "alpha" : "opaque"}`,entries:[
    {binding:0,visibility:vertex|(coverage ? fragment : 0),buffer:{type:"uniform",minBindingSize:PACKED_CAMERA_TYPE.size}},
    buffer(1,vertex|(coverage ? fragment : 0)),
    ...Array.from({length:6},(_,i)=>buffer(i+2)),
    ...(product ? [buffer(8,fragment),buffer(18),{binding:19,visibility:vertex,buffer:{type:"uniform" as GPUBufferBindingType,minBindingSize:16}}]
      : [buffer(10,fragment),buffer(20),{binding:21,visibility:vertex,buffer:{type:"uniform" as GPUBufferBindingType,minBindingSize:16}}]),
    ...(coverage ? Object.values(COVERAGE_BUFFER_BINDINGS).map(binding=>buffer(binding,fragment)) : []),
    buffer(26),buffer(27),{binding:28,visibility:vertex,buffer:{type:"uniform",hasDynamicOffset:true,minBindingSize:16}},
    ...(coverage ? [buffer(29)] : [])
  ]};
}
function rasterPipeline(product: boolean, doubleSided: boolean, bins: boolean, late: boolean,
  primitiveIndex: boolean, coverage?: AppearancePublishedCoverage): CachedRenderPipelineDescriptor {
  const code=product ? productMeshletVisibilityWgsl(coverage,bins) : meshletBucketVisibilityWgsl(primitiveIndex,bins,coverage);
  const module={label:"Geometry/finite compiled coverage",code};
  const groups:GPUBindGroupLayoutDescriptor[]=[rasterGroup(product,coverage)];
  for(const entries of coverage?.kernel.descriptor.groups.slice(1) ?? []) groups.push({entries});
  return {label:`Geometry/${product ? "Product" : "ordinary"}/${coverage ? "compiled-alpha" : "opaque"}/${doubleSided ? "double" : "front"}/${bins ? "bins" : "key"}/${late ? "late" : "main"}/${primitiveIndex ? "primitive" : "varying"}`,
    layout:{bindGroupLayouts:groups},vertex:{module,entryPoint:product ? "raster_virtual_meshlet" : "raster_meshlet_bucket"},
    fragment:{module,entryPoint:"write_visibility",targets:bins ? [{format:"r32uint"},{format:"r8uint"}] : [{format:"r32uint"}]},
    primitive:{topology:"triangle-list",cullMode:doubleSided ? "none" : "back",frontFace:"ccw"},
    depthStencil:{format:"depth32float",depthWriteEnabled:true,depthCompare:late ? "greater-equal" : "greater"}};
}

interface RasterPipelineFamily {
  readonly programs:readonly (AppearancePublishedCoverage|undefined)[];
  readonly modes:ReadonlyMap<string,readonly (readonly GPURenderPipeline[])[]>;
}
const RASTER_FAMILIES=new WeakMap<GpuRenderWorldRuntime,RasterPipelineFamily>();
const RASTER_PREPARATIONS=new WeakMap<GpuRenderWorldRuntime,Promise<void>>();
function modeKey(bins:boolean,late:boolean,primitive:boolean):string {return `${Number(bins)}:${Number(late)}:${Number(primitive)}`;}

/** Finite compiled coverage PSOs are admitted before the Scene transaction submits. */
export function prepareMeshletRasterPipelines(graphics:GraphicsContext,runtime:GpuRenderWorldRuntime):Promise<void> {
  const existing=RASTER_PREPARATIONS.get(runtime); if(existing)return existing;
  const prepare=async()=>{
    const product=Boolean(runtime.virtualGeometry),programs=publishedRasterPrograms(runtime),limits=graphics.device.limits;
    for(const coverage of programs) {
      const groups=[rasterGroup(product,coverage),...(coverage?.kernel.descriptor.groups.slice(1).map(entries=>({entries})) ?? [])];
      for(const stage of [GPUShaderStage.VERTEX,GPUShaderStage.FRAGMENT]) {
        const entries=groups.flatMap(group=>Array.from(group.entries)).filter(entry=>(entry.visibility & stage)!==0);
        if(entries.filter(entry=>entry.buffer && entry.buffer.type!=="uniform").length>limits.maxStorageBuffersPerShaderStage ||
          entries.filter(entry=>entry.texture).length>limits.maxSampledTexturesPerShaderStage ||
          entries.filter(entry=>entry.sampler).length>limits.maxSamplersPerShaderStage || groups.length>limits.maxBindGroups ||
          groups.some(group=>Array.from(group.entries).some(entry=>entry.binding>=limits.maxBindingsPerBindGroup)) ||
          limits.maxInterStageShaderVariables<14)throw new RangeError("Compiled coverage exceeds the negotiated raster resource profile");
      }
    }
    const modes=new Map<string,readonly (readonly GPURenderPipeline[])[]>(),jobs:Promise<void>[]=[];
    for(const bins of [false,true])for(const late of product ? [false,true] : [false]) {
      for(const primitive of !product && graphics.device.features.has("primitive-index") ? [false,true] : [false]) {
        jobs.push(Promise.all(programs.map(coverage=>Promise.all([false,true].map(double=>
          graphics.render_pipelines.prepare(rasterPipeline(product,double,bins,late,primitive,coverage)))))).then(pipelines=>{
            modes.set(modeKey(bins,late,primitive),pipelines);
          }));
      }
    }
    await Promise.all(jobs); RASTER_FAMILIES.set(runtime,{programs,modes});
  };
  const ready=prepare(); RASTER_PREPARATIONS.set(runtime,ready); return ready;
}

export interface MeshletBucketRasterInputs {
  readonly prepared:PreparedMeshletWorkCandidate;
  readonly camera:GPUBuffer;
  readonly assets:GpuAssetBindings;
  readonly scene:GpuSceneBindings;
  readonly frameInstances:GPUBuffer;
  readonly frameVertices:PreparedFrameVertices;
  readonly runtime:GpuRenderWorldRuntime;
  readonly visibilityKey:GPUTextureView;
  readonly shadingBinId:GPUTextureView|null;
  readonly depth:GPUTextureView;
  readonly virtualGeometry?:import("../gpu/VirtualGeometryResidency.js").GeometryProductGpuBindingsV1|null;
}

/** One unique production raster route: source work -> partition indices ->
 * hardware raster -> compiled alpha -> VisibilityKey. */
export class MeshletBucketRaster {
  readonly primitiveIndexSupported:boolean;
  private readonly bindings=new WeakMap<GPUBuffer,{camera:GPUBuffer;instances:GPUBuffer;vertices:PreparedFrameVertices;runtime:GpuRenderWorldRuntime;metadata:GPUBuffer|null;late:boolean;groups:readonly (readonly GPUBindGroup[])[]}>();
  constructor(private readonly graphics:GraphicsContext){this.primitiveIndexSupported=graphics.device.features.has("primitive-index");}
  prepare(runtime:GpuRenderWorldRuntime,prepared:PreparedMeshletWorkCandidate,assets:GpuAssetBindings,queue=prepared.queue):void {
    const publication=runtime.appearancePublication;
    if(!publication)throw new Error("Raster partition preparation requires compiled Appearance");
    this.graphics.raster_partitions.prepare(queue,prepared.capacity,publication,runtime.materialResources.materialRecords,assets.meshletRecords,Boolean(prepared.productMode));
  }
  encodeRaster(encoder:GPUCommandEncoder,inputs:MeshletBucketRasterInputs,executionMode:GpuShadingExecutionMode|"none"="sparse-microtile",primitiveIndexPath:"auto"|"portable"="auto"):void {
    if((executionMode==="sparse-microtile")!==(inputs.shadingBinId!==null))throw new Error("Visibility MRT differs from execution mode");
    this.encode(encoder,inputs,inputs.prepared.queue,false,primitiveIndexPath==="auto" && this.primitiveIndexSupported);
  }
  encodeFilteredVirtualRaster(encoder:GPUCommandEncoder,inputs:MeshletBucketRasterInputs,queue:GPUBuffer):void {
    if(!inputs.prepared.productMode)throw new Error("Late HZB raster requires Product work");
    this.encode(encoder,inputs,queue,true,false);
  }
  private groups(inputs:MeshletBucketRasterInputs,queue:GPUBuffer,partition:PreparedRasterWorkPartitions,late:boolean,
    coverage?:AppearancePublishedCoverage):readonly GPUBindGroup[] {
    const product=Boolean(inputs.prepared.productMode),publication=inputs.runtime.appearancePublication!;
    const geometry:GPUBindingResource[]=product ? [
      {buffer:inputs.camera},{buffer:inputs.frameInstances},{buffer:queue},{buffer:inputs.virtualGeometry!.metadata},
      ...inputs.prepared.productBanks!.map(buffer=>({buffer})),{buffer:inputs.runtime.materialResources.materialRecords},
      {buffer:inputs.frameVertices.arena.buffer},{buffer:late ? inputs.frameVertices.filteredRasterSettings : inputs.frameVertices.rasterSettings}
    ] : [{buffer:inputs.camera},{buffer:inputs.frameInstances},{buffer:inputs.assets.meshletRecords},
      {buffer:inputs.assets.meshletVertexIndices},{buffer:inputs.assets.meshletTriangleIndices},{buffer:inputs.assets.vertexStreamData},
      {buffer:inputs.assets.geometryRecords},{buffer:queue},{buffer:inputs.runtime.materialResources.materialRecords},
      {buffer:inputs.frameVertices.arena.buffer},{buffer:inputs.frameVertices.rasterSettings}];
    const groups=[this.graphics.bind_groups.obtain({layout:rasterGroup(product,coverage),entries:[...geometry,
      ...(coverage ? [publication.constants,publication.routes,publication.runtimeInputs,publication.coverageDirectory].map(buffer=>({buffer})) : []),
      {buffer:partition.indices},{buffer:partition.states},{buffer:partition.settings,size:16},...(coverage ? [{buffer:inputs.frameVertices.attributes}] : [])]})];
    if(coverage)groups.push(...coverageRasterResourceGroups(this.graphics,inputs.runtime,coverage));
    return groups;
  }
  private encode(encoder:GPUCommandEncoder,inputs:MeshletBucketRasterInputs,queue:GPUBuffer,late:boolean,primitiveIndex:boolean):void {
    const product=Boolean(inputs.prepared.productMode),bins=inputs.shadingBinId!==null;
    if(product && (!inputs.virtualGeometry || inputs.prepared.productBanks?.length!==4))throw new Error("Product raster requires resident four-bank geometry");
    const partition=this.graphics.raster_partitions.encode(encoder,queue);
    const family=RASTER_FAMILIES.get(inputs.runtime),mode=family?.modes.get(modeKey(bins,late,product ? false : primitiveIndex));
    if(!family || !mode)throw new Error("Raster finite PSO family was not prepared before Scene publication");
    const programs=family.programs,metadata=inputs.virtualGeometry?.metadata ?? null;
    let binding=this.bindings.get(queue);
    if(!binding || binding.camera!==inputs.camera || binding.instances!==inputs.frameInstances || binding.vertices!==inputs.frameVertices ||
      binding.runtime!==inputs.runtime || binding.metadata!==metadata || binding.late!==late) {
      binding={camera:inputs.camera,instances:inputs.frameInstances,vertices:inputs.frameVertices,runtime:inputs.runtime,metadata,late,
        groups:programs.map(coverage=>this.groups(inputs,queue,partition,late,coverage))};
      this.bindings.set(queue,binding);
    }
    const groups=binding.groups;
    const pass=encoder.beginRenderPass({label:"Geometry/partitioned compiled coverage",colorAttachments:bins
      ? gpuShadingBinVisibilityRenderPassAttachments(inputs.visibilityKey,inputs.shadingBinId!) : gpuVisibilityKeyRenderPassAttachments(inputs.visibilityKey),
      depthStencilAttachment:{view:inputs.depth,depthClearValue:0,depthLoadOp:late ? "load" : "clear",depthStoreOp:"store"}});
    for(const [index,coverage] of programs.entries())for(const double of [false,true]) {
      pass.setPipeline(mode[index]![Number(double)]!);
      groups[index]!.slice(1).forEach((group,groupIndex)=>pass.setBindGroup(groupIndex+1,group));
      for(const size of product ? [3] : [0,1,2,3]) {
        const key=(coverage?.rasterProgram ?? 0)*RASTER_PARTITIONS_PER_PROGRAM+size*2+Number(double);
        pass.setBindGroup(0,groups[index]![0]!,[key*RASTER_PARTITION_SETTINGS_STRIDE]);
        pass.drawIndirect(partition.draws,key*RASTER_PARTITION_INDIRECT_STRIDE);
      }
    }
    pass.end();
  }
}
