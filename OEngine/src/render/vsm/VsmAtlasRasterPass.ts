import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { AppearancePublishedCoverage } from "../../gpu/GpuAppearancePublication.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { VSM_ATLAS_PAGE_CLEAR_WGSL,vsmAtlasRasterWgsl } from "../../shaders/vsm_atlas_raster.js";
import { COVERAGE_BUFFER_BINDINGS } from "../../shaders/appearance_coverage.js";
import { RASTER_PARTITIONS_PER_PROGRAM,RASTER_PARTITION_SETTINGS_STRIDE,RASTER_PARTITION_INDIRECT_STRIDE } from "../../shaders/raster_work_partitions.js";
import { publishedRasterPrograms,coverageRasterResourceGroups } from "../CoverageRasterBindings.js";
import type { VsmDirectionalFrameConstants } from "./VsmReceiverDemandPass.js";
import type { VsmResources } from "./VsmResources.js";
import type { VsmCasterRecordFrame } from "./VsmCasterRecordPass.js";
import { VSM_CONTENT_VERSION_WGSL } from "../../shaders/vsm_content_version.js";

const DIRTY_COMMIT_WGSL = /* wgsl */ `
struct Constants { generation: u32, reserved0: u32, reserved1: u32, reserved2: u32 };
struct Record { instance_record_index: u32, geometry_record_index: u32, meshlet_record_index: u32, material_handle: u32, page_slot: u32, virtual_page: u32, raster_flags: u32, packed_profile_lod: u32 };
struct Caster { attempted: u32, written: u32, overflow: u32, generation: u32, records: array<Record> };
struct Entry { slot_x: u32, slot_y: u32, mip: u32, flags: u32, generation: u32, fallback_mip: u32, reserved_0: u32, reserved_1: u32 };
struct Meta { virtual_page: u32, mip: u32, last_visited: u32, flags: u32, generation: u32, owner: u32, reserved_0: u32, reserved_1: u32 };
struct Table { entries: array<Entry>, }
struct Metas { entries: array<Meta>, }
struct Locks { values: array<atomic<u32>>, }
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> caster: Caster;
@group(0) @binding(2) var<storage, read_write> page_table: Table;
@group(0) @binding(3) var<storage, read_write> meta_table: Metas;
@group(0) @binding(4) var<storage, read_write> page_locks: Locks;
@group(0) @binding(5) var<storage, read_write> content_version:array<atomic<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  // A truncated caster list cannot prove that any dirty page is complete.
  if (caster.overflow != 0u) { return; }
  let count = min(caster.written, arrayLength(&caster.records));
  if (id.x >= count) { return; }
  let record = caster.records[id.x];
  if (record.virtual_page >= arrayLength(&page_table.entries) || record.virtual_page >= arrayLength(&page_locks.values)) { return; }
  let lock = atomicCompareExchangeWeak(&page_locks.values[record.virtual_page], 0u, 1u);
  if (!lock.exchanged) { return; }
  var entry = page_table.entries[record.virtual_page];
  if (entry.generation == constants.generation && (entry.flags & 1u) != 0u && (entry.flags & 8u) != 0u) {
    if ((entry.flags & 2u) != 0u) {
      // This lock owns publication of the completed page content. Multiple
      // caster records for one page advance its content version only once.
      entry.reserved_0 = max(1u, entry.reserved_0 + 1u);
      atomicStore(&content_version[1u],1u);
    }
    entry.flags = entry.flags & ~2u;
    page_table.entries[record.virtual_page] = entry;
    if (record.page_slot < arrayLength(&meta_table.entries)) {
      var slot_meta = meta_table.entries[record.page_slot];
      if (slot_meta.virtual_page == record.virtual_page && slot_meta.generation == constants.generation) {
        slot_meta.flags = slot_meta.flags & ~2u;
        slot_meta.reserved_0 = entry.reserved_0;
        meta_table.entries[record.page_slot] = slot_meta;
      }
    }
  }
  atomicStore(&page_locks.values[record.virtual_page], 0u);
}
`;

