import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../../../../OEngine/src/assets/GeometryAssetPackage.js";
import { writeWgslToBuffer } from "../../../../OEngine/src/core/WgslBufferIO.js";
import { FrameProfiler } from "../../../../OEngine/src/debug/FrameProfiler.js";
import { FrameGraph, type PassResources } from "../../../../OEngine/src/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../../../OEngine/src/framegraph/ShadeGPUCommandContext.js";
import { GPU_GEOMETRY_RECORD_STRIDE, GPU_MESHLET_RECORD_STRIDE, GPU_POSITION_FORMAT,
  GPU_UV_FORMAT, packGpuGeometryRecord, packGpuMeshletRecords } from "../../../../OEngine/src/gpu/GpuGeometryAbi.js";
import { GraphicsContext } from "../../../../OEngine/src/gpu/GraphicsContext.js";
import { GPU_INSTANCE_RECORD_STRIDE, packGpuInstanceRecord } from "../../../../OEngine/src/gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_FLAGS, GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
  packGpuMaterialVisibilityRecord } from "../../../../OEngine/src/gpu/GpuMaterialVisibilityAbi.js";
import { GPU_MESHLET_BUCKET_STATE_STRIDE, GPU_MESHLET_DRAW_COUNT, GPU_MESHLET_DRAW_INDIRECT_STRIDE,
  GPU_MESHLET_RASTER_FLAGS, GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE, packGpuMeshletProfileLodBucket,
  packGpuMeshletRasterWork, packGpuMeshletWorkQueueHeader } from "../../../../OEngine/src/gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_BIN_CONTROL_OFFSETS, GPU_SHADING_BIN_COUNTER_OFFSETS,
  GPU_SHADING_BIN_COUNTER_STRIDE, GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE,
  packGpuShadingBinSettings } from "../../../../OEngine/src/gpu/GpuShadingBinAbi.js";
import { GPU_SHADING_MATERIAL_RECORD_STRIDE, GPU_SHADING_TEXTURE_ROUTE_STRIDE,
  packGpuShadingMaterialRecord, packGpuShadingTextureRoute } from "../../../../OEngine/src/gpu/GpuShadingMaterialAbi.js";
import { GpuShadingPublicationStore } from "../../../../OEngine/src/gpu/GpuShadingPublicationPlan.js";
import { GPU_SHADING_PROGRAM_COUNT, shadingProgramUsesTextures,
  type GpuShadingGeometryProfile, type GpuShadingMaterialProfile } from "../../../../OEngine/src/gpu/GpuShadingProgramAbi.js";
import { evaluateGpuShadingProgramReference, gpuShadingProgramSpecialization,
  type Vec3 } from "../../../../OEngine/src/gpu/GpuShadingProgramOracle.js";
import type { GpuSparseShadingCapabilityRecord } from "../../../../OEngine/src/gpu/GpuSparseShadingCapability.js";
import { GPU_SPARSE_SHADING_LIGHT_TYPE,
  packGpuSparseShadingLightDatabase } from "../../../../OEngine/src/gpu/GpuSparseShadingLightAbi.js";
import { GPU_TEXTURE_REF_INVALID, encodeGpuTextureRef } from "../../../../OEngine/src/gpu/GpuTextureRefAbi.js";
import type { GpuAssetBindings } from "../../../../OEngine/src/gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../../../OEngine/src/gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../../../OEngine/src/gpu/GpuRenderWorld.js";
import { MeshletBucketRaster } from "../../../../OEngine/src/render/MeshletBucketRaster.js";
import type { PreparedMeshletWorkCandidate } from "../../../../OEngine/src/render/MeshletWorkCandidate.js";
import { resolveTextureView } from "../../../../OEngine/src/render/RenderTargetViews.js";
import { addSparseShadingCandidateToGraph, type SparseShadingCandidateFrame,
  type SparseShadingCandidateStage } from "../../../../OEngine/src/render/pipeline/SparseShadingCandidatePipeline.js";
import { createSparseShadingCandidateExecutor } from "../../../../OEngine/src/render/pipeline/SparseShadingCandidateExecutor.js";
import { SparseShadingCandidateRuntime } from "../../../../OEngine/src/render/pipeline/SparseShadingCandidateRuntime.js";
import { ShadingBinPass } from "../../../../OEngine/src/render/passes/ShadingBinPass.js";
import { SparseShadingResolvePass, type SparseShadingResolveFrameBinding } from "../../../../OEngine/src/render/passes/SparseShadingResolvePass.js";
import { TonemapPass } from "../../../../OEngine/src/render/passes/TonemapPass.js";
import { PACKED_CAMERA_TYPE } from "../../../../OEngine/src/shaders/packed_camera.js";
import { MESHLET_BUCKET_SETTINGS_STRIDE } from "../../../../OEngine/src/shaders/meshlet_bucket_visibility.js";

const WIDTH = 256, HEIGHT = 256, PIXELS = WIDTH * HEIGHT;
const STRIP_WIDTH = 2, STRIPS_PER_PROGRAM = WIDTH / (GPU_SHADING_PROGRAM_COUNT * STRIP_WIDTH);
const VERTICES_PER_PROGRAM = STRIPS_PER_PROGRAM * 4, TRIANGLES_PER_PROGRAM = STRIPS_PER_PROGRAM * 2;
const VERTEX_STRIDE = 68, TRIANGLE_BYTES_PER_PROGRAM = TRIANGLES_PER_PROGRAM * 3;
const MATERIAL_GENERATION = 13, TEXTURE_GENERATION = 17, GEOMETRY_GENERATION = 19;
const PRE_EXPOSURE = 2, HDR_ROW_BYTES = WIDTH * 8, PRESENT_ROW_BYTES = WIDTH * 4;
const HDR_BYTES = HDR_ROW_BYTES * HEIGHT, PRESENT_BYTES = PRESENT_ROW_BYTES * HEIGHT;
const ORACLE_WORDS = 16 + 8 + 64 * 4 + 64 * 3, ORACLE_BYTES = ORACLE_WORDS * 4;
const HDR_OFFSET = 0, PRESENT_OFFSET = HDR_BYTES, ORACLE_OFFSET = HDR_BYTES + PRESENT_BYTES;
const READBACK_BYTES = ORACLE_OFFSET + ORACLE_BYTES, BUCKET = 12;
const IDENTITY = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const PIXEL_VIEW_PROJECTION = new Float32Array([
  2/WIDTH,0,0,0, 0,-2/HEIGHT,0,0, 0,0,1,0, -1,1,0,1
]);
const PIXEL_VIEW_PROJECTION_INVERSE = new Float32Array([
  WIDTH/2,0,0,0, 0,-HEIGHT/2,0,0, 0,0,1,0, WIDTH/2,HEIGHT/2,0,1
]);
const BASE_SAMPLE = [64/255,128/255,191/255,1] as const;
const NORMAL_SAMPLE = [128/255,128/255,1,1] as const;
const ORM_SAMPLE = [51/255,179/255,230/255,1] as const;
const EMISSIVE_SAMPLE = [128/255,64/255,1,1] as const;
const FEATURES = Object.freeze({ screenSpaceDiffuseMode:"off" as const, ssr:false, temporal:false,
  shadows:false, post:true, diagnostics:false });

interface CandidateResources {
  readonly settings:GPUBuffer; readonly shadingView:GPUBuffer; readonly camera:GPUBuffer;
  readonly queue:GPUBuffer; readonly bucketStates:GPUBuffer; readonly drawIndirect:GPUBuffer;
  readonly bucketSettings:GPUBuffer; readonly instances:GPUBuffer; readonly geometryRecords:GPUBuffer;
  readonly meshletRecords:GPUBuffer; readonly meshletVertexIndices:GPUBuffer;
  readonly meshletTriangleIndices:GPUBuffer; readonly vertexStreamData:GPUBuffer;
  readonly assetMetadata:GPUBuffer; readonly vertexPayload:GPUBuffer;
  readonly visibilityMaterials:GPUBuffer; readonly shadingMaterials:GPUBuffer; readonly routes:GPUBuffer;
  readonly textureBanks:readonly GPUTexture[]; readonly textureBankViews:readonly GPUTextureView[];
  readonly materialSamplers:readonly GPUSampler[]; readonly lightDatabase:GPUBuffer;
  readonly clusterHeaders:GPUBuffer; readonly clusterIndices:GPUBuffer; readonly lightSettings:GPUBuffer;
  readonly environmentSettings:GPUBuffer; readonly environmentTextures:readonly GPUTexture[];
  readonly environmentSampler:GPUSampler;
}

export interface SparseCandidateEvidence {
  readonly scenario:Readonly<Record<string,unknown>>; readonly graph:unknown; readonly profile:unknown;
  readonly lifecycle:unknown; readonly memory:unknown; readonly compilation:unknown;
}

export class SparseShadingCandidateFixture {
  private readonly buffers=new Set<GPUBuffer>(); private readonly textures=new Set<GPUTexture>();
  private readonly profiler=new FrameProfiler(); private readonly graphics:GraphicsContext;
  private readonly raster:MeshletBucketRaster; private readonly tonemap:TonemapPass;
  private readonly prepared:PreparedMeshletWorkCandidate; private readonly assets:GpuAssetBindings;
  private readonly scene:GpuSceneBindings; private readonly renderWorld:GpuRenderWorldRuntime;
  private destroyed=false;

  private constructor(private readonly device:GPUDevice, private readonly canvasContext:GPUCanvasContext,
    canvasFormat:GPUTextureFormat, private readonly resources:CandidateResources,
    private readonly runtime:SparseShadingCandidateRuntime, private readonly binPass:ShadingBinPass,
    private readonly resolve:SparseShadingResolvePass, private readonly oracleValidate:GPUComputePipeline,
    private readonly oracleExtract:GPUComputePipeline,
    private readonly compilation:Readonly<Record<string,unknown>>) {
    this.graphics=new GraphicsContext(device,this.profiler);
    this.profiler.configure({enabled:true,gpuTimestampAvailable:false,warmupFrames:0,gpuSampleInterval:1,
      gpuCounterSampleInterval:1,historyCapacity:16,readbackRingSlots:3,cpuPassTimings:true});
    this.raster=new MeshletBucketRaster(this.graphics); this.tonemap=new TonemapPass(device,canvasFormat,"shading-bin");
    this.prepared=createPrepared(resources); this.assets=createAssetBindings(resources);
    this.scene=createSceneBindings(resources); this.renderWorld=createRenderWorld(resources);
  }

  static async create(device:GPUDevice, canvasContext:GPUCanvasContext, canvasFormat:GPUTextureFormat,
    capability:Readonly<GpuSparseShadingCapabilityRecord>):Promise<SparseShadingCandidateFixture> {
    const buffers=new Set<GPUBuffer>(), textures=new Set<GPUTexture>();
    const resources=createResources(device,buffers,textures);
    const publications=new GpuShadingPublicationStore({width:WIDTH,height:HEIGHT,outputDependencyMask:0,
      shadowSamplingEnabled:false,capability,sizingLimits:{maxTextureDimension2D:device.limits.maxTextureDimension2D,
        maxBufferSize:device.limits.maxBufferSize,maxStorageBufferBindingSize:device.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupsPerDimension:device.limits.maxComputeWorkgroupsPerDimension}});
    const runtime=new SparseShadingCandidateRuntime(publications), mutation=runtime.beginMutation();
    mutation.replaceAll(createPublication()); runtime.commitMutation(mutation,0,FEATURES);
    const snapshot=publications.currentSnapshot();
    const binPass=await ShadingBinPass.create(device,snapshot.sizing,false);
    let resolve:SparseShadingResolvePass|undefined;
    try {
      resolve=await SparseShadingResolvePass.create(device,snapshot.pipelines,snapshot.revision,false);
      const oracle=await createOraclePipelines(device,snapshot.pipelines.slice().sort((a,b)=>a.programId-b.programId)
        .map((entry)=>entry.binId));
      const fixture=new SparseShadingCandidateFixture(device,canvasContext,canvasFormat,resources,runtime,
        binPass,resolve,oracle.validate,oracle.extract,Object.freeze({sparseOracle:oracle.messages}));
      for(const value of buffers)fixture.buffers.add(value); for(const value of textures)fixture.textures.add(value);
      uploadStaticInputs(device,resources,snapshot); return fixture;
    } catch(error) {
      resolve?.destroy(); binPass.destroy(); runtime.destroy();
      for(const value of buffers)value.destroy(); for(const value of textures)value.destroy(); throw error;
    }
  }