export interface VsmAtlasRasterInputs {
  readonly caster:VsmCasterRecordFrame;
  readonly resources:VsmResources;
  readonly frame:VsmDirectionalFrameConstants;
  readonly generation:number;
  readonly publication:Readonly<{runtime:GpuRenderWorldRuntime}>;
  readonly camera:ResourceId;
  readonly frameInstances:ResourceId;
  readonly pageTable:ResourceId;
  readonly allocation:ResourceId;
  readonly metaTable:ResourceId;
  readonly pageLocks:ResourceId;
  readonly contentVersion:ResourceId;
  readonly instances:ResourceId;
  readonly meshlets:ResourceId;
  readonly meshletVertices:ResourceId;
  readonly meshletTriangles:ResourceId;
  readonly vertexData:ResourceId;
  readonly geometries:ResourceId;
  readonly materials:ResourceId;
  readonly productHeap?:ResourceId;
  readonly productBanks?:readonly ResourceId[];
}
const CONSTANT_BYTES = 256;

function packConstants(input: VsmAtlasRasterInputs): ArrayBuffer {
  const data = new ArrayBuffer(CONSTANT_BYTES);
  const floats = new Float32Array(data); const uints = new Uint32Array(data);
  floats.set(input.frame.lightView, 0);
  for (let level = 0; level < 6; level++) floats.set(input.frame.clipOriginExtent[level] ?? [0, 0, 1, 1], 16 + level * 4);
  const c = input.resources.capabilities;
  uints.set([c.virtualPagesPerAxis, c.pageSize, c.border, c.atlasDimension], 40);
  uints.set([input.generation >>> 0, 0, c.casterRecordCapacity >>> 0, c.residentSlots >>> 0], 44);
  return data;
}


function atlasRasterGroup(product:boolean,coverage?:AppearancePublishedCoverage):GPUBindGroupLayoutDescriptor {
  const v=GPUShaderStage.VERTEX,f=GPUShaderStage.FRAGMENT;
  const buffer=(binding:number,visibility=v):GPUBindGroupLayoutEntry=>({binding,visibility,buffer:{type:"read-only-storage"}});
  return {label:`VSM/partitioned ${product ? "Product" : "ordinary"} ${coverage ? "alpha" : "opaque"}`,entries:[
    {binding:0,visibility:v,buffer:{type:"uniform",minBindingSize:CONSTANT_BYTES}},
    ...Array.from({length:8},(_,i)=>buffer(i+1)),buffer(9,f),
    ...(coverage ? Object.values(COVERAGE_BUFFER_BINDINGS).map(binding=>buffer(binding,f)) : []),
    buffer(26),buffer(27),{binding:28,visibility:v,buffer:{type:"uniform",hasDynamicOffset:true,minBindingSize:16}},
    ...(coverage ? [buffer(30,f),{binding:31,visibility:f,buffer:{type:"uniform" as GPUBufferBindingType}}] : [])
  ]};
}
function atlasRasterPipeline(product:boolean,double:boolean,coverage?:AppearancePublishedCoverage):CachedRenderPipelineDescriptor {
  const module={label:"VSM/compiled coverage",code:vsmAtlasRasterWgsl(product,coverage)};
  return {label:`VSM/${product ? "Product" : "ordinary"}/${double ? "double" : "front"}/${coverage ? "alpha" : "opaque"}`,
    layout:{bindGroupLayouts:[atlasRasterGroup(product,coverage),...(coverage?.kernel.descriptor.groups.slice(1).map(entries=>({entries})) ?? [])]},
    vertex:{module,entryPoint:"vsm_atlas_vertex"},fragment:{module,entryPoint:"vsm_atlas_fragment",targets:[]},
    primitive:{topology:"triangle-list",cullMode:double ? "none" : "back",frontFace:"ccw"},
    depthStencil:{format:"depth32float",depthWriteEnabled:true,depthCompare:"greater"}};
}
interface Family {programs:readonly (AppearancePublishedCoverage|undefined)[];pipelines:readonly (readonly GPURenderPipeline[])[]}
const FAMILIES=new WeakMap<GpuRenderWorldRuntime,Family>(),PREPARATIONS=new WeakMap<GpuRenderWorldRuntime,Promise<void>>();
export function prepareVsmAtlasRasterPipelines(graphics:GraphicsContext,runtime:GpuRenderWorldRuntime):Promise<void> {
  const existing=PREPARATIONS.get(runtime);if(existing)return existing;
  const programs=publishedRasterPrograms(runtime),product=Boolean(runtime.virtualGeometry),limits=graphics.device.limits;
  for(const coverage of programs) {
    const descriptor=atlasRasterPipeline(product,false,coverage),groups=descriptor.layout.bindGroupLayouts;
    for(const stage of [GPUShaderStage.VERTEX,GPUShaderStage.FRAGMENT]) {
      const entries=groups.flatMap(group=>Array.from(group.entries)).filter(entry=>(entry.visibility & stage)!==0);
      if(groups.length>limits.maxBindGroups || groups.some(group=>Array.from(group.entries).some(entry=>entry.binding>=limits.maxBindingsPerBindGroup)) ||
        entries.filter(entry=>entry.buffer && entry.buffer.type!=="uniform").length>limits.maxStorageBuffersPerShaderStage ||
        entries.filter(entry=>entry.texture).length>limits.maxSampledTexturesPerShaderStage ||
        entries.filter(entry=>entry.sampler).length>limits.maxSamplersPerShaderStage || limits.maxInterStageShaderVariables<10)throw new RangeError("VSM coverage exceeds negotiated raster resources");
    }
  }
  const ready=Promise.all(programs.map(coverage=>Promise.all([false,true].map(double=>graphics.render_pipelines.prepare(atlasRasterPipeline(product,double,coverage))))))
    .then(pipelines=>{FAMILIES.set(runtime,{programs,pipelines});});
  PREPARATIONS.set(runtime,ready);return ready;
}