  async runMixedBins():Promise<Readonly<SparseCandidateEvidence>> {
    this.requireAlive(); const ticket=this.runtime.beginFrame(FEATURES);
    const readback=this.trackBuffer(this.device.createBuffer({label:"ADR-0013 candidate MixedBins readback",
      size:READBACK_BYTES,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));
    const oracle=this.trackBuffer(this.device.createBuffer({label:"ADR-0013 candidate MixedBins oracle scratch",
      size:ORACLE_BYTES,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}));
    const presentation=this.canvasContext.getCurrentTexture(), graph=new FrameGraph("ADR-0013 sparse candidate MixedBins");
    const imported=(name:string,value:unknown)=>graph.import_resource(name,{kind:"imported",label:name},value);
    const ids={
      meshletWork:imported("candidate/meshlet-work",this.resources.queue),
      camera:imported("candidate/camera",this.resources.camera), instances:imported("candidate/instances",this.resources.instances),
      geometry:imported("candidate/geometry-records",this.resources.geometryRecords),
      meshlets:imported("candidate/meshlet-records",this.resources.meshletRecords),
      vertices:imported("candidate/meshlet-vertices",this.resources.meshletVertexIndices),
      triangles:imported("candidate/meshlet-triangles",this.resources.meshletTriangleIndices),
      vertexStream:imported("candidate/vertex-stream",this.resources.vertexStreamData),
      assetMetadata:imported("candidate/asset-metadata",this.resources.assetMetadata),
      vertexPayload:imported("candidate/vertex-payload",this.resources.vertexPayload),
      visibilityMaterials:imported("candidate/visibility-materials",this.resources.visibilityMaterials),
      shadingMaterials:imported("candidate/shading-materials",this.resources.shadingMaterials),
      routes:imported("candidate/texture-routes",this.resources.routes),
      lights:imported("candidate/light-database",this.resources.lightDatabase),
      clusterHeaders:imported("candidate/cluster-headers",this.resources.clusterHeaders),
      clusterIndices:imported("candidate/cluster-indices",this.resources.clusterIndices),
      lightSettings:imported("candidate/light-settings",this.resources.lightSettings),
      environmentSettings:imported("candidate/environment-settings",this.resources.environmentSettings),
      presentation:imported("candidate/presentation",presentation), readback:imported("candidate/capture-readback",readback),
      oracle:imported("candidate/capture-oracle",oracle)
    };
    const externalStage=(stage:SparseShadingCandidateStage,frame:Readonly<SparseShadingCandidateFrame>,
      resources:PassResources,context:{readonly encoder:unknown}):void=>{
      const command=requireCommand(context.encoder);
      if(stage==="visibility") { this.raster.encodeSparseShadingRaster(command.gpu_encoder,{prepared:this.prepared,
        camera:this.resources.camera,assets:this.assets,scene:this.scene,runtime:this.renderWorld,
        visibilityKey:textureView(frame.visibilityKey,resources),shadingBinId:textureView(frame.shadingBinId,resources),
        depth:textureView(frame.depth,resources,{aspect:"depth-only"})},"portable"); return; }
      if(stage==="light-cluster") { const pass=command.constructComputePass({pipeline:clusterPipelineDescriptor(),
        bindings:[[{buffer:this.resources.clusterHeaders},{buffer:this.resources.clusterIndices}]]});
        pass.dispatchWorkgroups(4); pass.end(); return; }
      if(stage==="output-clear") {
        const targets=[frame.hdr,frame.normal,frame.albedoAo,frame.material,frame.velocity].filter((id):id is number=>id!==null);
        const pass=command.beginRenderPass({label:"ADR-0013 clear sparse shading outputs",colorAttachments:targets.map((id)=>({
          view:textureView(id,resources),clearValue:{r:0,g:0,b:0,a:0},loadOp:"clear" as const,storeOp:"store" as const}))});
        pass.end();return;
      }
      if(stage==="post") { this.tonemap.execute(command,{swapchain:textureView(frame.finalOutput,resources),
        hdr:textureView(frame.stageInputHdr,resources)},{bloom:false,sharpening:false,colorGrading:false},
        {lift:0,gamma:1,gain:1,saturation:1,contrast:1,sharpeningStrength:0,bloomIntensity:0,
          samplers:this.graphics.samplers},undefined,buffer(frame.heap,resources)); return; }
      if(stage==="capture") { this.encodeCapture(command,frame,resources,presentation); return; }
      throw new Error(`MixedBins does not enable candidate stage '${stage}'`);
    };
    const executor=createSparseShadingCandidateExecutor({bins:this.binPass,settingsDynamicOffset:0,
      createBinBindings:(frame,resources)=>this.binPass.createFrameBindingsForExecution({
        shadingBinId:textureView(frame.shadingBinId,resources),settings:buffer(frame.settings,resources),
        settingsDynamicOffset:0,generation:ticket.snapshot.generation,layoutRevision:ticket.snapshot.layoutRevision}),
      resolve:this.resolve,createResolveBindings:(frame,resources)=>this.createResolveBindings(frame,resources),
      executeExternalStage:externalStage});
    const frame=addSparseShadingCandidateToGraph(graph,ticket.snapshot,FEATURES,{meshletWork:ids.meshletWork,
      sceneGeometry:[ids.camera,ids.instances,ids.geometry,ids.meshlets,ids.vertices,ids.triangles,ids.vertexStream,
        ids.assetMetadata,ids.vertexPayload],materials:[ids.visibilityMaterials,ids.shadingMaterials,ids.routes],
      lighting:[ids.lights,ids.clusterHeaders,ids.clusterIndices,ids.lightSettings,ids.environmentSettings],shadows:[],
      presentation:ids.presentation,captureReadback:ids.readback,captureScratch:[ids.oracle],
      captureEncoderWork:{computePasses:1,dispatches:2},
      binResources:{heap:this.binPass.heap,indirectArgs:this.binPass.indirectArgs,settings:this.resources.settings}},executor);
    this.profiler.beginFrame(0); const command=ShadeGPUCommandContext.create(this.graphics,"Renderer/main-0");
    command.recordGraphBuild(); this.profiler.recordGraphCompile(); let compiled;
    try { compiled=graph.compile(); command.encodeCompiledGraph(compiled,undefined);
      command.recordReadback("ADR-0013/MixedBins-capture",READBACK_BYTES); command.finish();
      this.runtime.commitSubmittedFrame(1,ticket.frameId);
    } catch(error) { command.abort(error); this.runtime.abortEncodedFrame(ticket.frameId); this.profiler.endFrame();
      throw new Error(errorChain(error)); }
    const profile=this.profiler.endFrame();
    if(profile===undefined)throw new Error("MixedBins profiler did not publish a frame snapshot");
    assertEqual(profile.submits.count,1,"MixedBins one-main-submit");assertEqual(profile.graph.builds,1,"MixedBins graph builds");
    assertEqual(profile.graph.compiles,1,"MixedBins graph compiles");assertEqual(profile.graph.executes,1,"MixedBins graph executes");
    await this.device.queue.onSubmittedWorkDone();
    this.runtime.completeSubmittedWork(1); await readback.mapAsync(GPUMapMode.READ);
    const bytes=new Uint8Array(readback.getMappedRange().slice(0)); readback.unmap();
    const graphDump=compiled.dump();validateCandidateTopology(graphDump);
    const evidence=Object.freeze({scenario:validateMixedBins(bytes,ticket.snapshot),graph:graphDump,profile,
      lifecycle:this.runtime.evidence(),memory:Object.freeze({plan:frame.plan.memory,live:this.graphics.memoryEvidence(),
        captureBytes:READBACK_BYTES,captureScratchBytes:ORACLE_BYTES}),compilation:this.compilation});
    compiled.destroy(); this.destroyBuffer(readback); this.destroyBuffer(oracle); return evidence;
  }

  resourceCounts():Readonly<Record<string,number>> { return Object.freeze({buffers:this.buffers.size,
    textures:this.textures.size,candidateRuntimeOwners:this.destroyed?0:1,graphicsOwners:this.destroyed?0:1}); }
  destroy():void { if(this.destroyed)return; this.destroyed=true; this.tonemap.destroy(); this.resolve.destroy();
    this.binPass.destroy(); this.runtime.destroy(); this.graphics.destroy();
    for(const value of this.buffers)value.destroy(); for(const value of this.textures)value.destroy();
    this.buffers.clear(); this.textures.clear(); }

  private createResolveBindings(frame:Readonly<SparseShadingCandidateFrame>,resources:PassResources):readonly SparseShadingResolveFrameBinding[] {
    const binding=(name:string):GPUBindingResource=>resolveBinding(name,frame,resources,this.resources,this.binPass);
    return this.resolve.activeBinIds.map((binId)=>{const pipeline=this.resolve.pipelineForBin(binId);
      const groups=pipeline.descriptor.groups.map((group,index)=>this.device.createBindGroup({
        label:`ADR-0013 MixedBins bin ${binId} group ${index}`,layout:pipeline.bindGroupLayouts[index]!,
        entries:group.bindings.map((entry)=>({binding:entry.binding,resource:binding(entry.name)}))}));
      return Object.freeze({binId,groups:Object.freeze(groups)});});
  }
  private encodeCapture(command:ShadeGPUCommandContext,frame:Readonly<SparseShadingCandidateFrame>,
    resources:PassResources,presentation:GPUTexture):void {
    const output=buffer(frame.captureScratch[0]??null,resources); command.clearBuffer(output);
    const validateGroup=this.device.createBindGroup({layout:this.oracleValidate.getBindGroupLayout(0),entries:[
      {binding:0,resource:textureView(frame.visibilityKey,resources)},{binding:1,resource:textureView(frame.shadingBinId,resources)},
      {binding:2,resource:textureView(frame.hdr,resources)},{binding:3,resource:{buffer:output}}]});
    const extractGroup=this.device.createBindGroup({layout:this.oracleExtract.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.binPass.heap}},{binding:1,resource:{buffer:this.binPass.indirectArgs}},
      {binding:2,resource:{buffer:output}}]});
    const pass=command.beginComputePass({label:"ADR-0013 MixedBins capture oracle"});
    pass.setPipeline(this.oracleValidate); pass.setBindGroup(0,validateGroup);
    pass.dispatchWorkgroups(Math.ceil(WIDTH/8),Math.ceil(HEIGHT/8)); pass.setPipeline(this.oracleExtract);
    pass.setBindGroup(0,extractGroup); pass.dispatchWorkgroups(1); pass.end();
    const readback=buffer(frame.captureReadback,resources);
    command.gpu_encoder.copyTextureToBuffer({texture:nativeTexture(resources.get(frame.hdr!))},
      {buffer:readback,offset:HDR_OFFSET,bytesPerRow:HDR_ROW_BYTES,rowsPerImage:HEIGHT},[WIDTH,HEIGHT,1]);
    command.gpu_encoder.copyTextureToBuffer({texture:presentation},
      {buffer:readback,offset:PRESENT_OFFSET,bytesPerRow:PRESENT_ROW_BYTES,rowsPerImage:HEIGHT},[WIDTH,HEIGHT,1]);
    command.copyBufferToBuffer(output,0,readback,ORACLE_OFFSET,ORACLE_BYTES);
  }
  private trackBuffer(value:GPUBuffer):GPUBuffer {this.buffers.add(value);return value;}
  private destroyBuffer(value:GPUBuffer):void {value.destroy();this.buffers.delete(value);}
  private requireAlive():void {if(this.destroyed)throw new Error("Sparse shading candidate fixture is destroyed");}
}