/** Dirty-slot clear -> finite compiled caster partitions -> content publication. */
export class VsmAtlasRasterPass {
  private readonly constants:GPUBuffer;
  private readonly commitConstants:GPUBuffer;
  private readonly clearLayout:GPUBindGroupLayoutDescriptor;
  private readonly commitLayout:GPUBindGroupLayoutDescriptor;
  private readonly clearPipeline:GPURenderPipeline;
  private readonly commitPipeline:GPUComputePipeline;
  private readonly contentPipeline:GPUComputePipeline;
  private readonly contentLayout:GPUBindGroupLayoutDescriptor;
  constructor(private readonly graphics:GraphicsContext) {
    const device=graphics.device;
    this.constants=device.createBuffer({label:"VSM/atlas constants",size:CONSTANT_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.commitConstants=device.createBuffer({label:"VSM/content commit constants",size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.clearLayout={entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:"uniform"}},
      {binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:"read-only-storage"}}]};
    const module={label:"VSM/dirty-slot clear",code:VSM_ATLAS_PAGE_CLEAR_WGSL};
    this.clearPipeline=graphics.render_pipelines.obtain({label:"VSM/dirty-slot clear",layout:{bindGroupLayouts:[this.clearLayout]},
      vertex:{module,entryPoint:"clear_page"},fragment:{module,entryPoint:"clear_depth",targets:[]},primitive:{topology:"triangle-list",cullMode:"none"},
      depthStencil:{format:"depth32float",depthWriteEnabled:true,depthCompare:"always"}});
    this.commitLayout={entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},
      ...[2,3,4,5].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage" as GPUBufferBindingType}}))]};
    this.commitPipeline=graphics.compute_pipelines.obtain({label:"VSM/dirty content commit",layout:{bindGroupLayouts:[this.commitLayout]},
      compute:{module:{code:DIRTY_COMMIT_WGSL},entryPoint:"main"}});
    this.contentLayout={entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}
    ]};
    this.contentPipeline=graphics.compute_pipelines.obtain({label:"VSM/content version publication",layout:{bindGroupLayouts:[this.contentLayout]},
      compute:{module:{code:VSM_CONTENT_VERSION_WGSL},entryPoint:"publish_vsm_content_version"}});
  }
  addToGraph(graph:FrameGraph,input:VsmAtlasRasterInputs):{readonly atlasDepth:ResourceId;readonly pageTable:ResourceId;readonly metaTable:ResourceId;readonly contentVersion:ResourceId} {
    if(!input.resources.atlasDepth || !input.resources.casterRecords)throw new Error("VSM raster resources are absent");
    const constants=graph.import_resource("VSM/atlas constants",{kind:"imported",label:"VSM atlas constants"},this.constants);
    const atlas=graph.import_resource("VSM/depth atlas",{kind:"imported",label:"VSM depth atlas"},input.resources.atlasDepth);
    const caster=input.caster.casterRecords,indirect=input.caster.rasterIndirect,pageTable=input.pageTable;
    const update=graph.add("VSM/update atlas constants",input,(data,_resolved,context)=>{
      (context.encoder as ShadeGPUCommandContext).writeBuffer(this.constants,0,packConstants(data),0,CONSTANT_BYTES);
    });
    const currentConstants=update.write(constants);
    const raster=graph.add("VSM/partitioned compiled caster raster",input,(data,resolved,context)=>{
      const command=context.encoder as ShadeGPUCommandContext,runtime=data.publication.runtime,publication=runtime.appearancePublication!;
      const family=FAMILIES.get(runtime);if(!family)throw new Error("VSM finite PSOs were not prepared at Scene publication");
      const product=Boolean(runtime.virtualGeometry),queue=resolved.get(caster) as GPUBuffer;
      this.graphics.raster_partitions.prepare(queue,data.caster.capacity,publication,resolved.get(data.materials) as GPUBuffer,
        resolved.get(data.meshlets) as GPUBuffer,product,true);
      const partitions=this.graphics.raster_partitions.encode(command.gpu_encoder,queue);
      const clearGroup=this.graphics.bind_groups.obtain({layout:this.clearLayout,entries:[{buffer:this.constants},{buffer:resolved.get(data.allocation) as GPUBuffer}]});
      const geometryBuffers=[this.constants,queue,resolved.get(pageTable) as GPUBuffer,resolved.get(data.instances) as GPUBuffer,
        ...(product ? [resolved.get(data.productHeap!) as GPUBuffer,...data.productBanks!.slice(0,4).map(id=>resolved.get(id) as GPUBuffer)]
          : [data.meshlets,data.meshletVertices,data.meshletTriangles,data.vertexData,data.geometries].map(id=>resolved.get(id) as GPUBuffer)),resolved.get(data.materials) as GPUBuffer];
      const groups=family.programs.map(coverage=>[
        this.graphics.bind_groups.obtain({layout:atlasRasterGroup(product,coverage),entries:[...geometryBuffers.map(buffer=>({buffer})),
          ...(coverage ? [publication.constants,publication.routes,publication.runtimeInputs,publication.coverageDirectory].map(buffer=>({buffer})) : []),
          {buffer:partitions.indices},{buffer:partitions.states},{buffer:partitions.settings,size:16},
          ...(coverage ? [{buffer:resolved.get(data.frameInstances) as GPUBuffer},{buffer:resolved.get(data.camera) as GPUBuffer}] : [])]}),
        ...(coverage ? coverageRasterResourceGroups(this.graphics,runtime,coverage) : [])]);
      const pass=command.beginRenderPass({label:"VSM/partitioned compiled caster raster",colorAttachments:[],depthStencilAttachment:{view:resolveTextureView(resolved.get(atlas)),depthLoadOp:"load",depthStoreOp:"store"}});
      pass.setPipeline(this.clearPipeline);pass.setBindGroup(0,clearGroup);pass.drawIndirect(resolved.get(indirect) as GPUBuffer,32);
      for(const [index,coverage] of family.programs.entries())for(const double of [false,true]) {
        pass.setPipeline(family.pipelines[index]![Number(double)]!);groups[index]!.slice(1).forEach((group,slot)=>pass.setBindGroup(slot+1,group));
        for(const size of product ? [3] : [0,1,2,3]) {
          const key=(coverage?.rasterProgram ?? 0)*RASTER_PARTITIONS_PER_PROGRAM+size*2+Number(double);
          pass.setBindGroup(0,groups[index]![0]!,[key*RASTER_PARTITION_SETTINGS_STRIDE]);pass.drawIndirect(partitions.draws,key*RASTER_PARTITION_INDIRECT_STRIDE);
        }
      }
      pass.end();
    });
    for(const id of [currentConstants,input.allocation,caster,indirect,pageTable,input.instances,input.meshlets,input.meshletVertices,input.meshletTriangles,input.vertexData,input.geometries,input.materials,input.frameInstances,input.camera,
      ...(input.productHeap===undefined ? [] : [input.productHeap]),...(input.productBanks ?? [])])raster.read(id);
    const rasteredAtlas=raster.write(atlas);raster.make_side_effect();
    const commitConstants=graph.import_resource("VSM/content commit constants",{kind:"imported",label:"VSM content commit constants"},this.commitConstants);
    const commit=graph.add("VSM/commit complete dirty pages",input,(data,resolved,context)=>{
      const command=context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(this.commitConstants,0,new Uint32Array([data.generation>>>0,0,0,0]).buffer,0,16);
      const group=this.graphics.bind_groups.obtain({layout:this.commitLayout,entries:[{buffer:this.commitConstants},{buffer:resolved.get(caster) as GPUBuffer},
        {buffer:resolved.get(pageTable) as GPUBuffer},{buffer:resolved.get(data.metaTable) as GPUBuffer},{buffer:resolved.get(data.pageLocks) as GPUBuffer},
        {buffer:resolved.get(data.contentVersion) as GPUBuffer}]});
      const pass=command.beginComputePass({label:"VSM/content commit"});pass.setPipeline(this.commitPipeline);pass.setBindGroup(0,group);
      pass.dispatchWorkgroups(Math.ceil(data.caster.capacity/64));pass.end();
    });
    commit.read(caster);commit.read(rasteredAtlas);commit.read(commitConstants);
    const publishedPageTable=commit.write(pageTable),publishedMetaTable=commit.write(input.metaTable);
    const dirtyContent=commit.write(input.contentVersion);
    commit.write(input.pageLocks);commit.make_side_effect();commit.dependsOn(raster);
    const publishContent=graph.add("VSM/publish sampled content version",{contentVersion:dirtyContent},(data,resolved,context)=>{
      const command=context.encoder as ShadeGPUCommandContext;
      const group=this.graphics.bind_groups.obtain({layout:this.contentLayout,entries:[
        {buffer:this.commitConstants},{buffer:resolved.get(data.contentVersion) as GPUBuffer}
      ]});
      const pass=command.beginComputePass({label:"VSM/publish sampled content version"});
      pass.setPipeline(this.contentPipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
    });
    publishContent.read(dirtyContent);publishContent.read(publishedPageTable);publishContent.read(publishedMetaTable);publishContent.read(rasteredAtlas);
    publishContent.dependsOn(commit);
    const contentVersion=publishContent.write(dirtyContent);
    return {atlasDepth:rasteredAtlas,pageTable:publishedPageTable,metaTable:publishedMetaTable,contentVersion};
  }
  destroy():void{this.constants.destroy();this.commitConstants.destroy();}
}