function createResources(device:GPUDevice,buffers:Set<GPUBuffer>,textures:Set<GPUTexture>):CandidateResources {
  const makeBuffer=(label:string,size:number,usage:GPUBufferUsageFlags)=>{const value=device.createBuffer({label,size:Math.max(size,4),usage});buffers.add(value);return value;};
  const makeTexture=(descriptor:GPUTextureDescriptor)=>{const value=device.createTexture(descriptor);textures.add(value);return value;};
  const geometryBytes=GPU_SHADING_PROGRAM_COUNT*GPU_GEOMETRY_RECORD_STRIDE;
  const meshletBytes=GPU_SHADING_PROGRAM_COUNT*GPU_MESHLET_RECORD_STRIDE;
  const vertexIndexBytes=GPU_SHADING_PROGRAM_COUNT*VERTICES_PER_PROGRAM*4;
  const triangleBytes=GPU_SHADING_PROGRAM_COUNT*TRIANGLE_BYTES_PER_PROGRAM;
  const vertexBytes=GPU_SHADING_PROGRAM_COUNT*VERTICES_PER_PROGRAM*VERTEX_STRIDE;
  const textureBanks=Array.from({length:9},(_,index)=>makeTexture({label:`ADR-0013 MixedBins texture bank ${index}`,
    size:[1,1,5],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}));
  const environmentTextures=Array.from({length:3},(_,index)=>makeTexture({label:`ADR-0013 MixedBins environment ${index}`,
    size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}));
  return {
    settings:makeBuffer("ADR-0013 MixedBins bin settings",GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    shadingView:makeBuffer("ADR-0013 MixedBins shading view",256,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    camera:makeBuffer("ADR-0013 MixedBins packed camera",PACKED_CAMERA_TYPE.size,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    queue:makeBuffer("ADR-0013 MixedBins MeshletWork queue",GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE+
      GPU_SHADING_PROGRAM_COUNT*GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    bucketStates:makeBuffer("ADR-0013 MixedBins bucket states",GPU_MESHLET_DRAW_COUNT*GPU_MESHLET_BUCKET_STATE_STRIDE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    drawIndirect:makeBuffer("ADR-0013 MixedBins raster indirect",GPU_MESHLET_DRAW_COUNT*GPU_MESHLET_DRAW_INDIRECT_STRIDE,
      GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST),
    bucketSettings:makeBuffer("ADR-0013 MixedBins bucket settings",GPU_MESHLET_DRAW_COUNT*MESHLET_BUCKET_SETTINGS_STRIDE,
      GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    instances:makeBuffer("ADR-0013 MixedBins instances",GPU_SHADING_PROGRAM_COUNT*GPU_INSTANCE_RECORD_STRIDE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    geometryRecords:makeBuffer("ADR-0013 MixedBins raster geometries",geometryBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    meshletRecords:makeBuffer("ADR-0013 MixedBins raster meshlets",meshletBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    meshletVertexIndices:makeBuffer("ADR-0013 MixedBins raster meshlet vertices",vertexIndexBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    meshletTriangleIndices:makeBuffer("ADR-0013 MixedBins raster meshlet triangles",triangleBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    vertexStreamData:makeBuffer("ADR-0013 MixedBins raster vertex stream",vertexBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    assetMetadata:makeBuffer("ADR-0013 MixedBins resolve asset metadata",geometryBytes+meshletBytes+GPU_SHADING_PROGRAM_COUNT*4,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    vertexPayload:makeBuffer("ADR-0013 MixedBins resolve vertex payload",vertexIndexBytes+triangleBytes+vertexBytes,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    visibilityMaterials:makeBuffer("ADR-0013 MixedBins visibility materials",GPU_SHADING_PROGRAM_COUNT*GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    shadingMaterials:makeBuffer("ADR-0013 MixedBins shading materials",GPU_SHADING_PROGRAM_COUNT*GPU_SHADING_MATERIAL_RECORD_STRIDE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    routes:makeBuffer("ADR-0013 MixedBins texture routes",GPU_SHADING_PROGRAM_COUNT*4*GPU_SHADING_TEXTURE_ROUTE_STRIDE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    textureBanks,textureBankViews:textureBanks.map((value)=>value.createView({dimension:"2d-array"})),
    materialSamplers:Array.from({length:6},()=>device.createSampler({addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge",
      minFilter:"nearest",magFilter:"nearest"})),
    lightDatabase:makeBuffer("ADR-0013 MixedBins light database",128,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    clusterHeaders:makeBuffer("ADR-0013 MixedBins cluster headers",16*16*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    clusterIndices:makeBuffer("ADR-0013 MixedBins cluster indices",4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    lightSettings:makeBuffer("ADR-0013 MixedBins light settings",64,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    environmentSettings:makeBuffer("ADR-0013 MixedBins environment settings",32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    environmentTextures,environmentSampler:device.createSampler({minFilter:"nearest",magFilter:"nearest"})
  };
}

function createPublication(){return {
  materials:Array.from({length:GPU_SHADING_PROGRAM_COUNT},(_,id)=>({id,profile:materialProfile(id),generation:MATERIAL_GENERATION,
    textureGeneration:TEXTURE_GENERATION})),
  geometries:Array.from({length:GPU_SHADING_PROGRAM_COUNT},(_,id)=>({id,profile:geometryProfile(id),generation:GEOMETRY_GENERATION})),
  instances:Array.from({length:GPU_SHADING_PROGRAM_COUNT},(_,id)=>({id,materialId:id,geometryId:id,active:true,transparent:false,
    generation:23}))};}
function materialProfile(programId:number):GpuShadingMaterialProfile {const bits=textureBits(programId);return Object.freeze({
  shadingModel:programId<4?"unlit":"standard-pbr",hasBaseTexture:(bits&1)!==0,hasOrmTexture:(bits&2)!==0,
  hasNormalTexture:(bits&4)!==0,hasEmissiveTexture:(bits&8)!==0,textureBindingSetId:bits===0?0:(programId%3)+1});}
function geometryProfile(programId:number):GpuShadingGeometryProfile {const bits=textureBits(programId);return Object.freeze({
  hasAuthoredVertexColor:programId===1||programId===3,hasUv0:bits!==0,hasNormal:programId>=4,hasTangent:(bits&4)!==0});}
function textureBits(programId:number):number{return [0,0,1,1,0,1,2,3,4,5,6,7,15,9,14,8][programId]??0;}

function uploadStaticInputs(device:GPUDevice,r:CandidateResources,snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>):void {
  device.queue.writeBuffer(r.settings,0,packGpuShadingBinSettings({width:WIDTH,height:HEIGHT,microtilesX:WIDTH/8,
    generation:snapshot.generation,allowedMaskLo:snapshot.summary.activeBinMaskLo,allowedMaskHi:snapshot.summary.activeBinMaskHi,
    maxDispatchDimension:device.limits.maxComputeWorkgroupsPerDimension,layoutRevision:snapshot.layoutRevision}));
  device.queue.writeBuffer(r.camera,0,packedCamera()); device.queue.writeBuffer(r.shadingView,0,shadingView(snapshot));
  const geometry=createGeometryData(); device.queue.writeBuffer(r.geometryRecords,0,geometry.geometryRecords);
  device.queue.writeBuffer(r.meshletRecords,0,geometry.meshletRecords);device.queue.writeBuffer(r.meshletVertexIndices,0,geometry.meshletVertices);
  device.queue.writeBuffer(r.meshletTriangleIndices,0,geometry.meshletTriangles);device.queue.writeBuffer(r.vertexStreamData,0,geometry.vertexStream);
  device.queue.writeBuffer(r.assetMetadata,0,geometry.assetMetadata);device.queue.writeBuffer(r.vertexPayload,0,geometry.vertexPayload);
  device.queue.writeBuffer(r.instances,0,createInstances());device.queue.writeBuffer(r.queue,0,createMeshletQueue(snapshot));
  device.queue.writeBuffer(r.bucketStates,0,createBucketStates());device.queue.writeBuffer(r.drawIndirect,0,createDrawIndirect());
  device.queue.writeBuffer(r.bucketSettings,0,createBucketSettings(device));const materials=createMaterials(snapshot);
  device.queue.writeBuffer(r.visibilityMaterials,0,materials.visibility);device.queue.writeBuffer(r.shadingMaterials,0,materials.shading);
  device.queue.writeBuffer(r.routes,0,materials.routes);
  const bank=new Uint8Array(256*5);bank.set([255,255,255,255],0);bank.set([64,128,191,255],256);
  bank.set([128,128,255,255],512);bank.set([51,179,230,255],768);bank.set([128,64,255,255],1024);
  for(const value of r.textureBanks)device.queue.writeTexture({texture:value},bank,{bytesPerRow:256,rowsPerImage:1},[1,1,5]);
  for(const value of r.environmentTextures)device.queue.writeTexture({texture:value},new Uint8Array([255,255,255,255]),{},[1,1,1]);
  device.queue.writeBuffer(r.lightDatabase,0,packGpuSparseShadingLightDatabase({directional:[{type:GPU_SPARSE_SHADING_LIGHT_TYPE.Directional,
    flags:0,shadowRecord:0,shadowRecordCount:0,position:[0,0,0],range:1,direction:[0,0,1],outerConeCos:0,
    color:[2,1,0.5],intensity:1,radius:0,innerConeCos:0}],local:[],shadowRecords:[]}));
  const lightSettings=new ArrayBuffer(64),ls=new DataView(lightSettings);[16,16,1,0].forEach((value,index)=>ls.setUint32(index*4,value,true));
  ls.setFloat32(16,1,true);ls.setFloat32(20,0,true);ls.setUint32(32,0,true);ls.setUint32(36,1,true);ls.setUint32(40,0,true);
  device.queue.writeBuffer(r.lightSettings,0,lightSettings);device.queue.writeBuffer(r.environmentSettings,0,new Uint32Array(8));
}

function packedCamera():ArrayBuffer {const output=new ArrayBuffer(PACKED_CAMERA_TYPE.size);writeWgslToBuffer({transform:IDENTITY,
  transform_inverse:IDENTITY,view_matrix:IDENTITY,view_matrix_inverse:IDENTITY,projection_matrix:PIXEL_VIEW_PROJECTION,
  projection_matrix_inverse:PIXEL_VIEW_PROJECTION_INVERSE,view_projection_matrix:PIXEL_VIEW_PROJECTION,
  view_projection_matrix_inverse:PIXEL_VIEW_PROJECTION_INVERSE,frustum:Array.from({length:6},()=>new Float32Array(4)),
  device_depth_to_view_space:new Float32Array([0,1,1,1])},PACKED_CAMERA_TYPE,output);return output;}
function shadingView(snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>):ArrayBuffer {
  const geometryWords=GPU_GEOMETRY_RECORD_STRIDE/4,meshletWords=GPU_MESHLET_RECORD_STRIDE/4;
  const vertexWords=GPU_SHADING_PROGRAM_COUNT*VERTICES_PER_PROGRAM;
  const triangleWords=GPU_SHADING_PROGRAM_COUNT*TRIANGLE_BYTES_PER_PROGRAM/4;
  const output=new ArrayBuffer(240),view=new DataView(output);
  [WIDTH,HEIGHT,GPU_SHADING_PROGRAM_COUNT,GPU_SHADING_PROGRAM_COUNT,MATERIAL_GENERATION,TEXTURE_GENERATION,
    GEOMETRY_GENERATION,snapshot.revision,0,GPU_SHADING_PROGRAM_COUNT*geometryWords,
    GPU_SHADING_PROGRAM_COUNT*(geometryWords+meshletWords),0,vertexWords,vertexWords+triangleWords,0,0]
    .forEach((value,index)=>view.setUint32(index*4,value,true));
  view.setFloat32(64,PRE_EXPOSURE,true);view.setFloat32(72,1,true);view.setFloat32(76,1,true);
  [WIDTH/2,HEIGHT/2,100,1].forEach((value,index)=>view.setFloat32(96+index*4,value,true));
  new Float32Array(output,112,16).set(PIXEL_VIEW_PROJECTION);new Float32Array(output,176,16).set(PIXEL_VIEW_PROJECTION);return output;
}

function createGeometryData(){
  const geometryRecords=new Uint8Array(GPU_SHADING_PROGRAM_COUNT*GPU_GEOMETRY_RECORD_STRIDE);
  const meshletRecords=new Uint8Array(GPU_SHADING_PROGRAM_COUNT*GPU_MESHLET_RECORD_STRIDE);
  const meshletVertices=new Uint32Array(GPU_SHADING_PROGRAM_COUNT*VERTICES_PER_PROGRAM);
  const meshletTriangles=new Uint8Array(GPU_SHADING_PROGRAM_COUNT*TRIANGLE_BYTES_PER_PROGRAM);
  const vertexStream=new ArrayBuffer(GPU_SHADING_PROGRAM_COUNT*VERTICES_PER_PROGRAM*VERTEX_STRIDE);
  const vertexFloats=new Float32Array(vertexStream);
  for(let program=0;program<GPU_SHADING_PROGRAM_COUNT;program++){
    const vertexByteBase=program*VERTICES_PER_PROGRAM*VERTEX_STRIDE;
    const vertexIndexBase=program*VERTICES_PER_PROGRAM;
    const triangleByteBase=program*TRIANGLE_BYTES_PER_PROGRAM;
    for(let stripe=0;stripe<STRIPS_PER_PROGRAM;stripe++){
      const x0=program*STRIP_WIDTH+stripe*GPU_SHADING_PROGRAM_COUNT*STRIP_WIDTH,x1=x0+STRIP_WIDTH;
      const vertices=[[x0,0],[x0,HEIGHT],[x1,HEIGHT],[x1,0]];
      for(let corner=0;corner<4;corner++){
        const local=stripe*4+corner;baseVertex(meshletVertices,vertexFloats,vertexIndexBase,vertexByteBase,local,
          vertices[corner]![0]!,vertices[corner]![1]!,corner);
      }
      meshletTriangles.set([stripe*4,stripe*4+3,stripe*4+2,stripe*4,stripe*4+2,stripe*4+1],triangleByteBase+stripe*6);
    }
    geometryRecords.set(packGpuGeometryRecord({boundsSphere:[WIDTH/2,HEIGHT/2,1,181],boundsMin:[0,0,1,0],
      boundsMax:[WIDTH,HEIGHT,1,0],vertexCount:VERTICES_PER_PROGRAM,indexBegin:0,indexCount:TRIANGLES_PER_PROGRAM*3,
      meshletBegin:program,meshletCount:1,clusterBegin:0,clusterRoot:0,clusterCount:0,bvhBegin:0,bvhRoot:0,bvhCount:0,
      materialRangeBegin:0,materialRangeCount:1,streamDescriptorBegin:0,streamDescriptorCount:4,
      vertexDataByteBegin:vertexByteBase,vertexDataByteLength:VERTICES_PER_PROGRAM*VERTEX_STRIDE,
      positionByteOffset:vertexByteBase,positionStride:VERTEX_STRIDE,positionFormat:GPU_POSITION_FORMAT.Float32x3,flags:0,
      uv0ByteOffset:vertexByteBase+12,uv0Stride:VERTEX_STRIDE,uv0Format:GPU_UV_FORMAT.Float32x2,
      uv1ByteOffset:0,uv1Stride:0,uv1Format:0,uv2ByteOffset:0,uv2Stride:0,uv2Format:0,
      normalDescriptor:1,tangentDescriptor:2,colorDescriptor:3,normalByteOffset:vertexByteBase+20,normalStride:VERTEX_STRIDE,
      normalFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,normalNormalized:0,tangentByteOffset:vertexByteBase+36,
      tangentStride:VERTEX_STRIDE,tangentFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,tangentNormalized:0,
      colorByteOffset:vertexByteBase+52,colorStride:VERTEX_STRIDE,colorFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,
      colorNormalized:0}),program*GPU_GEOMETRY_RECORD_STRIDE);
    meshletRecords.set(packGpuMeshletRecords([{vertexOffset:vertexIndexBase,vertexCount:VERTICES_PER_PROGRAM,
      triangleByteOffset:triangleByteBase,triangleCount:TRIANGLES_PER_PROGRAM,materialRangeIndex:0,materialId:program,flags:0,
      boundsMin:[0,0,1,0],boundsMax:[WIDTH,HEIGHT,1,0],boundsSphere:[WIDTH/2,HEIGHT/2,1,181],
      coneApex:[0,0,0,0],coneAxisCutoff:[0,0,1,1]}]),program*GPU_MESHLET_RECORD_STRIDE);
  }
  const assetMetadata=new Uint8Array(geometryRecords.byteLength+meshletRecords.byteLength+GPU_SHADING_PROGRAM_COUNT*4);
  assetMetadata.set(geometryRecords);assetMetadata.set(meshletRecords,geometryRecords.byteLength);
  new Uint32Array(assetMetadata.buffer,geometryRecords.byteLength+meshletRecords.byteLength).fill(GEOMETRY_GENERATION);
  const vertexPayload=new Uint8Array(meshletVertices.byteLength+meshletTriangles.byteLength+vertexStream.byteLength);
  vertexPayload.set(new Uint8Array(meshletVertices.buffer));vertexPayload.set(meshletTriangles,meshletVertices.byteLength);
  vertexPayload.set(new Uint8Array(vertexStream),meshletVertices.byteLength+meshletTriangles.byteLength);
  return {geometryRecords,meshletRecords,meshletVertices,meshletTriangles,vertexStream,assetMetadata,vertexPayload};
}
function baseVertex(indices:Uint32Array,floats:Float32Array,indexBase:number,byteBase:number,local:number,x:number,y:number,corner:number):void{
  indices[indexBase+local]=local;const base=(byteBase+local*VERTEX_STRIDE)/4;floats.set([x,y,1],base);
  floats.set([corner>=2?1:0,corner===1||corner===2?1:0],base+3);floats.set([0,0,1,0],base+5);
  floats.set([1,0,0,1],base+9);floats.set([0.5,0.8,1,1],base+13);
}
function createInstances():Uint8Array {const output=new Uint8Array(GPU_SHADING_PROGRAM_COUNT*GPU_INSTANCE_RECORD_STRIDE);
  for(let program=0;program<GPU_SHADING_PROGRAM_COUNT;program++)output.set(packGpuInstanceRecord({geometryRecordIndex:program,
    materialHandle:program,flags:GPU_MESHLET_RASTER_FLAGS.DoubleSided,debugId:program+1,boundsSphere:[WIDTH/2,HEIGHT/2,1,181],
    boundsMin:[0,0,1],boundsMax:[WIDTH,HEIGHT,1],currentObjectToWorld:IDENTITY,previousObjectToWorld:IDENTITY}),
    program*GPU_INSTANCE_RECORD_STRIDE);return output;}
function createMeshletQueue(snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>):Uint8Array{
  const output=new Uint8Array(GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE+GPU_SHADING_PROGRAM_COUNT*GPU_MESHLET_RASTER_WORK_RECORD_STRIDE);
  output.set(packGpuMeshletWorkQueueHeader({attemptedCount:GPU_SHADING_PROGRAM_COUNT,writtenCount:GPU_SHADING_PROGRAM_COUNT,
    consumedCount:GPU_SHADING_PROGRAM_COUNT,capacity:GPU_SHADING_PROGRAM_COUNT,overflowCount:0,generation:snapshot.generation,
    invalidCount:0}));const byProgram=new Map(snapshot.associations.map((entry)=>[entry.identity.programId,entry]));
  for(let program=0;program<GPU_SHADING_PROGRAM_COUNT;program++){const association=byProgram.get(program);
    if(association===undefined)throw new Error(`Missing MixedBins publication for program ${program}`);
    output.set(packGpuMeshletRasterWork({instanceSlot:program,geometrySlot:program,meshletSlot:program,materialSlotOrRange:program,
      packedRasterFlags:GPU_MESHLET_RASTER_FLAGS.DoubleSided|(association.identity.binId<<8),
      packedProfileLod:packGpuMeshletProfileLodBucket(2,0,BUCKET,0)}),GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE+
      program*GPU_MESHLET_RASTER_WORK_RECORD_STRIDE);}return output;}
function createBucketStates():Uint32Array{const output=new Uint32Array(GPU_MESHLET_DRAW_COUNT*GPU_MESHLET_BUCKET_STATE_STRIDE/4);
  output.set([GPU_SHADING_PROGRAM_COUNT,0,GPU_SHADING_PROGRAM_COUNT,0],BUCKET*4);return output;}
function createDrawIndirect():Uint32Array{const output=new Uint32Array(GPU_MESHLET_DRAW_COUNT*GPU_MESHLET_DRAW_INDIRECT_STRIDE/4);
  output.set([TRIANGLES_PER_PROGRAM*3,GPU_SHADING_PROGRAM_COUNT,0,0],BUCKET*4);return output;}
function createBucketSettings(device:GPUDevice):Uint32Array{const output=new Uint32Array(GPU_MESHLET_DRAW_COUNT*MESHLET_BUCKET_SETTINGS_STRIDE/4);
  for(let bucket=0;bucket<GPU_MESHLET_DRAW_COUNT;bucket++){const base=bucket*MESHLET_BUCKET_SETTINGS_STRIDE/4;output[base]=bucket;
    output[base+1]=device.features.has("indirect-first-instance")?1:0;}return output;}

function createMaterials(snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>){
  const visibility=new Uint8Array(GPU_SHADING_PROGRAM_COUNT*GPU_MATERIAL_VISIBILITY_RECORD_STRIDE);
  const shading=new Uint8Array(GPU_SHADING_PROGRAM_COUNT*GPU_SHADING_MATERIAL_RECORD_STRIDE);
  const routes=new Uint8Array(GPU_SHADING_PROGRAM_COUNT*4*GPU_SHADING_TEXTURE_ROUTE_STRIDE);
  for(let program=0;program<GPU_SHADING_PROGRAM_COUNT;program++){
    const profile=materialProfile(program),specialization=gpuShadingProgramSpecialization(program,0);
    const set=shadingProgramUsesTextures(program)?profile.textureBindingSetId:0;
    const base=specialization.baseTexture==="never"?GPU_TEXTURE_REF_INVALID:encodeGpuTextureRef(0,1);
    const normal=specialization.normalTexture==="never"?GPU_TEXTURE_REF_INVALID:encodeGpuTextureRef(0,2);
    const orm=specialization.ormTexture==="never"?GPU_TEXTURE_REF_INVALID:encodeGpuTextureRef(0,3);
    const emissive=specialization.emissiveTexture==="never"?GPU_TEXTURE_REF_INVALID:encodeGpuTextureRef(0,4);
    let flags=GPU_MATERIAL_VISIBILITY_FLAGS.Valid;if(program<4)flags|=GPU_MATERIAL_VISIBILITY_FLAGS.Unlit;
    if(normal!==GPU_TEXTURE_REF_INVALID)flags|=GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture;
    if(orm!==GPU_TEXTURE_REF_INVALID)flags|=GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture;
    if(emissive!==GPU_TEXTURE_REF_INVALID)flags|=GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture;
    const payload=materialPayload(flags,set,base,normal,orm,emissive);
    visibility.set(new Uint8Array(packGpuMaterialVisibilityRecord(payload)),program*GPU_MATERIAL_VISIBILITY_RECORD_STRIDE);
    shading.set(packGpuShadingMaterialRecord({programId:program,textureBindingSetId:set,materialGeneration:MATERIAL_GENERATION,
      textureGeneration:TEXTURE_GENERATION,publicationRevision:snapshot.revision,flags:0},payload),
      program*GPU_SHADING_MATERIAL_RECORD_STRIDE);
    [base,normal,orm,emissive].forEach((textureRef,slot)=>routes.set(packGpuShadingTextureRoute({textureRef,
      textureGeneration:TEXTURE_GENERATION,publicationRevision:snapshot.revision,textureBindingSetId:set}),
      (program*4+slot)*GPU_SHADING_TEXTURE_ROUTE_STRIDE));
  }return {visibility,shading,routes};
}
function materialPayload(flags:number,set:number,base:number,normal:number,orm:number,emissive:number){return {
  kernelClass:0,alphaMode:0,flags,textureRef:base,baseColorFactorAlpha:1,alphaCutoff:0.5,textureUvSets:0,samplerClass:0,
  uvOffset:[0,0] as const,uvScale:[1,1] as const,rotationCos:1,rotationSin:0,baseColorFactor:[0.8,0.5,0.25,1] as const,
  metallicFactor:0.4,perceptualRoughness:0.6,normalScale:1,occlusionStrength:0.75,emissiveFactor:[0.1,0.2,0.3,1] as const,
  normalTextureRef:normal,ormTextureRef:orm,emissiveTextureRef:emissive,textureSamplerClasses:0,
  normalUvOffset:[0,0] as const,normalUvScale:[1,1] as const,normalRotationCos:1,normalRotationSin:0,
  ormUvOffset:[0,0] as const,ormUvScale:[1,1] as const,ormRotationCos:1,ormRotationSin:0,
  emissiveUvOffset:[0,0] as const,emissiveUvScale:[1,1] as const,emissiveRotationCos:1,emissiveRotationSin:0,
  textureBindingSetId:set};}

function createPrepared(r:CandidateResources):PreparedMeshletWorkCandidate {
  return Object.freeze({queue:r.queue,bucketStates:r.bucketStates,drawIndirect:r.drawIndirect,
    bucketSettings:r.bucketSettings,bucketCount:GPU_MESHLET_DRAW_COUNT,compactionPath:"portable",capacity:GPU_SHADING_PROGRAM_COUNT
  }) as PreparedMeshletWorkCandidate;
}

function createAssetBindings(r:CandidateResources):GpuAssetBindings {
  const zero={geometryRecords:GPU_SHADING_PROGRAM_COUNT,meshletRecords:GPU_SHADING_PROGRAM_COUNT,clusterRecords:0,
    bvh8Nodes:0,vertexStreamDescriptors:0,materialRanges:0,vertexStreamBytes:r.vertexStreamData.size,indices:0,
    meshletVertexIndices:GPU_SHADING_PROGRAM_COUNT*VERTICES_PER_PROGRAM,
    meshletTriangleBytes:GPU_SHADING_PROGRAM_COUNT*TRIANGLE_BYTES_PER_PROGRAM,clusterChildren:0};
  return Object.freeze({abiVersion:1,epoch:1,geometryRecords:r.geometryRecords,meshletRecords:r.meshletRecords,
    clusterRecords:r.geometryRecords,bvh8Nodes:r.geometryRecords,vertexStreamDescriptors:r.geometryRecords,
    materialRanges:r.geometryRecords,vertexStreamData:r.vertexStreamData,indices:r.meshletVertexIndices,
    meshletVertexIndices:r.meshletVertexIndices,meshletTriangleIndices:r.meshletTriangleIndices,
    clusterChildren:r.meshletVertexIndices,highWaterCounts:Object.freeze(zero)});
}

function createSceneBindings(r:CandidateResources):GpuSceneBindings {
  return Object.freeze({abiVersion:1,resourceEpoch:1,contentRevision:1,instances:r.instances,
    recordStride:GPU_INSTANCE_RECORD_STRIDE,highWaterCount:GPU_SHADING_PROGRAM_COUNT,activeCount:GPU_SHADING_PROGRAM_COUNT});
}

function createRenderWorld(r:CandidateResources):GpuRenderWorldRuntime {
  const banks=r.textureBankViews as [GPUTextureView,GPUTextureView,GPUTextureView,GPUTextureView,GPUTextureView,
    GPUTextureView,GPUTextureView,GPUTextureView,GPUTextureView];
  return Object.freeze({handle:{},scene:{},sourceKind:"packed",assetHandles:[],instanceHandle:{},materials:[],opaqueMaterialCount:16,
    materialSlots:Array.from({length:16},(_,index)=>index),materialResources:Object.freeze({abiVersion:1,materialCapacity:16,
      materialRecords:r.visibilityMaterials,textureCapacity:5,bindingSets:Object.freeze([{id:0,generation:TEXTURE_GENERATION,
        textureBanks:banks,bankDescriptors:Object.freeze([])}])}),instanceBegin:0,instanceCount:16,transparentInstanceCount:0,
    activeKernelMask:1,activeKernelMasksByBindingSet:Object.freeze([1]),hierarchyTraversalCapacity:16,
    hierarchyVisibleClusterCapacity:16,hierarchyRasterWorkCapacity:16,counterSink:r.queue}) as unknown as GpuRenderWorldRuntime;
}

function resolveBinding(name:string,frame:Readonly<SparseShadingCandidateFrame>,resources:PassResources,r:CandidateResources,
  bins:ShadingBinPass):GPUBindingResource {
  const buffers:Readonly<Record<string,GPUBuffer>>={shading_bin_settings:r.settings,shading_bin_heap:bins.heap,
    shading_view:r.shadingView,meshlet_work:r.queue,instance_records:r.instances,asset_metadata_heap:r.assetMetadata,
    vertex_payload_heap:r.vertexPayload,material_records:r.shadingMaterials,texture_descriptor_routing_heap:r.routes,
    light_database:r.lightDatabase,light_cluster_headers:r.clusterHeaders,light_cluster_indices:r.clusterIndices,
    light_settings:r.lightSettings,environment_settings:r.environmentSettings};
  const direct=buffers[name];if(direct!==undefined)return {buffer:direct};
  if(name==="shading_bin_id")return textureView(frame.shadingBinId,resources);
  if(name==="visibility_key")return textureView(frame.visibilityKey,resources);
  if(name==="visibility_depth")return textureView(frame.depth,resources,{aspect:"depth-only"});
  if(name==="output_hdr")return textureView(frame.hdr,resources);
  if(name.startsWith("material_texture_"))return r.textureBankViews[Number(name.slice(-1))]!;
  if(name.startsWith("material_sampler_"))return r.materialSamplers[Number(name.slice(-1))]!;
  if(name.startsWith("environment_texture_"))return r.environmentTextures[Number(name.slice(-1))]!.createView();
  if(name==="environment_sampler")return r.environmentSampler;
  if(name==="shadow_atlas"||name==="shadow_sampler")throw new Error("Shadow-off MixedBins pipeline declared a shadow binding");
  throw new Error(`Missing ADR-0013 MixedBins binding '${name}'`);
}

const CLUSTER_PIPELINE_DESCRIPTOR={label:"ADR-0013 MixedBins exact empty local-light clusters",layout:{label:"ADR-0013 MixedBins cluster layout",
  bindGroupLayouts:[{label:"ADR-0013 MixedBins cluster group0",entries:[
    {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage" as const}},
    {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage" as const}}]}]},compute:{entryPoint:"main",
    module:{label:"ADR-0013 MixedBins empty cluster producer",code:`
struct ClusterHeader { offset:u32, count:u32, overflow_count:u32, reserved:u32 }
@group(0) @binding(0) var<storage,read_write> headers:array<ClusterHeader>;
@group(0) @binding(1) var<storage,read_write> indices:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x<256u){headers[id.x]=ClusterHeader(0u,0u,0u,0u);}if(id.x==0u){indices[0]=0xffffffffu;}
}`}}} as const;
function clusterPipelineDescriptor(){return CLUSTER_PIPELINE_DESCRIPTOR;}

async function createOraclePipelines(device:GPUDevice,binIds:readonly number[]) {
  if(binIds.length!==GPU_SHADING_PROGRAM_COUNT)throw new Error("MixedBins requires all sixteen shading programs");
  const bins=binIds.map((value)=>`${value}u`).join(",");
  const validateModule=device.createShaderModule({label:"ADR-0013 MixedBins visibility/HDR oracle",code:`
const WIDTH:u32=${WIDTH}u; const HEIGHT:u32=${HEIGHT}u;
const BINS:array<u32,${GPU_SHADING_PROGRAM_COUNT}>=array<u32,${GPU_SHADING_PROGRAM_COUNT}>(${bins});
@group(0) @binding(0) var visibility:texture_2d<u32>;
@group(0) @binding(1) var bin_ids:texture_2d<u32>;
@group(0) @binding(2) var hdr:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> output:array<atomic<u32>>;
@compute @workgroup_size(8,8) fn validate(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=WIDTH||id.y>=HEIGHT){return;} atomicAdd(&output[0],1u);
  let program=(id.x/2u)%${GPU_SHADING_PROGRAM_COUNT}u; let key=textureLoad(visibility,vec2u(id.xy),0).x;
  let bin_id=textureLoad(bin_ids,vec2u(id.xy),0).x; let color=textureLoad(hdr,vec2u(id.xy),0);
  if(key==0xffffffffu){atomicAdd(&output[1],1u);} if((key&0x00ffffffu)!=program){atomicAdd(&output[2],1u);}
  if(bin_id!=BINS[program]){atomicAdd(&output[3],1u);} if((key>>24u)>=${TRIANGLES_PER_PROGRAM}u){atomicAdd(&output[4],1u);}
  if(any(color!=color)||any(abs(color)>vec4f(65504.0))){atomicAdd(&output[5],1u);}
  if(abs(color.a-1.0)>0.001){atomicAdd(&output[6],1u);}
}`});
  const extractModule=device.createShaderModule({label:"ADR-0013 MixedBins bin heap/args oracle",code:`
@group(0) @binding(0) var<storage,read> heap:array<u32>;
@group(0) @binding(1) var<storage,read> args:array<u32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(256) fn extract(@builtin(local_invocation_id) id:vec3u){
  if(id.x<256u){output[16u+id.x]=heap[id.x];}
  if(id.x<8u){output[272u+id.x]=heap[256u+id.x];}
  if(id.x<192u){output[280u+id.x]=args[id.x];}
}`});
  const [validateInfo,extractInfo]=await Promise.all([validateModule.getCompilationInfo(),extractModule.getCompilationInfo()]);
  assertNoCompilationErrors(validateInfo,"MixedBins validate oracle");assertNoCompilationErrors(extractInfo,"MixedBins extract oracle");
  const textureEntries:GPUBindGroupLayoutEntry[]=[
    {binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"uint"}},
    {binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"uint"}},
    {binding:2,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"unfilterable-float"}},
    {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}];
  const validateLayout=device.createBindGroupLayout({label:"ADR-0013 MixedBins validate oracle layout",entries:textureEntries});
  const storageEntries:GPUBindGroupLayoutEntry[]=[
    {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},
    {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},
    {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}];
  const extractLayout=device.createBindGroupLayout({label:"ADR-0013 MixedBins extract oracle layout",entries:storageEntries});
  const [validate,extract]=await Promise.all([
    device.createComputePipelineAsync({label:"ADR-0013 MixedBins validate oracle",layout:device.createPipelineLayout({bindGroupLayouts:[validateLayout]}),
      compute:{module:validateModule,entryPoint:"validate"}}),
    device.createComputePipelineAsync({label:"ADR-0013 MixedBins extract oracle",layout:device.createPipelineLayout({bindGroupLayouts:[extractLayout]}),
      compute:{module:extractModule,entryPoint:"extract"}})]);
  return Object.freeze({validate,extract,messages:Object.freeze({validate:compilationMessages(validateInfo),extract:compilationMessages(extractInfo)})});
}

function validateMixedBins(bytes:Uint8Array,snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>):Readonly<Record<string,unknown>> {
  if(bytes.byteLength!==READBACK_BYTES)throw new Error(`MixedBins readback length ${bytes.byteLength} != ${READBACK_BYTES}`);
  const oracle=new Uint32Array(bytes.buffer,bytes.byteOffset+ORACLE_OFFSET,ORACLE_WORDS);
  assertEqual(oracle[0],PIXELS,"MixedBins oracle pixel count");
  ["invalid visibility key","work-slot routing","ShadingBinId routing","primitive range","finite HDR","HDR alpha"]
    .forEach((label,index)=>assertEqual(oracle[index+1],0,`MixedBins ${label}`));
  const control=oracle.subarray(16,24),counters=oracle.subarray(24,280),args=oracle.subarray(280,472);
  assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.frameFlags/4],0,"MixedBins bin frame flags");
  assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.errorCount/4],0,"MixedBins bin error count");
  assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.finalizedGeneration/4],snapshot.generation,"MixedBins finalized generation");
  assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.layoutRevision/4],snapshot.layoutRevision,"MixedBins finalized layout revision");
  const byProgram=new Map(snapshot.associations.map((entry)=>[entry.identity.programId,entry.identity.binId]));
  const activeBins=new Set<number>(),perBin:Record<string,Readonly<Record<string,number>>>={};let attemptedTotal=0,writtenTotal=0;
  for(let program=0;program<GPU_SHADING_PROGRAM_COUNT;program++){
    const binId=byProgram.get(program);if(binId===undefined)throw new Error(`MixedBins missing program ${program} association`);
    activeBins.add(binId);const counterBase=binId*GPU_SHADING_BIN_COUNTER_STRIDE/4;
    const attempted=counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.attemptedCount/4]!;
    const written=counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.writtenCount/4]!;
    const overflow=counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.overflowCount/4]!;
    const flags=counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.flags/4]!;
    assertEqual(attempted,256,`MixedBins bin ${binId} attempted`);assertEqual(written,256,`MixedBins bin ${binId} written`);
    assertEqual(overflow,0,`MixedBins bin ${binId} overflow`);assertEqual(flags,0,`MixedBins bin ${binId} flags`);
    assertArray(Array.from(args.subarray(binId*3,binId*3+3)),[256,1,1],`MixedBins bin ${binId} indirect args`);
    attemptedTotal+=attempted;writtenTotal+=written;perBin[String(binId)]=Object.freeze({program,attempted,written,overflow,flags,
      dispatchX:args[binId*3]!});
  }
  let inactiveDispatchXNonZero=0;for(let binId=0;binId<64;binId++)if(!activeBins.has(binId)){
    const dispatch=Array.from(args.subarray(binId*3,binId*3+3));if(dispatch[0]!==0)inactiveDispatchXNonZero++;
    assertArray(dispatch,[0,1,1],`MixedBins inactive bin ${binId} indirect args`);
  }
  assertEqual(attemptedTotal,4096,"MixedBins total attempted records");assertEqual(writtenTotal,4096,"MixedBins total written records");
  const hdr=decodeHalfTexture(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES));let maxHdrError=0;
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++){
    const program=Math.floor(x/STRIP_WIDTH)%GPU_SHADING_PROGRAM_COUNT;
    const viewDirection=normalize([WIDTH/2-(x+0.5),HEIGHT/2-(y+0.5),99]);
    const expected=evaluateGpuShadingProgramReference({programId:program,outputDependencyMask:0,material:{
      baseColorFactor:[0.8,0.5,0.25],metallicFactor:0.4,roughnessFactor:0.6,normalScale:1,occlusionStrength:0.75,
      emissiveFactor:[0.1,0.2,0.3],vertexColor:[0.5,0.8,1],baseSample:BASE_SAMPLE,ormSample:ORM_SAMPLE,
      normalSample:NORMAL_SAMPLE,emissiveSample:EMISSIVE_SAMPLE,shadingNormal:[0,0,1],geometricNormal:[0,0,1],
      tangent:[1,0,0,1]},viewDirection,directLights:[{direction:[0,0,1],radiance:[2,1,0.5],visibility:1}],
      preExposure:PRE_EXPOSURE,gradientValid:true});
    const pixel=(y*WIDTH+x)*4;for(let component=0;component<3;component++)maxHdrError=Math.max(maxHdrError,
      Math.abs(hdr[pixel+component]!-expected.radiance[component]!));
    maxHdrError=Math.max(maxHdrError,Math.abs(hdr[pixel+3]!-1));
  }
  assertAtMost(maxHdrError,0.03,"MixedBins HDR reference error");
  const presentation=bytes.subarray(PRESENT_OFFSET,PRESENT_OFFSET+PRESENT_BYTES);let nonBlack=0,opaque=0,diagnosticMagenta=0;
  const presentationColors=new Set<number>();
  for(let pixel=0;pixel<PIXELS;pixel++){const offset=pixel*4;if((presentation[offset]??0)+(presentation[offset+1]??0)+
      (presentation[offset+2]??0)>0)nonBlack++;if(presentation[offset+3]===255)opaque++;
    if(presentation[offset]!>=250&&presentation[offset+1]!<=5&&presentation[offset+2]!>=250)diagnosticMagenta++;
    presentationColors.add(presentation[offset]!|(presentation[offset+1]!<<8)|(presentation[offset+2]!<<16));}
  if(nonBlack<Math.floor(PIXELS*0.9))throw new Error(`MixedBins presentation only covered ${nonBlack}/${PIXELS} pixels`);
  assertEqual(opaque,PIXELS,"MixedBins presentation opaque pixels");assertEqual(diagnosticMagenta,0,"MixedBins diagnostic-magenta pixels");
  if(presentationColors.size<8)throw new Error(`MixedBins presentation produced only ${presentationColors.size} distinct RGB values`);
  return Object.freeze({name:"MixedBins",passed:true,dimensions:[WIDTH,HEIGHT],programCount:GPU_SHADING_PROGRAM_COUNT,
    activeBinCount:activeBins.size,microtileRecords:{attempted:attemptedTotal,written:writtenTotal,overflow:0,
      expectedPerProgram:256},inactiveBins:{count:64-activeBins.size,dispatchXNonZero:inactiveDispatchXNonZero},
    visibility:{pixels:oracle[0],invalidKeys:oracle[1],workSlotMismatches:oracle[2],binMismatches:oracle[3],
      primitiveRangeErrors:oracle[4]},hdr:{maxReferenceError:maxHdrError,nonFinite:oracle[5],alphaErrors:oracle[6],
      fnv1a32:fnv1a32(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES))},presentation:{nonBlackPixels:nonBlack,opaquePixels:opaque,
      diagnosticMagentaPixels:diagnosticMagenta,distinctRgbValues:presentationColors.size,fnv1a32:fnv1a32(presentation)},
    perBin:Object.freeze(perBin)});
}

function validateCandidateTopology(value:unknown):void {
  const dump=value as {readonly passes:readonly {readonly id:number;readonly name:string;readonly culled:boolean;
    readonly dependencies:readonly number[]}[];readonly resources:readonly {readonly name:string}[]};
  const byName=new Map(dump.passes.map((pass)=>[pass.name,pass])),requirePass=(name:string)=>{const pass=byName.get(name);
    if(pass===undefined||pass.culled)throw new Error(`MixedBins required live pass '${name}'`);return pass;};
  const visibility=requirePass("SparseShading/visibility MRT"),lighting=requirePass("SparseShading/light cluster producer");
  const classifier=requirePass("SparseShading/clear + classify"),finalizer=requirePass("SparseShading/finalize indirect");
  const outputClear=requirePass("SparseShading/clear sparse outputs");
  const resolve=requirePass("SparseShading/active-bin indirect resolve"),post=requirePass("SparseShading/downstream/post");
  const capture=requirePass("SparseShading/validation capture boundary");
  requireDependency(classifier,visibility,"visibility -> classifier");requireDependency(finalizer,classifier,"classifier -> finalizer");
  requireDependency(outputClear,finalizer,"finalizer -> output clear");requireDependency(resolve,outputClear,"output clear -> resolve");
  requireDependency(resolve,lighting,"lighting -> resolve");
  requireDependency(post,resolve,"resolve -> post");requireDependency(capture,post,"post -> capture");
  const passNames=dump.passes.filter((pass)=>!pass.culled).map((pass)=>pass.name).join("\n");
  for(const forbidden of ["shadow producer","diagnostics finalize","diagnostics async copy","downstream/gtao","downstream/ssgi",
    "downstream/ssr","downstream/temporal"])if(passNames.includes(forbidden))throw new Error(`MixedBins feature-off pass '${forbidden}' is live`);
  const resourceNames=dump.resources.map((resource)=>resource.name);
  for(const forbidden of ["sparse-shading/normal","sparse-shading/albedo-ao","sparse-shading/material","sparse-shading/velocity",
    "sparse-shading/claims","sparse-shading/diagnostics","sparse-shading/diagnostics-readback"])
    if(resourceNames.includes(forbidden))throw new Error(`MixedBins feature-off resource '${forbidden}' exists`);
}
function requireDependency(consumer:{readonly dependencies:readonly number[]},producer:{readonly id:number},label:string):void {
  if(!consumer.dependencies.includes(producer.id))throw new Error(`MixedBins missing explicit ${label} dependency`);
}

function decodeHalfTexture(bytes:Uint8Array):Float32Array {const output=new Float32Array(PIXELS*4),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++)for(let component=0;component<4;component++)output[(y*WIDTH+x)*4+component]=
    halfToFloat(view.getUint16(y*HDR_ROW_BYTES+(x*4+component)*2,true));return output;}
function halfToFloat(value:number):number {const sign=(value&0x8000)?-1:1,exponent=(value>>10)&31,fraction=value&1023;
  if(exponent===0)return sign*Math.pow(2,-14)*(fraction/1024);if(exponent===31)return fraction?NaN:sign*Infinity;
  return sign*Math.pow(2,exponent-15)*(1+fraction/1024);}
function normalize(value:Vec3):Vec3 {const length=Math.hypot(...value);return [value[0]/length,value[1]/length,value[2]/length];}
function fnv1a32(bytes:ArrayLike<number>):string {let hash=0x811c9dc5;for(let index=0;index<bytes.length;index++){
  hash^=bytes[index]!;hash=Math.imul(hash,0x01000193)>>>0;}return hash.toString(16).padStart(8,"0");}
function compilationMessages(info:GPUCompilationInfo):readonly Readonly<Record<string,unknown>>[]{return Object.freeze(info.messages.map((message)=>
  Object.freeze({type:message.type,message:message.message,lineNum:message.lineNum,linePos:message.linePos})));}
function assertNoCompilationErrors(info:GPUCompilationInfo,label:string):void {const errors=info.messages.filter((message)=>message.type==="error");
  if(errors.length>0)throw new Error(`${label}: ${errors.map((error)=>error.message).join("; ")}`);}
function assertEqual(actual:unknown,expected:unknown,label:string):void {if(actual!==expected)throw new Error(`${label}: expected ${expected}, actual ${actual}`);}
function assertArray(actual:readonly number[],expected:readonly number[],label:string):void {if(actual.length!==expected.length||
  actual.some((value,index)=>value!==expected[index]))throw new Error(`${label}: expected ${expected.join(",")}, actual ${actual.join(",")}`);}
function assertAtMost(actual:number,limit:number,label:string):void {if(!Number.isFinite(actual)||actual>limit)throw new Error(`${label}: ${actual} exceeds ${limit}`);}

function textureView(id:SparseShadingCandidateFrame[keyof SparseShadingCandidateFrame],resources:PassResources,
  descriptor?:GPUTextureViewDescriptor):GPUTextureView {if(id===null||typeof id!=="number")throw new Error("Missing MixedBins texture resource id");
  return resolveTextureView(resources.get(id as never) as GPUTexture|GPUTextureView,descriptor);}
function buffer(id:SparseShadingCandidateFrame[keyof SparseShadingCandidateFrame],resources:PassResources):GPUBuffer {if(id===null||typeof id!=="number")
  throw new Error("Missing MixedBins buffer resource id");const value=resources.get(id as never);if(value===null||typeof value!=="object")
  throw new Error("MixedBins buffer resource did not resolve");return value as GPUBuffer;}
function nativeTexture(value:unknown):GPUTexture {if(value!==null&&typeof value==="object"&&"isGPUTextureContext" in value){
  const texture=(value as unknown as {readonly gpu_texture:GPUTexture}).gpu_texture;if(texture!==undefined)return texture;}
  return value as GPUTexture;}
function requireCommand(value:unknown):ShadeGPUCommandContext {if(value instanceof ShadeGPUCommandContext)return value;
  throw new Error("MixedBins requires ShadeGPUCommandContext execution");}
function errorChain(value:unknown):string {const messages:string[]=[];let cursor:unknown=value;while(cursor instanceof Error){
  messages.push(cursor.message);cursor=(cursor as Error&{readonly cause?:unknown}).cause;}if(cursor!==undefined)messages.push(String(cursor));
  return messages.join(" <- ");}
