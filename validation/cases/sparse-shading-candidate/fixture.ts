import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../../../../OEngine/src/assets/GeometryAssetPackage.js";
import { PerspectiveCamera } from "../../../../OEngine/src/camera/PerspectiveCamera.js";
import { OrthographicCamera } from "../../../../OEngine/src/camera/OrthographicCamera.js";
import { mat4Invert } from "../../../../OEngine/src/core/math/Mat4.js";
import { writeWgslToBuffer } from "../../../../OEngine/src/core/WgslBufferIO.js";
import { FrameProfiler } from "../../../../OEngine/src/debug/FrameProfiler.js";
import { FrameGraph, type FrameGraphContext, type PassResources } from "../../../../OEngine/src/framegraph/FrameGraph.js";
import type { ResourceId } from "../../../../OEngine/src/framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../../../OEngine/src/framegraph/ShadeGPUCommandContext.js";
import { GPU_GEOMETRY_RECORD_STRIDE, GPU_GEOMETRY_RECORD_WGSL, GPU_GEOMETRY_VERTEX_DECODE_WGSL,
  GPU_MESHLET_RECORD_STRIDE, GPU_MESHLET_RECORD_WGSL, GPU_POSITION_FORMAT,
  GPU_UV_FORMAT, packGpuGeometryRecord, packGpuMeshletRecords } from "../../../../OEngine/src/gpu/GpuGeometryAbi.js";
import { GraphicsContext } from "../../../../OEngine/src/gpu/GraphicsContext.js";
import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_STRIDE, GPU_INSTANCE_RECORD_WGSL,
  packGpuInstanceRecord } from "../../../../OEngine/src/gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_FLAGS } from "../../../../OEngine/src/gpu/GpuMaterialVisibilityAbi.js";
import { GPU_MESHLET_BUCKET_STATE_STRIDE, GPU_MESHLET_DRAW_COUNT, GPU_MESHLET_DRAW_INDIRECT_STRIDE,
  GPU_MESHLET_RASTER_FLAGS, GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_RASTER_WORK_WGSL, GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE, packGpuMeshletProfileLodBucket,
  packGpuMeshletRasterWork, packGpuMeshletWorkQueueHeader } from "../../../../OEngine/src/gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_BIN_CONTROL_OFFSETS, GPU_SHADING_BIN_COUNTER_OFFSETS,
  GPU_SHADING_BIN_COUNTER_STRIDE, GPU_SHADING_BIN_INVALID_ID } from "../../../../OEngine/src/gpu/GpuShadingBinAbi.js";
import { GPU_SHADING_MATERIAL_RECORD_STRIDE, GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL, GPU_SHADING_TEXTURE_ROUTE_STRIDE,
  packGpuShadingMaterialRecord, packGpuShadingTextureRoute } from "../../../../OEngine/src/gpu/GpuShadingMaterialAbi.js";
import { GpuShadingPublicationStore } from "../../../../OEngine/src/gpu/GpuShadingPublicationPlan.js";
import { GPU_SHADING_PROGRAM_COUNT, shadingProgramUsesTextures,
  type GpuShadingGeometryProfile, type GpuShadingMaterialProfile } from "../../../../OEngine/src/gpu/GpuShadingProgramAbi.js";
import { evaluateGpuShadingProgramReference, gpuShadingProgramSpecialization,
  type Vec3 } from "../../../../OEngine/src/gpu/GpuShadingProgramOracle.js";
import type { GpuSparseShadingCapabilityRecord } from "../../../../OEngine/src/gpu/GpuSparseShadingCapability.js";
import { GPU_SHADING_OUTPUT_DEPENDENCY } from "../../../../OEngine/src/gpu/GpuSparseShadingPipelineContract.js";
import { packGpuSparseShadingView } from "../../../../OEngine/src/gpu/GpuSparseShadingFrameAbi.js";
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
import { SparseShadingGpuRevisionOwner,
  type SparseShadingGpuRevision } from "../../../../OEngine/src/render/pipeline/SparseShadingGpuRevision.js";
import { SparseShadingCandidateRuntime } from "../../../../OEngine/src/render/pipeline/SparseShadingCandidateRuntime.js";
import { ShadingBinPass } from "../../../../OEngine/src/render/passes/ShadingBinPass.js";
import { SparseShadingResolvePass, type SparseShadingResolveFrameBinding } from "../../../../OEngine/src/render/passes/SparseShadingResolvePass.js";
import { TonemapPass } from "../../../../OEngine/src/render/passes/TonemapPass.js";
import { BRICK4_LIGHT_MAP_MIN_BINDING_BYTES } from "../../../../OEngine/src/gpu/Brick4LightMap.js";
import { GPU_COUNTER_BYTE_SIZE } from "../../../../OEngine/src/debug/GpuFrameCounters.js";
import { PACKED_CAMERA_TYPE } from "../../../../OEngine/src/shaders/packed_camera.js";
import { MESHLET_BUCKET_SETTINGS_STRIDE } from "../../../../OEngine/src/shaders/meshlet_bucket_visibility.js";
import { RenderingLabDownstream, type RenderingLabDownstreamResources } from "./renderingLabDownstream.ts";
import { packNativeLightDatabaseFixture } from "../../fixtures/native-light-database.js";

const WIDTH = 256, HEIGHT = 256, PIXELS = WIDTH * HEIGHT;
const STRIP_WIDTH = 2, STRIPS_PER_PROGRAM = WIDTH / (GPU_SHADING_PROGRAM_COUNT * STRIP_WIDTH);
const VERTICES_PER_PROGRAM = STRIPS_PER_PROGRAM * 4, TRIANGLES_PER_PROGRAM = STRIPS_PER_PROGRAM * 2;
const VERTEX_STRIDE = 68, TRIANGLE_BYTES_PER_PROGRAM = TRIANGLES_PER_PROGRAM * 3;
const MATERIAL_GENERATION = 13, TEXTURE_GENERATION = 17, GEOMETRY_GENERATION = 19;
const PRE_EXPOSURE = 2, HDR_ROW_BYTES = WIDTH * 8, PRESENT_ROW_BYTES = WIDTH * 4;
const HDR_BYTES = HDR_ROW_BYTES * HEIGHT, PRESENT_BYTES = PRESENT_ROW_BYTES * HEIGHT;
const VISIBILITY_ROW_BYTES = WIDTH * 4, VISIBILITY_BYTES = VISIBILITY_ROW_BYTES * HEIGHT;
const BIN_ROW_BYTES = WIDTH, BIN_BYTES = BIN_ROW_BYTES * HEIGHT;
const ORACLE_WORDS = 16 + 8 + 64 * 4 + 64 * 3, ORACLE_BYTES = ORACLE_WORDS * 4;
const HDR_OFFSET = 0, PRESENT_OFFSET = HDR_BYTES, VISIBILITY_OFFSET = PRESENT_OFFSET + PRESENT_BYTES;
const BIN_OFFSET = VISIBILITY_OFFSET + VISIBILITY_BYTES, ORACLE_OFFSET = BIN_OFFSET + BIN_BYTES;
const SHADOW_SIZE=256,SHADOW_ROW_BYTES=SHADOW_SIZE*4,SHADOW_BYTES=SHADOW_ROW_BYTES*SHADOW_SIZE;
const SHADOW_OFFSET=ORACLE_OFFSET+ORACLE_BYTES,READBACK_BYTES = SHADOW_OFFSET + SHADOW_BYTES, BUCKET = 12;
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
const RENDERING_LAB_FEATURES=Object.freeze({screenSpaceDiffuseMode:"ssgi" as const,ssr:true,temporal:true,
  shadows:true,post:true,diagnostics:false});
const NATIVE_LIGHT_DATABASE_MAX_BYTES=packNativeLightDatabaseFixture({directional:[{
  direction:[0,0,-1],color:[1,1,1],disk_radius:0,flags:1,near_clip_distance:0.1,shadow_id:0
}],shadowDirectional:[Array.from({length:3},()=>({atlas:[0,0,SHADOW_SIZE,SHADOW_SIZE],projection:IDENTITY}))]}).byteLength;

export type SparseCandidateWorkload = "mixed-bins"|"basic-cube"|"unlit-vertex-color"|"unlit-texture"|
  "rendering-lab-fixed"|"lifecycle-resize";

interface WorkloadLayout {
  readonly geometryCount:number; readonly meshletCount:number; readonly vertexCount:number;
  readonly triangleBytes:number; readonly instanceCount:number; readonly workCount:number;
  readonly materialCount:number;
}

const MIXED_LAYOUT:WorkloadLayout=Object.freeze({geometryCount:GPU_SHADING_PROGRAM_COUNT,
  meshletCount:GPU_SHADING_PROGRAM_COUNT,vertexCount:GPU_SHADING_PROGRAM_COUNT*VERTICES_PER_PROGRAM,
  triangleBytes:GPU_SHADING_PROGRAM_COUNT*TRIANGLE_BYTES_PER_PROGRAM,instanceCount:GPU_SHADING_PROGRAM_COUNT,
  workCount:GPU_SHADING_PROGRAM_COUNT,materialCount:GPU_SHADING_PROGRAM_COUNT});
const CUBE_VERTEX_COUNT=8,CUBE_TRIANGLE_COUNT=12;
const CUBE_LAYOUT:WorkloadLayout=Object.freeze({geometryCount:1,meshletCount:1,vertexCount:CUBE_VERTEX_COUNT,
  triangleBytes:CUBE_TRIANGLE_COUNT*3,instanceCount:1,workCount:1,materialCount:1});
const VERTEX_COLOR_VERTEX_COUNT=4,VERTEX_COLOR_TRIANGLE_COUNT=2;
const VERTEX_COLOR_LAYOUT:WorkloadLayout=Object.freeze({geometryCount:1,meshletCount:1,vertexCount:VERTEX_COLOR_VERTEX_COUNT,
  triangleBytes:8,instanceCount:1,workCount:1,materialCount:1});
const RENDERING_LAB_PROGRAMS=Object.freeze([0,2,4,12] as const);
const RENDERING_LAB_LAYOUT:WorkloadLayout=Object.freeze({geometryCount:RENDERING_LAB_PROGRAMS.length,
  meshletCount:RENDERING_LAB_PROGRAMS.length,vertexCount:RENDERING_LAB_PROGRAMS.length*CUBE_VERTEX_COUNT,
  triangleBytes:RENDERING_LAB_PROGRAMS.length*CUBE_TRIANGLE_COUNT*3,instanceCount:RENDERING_LAB_PROGRAMS.length,
  workCount:RENDERING_LAB_PROGRAMS.length,materialCount:RENDERING_LAB_PROGRAMS.length});
const CUBE_NEAR_DISTANCE=4,CUBE_FAR_DISTANCE=8,CUBE_FOV_DEGREES=60;

function workloadLayout(workload:SparseCandidateWorkload):WorkloadLayout {
  if(workload==="mixed-bins")return MIXED_LAYOUT;
  if(workload==="rendering-lab-fixed")return RENDERING_LAB_LAYOUT;
  return workload==="basic-cube"||workload==="lifecycle-resize"?CUBE_LAYOUT:VERTEX_COLOR_LAYOUT;
}
function workloadProgramIds(workload:SparseCandidateWorkload):readonly number[] {
  return workload==="mixed-bins"?Object.freeze(Array.from({length:GPU_SHADING_PROGRAM_COUNT},(_,program)=>program)):
    workload==="rendering-lab-fixed"?RENDERING_LAB_PROGRAMS:
    Object.freeze([workload==="basic-cube"||workload==="lifecycle-resize"?0:workload==="unlit-vertex-color"?1:2]);
}
function workloadTriangleCount(workload:SparseCandidateWorkload):number {
  if(workload==="mixed-bins")return TRIANGLES_PER_PROGRAM;
  return workload==="basic-cube"||workload==="lifecycle-resize"||workload==="rendering-lab-fixed"?
    CUBE_TRIANGLE_COUNT:VERTEX_COLOR_TRIANGLE_COUNT;
}
function workloadFeatures(workload:SparseCandidateWorkload){return workload==="rendering-lab-fixed"?RENDERING_LAB_FEATURES:FEATURES;}

interface CandidateResources {
  readonly workload:SparseCandidateWorkload;readonly layout:WorkloadLayout;
  readonly shadingView:GPUBuffer; readonly camera:GPUBuffer;
  readonly queue:GPUBuffer; readonly bucketStates:GPUBuffer; readonly drawIndirect:GPUBuffer;
  readonly bucketSettings:GPUBuffer; readonly instances:GPUBuffer; readonly geometryRecords:GPUBuffer;
  readonly meshletRecords:GPUBuffer; readonly meshletVertexIndices:GPUBuffer;
  readonly meshletTriangleIndices:GPUBuffer; readonly vertexStreamData:GPUBuffer;
  readonly assetMetadata:GPUBuffer; readonly vertexPayload:GPUBuffer;
  readonly shadingMaterials:GPUBuffer; readonly routes:GPUBuffer;
  readonly textureBanks:readonly GPUTexture[]; readonly textureBankViews:readonly GPUTextureView[];
  readonly materialSamplers:readonly GPUSampler[]; readonly lightDatabase:GPUBuffer|null;
  readonly clusterHeaders:GPUBuffer|null; readonly clusterIndices:GPUBuffer|null; readonly lightSettings:GPUBuffer|null;
  readonly renderingLab:RenderingLabPersistentResources|null;
}

interface RenderingLabPersistentResources {
  readonly previousCamera:GPUBuffer;readonly previousDepth:GPUTexture;readonly view:GPUBuffer;
  readonly counters:GPUBuffer;readonly stbn:GPUTexture;readonly blueNoise:GPUTexture;
  readonly environmentDiffuse:GPUTexture;readonly environmentSpecular:GPUTexture;readonly splitSum:GPUTexture;
  readonly fallbackDiffuse:GPUTexture;readonly brick4:GPUBuffer;readonly lpvMeshBvh:GPUBuffer;
  readonly lpvMetadata:GPUBuffer;readonly lpvTetrahedra:GPUBuffer;readonly lpvProbes:GPUBuffer;
  readonly lpvDepthAtlas:GPUTexture;readonly shadowAtlas:GPUTexture;readonly shadowMatrix:GPUBuffer;
  readonly shadowSampler:GPUSampler;
}

export interface SparseCandidateEvidence {
  readonly scenario:Readonly<Record<string,unknown>>; readonly graph:unknown; readonly profile:unknown;
  readonly lifecycle:unknown; readonly memory:unknown; readonly compilation:unknown;
}

export class SparseShadingCandidateFixture {
  private readonly buffers=new Set<GPUBuffer>(); private readonly textures=new Set<GPUTexture>();
  private readonly profiler=new FrameProfiler(); private readonly graphics:GraphicsContext;
  private readonly raster:MeshletBucketRaster; private readonly tonemap:TonemapPass;
  private readonly renderingLab:RenderingLabDownstream|null;
  private readonly prepared:PreparedMeshletWorkCandidate; private readonly assets:GpuAssetBindings;
  private readonly scene:GpuSceneBindings; private readonly renderWorld:GpuRenderWorldRuntime;
  private destroyed=false;

  private constructor(private readonly device:GPUDevice, private readonly canvasContext:GPUCanvasContext,
    canvasFormat:GPUTextureFormat, private readonly workload:SparseCandidateWorkload,
    private readonly resources:CandidateResources,
    private readonly runtime:SparseShadingCandidateRuntime, private readonly gpuRevisions:SparseShadingGpuRevisionOwner,
    private readonly oracleValidate:GPUComputePipeline,
    private readonly oracleExtract:GPUComputePipeline,
    private readonly publicationSnapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,
    private readonly compilation:Readonly<Record<string,unknown>>,
    private readonly shadowPipeline:GPURenderPipeline|null) {
    this.graphics=new GraphicsContext(device,this.profiler);
    this.profiler.configure({enabled:true,gpuTimestampAvailable:false,warmupFrames:0,gpuSampleInterval:1,
      gpuCounterSampleInterval:1,historyCapacity:16,readbackRingSlots:3,cpuPassTimings:true});
    this.raster=new MeshletBucketRaster(this.graphics); this.tonemap=new TonemapPass(device,canvasFormat);
    this.renderingLab=workload==="rendering-lab-fixed"?new RenderingLabDownstream(this.graphics,WIDTH,HEIGHT):null;
    this.prepared=createPrepared(resources); this.assets=createAssetBindings(resources);
    this.scene=createSceneBindings(resources); this.renderWorld=createRenderWorld(resources,publicationSnapshot);
  }

  static async create(device:GPUDevice, canvasContext:GPUCanvasContext, canvasFormat:GPUTextureFormat,
    capability:Readonly<GpuSparseShadingCapabilityRecord>,workload:SparseCandidateWorkload="mixed-bins"):
    Promise<SparseShadingCandidateFixture> {
    const buffers=new Set<GPUBuffer>(), textures=new Set<GPUTexture>();
    const resources=createResources(device,buffers,textures,workload);
    const features=workloadFeatures(workload);
    const outputDependencyMask=workload==="rendering-lab-fixed"?
      GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite|GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite|
      GPU_SHADING_OUTPUT_DEPENDENCY.Velocity:0;
    const publications=new GpuShadingPublicationStore({width:WIDTH,height:HEIGHT,outputDependencyMask,
      shadowSamplingEnabled:features.shadows,capability,sizingLimits:{maxTextureDimension2D:device.limits.maxTextureDimension2D,
        maxBufferSize:device.limits.maxBufferSize,maxStorageBufferBindingSize:device.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupsPerDimension:device.limits.maxComputeWorkgroupsPerDimension}});
    const runtime=new SparseShadingCandidateRuntime(publications),gpuRevisions=new SparseShadingGpuRevisionOwner(device);
    const mutation=runtime.beginMutation();mutation.replaceAll(createPublication(workload));
    const preparedSnapshot=mutation.prepare();let preparedGpu;
    try {
      preparedGpu=await gpuRevisions.prepare(preparedSnapshot);
      runtime.commitMutation(mutation,0,features);const snapshot=publications.currentSnapshot();
      const revision=gpuRevisions.publish(preparedGpu,snapshot,0),resolve=requireResource(revision.resolve,"candidate resolve");
      const oracle=await createOraclePipelines(device,snapshot.pipelines.slice().sort((a,b)=>a.programId-b.programId)
        .map((entry)=>entry.binId),workload,snapshot.executionMode==="direct-single-bin");
      const shadow=workload==="rendering-lab-fixed"?await createRenderingLabShadowPipeline(device):null;
      const fixture=new SparseShadingCandidateFixture(device,canvasContext,canvasFormat,workload,resources,runtime,
        gpuRevisions,oracle.validate,oracle.extract,snapshot,Object.freeze({sparseOracle:oracle.messages,
          ...(shadow===null?{}:{shadow:shadow.messages})}),shadow?.pipeline??null);
      for(const value of buffers)fixture.buffers.add(value); for(const value of textures)fixture.textures.add(value);
      uploadStaticInputs(device,resources,snapshot,workload); return fixture;
    } catch(error) {
      gpuRevisions.destroy(); runtime.destroy();
      for(const value of buffers)value.destroy(); for(const value of textures)value.destroy(); throw error;
    }
  }

  async runMixedBins():Promise<Readonly<SparseCandidateEvidence>> {
    if(this.workload!=="mixed-bins")throw new Error("runMixedBins requires the mixed-bins fixture publication");
    return this.runCandidateFrame("MixedBins",0,1,(bytes,snapshot)=>validateMixedBins(bytes,snapshot));
  }

  async runBasicCubeNearFar():Promise<Readonly<SparseCandidateEvidence>> {
    if(this.workload!=="basic-cube")throw new Error("runBasicCubeNearFar requires the basic-cube fixture publication");
    this.requireAlive();const snapshot=this.publicationSnapshot;
    const nearCamera=createCubeCamera(CUBE_NEAR_DISTANCE);uploadCameraFrame(this.device,this.resources,snapshot,nearCamera,0);
    const near=await this.runCandidateFrame("BasicCubeNear",0,1,(bytes,current)=>validateBasicCube(bytes,current,nearCamera));
    const farCamera=createCubeCamera(CUBE_FAR_DISTANCE);uploadCameraFrame(this.device,this.resources,snapshot,farCamera,1);
    const far=await this.runCandidateFrame("BasicCubeFar",1,2,(bytes,current)=>validateBasicCube(bytes,current,farCamera));
    const nearCoverage=coverageEvidence(near.scenario),farCoverage=coverageEvidence(far.scenario);
    if(nearCoverage.visiblePixels<=farCoverage.visiblePixels*4)throw new Error(
      `BasicCube coverage slope too shallow: near ${nearCoverage.visiblePixels}, far ${farCoverage.visiblePixels}`);
    const expectedRatio=nearCoverage.expectedPixels/farCoverage.expectedPixels;
    const actualRatio=nearCoverage.visiblePixels/farCoverage.visiblePixels;
    if(Math.abs(actualRatio-expectedRatio)>0.01)throw new Error(
      `BasicCube coverage slope disagrees with analytic oracle: expected ${expectedRatio}, actual ${actualRatio}`);
    return Object.freeze({scenario:Object.freeze({name:"BasicCubeNear/Far",passed:true,
      immutablePublication:Object.freeze({generation:snapshot.generation,layoutRevision:snapshot.layoutRevision,
        associationCount:snapshot.associations.length}),near:near.scenario,far:far.scenario,
      coverageSlope:Object.freeze({nearPixels:nearCoverage.visiblePixels,farPixels:farCoverage.visiblePixels,
        actualRatio,expectedRatio})}),graph:Object.freeze([near.graph,far.graph]),profile:Object.freeze([near.profile,far.profile]),
      lifecycle:this.runtime.evidence(),memory:Object.freeze({near:near.memory,far:far.memory}),compilation:this.compilation});
  }

  async runUnlitVertexColor():Promise<Readonly<SparseCandidateEvidence>> {
    if(this.workload!=="unlit-vertex-color")throw new Error("runUnlitVertexColor requires its dedicated fixture publication");
    const camera=createCubeCamera(CUBE_NEAR_DISTANCE);uploadCameraFrame(this.device,this.resources,this.runtimeSnapshot(),camera,0);
    return this.runCandidateFrame("UnlitVertexColor",0,1,(bytes,snapshot)=>validateUnlitVertexColor(bytes,snapshot,camera));
  }

  async runUnlitTexture():Promise<Readonly<SparseCandidateEvidence>> {
    if(this.workload!=="unlit-texture")throw new Error("runUnlitTexture requires its dedicated fixture publication");
    const camera=createCubeCamera(CUBE_NEAR_DISTANCE);uploadCameraFrame(this.device,this.resources,this.runtimeSnapshot(),camera,0);
    return this.runCandidateFrame("UnlitTexture",0,1,(bytes,snapshot)=>validateUnlitTexture(bytes,snapshot,camera));
  }

  async runRenderingLabFixed():Promise<Readonly<SparseCandidateEvidence>> {
    if(this.workload!=="rendering-lab-fixed")throw new Error("runRenderingLabFixed requires its dedicated fixture publication");
    const camera=createRenderingLabCamera();uploadCameraFrame(this.device,this.resources,this.runtimeSnapshot(),camera,0);
    const frames=[] as SparseCandidateEvidence[];
    for(let frameIndex=0;frameIndex<3;frameIndex++){
      uploadCameraFrame(this.device,this.resources,this.runtimeSnapshot(),camera,frameIndex);
      frames.push(await this.runCandidateFrame(`RenderingLabFixed/${frameIndex===0?"cold":frameIndex===1?"warm":"stable"}`,
        frameIndex,frameIndex+1,(bytes,snapshot)=>validateRenderingLab(bytes,snapshot,frameIndex)) as SparseCandidateEvidence);
    }
    return Object.freeze({scenario:Object.freeze({name:"RenderingLabFixed",passed:true,
      frames:Object.freeze(frames.map((entry)=>entry.scenario))}),graph:Object.freeze(frames.map((entry)=>entry.graph)),
      profile:Object.freeze(frames.map((entry)=>entry.profile)),lifecycle:this.runtime.evidence(),
      memory:Object.freeze(frames.map((entry)=>entry.memory)),compilation:this.compilation});
  }

  async runResizeLifecycle():Promise<Readonly<SparseCandidateEvidence>> {
    if(this.workload!=="lifecycle-resize")throw new Error("runResizeLifecycle requires its dedicated fixture publication");
    this.requireAlive();const initialSnapshot=this.runtimeSnapshot(),initialCamera=createCubeCamera(CUBE_NEAR_DISTANCE,1);
    uploadFrameConfiguration(this.device,this.resources,initialSnapshot,initialCamera,0);
    const resizeBoundary:{beforeCompletion?:ReturnType<SparseShadingGpuRevisionOwner["evidence"]>}={};
    const initial=await this.runCandidateFrame("LifecycleResize/initial",0,1,
      (bytes,snapshot)=>validateBasicCube(bytes,snapshot,initialCamera),{afterSubmitBeforeCompletion:async()=>{
        const mutation=this.runtime.beginMutation();mutation.updateContext({...initialSnapshot.context,height:128});
        const candidatePlan=this.runtime.prepareMutation(mutation,FEATURES),preparedSnapshot=mutation.prepare();
        assertEqual(candidatePlan.width,WIDTH,"LifecycleResize prepared width");
        assertEqual(candidatePlan.height,128,"LifecycleResize prepared height");
        const preparedGpu=await this.gpuRevisions.prepare(preparedSnapshot);let committed=false;
        try {
          this.runtime.commitMutation(mutation,1,FEATURES);committed=true;
          const published=this.runtimeSnapshot();this.gpuRevisions.publish(preparedGpu,published,1);
          resizeBoundary.beforeCompletion=this.gpuRevisions.evidence();
          uploadSnapshotDependentInputs(this.device,this.resources,published,createCubeCamera(CUBE_NEAR_DISTANCE,2),1);
        } catch(error) {
          if(!committed){this.gpuRevisions.abort(preparedGpu);this.runtime.abortMutation(mutation);}
          throw error;
        }
      }});
    const beforeCompletion=resizeBoundary.beforeCompletion;
    if(beforeCompletion===undefined)throw new Error("LifecycleResize did not capture the pre-completion retirement boundary");
    const afterCompletion=this.gpuRevisions.evidence(),resizedSnapshot=this.runtimeSnapshot();
    assertArray(beforeCompletion.retiringRevisions,[initialSnapshot.revision],"LifecycleResize in-flight revision");
    assertEqual(beforeCompletion.retireCount,0,"LifecycleResize pre-completion retire count");
    assertArray(afterCompletion.retiringRevisions,[],"LifecycleResize completed retiring revisions");
    assertEqual(afterCompletion.retireCount,1,"LifecycleResize completed retire count");
    if(resizedSnapshot.revision===initialSnapshot.revision)throw new Error("LifecycleResize did not publish a new revision");
    if(resizedSnapshot.sizing.heapBytes>=initialSnapshot.sizing.heapBytes)throw new Error(
      "LifecycleResize smaller extent did not reduce the revision-owned heap");
    const resizedCamera=createCubeCamera(CUBE_NEAR_DISTANCE,2);
    const resized=await this.runCandidateFrame("LifecycleResize/resized",1,2,
      (bytes,snapshot)=>validateBasicCube(bytes,snapshot,resizedCamera));
    const stableCreateCount=this.gpuRevisions.evidence().createCount;
    const stable=await this.runCandidateFrame("LifecycleResize/reuse",2,3,
      (bytes,snapshot)=>validateBasicCube(bytes,snapshot,resizedCamera));
    assertEqual(this.gpuRevisions.evidence().createCount,stableCreateCount,
      "LifecycleResize stable-frame GPU revision creation");
    return Object.freeze({scenario:Object.freeze({name:"LifecycleResize",passed:true,
      extents:Object.freeze({initial:[initialSnapshot.context.width,initialSnapshot.context.height],
        resized:[resizedSnapshot.context.width,resizedSnapshot.context.height]}),
      revisions:Object.freeze({initial:initialSnapshot.revision,resized:resizedSnapshot.revision,
        retiredAtSubmission:1,beforeCompletion,afterCompletion}),
      heapBytes:Object.freeze({initial:initialSnapshot.sizing.heapBytes,resized:resizedSnapshot.sizing.heapBytes}),
      frames:Object.freeze([initial.scenario,resized.scenario,stable.scenario])}),
      graph:Object.freeze([initial.graph,resized.graph,stable.graph]),profile:Object.freeze([initial.profile,resized.profile,stable.profile]),
      lifecycle:Object.freeze({candidate:this.runtime.evidence(),gpuRevisions:this.gpuRevisions.evidence()}),
      memory:Object.freeze([initial.memory,resized.memory,stable.memory]),compilation:this.compilation});
  }

  private async runCandidateFrame(scenario:string,frameIndex:number,serial:number,
    validate:(bytes:Uint8Array,snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>)=>Readonly<Record<string,unknown>>,
    options:Readonly<{afterSubmitBeforeCompletion?:()=>Promise<void>}>={}):
    Promise<Readonly<SparseCandidateEvidence>> {
    this.requireAlive(); const features=workloadFeatures(this.workload),ticket=this.runtime.beginFrame(features);
    const gpuRevision=this.gpuRevisions.active(ticket.snapshot),binPass=gpuRevision.bins,
      resolve=requireResource(gpuRevision.resolve,"candidate resolve");
    const readback=this.trackBuffer(this.device.createBuffer({label:`ADR-0013 candidate ${scenario} readback`,
      size:READBACK_BYTES,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));
    const oracle=this.trackBuffer(this.device.createBuffer({label:`ADR-0013 candidate ${scenario} oracle scratch`,
      size:ORACLE_BYTES,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}));
    const presentation=this.canvasContext.getCurrentTexture(), graph=new FrameGraph(`ADR-0013 sparse candidate ${scenario}`);
    this.renderingLab?.beginFrame(graph,frameIndex);
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
      shadingMaterials:imported("candidate/shading-materials",this.resources.shadingMaterials),
      routes:imported("candidate/texture-routes",this.resources.routes),
      presentation:imported("candidate/presentation",presentation), readback:imported("candidate/capture-readback",readback),
      oracle:imported("candidate/capture-oracle",oracle)
    };
    const lab=this.resources.renderingLab;
    const labIds=lab===null?null:Object.freeze({
      previousCamera:imported("candidate/rendering-lab/previous-camera",lab.previousCamera),
      previousDepth:imported("candidate/rendering-lab/previous-depth",lab.previousDepth),
      view:imported("candidate/rendering-lab/view",lab.view),
      counters:imported("candidate/rendering-lab/counters",lab.counters),
      stbn:imported("candidate/rendering-lab/stbn",lab.stbn),
      blueNoise:imported("candidate/rendering-lab/blue-noise",lab.blueNoise),
      environmentDiffuse:imported("candidate/rendering-lab/environment-diffuse",lab.environmentDiffuse),
      environmentSpecular:imported("candidate/rendering-lab/environment-specular",lab.environmentSpecular),
      splitSum:imported("candidate/rendering-lab/split-sum",lab.splitSum),
      fallbackDiffuse:imported("candidate/rendering-lab/fallback-diffuse",lab.fallbackDiffuse),
      brick4:imported("candidate/rendering-lab/brick4",lab.brick4),
      lpvMeshBvh:imported("candidate/rendering-lab/lpv-bvh",lab.lpvMeshBvh),
      lpvMetadata:imported("candidate/rendering-lab/lpv-metadata",lab.lpvMetadata),
      lpvTetrahedra:imported("candidate/rendering-lab/lpv-tetrahedra",lab.lpvTetrahedra),
      lpvProbes:imported("candidate/rendering-lab/lpv-probes",lab.lpvProbes),
      lpvDepthAtlas:imported("candidate/rendering-lab/lpv-depth-atlas",lab.lpvDepthAtlas),
      shadowAtlas:imported("candidate/rendering-lab/shadow-atlas",lab.shadowAtlas)
    });
    const lighting=this.workload==="mixed-bins"||this.workload==="rendering-lab-fixed"?[
      imported("candidate/light-database",requireResource(this.resources.lightDatabase,"light database")),
      imported("candidate/cluster-headers",requireResource(this.resources.clusterHeaders,"cluster headers")),
      imported("candidate/cluster-indices",requireResource(this.resources.clusterIndices,"cluster indices")),
      imported("candidate/light-settings",requireResource(this.resources.lightSettings,"light settings"))]:[];
    const externalStage=(stage:SparseShadingCandidateStage,frame:Readonly<SparseShadingCandidateFrame>,
      resources:PassResources,context:{readonly encoder:unknown}):void=>{
      const command=requireCommand(context.encoder);
      if(stage==="visibility") { this.raster.encodeRaster(command.gpu_encoder,{prepared:this.prepared,
        camera:this.resources.camera,assets:this.assets,scene:this.scene,runtime:this.renderWorld,
        visibilityKey:textureView(frame.visibilityKey,resources),
        shadingBinId:ticket.snapshot.executionMode==="sparse-microtile"?textureView(frame.shadingBinId,resources):null,
        depth:textureView(frame.depth,resources,{aspect:"depth-only"})},ticket.snapshot.executionMode,"portable"); return; }
      if(stage==="light-cluster") { const pass=command.constructComputePass({pipeline:clusterPipelineDescriptor(),
        bindings:[[{buffer:requireResource(this.resources.clusterHeaders,"cluster headers")},
          {buffer:requireResource(this.resources.clusterIndices,"cluster indices")}]]});
        pass.dispatchWorkgroups(4); pass.end(); return; }
      if(stage==="shadow") { this.encodeRenderingLabShadow(command); return; }
      if(stage==="output-clear") {
        const pass=command.beginRenderPass({label:"ADR-0013 clear sparse shading HDR",colorAttachments:[{
          view:textureView(frame.hdr,resources),clearValue:{r:0,g:0,b:0,a:0},loadOp:"clear" as const,storeOp:"store" as const}]});
        pass.end();return;
      }
      if(stage==="post") { this.tonemap.execute(command,{swapchain:textureView(frame.finalOutput,resources),
        hdr:textureView(frame.stageInputHdr,resources)},{bloom:false,sharpening:false,colorGrading:false},
        {lift:0,gamma:1,gain:1,saturation:1,contrast:1,sharpeningStrength:0,bloomIntensity:0,
          samplers:this.graphics.samplers},undefined); return; }
      if(stage==="capture") { this.encodeCapture(command,frame,resources,presentation,binPass); return; }
      throw new Error(`${scenario} does not enable candidate stage '${stage}'`);
    };
    const executor=createSparseShadingCandidateExecutor({bins:binPass, directStatus:gpuRevision.status,
      settingsDynamicOffset:0,
      createBinBindings:(frame,resources)=>requireResource(binPass,"candidate bins").createFrameBindingsForExecution({
        shadingBinId:textureView(frame.shadingBinId,resources),settings:buffer(frame.settings,resources),
        settingsDynamicOffset:0,generation:ticket.snapshot.generation,layoutRevision:ticket.snapshot.layoutRevision}),
      resolve,createResolveBindings:(frame,resources)=>this.createResolveBindings(gpuRevision,frame,resources),
      executeExternalStage:externalStage});
    const downstreamResources:RenderingLabDownstreamResources|null=labIds===null?null:Object.freeze({
      camera:ids.camera,previousCamera:labIds.previousCamera,previousDepth:labIds.previousDepth,view:labIds.view,
      counters:labIds.counters,stbn:labIds.stbn,blueNoise:labIds.blueNoise,
      environmentDiffuse:labIds.environmentDiffuse,environmentSpecular:labIds.environmentSpecular,
      splitSum:labIds.splitSum,fallbackDiffuse:labIds.fallbackDiffuse,brick4:labIds.brick4,
      lpvMeshBvh:labIds.lpvMeshBvh,lpvMetadata:labIds.lpvMetadata,lpvTetrahedra:labIds.lpvTetrahedra,
      lpvProbes:labIds.lpvProbes,lpvDepthAtlas:labIds.lpvDepthAtlas,presentation:ids.presentation,
      post:(ownerGraph:FrameGraph,hdr:ResourceId,presentationResource:ResourceId)=>{
        let output=-1;const post=ownerGraph.add("RenderingLab production Tonemap",{},(_data:unknown,postResources:PassResources,
          postContext:FrameGraphContext)=>{
          const postCommand=requireCommand(postContext.encoder);this.tonemap.execute(postCommand,
            {swapchain:textureView(output,postResources),hdr:textureView(hdr,postResources)},
            {bloom:false,sharpening:false,colorGrading:false},{lift:0,gamma:1,gain:1,saturation:1,contrast:1,
              sharpeningStrength:0,bloomIntensity:0,samplers:this.graphics.samplers},undefined,
             undefined);
        });
        post.read(hdr);output=post.write(presentationResource);post.declareEncoderWork({renderPasses:1,draws:1});return output;
      }
    });
    const frame=addSparseShadingCandidateToGraph(graph,ticket.snapshot,features,{meshletWork:ids.meshletWork,
      sceneGeometry:[ids.camera,ids.instances,ids.geometry,ids.meshlets,ids.vertices,ids.triangles,ids.vertexStream,
        ids.assetMetadata,ids.vertexPayload],materials:[ids.shadingMaterials,ids.routes],
      lighting,shadows:labIds===null?[]:[labIds.shadowAtlas],
      presentation:ids.presentation,captureReadback:ids.readback,captureScratch:[ids.oracle],
      captureEncoderWork:{computePasses:1,dispatches:2},
      ...(binPass===null?{directStatus:requireResource(gpuRevision.status,"candidate direct status")}: {
        binResources:{heap:binPass.heap,indirectArgs:binPass.indirectArgs,
          settings:requireResource(gpuRevision.settings,"candidate settings")}}),
      ...(downstreamResources===null?{}:{composeDownstream:(stage,ownerGraph,stageFrame)=>
        this.renderingLab!.compose(stage,ownerGraph,stageFrame,downstreamResources)})},executor);
    this.profiler.beginFrame(frameIndex); const command=ShadeGPUCommandContext.create(this.graphics,"Renderer/main-0");
    command.recordGraphBuild(); this.profiler.recordGraphCompile(); let compiled;
    try { compiled=graph.compile(); command.encodeCompiledGraph(compiled,undefined);
      command.recordReadback(`ADR-0013/${scenario}-capture`,READBACK_BYTES); command.finish();
      this.runtime.commitSubmittedFrame(serial,ticket.frameId);
    } catch(error) { command.abort(error); this.runtime.abortEncodedFrame(ticket.frameId);this.renderingLab?.abortFrame(graph); this.profiler.endFrame();
      throw new Error(errorChain(error)); }
    const profile=this.profiler.endFrame();
    if(profile===undefined)throw new Error(`${scenario} profiler did not publish a frame snapshot`);
    assertEqual(profile.submits.count,1,`${scenario} one-main-submit`);assertEqual(profile.graph.builds,1,`${scenario} graph builds`);
    assertEqual(profile.graph.compiles,1,`${scenario} graph compiles`);assertEqual(profile.graph.executes,1,`${scenario} graph executes`);
    await options.afterSubmitBeforeCompletion?.();
    await this.device.queue.onSubmittedWorkDone();
    this.runtime.completeSubmittedWork(serial);this.gpuRevisions.completeSubmittedWork(serial);
    this.renderingLab?.commitSubmittedFrame(graph); await readback.mapAsync(GPUMapMode.READ);
    const bytes=new Uint8Array(readback.getMappedRange().slice(0)); readback.unmap();
    const graphDump=compiled.dump();validateCandidateTopology(graphDump,scenario,ticket.snapshot.executionMode);
    const evidence=Object.freeze({scenario:validate(bytes,ticket.snapshot),graph:graphDump,profile,
      lifecycle:Object.freeze({candidate:this.runtime.evidence(),gpuRevisions:this.gpuRevisions.evidence(),
        downstream:this.renderingLab?.evidence()??null}),memory:Object.freeze({plan:frame.plan.memory,live:this.graphics.memoryEvidence(),
        captureBytes:READBACK_BYTES,captureScratchBytes:ORACLE_BYTES}),compilation:this.compilation});
    compiled.destroy(); this.destroyBuffer(readback); this.destroyBuffer(oracle); return evidence;
  }

  resourceCounts():Readonly<Record<string,number>> { return Object.freeze({buffers:this.buffers.size,
    textures:this.textures.size,candidateRuntimeOwners:this.destroyed?0:2,graphicsOwners:this.destroyed?0:1}); }
  destroy():void { if(this.destroyed)return; this.destroyed=true; this.tonemap.destroy();
    this.renderingLab?.destroy();this.gpuRevisions.destroy(); this.runtime.destroy(); this.graphics.destroy();
    for(const value of this.buffers)value.destroy(); for(const value of this.textures)value.destroy();
    this.buffers.clear(); this.textures.clear(); }

  private createResolveBindings(revision:Readonly<SparseShadingGpuRevision>,frame:Readonly<SparseShadingCandidateFrame>,
    resources:PassResources):readonly SparseShadingResolveFrameBinding[] {
    const resolve=requireResource(revision.resolve,"candidate resolve");
    const bins=revision.bins, settings=revision.settings;
    const binding=(name:string):GPUBindingResource=>resolveBinding(name,frame,resources,this.resources,bins,settings,
      revision.status);
    return resolve.createFrameBindingsForExecution(binding);
  }
  private encodeRenderingLabShadow(command:ShadeGPUCommandContext):void {
    const lab=requireResource(this.resources.renderingLab,"RenderingLab resources");
    const pipeline=requireResource(this.shadowPipeline,"RenderingLab shadow pipeline");
    const group=this.device.createBindGroup({label:"ADR-0013 RenderingLab fixed shadow raster group",
      layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:this.resources.queue}},{binding:1,resource:{buffer:this.resources.instances}},
        {binding:2,resource:{buffer:this.resources.geometryRecords}},{binding:3,resource:{buffer:this.resources.meshletRecords}},
        {binding:4,resource:{buffer:this.resources.meshletVertexIndices}},
        {binding:5,resource:{buffer:this.resources.meshletTriangleIndices}},
        {binding:6,resource:{buffer:this.resources.vertexStreamData}},{binding:7,resource:{buffer:lab.shadowMatrix}}
      ]});
    const pass=command.beginRenderPass({label:"ADR-0013 RenderingLab fixed directional shadow raster",
      colorAttachments:[],depthStencilAttachment:{view:lab.shadowAtlas.createView({aspect:"depth-only"}),
        depthClearValue:0,depthLoadOp:"clear",depthStoreOp:"store"}});
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(CUBE_TRIANGLE_COUNT*3,this.resources.layout.workCount);pass.end();
  }
  private encodeCapture(command:ShadeGPUCommandContext,frame:Readonly<SparseShadingCandidateFrame>,
    resources:PassResources,presentation:GPUTexture,bins:ShadingBinPass|null):void {
    const width=frame.plan.width,height=frame.plan.height;
    if(width!==WIDTH||height>HEIGHT)throw new Error(`Candidate capture extent ${width}x${height} exceeds its frozen row layout`);
    const output=buffer(frame.captureScratch[0]??null,resources); command.clearBuffer(output);
    const validateGroup=this.device.createBindGroup({layout:this.oracleValidate.getBindGroupLayout(0),entries:[
      {binding:0,resource:textureView(frame.visibilityKey,resources)},
      {binding:1,resource:frame.shadingBinId===null?textureView(frame.visibilityKey,resources):textureView(frame.shadingBinId,resources)},
      {binding:2,resource:textureView(frame.hdr,resources)},{binding:3,resource:{buffer:output}}]});
    const pass=command.beginComputePass({label:"ADR-0013 MixedBins capture oracle"});
    pass.setPipeline(this.oracleValidate); pass.setBindGroup(0,validateGroup);
    pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));
    if (bins !== null) {
      const extractGroup=this.device.createBindGroup({layout:this.oracleExtract.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:bins.heap}},{binding:1,resource:{buffer:bins.indirectArgs}},
        {binding:2,resource:{buffer:output}}]});
      pass.setPipeline(this.oracleExtract); pass.setBindGroup(0,extractGroup); pass.dispatchWorkgroups(1);
    }
    pass.end();
    const readback=buffer(frame.captureReadback,resources);
    command.gpu_encoder.copyTextureToBuffer({texture:nativeTexture(resources.get(frame.hdr!))},
      {buffer:readback,offset:HDR_OFFSET,bytesPerRow:HDR_ROW_BYTES,rowsPerImage:height},[width,height,1]);
    command.gpu_encoder.copyTextureToBuffer({texture:presentation},
      {buffer:readback,offset:PRESENT_OFFSET,bytesPerRow:PRESENT_ROW_BYTES,rowsPerImage:height},[width,height,1]);
    command.gpu_encoder.copyTextureToBuffer({texture:nativeTexture(resources.get(frame.visibilityKey!))},
      {buffer:readback,offset:VISIBILITY_OFFSET,bytesPerRow:VISIBILITY_ROW_BYTES,rowsPerImage:height},[width,height,1]);
    if (frame.shadingBinId !== null) {
      command.gpu_encoder.copyTextureToBuffer({texture:nativeTexture(resources.get(frame.shadingBinId))},
        {buffer:readback,offset:BIN_OFFSET,bytesPerRow:BIN_ROW_BYTES,rowsPerImage:height},[width,height,1]);
    } else {
      command.clearBuffer(readback, BIN_OFFSET, BIN_BYTES);
    }
    command.copyBufferToBuffer(output,0,readback,ORACLE_OFFSET,ORACLE_BYTES);
    if(this.resources.renderingLab!==null)command.gpu_encoder.copyTextureToBuffer(
      {texture:this.resources.renderingLab.shadowAtlas,aspect:"depth-only"},
      {buffer:readback,offset:SHADOW_OFFSET,bytesPerRow:SHADOW_ROW_BYTES,rowsPerImage:SHADOW_SIZE},
      [SHADOW_SIZE,SHADOW_SIZE,1]);
  }
  private trackBuffer(value:GPUBuffer):GPUBuffer {this.buffers.add(value);return value;}
  private destroyBuffer(value:GPUBuffer):void {value.destroy();this.buffers.delete(value);}
  private requireAlive():void {if(this.destroyed)throw new Error("Sparse shading candidate fixture is destroyed");}
  private runtimeSnapshot():ReturnType<GpuShadingPublicationStore["currentSnapshot"]> {
    this.requireAlive();return this.runtime.publications.currentSnapshot();
  }
}

function createResources(device:GPUDevice,buffers:Set<GPUBuffer>,textures:Set<GPUTexture>,
  workload:SparseCandidateWorkload):CandidateResources {
  const layout=workloadLayout(workload),label=workload==="mixed-bins"?"MixedBins":
    workload==="basic-cube"?"BasicCube":workload==="unlit-vertex-color"?"UnlitVertexColor":
    workload==="unlit-texture"?"UnlitTexture":workload==="rendering-lab-fixed"?"RenderingLabFixed":"LifecycleResize";
  const lit=workload==="mixed-bins"||workload==="rendering-lab-fixed",textured=lit||workload==="unlit-texture";
  const makeBuffer=(label:string,size:number,usage:GPUBufferUsageFlags)=>{const value=device.createBuffer({label,size:Math.max(size,4),usage});buffers.add(value);return value;};
  const makeTexture=(descriptor:GPUTextureDescriptor)=>{const value=device.createTexture(descriptor);textures.add(value);return value;};
  const geometryBytes=layout.geometryCount*GPU_GEOMETRY_RECORD_STRIDE;
  const meshletBytes=layout.meshletCount*GPU_MESHLET_RECORD_STRIDE;
  const vertexIndexBytes=layout.vertexCount*4;
  const triangleBytes=layout.triangleBytes;
  const vertexBytes=layout.vertexCount*VERTEX_STRIDE,textureExtent=workload==="unlit-texture"||workload==="rendering-lab-fixed"?4:1;
  const textureBanks=Array.from({length:9},(_,index)=>makeTexture({label:`ADR-0013 ${label} texture bank ${index}`,
    size:[textureExtent,textureExtent,5],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}));
  const renderingLab=workload==="rendering-lab-fixed"?createRenderingLabPersistentResources(device,makeBuffer,makeTexture):null;
  return {
    workload,layout,
    shadingView:makeBuffer(`ADR-0013 ${label} shading view`,256,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    camera:makeBuffer(`ADR-0013 ${label} packed camera`,PACKED_CAMERA_TYPE.size,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST|
      (workload==="rendering-lab-fixed"?GPUBufferUsage.COPY_SRC:0)),
    queue:makeBuffer(`ADR-0013 ${label} MeshletWork queue`,GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE+
      layout.workCount*GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    bucketStates:makeBuffer(`ADR-0013 ${label} bucket states`,GPU_MESHLET_DRAW_COUNT*GPU_MESHLET_BUCKET_STATE_STRIDE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    drawIndirect:makeBuffer(`ADR-0013 ${label} raster indirect`,GPU_MESHLET_DRAW_COUNT*GPU_MESHLET_DRAW_INDIRECT_STRIDE,
      GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST),
    bucketSettings:makeBuffer(`ADR-0013 ${label} bucket settings`,GPU_MESHLET_DRAW_COUNT*MESHLET_BUCKET_SETTINGS_STRIDE,
      GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    instances:makeBuffer(`ADR-0013 ${label} instances`,layout.instanceCount*GPU_INSTANCE_RECORD_STRIDE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    geometryRecords:makeBuffer(`ADR-0013 ${label} raster geometries`,geometryBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    meshletRecords:makeBuffer(`ADR-0013 ${label} raster meshlets`,meshletBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    meshletVertexIndices:makeBuffer(`ADR-0013 ${label} raster meshlet vertices`,vertexIndexBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    meshletTriangleIndices:makeBuffer(`ADR-0013 ${label} raster meshlet triangles`,triangleBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    vertexStreamData:makeBuffer(`ADR-0013 ${label} raster vertex stream`,vertexBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    assetMetadata:makeBuffer(`ADR-0013 ${label} resolve asset metadata`,geometryBytes+meshletBytes+layout.geometryCount*4,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    vertexPayload:makeBuffer(`ADR-0013 ${label} resolve vertex payload`,vertexIndexBytes+triangleBytes+vertexBytes,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    shadingMaterials:makeBuffer(`ADR-0013 ${label} shading materials`,layout.materialCount*GPU_SHADING_MATERIAL_RECORD_STRIDE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    routes:makeBuffer(`ADR-0013 ${label} texture routes`,layout.materialCount*GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL*GPU_SHADING_TEXTURE_ROUTE_STRIDE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    textureBanks,textureBankViews:textureBanks.map((value)=>value.createView({dimension:"2d-array"})),
    materialSamplers:textured?Array.from({length:6},()=>device.createSampler({addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge",
      minFilter:"nearest",magFilter:"nearest"})):[],
    lightDatabase:lit?makeBuffer(`ADR-0013 ${label} light database`,NATIVE_LIGHT_DATABASE_MAX_BYTES,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST):null,
    clusterHeaders:lit?makeBuffer(`ADR-0013 ${label} cluster headers`,16*16*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST):null,
    clusterIndices:lit?makeBuffer(`ADR-0013 ${label} cluster data`,36,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST):null,
    lightSettings:lit?makeBuffer(`ADR-0013 ${label} cluster parameters`,16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST):null,
    renderingLab
  };
}

function createRenderingLabPersistentResources(
  device:GPUDevice,
  makeBuffer:(label:string,size:number,usage:GPUBufferUsageFlags)=>GPUBuffer,
  makeTexture:(descriptor:GPUTextureDescriptor)=>GPUTexture
):RenderingLabPersistentResources {
  const sampled=(label:string,size:GPUExtent3D,dimension:GPUTextureDimension="2d")=>makeTexture({label,size,dimension,
    format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  return Object.freeze({
    previousCamera:makeBuffer("ADR-0013 RenderingLab previous camera",PACKED_CAMERA_TYPE.size,
      GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    previousDepth:makeTexture({label:"ADR-0013 RenderingLab previous depth",size:[WIDTH,HEIGHT],format:"depth32float",
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),
    view:makeBuffer("ADR-0013 RenderingLab view",96,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    counters:makeBuffer("ADR-0013 RenderingLab downstream counters",GPU_COUNTER_BYTE_SIZE,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC),
    stbn:sampled("ADR-0013 RenderingLab STBN",[4,4,4],"3d"),
    blueNoise:sampled("ADR-0013 RenderingLab blue noise",[4,4,4],"3d"),
    environmentDiffuse:sampled("ADR-0013 RenderingLab diffuse environment",[8,8]),
    environmentSpecular:sampled("ADR-0013 RenderingLab specular environment",[8,8]),
    splitSum:sampled("ADR-0013 RenderingLab split sum",[4,4]),
    fallbackDiffuse:sampled("ADR-0013 RenderingLab fallback diffuse",[8,8]),
    brick4:makeBuffer("ADR-0013 RenderingLab disabled Brick4",BRICK4_LIGHT_MAP_MIN_BINDING_BYTES,
      GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    lpvMeshBvh:makeBuffer("ADR-0013 RenderingLab disabled LPV BVH",256,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    lpvMetadata:makeBuffer("ADR-0013 RenderingLab disabled LPV metadata",256,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    lpvTetrahedra:makeBuffer("ADR-0013 RenderingLab disabled LPV tetrahedra",256,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    lpvProbes:makeBuffer("ADR-0013 RenderingLab disabled LPV probes",256,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),
    lpvDepthAtlas:sampled("ADR-0013 RenderingLab disabled LPV depth atlas",[1,1]),
    shadowAtlas:makeTexture({label:"ADR-0013 RenderingLab shadow atlas",size:[SHADOW_SIZE,SHADOW_SIZE],
      format:"depth32float",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC}),
    shadowMatrix:makeBuffer("ADR-0013 RenderingLab shadow matrix",64,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    shadowSampler:device.createSampler({compare:"greater",minFilter:"linear",magFilter:"linear"})
  });
}

function createPublication(workload:SparseCandidateWorkload){const programs=workloadProgramIds(workload);return {
  materials:programs.map((program,id)=>({id,profile:materialProfile(program),generation:MATERIAL_GENERATION,
    textureGeneration:TEXTURE_GENERATION})),
  geometries:programs.map((program,id)=>({id,profile:geometryProfile(program),generation:GEOMETRY_GENERATION})),
  instances:programs.map((_,id)=>({id,materialId:id,geometryId:id,active:true,transparent:false,
    generation:23}))};}
function materialProfile(programId:number):GpuShadingMaterialProfile {const bits=textureBits(programId);return Object.freeze({
  shadingModel:programId<4?"unlit":"standard-pbr",hasBaseTexture:(bits&1)!==0,hasOrmTexture:(bits&2)!==0,
  hasNormalTexture:(bits&4)!==0,hasEmissiveTexture:(bits&8)!==0,hasOcclusionTexture:false,
  requiredUvSetsMask:bits===0?0:1,textureBindingSetId:bits===0?0:(programId%3)+1});}
function geometryProfile(programId:number):GpuShadingGeometryProfile {const bits=textureBits(programId);return Object.freeze({
  hasAuthoredVertexColor:programId===1||programId===3,hasUv0:bits!==0,hasUv1:false,hasUv2:false,
  hasNormal:programId>=4,hasTangent:(bits&4)!==0});}
function textureBits(programId:number):number{return [0,0,1,1,0,1,2,3,4,5,6,7,15,9,14,8][programId]??0;}

function uploadStaticInputs(device:GPUDevice,r:CandidateResources,snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,
  workload:SparseCandidateWorkload):void {
  if(workload==="mixed-bins"){
    device.queue.writeBuffer(r.camera,0,packedPixelCamera());
    device.queue.writeBuffer(r.shadingView,0,shadingView(snapshot,r,PIXEL_VIEW_PROJECTION,[WIDTH/2,HEIGHT/2,100],0));
  } else uploadCameraFrame(device,r,snapshot,workload==="rendering-lab-fixed"?createRenderingLabCamera():createCubeCamera(CUBE_NEAR_DISTANCE),0);
  const geometry=createGeometryData(workload,r.layout); device.queue.writeBuffer(r.geometryRecords,0,geometry.geometryRecords);
  device.queue.writeBuffer(r.meshletRecords,0,geometry.meshletRecords);device.queue.writeBuffer(r.meshletVertexIndices,0,geometry.meshletVertices);
  device.queue.writeBuffer(r.meshletTriangleIndices,0,geometry.meshletTriangles);device.queue.writeBuffer(r.vertexStreamData,0,geometry.vertexStream);
  device.queue.writeBuffer(r.assetMetadata,0,geometry.assetMetadata);device.queue.writeBuffer(r.vertexPayload,0,geometry.vertexPayload);
  device.queue.writeBuffer(r.instances,0,createInstances(workload));device.queue.writeBuffer(r.queue,0,createMeshletQueue(snapshot,workload));
  device.queue.writeBuffer(r.bucketStates,0,createBucketStates(r.layout));device.queue.writeBuffer(r.drawIndirect,0,createDrawIndirect(workload,r.layout));
  device.queue.writeBuffer(r.bucketSettings,0,createBucketSettings(device));const materials=createMaterials(snapshot,workload);
    device.queue.writeBuffer(r.shadingMaterials,0,materials.shading);
  device.queue.writeBuffer(r.routes,0,materials.routes);
  const bank=createTextureBankUpload(workload);
  for(const value of r.textureBanks)device.queue.writeTexture({texture:value},bank.bytes,
    {bytesPerRow:bank.bytesPerRow,rowsPerImage:bank.extent},[bank.extent,bank.extent,5]);
  if(workload==="mixed-bins"||workload==="rendering-lab-fixed"){
    const shadowProjection=workload==="rendering-lab-fixed"?createRenderingLabShadowProjection():null;
    device.queue.writeBuffer(requireResource(r.lightDatabase,"light database"),0,
      candidateLightDatabase(workload,shadowProjection));
    device.queue.writeBuffer(requireResource(r.lightSettings,"light settings"),0,new Float32Array([1,0,4.06,0]));
  }
  if(r.renderingLab!==null)uploadRenderingLabPersistentResources(device,r.renderingLab);
}

function candidateLightDatabase(
  workload:SparseCandidateWorkload,
  shadowProjection:Float32Array|null
):ArrayBuffer {
  const incident=shadowProjection===null?[0,0,1] as const:[0.557086,0.742781,0.371391] as const;
  const shadow=shadowProjection===null?[]:[Array.from({length:3},()=>({
    projection:shadowProjection,atlas:[0,0,SHADOW_SIZE,SHADOW_SIZE]
  }))];
  return packNativeLightDatabaseFixture({directional:[{
    direction:[-incident[0],-incident[1],-incident[2]],
    color:workload==="mixed-bins"?[2,1,0.5]:[3.2,2.9,2.5],disk_radius:0,
    flags:shadowProjection===null?0:1,near_clip_distance:0.1,shadow_id:0
  }],shadowDirectional:shadow});
}

function unlitTextureTexel(x:number,y:number):readonly [number,number,number,number] {
  return Object.freeze([32+56*x,24+64*y,16+24*(x+y),255] as const);
}
function createTextureBankUpload(workload:SparseCandidateWorkload):Readonly<{bytes:Uint8Array;bytesPerRow:number;extent:number}> {
  if(workload!=="unlit-texture"&&workload!=="rendering-lab-fixed"){
    const bytes=new Uint8Array(256*5);bytes.set([255,255,255,255],0);bytes.set([64,128,191,255],256);
    bytes.set([128,128,255,255],512);bytes.set([51,179,230,255],768);bytes.set([128,64,255,255],1024);
    return Object.freeze({bytes,bytesPerRow:256,extent:1});
  }
  const extent=4,bytesPerRow=256,bytes=new Uint8Array(bytesPerRow*extent*5);
  for(let layer=0;layer<5;layer++)for(let y=0;y<extent;y++)for(let x=0;x<extent;x++){
    const value=workload==="unlit-texture"?(layer===1?unlitTextureTexel(x,y):[255,255,255,255] as const):
      layer===1?[48+42*x,40+38*y,32+24*((x+y)%4),255] as const:
      layer===2?[128+Math.min(30,x*8),128+Math.min(30,y*8),255,255] as const:
      layer===3?[210-24*x,70+30*y,180-16*y,255] as const:
      layer===4?[20+24*x,12+18*y,8+12*(x+y),255] as const:[255,255,255,255] as const;
    bytes.set(value,(layer*extent+y)*bytesPerRow+x*4);
  }
  return Object.freeze({bytes,bytesPerRow,extent});
}

function packedPixelCamera():ArrayBuffer {const output=new ArrayBuffer(PACKED_CAMERA_TYPE.size);writeWgslToBuffer({transform:IDENTITY,
  transform_inverse:IDENTITY,view_matrix:IDENTITY,view_matrix_inverse:IDENTITY,projection_matrix:PIXEL_VIEW_PROJECTION,
  projection_matrix_inverse:PIXEL_VIEW_PROJECTION_INVERSE,view_projection_matrix:PIXEL_VIEW_PROJECTION,
  view_projection_matrix_inverse:PIXEL_VIEW_PROJECTION_INVERSE,frustum:Array.from({length:6},()=>new Float32Array(4)),
  device_depth_to_view_space:new Float32Array([0,1,1,1])},PACKED_CAMERA_TYPE,output);return output;}

interface CubeCameraFrame {
  readonly distance:number;readonly fovDegrees:number;readonly position:readonly [number,number,number];
  readonly viewProjection:Float32Array;readonly packed:ArrayBuffer;
}

function createCubeCamera(distance:number,aspect=1):CubeCameraFrame {
  const camera=new PerspectiveCamera();camera.fov_degrees=CUBE_FOV_DEGREES;camera.aspect=aspect;camera.near=0.1;
  camera.transform.position.set(0,0,distance);camera.transform.lookAt({x:0,y:0,z:0});camera.update();
  const transformInverse=new Float32Array(16),viewInverse=new Float32Array(16),projectionInverse=new Float32Array(16),
    viewProjectionInverse=new Float32Array(16);
  if(!mat4Invert(transformInverse,camera.transform.matrix)||!mat4Invert(viewInverse,camera.view_matrix)||
    !mat4Invert(projectionInverse,camera.projection_matrix)||!mat4Invert(viewProjectionInverse,camera.view_projection_matrix))
    throw new Error("BasicCube camera matrix is singular");
  const output=new ArrayBuffer(PACKED_CAMERA_TYPE.size),cotangent=1/Math.tan(camera.fov*0.5);
  writeWgslToBuffer({transform:camera.transform.matrix,transform_inverse:transformInverse,view_matrix:camera.view_matrix,
    view_matrix_inverse:viewInverse,projection_matrix:camera.projection_matrix,projection_matrix_inverse:projectionInverse,
    view_projection_matrix:camera.view_projection_matrix,view_projection_matrix_inverse:viewProjectionInverse,
    frustum:Array.from({length:6},(_,index)=>camera.frustum.subarray(index*4,index*4+4)),
    device_depth_to_view_space:new Float32Array([0,camera.near,camera.aspect/cotangent,1/cotangent])},PACKED_CAMERA_TYPE,output);
  return Object.freeze({distance,fovDegrees:CUBE_FOV_DEGREES,position:Object.freeze([0,0,distance] as const),
    viewProjection:new Float32Array(camera.view_projection_matrix),packed:output});
}

function createRenderingLabCamera():CubeCameraFrame {
  const camera=new PerspectiveCamera();camera.fov_degrees=55;camera.aspect=1;camera.near=0.1;
  camera.transform.position.set(5,3.5,7.5);camera.transform.lookAt({x:0,y:0,z:0});camera.update();
  const transformInverse=new Float32Array(16),viewInverse=new Float32Array(16),projectionInverse=new Float32Array(16),
    viewProjectionInverse=new Float32Array(16);
  if(!mat4Invert(transformInverse,camera.transform.matrix)||!mat4Invert(viewInverse,camera.view_matrix)||
    !mat4Invert(projectionInverse,camera.projection_matrix)||!mat4Invert(viewProjectionInverse,camera.view_projection_matrix))
    throw new Error("RenderingLab camera matrix is singular");
  const output=new ArrayBuffer(PACKED_CAMERA_TYPE.size),cotangent=1/Math.tan(camera.fov*0.5);
  writeWgslToBuffer({transform:camera.transform.matrix,transform_inverse:transformInverse,view_matrix:camera.view_matrix,
    view_matrix_inverse:viewInverse,projection_matrix:camera.projection_matrix,projection_matrix_inverse:projectionInverse,
    view_projection_matrix:camera.view_projection_matrix,view_projection_matrix_inverse:viewProjectionInverse,
    frustum:Array.from({length:6},(_,index)=>camera.frustum.subarray(index*4,index*4+4)),
    device_depth_to_view_space:new Float32Array([0,camera.near,camera.aspect/cotangent,1/cotangent])},PACKED_CAMERA_TYPE,output);
  return Object.freeze({distance:Math.hypot(5,3.5,7.5),fovDegrees:55,position:Object.freeze([5,3.5,7.5] as const),
    viewProjection:new Float32Array(camera.view_projection_matrix),packed:output});
}

function createRenderingLabShadowProjection():Float32Array {
  const camera=new OrthographicCamera();camera.left=-6;camera.right=6;camera.bottom=-6;camera.top=6;
  camera.near=0.1;camera.far=30;camera.transform.position.set(7.5,10,5);
  camera.transform.lookAt({x:0,y:0,z:0});camera.update();return new Float32Array(camera.view_projection_matrix);
}

function uploadRenderingLabPersistentResources(device:GPUDevice,lab:RenderingLabPersistentResources):void {
  const camera=createRenderingLabCamera(),shadow=createRenderingLabShadowProjection();
  device.queue.writeBuffer(lab.previousCamera,0,camera.packed);device.queue.writeBuffer(lab.shadowMatrix,0,shadow);
  const view=new ArrayBuffer(96),dv=new DataView(view);new Float32Array(view,0,16).set(camera.viewProjection);
  dv.setFloat32(64,1,true);dv.setFloat32(68,1,true);dv.setUint32(80,WIDTH,true);dv.setUint32(84,HEIGHT,true);
  dv.setUint32(88,0,true);device.queue.writeBuffer(lab.view,0,view);
  device.queue.writeBuffer(lab.counters,0,new Uint8Array(GPU_COUNTER_BYTE_SIZE));
  uploadRgba8(device,lab.stbn,4,4,4,(x,y,z)=>[32+47*x,24+53*y,16+61*z,255]);
  uploadRgba8(device,lab.blueNoise,4,4,4,(x,y,z)=>[(x*73+y*37+z*19)&255,
    (x*29+y*97+z*43)&255,(x*151+y*17+z*67)&255,255]);
  uploadRgba8(device,lab.environmentDiffuse,8,8,1,(x,y)=>[40+8*x,52+6*y,72+5*((x+y)%8),255]);
  uploadRgba8(device,lab.environmentSpecular,8,8,1,(x,y)=>[80+12*x,96+10*y,128+8*((x+y)%8),255]);
  uploadRgba8(device,lab.fallbackDiffuse,8,8,1,(x,y)=>[36+6*x,44+5*y,60+4*((x+y)%8),255]);
  uploadRgba8(device,lab.splitSum,4,4,1,(x,y)=>[96+24*x,48+28*y,0,255]);
  uploadRgba8(device,lab.lpvDepthAtlas,1,1,1,()=>[0,0,0,255]);
}

function uploadRgba8(device:GPUDevice,texture:GPUTexture,width:number,height:number,depth:number,
  texel:(x:number,y:number,z:number)=>readonly [number,number,number,number]):void {
  const bytesPerRow=256,bytes=new Uint8Array(bytesPerRow*height*depth);
  for(let z=0;z<depth;z++)for(let y=0;y<height;y++)for(let x=0;x<width;x++)
    bytes.set(texel(x,y,z),(z*height+y)*bytesPerRow+x*4);
  device.queue.writeTexture({texture},bytes,{bytesPerRow,rowsPerImage:height},[width,height,depth]);
}

function uploadCameraFrame(device:GPUDevice,r:CandidateResources,
  snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,camera:CubeCameraFrame,frameIndex:number):void {
  device.queue.writeBuffer(r.camera,0,camera.packed);device.queue.writeBuffer(r.shadingView,0,
    shadingView(snapshot,r,camera.viewProjection,camera.position,frameIndex));
}
function uploadFrameConfiguration(device:GPUDevice,r:CandidateResources,
  snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,camera:CubeCameraFrame,frameIndex:number):void {
  uploadCameraFrame(device,r,snapshot,camera,frameIndex);
}
function uploadSnapshotDependentInputs(device:GPUDevice,r:CandidateResources,
  snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,camera:CubeCameraFrame,frameIndex:number):void {
  uploadFrameConfiguration(device,r,snapshot,camera,frameIndex);
  device.queue.writeBuffer(r.queue,0,createMeshletQueue(snapshot,r.workload));
  const materials=createMaterials(snapshot,r.workload);
  device.queue.writeBuffer(r.shadingMaterials,0,materials.shading);
  device.queue.writeBuffer(r.routes,0,materials.routes);
}
function shadingView(snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,r:CandidateResources,
  currentViewProjection:ArrayLike<number>,cameraPosition:readonly number[],frameIndex:number):ArrayBuffer {
  const layout=r.layout;
  const geometryWords=GPU_GEOMETRY_RECORD_STRIDE/4,meshletWords=GPU_MESHLET_RECORD_STRIDE/4;
  const vertexWords=layout.vertexCount;
  const triangleWords=layout.triangleBytes/4;
  return packGpuSparseShadingView({width:snapshot.context.width,height:snapshot.context.height,
    materialCount:layout.materialCount,materialGeneration:MATERIAL_GENERATION,textureGeneration:TEXTURE_GENERATION,
    publicationRevision:snapshot.revision,frameIndex,preExposure:PRE_EXPOSURE,upscaleRatio:[1,1],
    cameraPosition:[cameraPosition[0]!,cameraPosition[1]!,cameraPosition[2]!],currentViewProjection,
    previousViewProjection:currentViewProjection,assets:{schemaVersion:1,epoch:1,assetMetadataHeap:r.assetMetadata,
      vertexPayloadHeap:r.vertexPayload,geometryWordBase:0,meshletWordBase:layout.geometryCount*geometryWords,
      geometryGenerationWordBase:layout.geometryCount*geometryWords+layout.meshletCount*meshletWords,
      meshletVertexWordBase:0,meshletTriangleWordBase:vertexWords,vertexDataWordBase:vertexWords+triangleWords,
      geometryCount:layout.geometryCount,meshletCount:layout.meshletCount,assetMetadataBytes:r.assetMetadata.size,
      vertexPayloadBytes:r.vertexPayload.size}});
}

function createGeometryData(workload:SparseCandidateWorkload,layout:WorkloadLayout){
  if(workload==="basic-cube"||workload==="lifecycle-resize")return createCubeGeometryData(layout);
  if(workload==="rendering-lab-fixed")return createRenderingLabGeometryData(layout);
  if(workload==="unlit-vertex-color"||workload==="unlit-texture")return createPlanarUnlitGeometryData(layout,workload);
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

function createCubeGeometryData(layout:WorkloadLayout){
  const geometryRecords=new Uint8Array(layout.geometryCount*GPU_GEOMETRY_RECORD_STRIDE);
  const meshletRecords=new Uint8Array(layout.meshletCount*GPU_MESHLET_RECORD_STRIDE);
  const meshletVertices=new Uint32Array(layout.vertexCount);
  const meshletTriangles=new Uint8Array(layout.triangleBytes);
  const vertexStream=new ArrayBuffer(layout.vertexCount*VERTEX_STRIDE),floats=new Float32Array(vertexStream);
  const positions=Object.freeze([[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]] as const);
  for(let vertex=0;vertex<positions.length;vertex++){
    meshletVertices[vertex]=vertex;const base=vertex*VERTEX_STRIDE/4;floats.set(positions[vertex]!,base);
    floats.set([0,0],base+3);floats.set([0,0,1,0],base+5);floats.set([1,0,0,1],base+9);floats.set([1,1,1,1],base+13);
  }
  meshletTriangles.set([4,5,6,4,6,7, 0,2,1,0,3,2, 0,4,7,0,7,3,
    1,2,6,1,6,5, 3,7,6,3,6,2, 0,1,5,0,5,4]);
  geometryRecords.set(packGpuGeometryRecord({boundsSphere:[0,0,0,Math.sqrt(3)],boundsMin:[-1,-1,-1,0],boundsMax:[1,1,1,0],
    vertexCount:layout.vertexCount,indexBegin:0,indexCount:CUBE_TRIANGLE_COUNT*3,meshletBegin:0,meshletCount:1,
    clusterBegin:0,clusterRoot:0,clusterCount:0,bvhBegin:0,bvhRoot:0,bvhCount:0,materialRangeBegin:0,materialRangeCount:1,
    streamDescriptorBegin:0,streamDescriptorCount:4,vertexDataByteBegin:0,vertexDataByteLength:vertexStream.byteLength,
    positionByteOffset:0,positionStride:VERTEX_STRIDE,positionFormat:GPU_POSITION_FORMAT.Float32x3,flags:0,
    uv0ByteOffset:12,uv0Stride:VERTEX_STRIDE,uv0Format:GPU_UV_FORMAT.Float32x2,uv1ByteOffset:0,uv1Stride:0,uv1Format:0,
    uv2ByteOffset:0,uv2Stride:0,uv2Format:0,normalDescriptor:1,tangentDescriptor:2,colorDescriptor:3,
    normalByteOffset:20,normalStride:VERTEX_STRIDE,normalFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,normalNormalized:0,
    tangentByteOffset:36,tangentStride:VERTEX_STRIDE,tangentFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,tangentNormalized:0,
    colorByteOffset:52,colorStride:VERTEX_STRIDE,colorFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,colorNormalized:0}));
  meshletRecords.set(packGpuMeshletRecords([{vertexOffset:0,vertexCount:layout.vertexCount,triangleByteOffset:0,
    triangleCount:CUBE_TRIANGLE_COUNT,materialRangeIndex:0,materialId:0,flags:0,boundsMin:[-1,-1,-1,0],boundsMax:[1,1,1,0],
    boundsSphere:[0,0,0,Math.sqrt(3)],coneApex:[0,0,0,0],coneAxisCutoff:[0,0,1,1]}]));
  const assetMetadata=new Uint8Array(geometryRecords.byteLength+meshletRecords.byteLength+4);
  assetMetadata.set(geometryRecords);assetMetadata.set(meshletRecords,geometryRecords.byteLength);
  new DataView(assetMetadata.buffer).setUint32(geometryRecords.byteLength+meshletRecords.byteLength,GEOMETRY_GENERATION,true);
  const vertexPayload=new Uint8Array(meshletVertices.byteLength+meshletTriangles.byteLength+vertexStream.byteLength);
  vertexPayload.set(new Uint8Array(meshletVertices.buffer));vertexPayload.set(meshletTriangles,meshletVertices.byteLength);
  vertexPayload.set(new Uint8Array(vertexStream),meshletVertices.byteLength+meshletTriangles.byteLength);
  return {geometryRecords,meshletRecords,meshletVertices,meshletTriangles,vertexStream,assetMetadata,vertexPayload};
}

function createRenderingLabGeometryData(layout:WorkloadLayout){
  const geometryRecords=new Uint8Array(layout.geometryCount*GPU_GEOMETRY_RECORD_STRIDE);
  const meshletRecords=new Uint8Array(layout.meshletCount*GPU_MESHLET_RECORD_STRIDE);
  const meshletVertices=new Uint32Array(layout.vertexCount),meshletTriangles=new Uint8Array(layout.triangleBytes);
  const vertexStream=new ArrayBuffer(layout.vertexCount*VERTEX_STRIDE),floats=new Float32Array(vertexStream);
  const positions=Object.freeze([[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]] as const);
  const triangles=Object.freeze([4,5,6,4,6,7,0,2,1,0,3,2,0,4,7,0,7,3,1,2,6,1,6,5,3,7,6,3,6,2,0,1,5,0,5,4]);
  for(let geometry=0;geometry<layout.geometryCount;geometry++){
    const vertexBase=geometry*CUBE_VERTEX_COUNT,vertexByteBase=vertexBase*VERTEX_STRIDE;
    const triangleByteBase=geometry*CUBE_TRIANGLE_COUNT*3;
    for(let vertex=0;vertex<CUBE_VERTEX_COUNT;vertex++){
      meshletVertices[vertexBase+vertex]=vertex;const base=(vertexByteBase+vertex*VERTEX_STRIDE)/4;
      const position=positions[vertex]!;floats.set(position,base);
      floats.set([(position[0]+1)*0.5,1-(position[1]+1)*0.5],base+3);
      const inverse=1/Math.sqrt(3);floats.set([position[0]*inverse,position[1]*inverse,position[2]*inverse,0],base+5);
      floats.set([1,0,0,1],base+9);floats.set([1,1,1,1],base+13);
    }
    meshletTriangles.set(triangles,triangleByteBase);
    geometryRecords.set(packGpuGeometryRecord({boundsSphere:[0,0,0,Math.sqrt(3)],boundsMin:[-1,-1,-1,0],boundsMax:[1,1,1,0],
      vertexCount:CUBE_VERTEX_COUNT,indexBegin:0,indexCount:CUBE_TRIANGLE_COUNT*3,meshletBegin:geometry,meshletCount:1,
      clusterBegin:0,clusterRoot:0,clusterCount:0,bvhBegin:0,bvhRoot:0,bvhCount:0,materialRangeBegin:0,materialRangeCount:1,
      streamDescriptorBegin:0,streamDescriptorCount:4,vertexDataByteBegin:vertexByteBase,vertexDataByteLength:CUBE_VERTEX_COUNT*VERTEX_STRIDE,
      positionByteOffset:vertexByteBase,positionStride:VERTEX_STRIDE,positionFormat:GPU_POSITION_FORMAT.Float32x3,flags:0,
      uv0ByteOffset:vertexByteBase+12,uv0Stride:VERTEX_STRIDE,uv0Format:GPU_UV_FORMAT.Float32x2,
      uv1ByteOffset:0,uv1Stride:0,uv1Format:0,uv2ByteOffset:0,uv2Stride:0,uv2Format:0,
      normalDescriptor:1,tangentDescriptor:2,colorDescriptor:3,normalByteOffset:vertexByteBase+20,normalStride:VERTEX_STRIDE,
      normalFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,normalNormalized:0,tangentByteOffset:vertexByteBase+36,
      tangentStride:VERTEX_STRIDE,tangentFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,tangentNormalized:0,
      colorByteOffset:vertexByteBase+52,colorStride:VERTEX_STRIDE,colorFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,
      colorNormalized:0}),geometry*GPU_GEOMETRY_RECORD_STRIDE);
    meshletRecords.set(packGpuMeshletRecords([{vertexOffset:vertexBase,vertexCount:CUBE_VERTEX_COUNT,
      triangleByteOffset:triangleByteBase,triangleCount:CUBE_TRIANGLE_COUNT,materialRangeIndex:0,materialId:geometry,flags:0,
      boundsMin:[-1,-1,-1,0],boundsMax:[1,1,1,0],boundsSphere:[0,0,0,Math.sqrt(3)],coneApex:[0,0,0,0],
      coneAxisCutoff:[0,0,1,1]}]),geometry*GPU_MESHLET_RECORD_STRIDE);
  }
  const assetMetadata=new Uint8Array(geometryRecords.byteLength+meshletRecords.byteLength+layout.geometryCount*4);
  assetMetadata.set(geometryRecords);assetMetadata.set(meshletRecords,geometryRecords.byteLength);
  new Uint32Array(assetMetadata.buffer,geometryRecords.byteLength+meshletRecords.byteLength).fill(GEOMETRY_GENERATION);
  const vertexPayload=new Uint8Array(meshletVertices.byteLength+meshletTriangles.byteLength+vertexStream.byteLength);
  vertexPayload.set(new Uint8Array(meshletVertices.buffer));vertexPayload.set(meshletTriangles,meshletVertices.byteLength);
  vertexPayload.set(new Uint8Array(vertexStream),meshletVertices.byteLength+meshletTriangles.byteLength);
  return {geometryRecords,meshletRecords,meshletVertices,meshletTriangles,vertexStream,assetMetadata,vertexPayload};
}

const VERTEX_COLOR_POSITIONS=Object.freeze([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]] as const);
const VERTEX_COLOR_VALUES=Object.freeze([[1,0,0,1],[0,1,0,1],[0,0,1,1],[1,1,1,1]] as const);
const VERTEX_COLOR_TRIANGLES=Object.freeze([[0,1,2],[0,2,3]] as const);
const UNLIT_TEXTURE_UVS=Object.freeze([[0,1],[1,1],[1,0],[0,0]] as const);

function createPlanarUnlitGeometryData(layout:WorkloadLayout,workload:SparseCandidateWorkload){
  const geometryRecords=new Uint8Array(GPU_GEOMETRY_RECORD_STRIDE),meshletRecords=new Uint8Array(GPU_MESHLET_RECORD_STRIDE);
  const meshletVertices=new Uint32Array(layout.vertexCount),meshletTriangles=new Uint8Array(layout.triangleBytes);
  const vertexStream=new ArrayBuffer(layout.vertexCount*VERTEX_STRIDE),floats=new Float32Array(vertexStream);
  for(let vertex=0;vertex<VERTEX_COLOR_POSITIONS.length;vertex++){
    meshletVertices[vertex]=vertex;const base=vertex*VERTEX_STRIDE/4;floats.set(VERTEX_COLOR_POSITIONS[vertex]!,base);
    floats.set(workload==="unlit-texture"?UNLIT_TEXTURE_UVS[vertex]!:[0,0],base+3);
    floats.set([0,0,1,0],base+5);floats.set([1,0,0,1],base+9);
    floats.set(workload==="unlit-vertex-color"?VERTEX_COLOR_VALUES[vertex]!:[1,1,1,1],base+13);
  }
  meshletTriangles.set(VERTEX_COLOR_TRIANGLES.flat());
  geometryRecords.set(packGpuGeometryRecord({boundsSphere:[0,0,0,Math.sqrt(2)],boundsMin:[-1,-1,0,0],boundsMax:[1,1,0,0],
    vertexCount:layout.vertexCount,indexBegin:0,indexCount:VERTEX_COLOR_TRIANGLE_COUNT*3,meshletBegin:0,meshletCount:1,
    clusterBegin:0,clusterRoot:0,clusterCount:0,bvhBegin:0,bvhRoot:0,bvhCount:0,materialRangeBegin:0,materialRangeCount:1,
    streamDescriptorBegin:0,streamDescriptorCount:4,vertexDataByteBegin:0,vertexDataByteLength:vertexStream.byteLength,
    positionByteOffset:0,positionStride:VERTEX_STRIDE,positionFormat:GPU_POSITION_FORMAT.Float32x3,flags:0,
    uv0ByteOffset:12,uv0Stride:VERTEX_STRIDE,uv0Format:GPU_UV_FORMAT.Float32x2,uv1ByteOffset:0,uv1Stride:0,uv1Format:0,
    uv2ByteOffset:0,uv2Stride:0,uv2Format:0,normalDescriptor:1,tangentDescriptor:2,colorDescriptor:3,
    normalByteOffset:20,normalStride:VERTEX_STRIDE,normalFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,normalNormalized:0,
    tangentByteOffset:36,tangentStride:VERTEX_STRIDE,tangentFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,tangentNormalized:0,
    colorByteOffset:52,colorStride:VERTEX_STRIDE,colorFormat:GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,colorNormalized:0}));
  meshletRecords.set(packGpuMeshletRecords([{vertexOffset:0,vertexCount:layout.vertexCount,triangleByteOffset:0,
    triangleCount:VERTEX_COLOR_TRIANGLE_COUNT,materialRangeIndex:0,materialId:0,flags:0,boundsMin:[-1,-1,0,0],boundsMax:[1,1,0,0],
    boundsSphere:[0,0,0,Math.sqrt(2)],coneApex:[0,0,0,0],coneAxisCutoff:[0,0,1,1]}]));
  const assetMetadata=new Uint8Array(geometryRecords.byteLength+meshletRecords.byteLength+4);
  assetMetadata.set(geometryRecords);assetMetadata.set(meshletRecords,geometryRecords.byteLength);
  new DataView(assetMetadata.buffer).setUint32(geometryRecords.byteLength+meshletRecords.byteLength,GEOMETRY_GENERATION,true);
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
function createInstances(workload:SparseCandidateWorkload):Uint8Array {
  if(workload==="rendering-lab-fixed"){
    const transforms=[affineTransform(0.55,0.55,0.55,-2.1,-0.65,-0.3),affineTransform(0.65,0.9,0.2,2,-0.3,-0.5),
      affineTransform(3.8,0.18,3.8,0,-1.75,0),affineTransform(0.95,0.95,0.95,0,0,0.35)];
    const output=new Uint8Array(RENDERING_LAB_PROGRAMS.length*GPU_INSTANCE_RECORD_STRIDE);
    for(let index=0;index<RENDERING_LAB_PROGRAMS.length;index++)output.set(packGpuInstanceRecord({geometryRecordIndex:index,geometryGeneration:GEOMETRY_GENERATION,
      materialHandle:index,flags:GPU_MESHLET_RASTER_FLAGS.DoubleSided|GPU_INSTANCE_FLAGS.CastsShadow,debugId:index+1,
      boundsSphere:[0,0,0,Math.sqrt(3)],boundsMin:[-1,-1,-1],boundsMax:[1,1,1],
      currentObjectToWorld:transforms[index]!,previousObjectToWorld:transforms[index]!}),index*GPU_INSTANCE_RECORD_STRIDE);
    return output;
  }
  if(workload!=="mixed-bins")return new Uint8Array(packGpuInstanceRecord({geometryRecordIndex:0,geometryGeneration:GEOMETRY_GENERATION,materialHandle:0,
    flags:GPU_MESHLET_RASTER_FLAGS.DoubleSided,debugId:1,
    boundsSphere:[0,0,0,workload==="basic-cube"||workload==="lifecycle-resize"?Math.sqrt(3):Math.sqrt(2)],
    boundsMin:[-1,-1,workload==="basic-cube"||workload==="lifecycle-resize"?-1:0],
    boundsMax:[1,1,workload==="basic-cube"||workload==="lifecycle-resize"?1:0],
    currentObjectToWorld:IDENTITY,previousObjectToWorld:IDENTITY}));
  const output=new Uint8Array(GPU_SHADING_PROGRAM_COUNT*GPU_INSTANCE_RECORD_STRIDE);
  for(let program=0;program<GPU_SHADING_PROGRAM_COUNT;program++)output.set(packGpuInstanceRecord({geometryRecordIndex:program,geometryGeneration:GEOMETRY_GENERATION,
    materialHandle:program,flags:GPU_MESHLET_RASTER_FLAGS.DoubleSided,debugId:program+1,boundsSphere:[WIDTH/2,HEIGHT/2,1,181],
    boundsMin:[0,0,1],boundsMax:[WIDTH,HEIGHT,1],currentObjectToWorld:IDENTITY,previousObjectToWorld:IDENTITY}),
    program*GPU_INSTANCE_RECORD_STRIDE);return output;}
function affineTransform(sx:number,sy:number,sz:number,tx:number,ty:number,tz:number):Float32Array{return new Float32Array([
  sx,0,0,0,0,sy,0,0,0,0,sz,0,tx,ty,tz,1]);}
function createMeshletQueue(snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,workload:SparseCandidateWorkload):Uint8Array{
  if(workload!=="mixed-bins"&&workload!=="rendering-lab-fixed"){
    const association=snapshot.associations[0];if(association===undefined)throw new Error(`Missing ${workload} publication association`);
    const output=new Uint8Array(GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE+GPU_MESHLET_RASTER_WORK_RECORD_STRIDE);
    output.set(packGpuMeshletWorkQueueHeader({attemptedCount:1,writtenCount:1,consumedCount:1,capacity:1,overflowCount:0,
      generation:snapshot.generation,invalidCount:0}));
    output.set(packGpuMeshletRasterWork({instanceSlot:0,geometrySlot:0,meshletSlot:0,materialSlotOrRange:0,
      packedRasterFlags:GPU_MESHLET_RASTER_FLAGS.DoubleSided|(association.identity.binId<<8),
      packedProfileLod:packGpuMeshletProfileLodBucket(2,0,BUCKET,0)}),GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE);return output;
  }
  const programs=workloadProgramIds(workload),output=new Uint8Array(GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE+
    programs.length*GPU_MESHLET_RASTER_WORK_RECORD_STRIDE);
  output.set(packGpuMeshletWorkQueueHeader({attemptedCount:programs.length,writtenCount:programs.length,
    consumedCount:programs.length,capacity:programs.length,overflowCount:0,generation:snapshot.generation,
    invalidCount:0}));const byProgram=new Map(snapshot.associations.map((entry)=>[entry.identity.programId,entry]));
  for(let index=0;index<programs.length;index++){const program=programs[index]!,association=byProgram.get(program);
    if(association===undefined)throw new Error(`Missing ${workload} publication for program ${program}`);
    output.set(packGpuMeshletRasterWork({instanceSlot:index,geometrySlot:index,meshletSlot:index,materialSlotOrRange:index,
      packedRasterFlags:GPU_MESHLET_RASTER_FLAGS.DoubleSided|(association.identity.binId<<8),
      packedProfileLod:packGpuMeshletProfileLodBucket(2,0,BUCKET,0)}),GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE+
      index*GPU_MESHLET_RASTER_WORK_RECORD_STRIDE);}return output;}
function createBucketStates(layout:WorkloadLayout):Uint32Array{const output=new Uint32Array(GPU_MESHLET_DRAW_COUNT*GPU_MESHLET_BUCKET_STATE_STRIDE/4);
  output.set([layout.workCount,0,layout.workCount,0],BUCKET*4);return output;}
function createDrawIndirect(workload:SparseCandidateWorkload,layout:WorkloadLayout):Uint32Array{
  const output=new Uint32Array(GPU_MESHLET_DRAW_COUNT*GPU_MESHLET_DRAW_INDIRECT_STRIDE/4);
  output.set([workloadTriangleCount(workload)*3,layout.workCount,0,0],BUCKET*4);return output;}
function createBucketSettings(device:GPUDevice):Uint32Array{const output=new Uint32Array(GPU_MESHLET_DRAW_COUNT*MESHLET_BUCKET_SETTINGS_STRIDE/4);
  for(let bucket=0;bucket<GPU_MESHLET_DRAW_COUNT;bucket++){const base=bucket*MESHLET_BUCKET_SETTINGS_STRIDE/4;output[base]=bucket;
    output[base+1]=device.features.has("indirect-first-instance")?1:0;}return output;}

function createMaterials(snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,workload:SparseCandidateWorkload){
  const programs=workloadProgramIds(workload),count=programs.length;
  const shading=new Uint8Array(count*GPU_SHADING_MATERIAL_RECORD_STRIDE);
  const routes=new Uint8Array(count*GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL*GPU_SHADING_TEXTURE_ROUTE_STRIDE);
  for(let materialSlot=0;materialSlot<count;materialSlot++){const program=programs[materialSlot]!;
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
    shading.set(packGpuShadingMaterialRecord({programId:program,textureBindingSetId:set,materialGeneration:MATERIAL_GENERATION,
      textureGeneration:TEXTURE_GENERATION,publicationRevision:snapshot.revision,flags:0},payload),
      materialSlot*GPU_SHADING_MATERIAL_RECORD_STRIDE);
    [base,normal,orm,emissive,GPU_TEXTURE_REF_INVALID].forEach((textureRef,textureSlot)=>routes.set(packGpuShadingTextureRoute({textureRef,
      textureGeneration:TEXTURE_GENERATION,publicationRevision:snapshot.revision,textureBindingSetId:set}),
      (materialSlot*GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL+textureSlot)*GPU_SHADING_TEXTURE_ROUTE_STRIDE));
  }return {shading,routes};
}
function materialPayload(flags:number,set:number,base:number,normal:number,orm:number,emissive:number){return {
  reserved0:0,alphaMode:0,flags,textureRef:base,baseColorFactorAlpha:1,alphaCutoff:0.5,textureUvSets:0,samplerClass:0,
  uvOffset:[0,0] as const,uvScale:[1,1] as const,rotationCos:1,rotationSin:0,baseColorFactor:[0.8,0.5,0.25,1] as const,
  metallicFactor:0.4,perceptualRoughness:0.6,normalScale:1,occlusionStrength:0.75,emissiveFactor:[0.1,0.2,0.3,1] as const,
  normalTextureRef:normal,ormTextureRef:orm,emissiveTextureRef:emissive,textureSamplerClasses:0,
  normalUvOffset:[0,0] as const,normalUvScale:[1,1] as const,normalRotationCos:1,normalRotationSin:0,
  ormUvOffset:[0,0] as const,ormUvScale:[1,1] as const,ormRotationCos:1,ormRotationSin:0,
  emissiveUvOffset:[0,0] as const,emissiveUvScale:[1,1] as const,emissiveRotationCos:1,emissiveRotationSin:0,
  textureBindingSetId:set,occlusionTextureRef:GPU_TEXTURE_REF_INVALID,occlusionUvSet:0,
  occlusionUvOffset:[0,0] as const,occlusionUvScale:[1,1] as const,
  occlusionRotationCos:1,occlusionRotationSin:0};}

function createPrepared(r:CandidateResources):PreparedMeshletWorkCandidate {
  return Object.freeze({queue:r.queue,bucketStates:r.bucketStates,drawIndirect:r.drawIndirect,
    bucketSettings:r.bucketSettings,bucketCount:GPU_MESHLET_DRAW_COUNT,compactionPath:"portable",capacity:r.layout.workCount
  }) as PreparedMeshletWorkCandidate;
}

function createAssetBindings(r:CandidateResources):GpuAssetBindings {
  const zero={geometryRecords:r.layout.geometryCount,meshletRecords:r.layout.meshletCount,clusterRecords:0,
    bvh8Nodes:0,vertexStreamDescriptors:0,materialRanges:0,vertexStreamBytes:r.vertexStreamData.size,indices:0,
    meshletVertexIndices:r.layout.vertexCount,meshletTriangleBytes:r.layout.triangleBytes,clusterChildren:0};
  return Object.freeze({abiVersion:1,epoch:1,geometryRecords:r.geometryRecords,meshletRecords:r.meshletRecords,
    clusterRecords:r.geometryRecords,bvh8Nodes:r.geometryRecords,vertexStreamDescriptors:r.geometryRecords,
    materialRanges:r.geometryRecords,vertexStreamData:r.vertexStreamData,indices:r.meshletVertexIndices,
    meshletVertexIndices:r.meshletVertexIndices,meshletTriangleIndices:r.meshletTriangleIndices,
    clusterChildren:r.meshletVertexIndices,sparseShading:Object.freeze({schemaVersion:1,epoch:1,
      assetMetadataHeap:r.assetMetadata,vertexPayloadHeap:r.vertexPayload,geometryWordBase:0,
      meshletWordBase:r.layout.geometryCount*GPU_GEOMETRY_RECORD_STRIDE/4,
      geometryGenerationWordBase:(r.layout.geometryCount*GPU_GEOMETRY_RECORD_STRIDE+
        r.layout.meshletCount*GPU_MESHLET_RECORD_STRIDE)/4,
      meshletVertexWordBase:0,meshletTriangleWordBase:r.layout.vertexCount,
      vertexDataWordBase:r.layout.vertexCount+r.layout.triangleBytes/4,
      geometryCount:r.layout.geometryCount,meshletCount:r.layout.meshletCount,
      assetMetadataBytes:r.assetMetadata.size,vertexPayloadBytes:r.vertexPayload.size}),
    highWaterCounts:Object.freeze(zero)});
}

function createSceneBindings(r:CandidateResources):GpuSceneBindings {
  return Object.freeze({abiVersion:1,resourceEpoch:1,contentRevision:1,instances:r.instances,
    recordStride:GPU_INSTANCE_RECORD_STRIDE,highWaterCount:r.layout.instanceCount,activeCount:r.layout.instanceCount});
}

function createRenderWorld(r:CandidateResources,
  publication:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>):GpuRenderWorldRuntime {
  const banks=r.textureBankViews as [GPUTextureView,GPUTextureView,GPUTextureView,GPUTextureView,GPUTextureView,
    GPUTextureView,GPUTextureView,GPUTextureView,GPUTextureView];
  const program=workloadProgramIds(r.workload)[0]??0,bindingSetId=shadingProgramUsesTextures(program)?materialProfile(program).textureBindingSetId:0;
  const materialBinSlots=new Uint32Array(r.layout.materialCount*64);materialBinSlots.fill(0xffffffff);
  workloadProgramIds(r.workload).forEach((programId,materialIndex)=>{const profile=materialProfile(programId);
    const set=shadingProgramUsesTextures(programId)?profile.textureBindingSetId:0;
    materialBinSlots[materialIndex*64+((set<<4)|programId)]=materialIndex;});
  return Object.freeze({handle:{},scene:{},sourceKind:"packed",assetHandles:[],instanceHandle:{},materials:[],
    opaqueMaterialCount:r.layout.materialCount,materialPublication:{},
    materialBinSlots,
    materialDictionaryCount:r.layout.materialCount,materialGeneration:MATERIAL_GENERATION,
    textureGeneration:TEXTURE_GENERATION,materialPublicationRevision:publication.revision,
    materialResources:Object.freeze({abiVersion:1,materialCapacity:r.layout.materialCount,
      materialRecords:r.shadingMaterials,textureRouteRecords:r.routes,textureCapacity:5,
      bindingSets:Object.freeze([{id:bindingSetId,generation:TEXTURE_GENERATION,
        textureBanks:banks,bankDescriptors:Object.freeze([])}])}),instanceBegin:0,instanceCount:r.layout.instanceCount,transparentInstanceCount:0,
    activeShadingSummary:publication.summary,hierarchyTraversalCapacity:r.layout.workCount,
    hierarchyVisibleClusterCapacity:r.layout.workCount,hierarchyRasterWorkCapacity:r.layout.workCount,counterSink:r.queue}) as unknown as GpuRenderWorldRuntime;
}

function resolveBinding(name:string,frame:Readonly<SparseShadingCandidateFrame>,resources:PassResources,r:CandidateResources,
  bins:ShadingBinPass|null,settings:GPUBuffer|null,status:GPUBuffer|null):GPUBindingResource {
  const buffers:Readonly<Record<string,GPUBuffer|undefined>>={shading_bin_settings:settings??undefined,
    shading_bin_heap:bins?.heap,shading_frame_status:status??undefined,
    shading_view:r.shadingView,meshlet_work:r.queue,instance_records:r.instances,asset_metadata_heap:r.assetMetadata,
    vertex_payload_heap:r.vertexPayload,material_records:r.shadingMaterials,texture_descriptor_routing_heap:r.routes};
  const direct=buffers[name];if(direct!==undefined)return {buffer:direct};
  const optionalBuffers:Readonly<Record<string,GPUBuffer|null>>={light_database:r.lightDatabase,
    light_cluster_lookup:r.clusterHeaders,light_cluster_data:r.clusterIndices,
    light_cluster_parameters:r.lightSettings};
  if(name in optionalBuffers)return {buffer:requireResource(optionalBuffers[name]??null,name)};
  if(name==="shading_bin_id")return textureView(frame.shadingBinId,resources);
  if(name==="visibility_key")return textureView(frame.visibilityKey,resources);
  if(name==="visibility_depth")return textureView(frame.depth,resources,{aspect:"depth-only"});
  if(name==="output_hdr")return textureView(frame.hdr,resources);
  if(name==="output_normal")return textureView(frame.normal,resources);
  if(name==="output_albedo_ao")return textureView(frame.albedoAo,resources);
  if(name==="output_material")return textureView(frame.material,resources);
  if(name==="output_velocity")return textureView(frame.velocity,resources);
  if(name.startsWith("material_texture_"))return r.textureBankViews[Number(name.slice(-1))]!;
  if(name.startsWith("material_sampler_"))return r.materialSamplers[Number(name.slice(-1))]!;
  if(name==="shadow_atlas")return requireResource(r.renderingLab,"RenderingLab resources").shadowAtlas.createView({aspect:"depth-only"});
  if(name==="shadow_sampler")return requireResource(r.renderingLab,"RenderingLab resources").shadowSampler;
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
  if(id.x<256u){headers[id.x]=ClusterHeader(0u,0u,0u,0u);}if(id.x<9u){indices[id.x]=0u;}
}`}}} as const;
function clusterPipelineDescriptor(){return CLUSTER_PIPELINE_DESCRIPTOR;}

async function createRenderingLabShadowPipeline(device:GPUDevice):Promise<Readonly<{
  pipeline:GPURenderPipeline;messages:readonly Readonly<{type:string;lineNum:number;linePos:number;message:string}>[]}>> {
  const code=/* wgsl */`
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
@group(0) @binding(0) var<storage,read> work_queue: OEngineMeshletWorkQueueRead;
@group(0) @binding(1) var<storage,read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage,read> geometries: array<GpuGeometryRecord>;
@group(0) @binding(3) var<storage,read> meshlets: array<GpuMeshletRecord>;
@group(0) @binding(4) var<storage,read> meshlet_vertices: array<u32>;
@group(0) @binding(5) var<storage,read> meshlet_triangles: array<u32>;
@group(0) @binding(6) var<storage,read> vertex_data: array<u32>;
@group(0) @binding(7) var<uniform> shadow_view_projection: mat4x4f;
fn read_u8(byte_offset:u32)->u32 {let word=meshlet_triangles[byte_offset>>2u];
  return (word>>((byte_offset&3u)*8u))&0xffu;}
@vertex fn main(@builtin(vertex_index) vertex_index:u32,@builtin(instance_index) work_index:u32)
  -> @builtin(position) vec4f {
  let work=work_queue.elements[work_index];let instance=instances[work.instance_slot];
  let geometry=geometries[work.geometry_slot];let meshlet=meshlets[work.meshlet_slot];
  let triangle=vertex_index/3u;let corner=vertex_index%3u;let valid=triangle<meshlet.triangle_count;
  let safe_triangle=min(triangle,max(meshlet.triangle_count,1u)-1u);
  let local_vertex=read_u8(meshlet.triangle_byte_offset+safe_triangle*3u+corner);
  let source_vertex=meshlet_vertices[meshlet.vertex_offset+local_vertex];
  let position=oengine_geometry_position(&vertex_data,geometry,source_vertex);
  return select(vec4f(2.0,2.0,2.0,1.0),shadow_view_projection*
    oengine_instance_current_object_to_world(instance)*vec4f(position,1.0),valid);
}`;
  const module=device.createShaderModule({label:"ADR-0013 RenderingLab fixed shadow raster",code});
  const info=await module.getCompilationInfo(),messages=Object.freeze(info.messages.map((entry)=>Object.freeze({
    type:entry.type,lineNum:entry.lineNum,linePos:entry.linePos,message:entry.message})));
  const errors=messages.filter((entry)=>entry.type==="error");if(errors.length>0)throw new Error(
    `RenderingLab shadow WGSL failed: ${errors.map((entry)=>`${entry.lineNum}:${entry.linePos} ${entry.message}`).join(" | ")}`);
  const pipeline=await device.createRenderPipelineAsync({label:"ADR-0013 RenderingLab fixed shadow raster",layout:"auto",
    vertex:{module,entryPoint:"main"},primitive:{topology:"triangle-list",cullMode:"none"},
    depthStencil:{format:"depth32float",depthWriteEnabled:true,depthCompare:"greater",depthBias:2,depthBiasSlopeScale:1}});
  return Object.freeze({pipeline,messages});
}

async function createOraclePipelines(device:GPUDevice,binIds:readonly number[],workload:SparseCandidateWorkload,
  directSingle=false) {
  const expectedCount=workload==="mixed-bins"?GPU_SHADING_PROGRAM_COUNT:
    workload==="rendering-lab-fixed"?RENDERING_LAB_PROGRAMS.length:1,triangleCount=workloadTriangleCount(workload);
  if(binIds.length!==expectedCount)throw new Error(`${workload} expected ${expectedCount} active shading programs`);
  const bins=binIds.map((value)=>`${value}u`).join(",");
  const validateSource=workload==="mixed-bins"?`
const WIDTH:u32=${WIDTH}u; const HEIGHT:u32=${HEIGHT}u;
const BINS:array<u32,${GPU_SHADING_PROGRAM_COUNT}>=array<u32,${GPU_SHADING_PROGRAM_COUNT}>(${bins});
@group(0) @binding(0) var visibility:texture_2d<u32>;
@group(0) @binding(1) var bin_ids:texture_2d<u32>;
@group(0) @binding(2) var hdr:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> output:array<atomic<u32>>;
@compute @workgroup_size(8,8) fn validate(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=textureDimensions(visibility))){return;} atomicAdd(&output[0],1u);
  let program=(id.x/2u)%${GPU_SHADING_PROGRAM_COUNT}u; let key=textureLoad(visibility,vec2u(id.xy),0).x;
  let bin_id=textureLoad(bin_ids,vec2u(id.xy),0).x; let color=textureLoad(hdr,vec2u(id.xy),0);
  if(key==0xffffffffu){atomicAdd(&output[1],1u);} if((key&0x00ffffffu)!=program){atomicAdd(&output[2],1u);}
  if(bin_id!=BINS[program]){atomicAdd(&output[3],1u);} if((key>>24u)>=${TRIANGLES_PER_PROGRAM}u){atomicAdd(&output[4],1u);}
  if(any(color!=color)||any(abs(color)>vec4f(65504.0))){atomicAdd(&output[5],1u);}
  if(abs(color.a-1.0)>0.001){atomicAdd(&output[6],1u);}
}`:workload==="rendering-lab-fixed"?`
const WIDTH:u32=${WIDTH}u;const HEIGHT:u32=${HEIGHT}u;
const BINS:array<u32,${RENDERING_LAB_PROGRAMS.length}>=array<u32,${RENDERING_LAB_PROGRAMS.length}>(${bins});
@group(0) @binding(0) var visibility:texture_2d<u32>;
@group(0) @binding(1) var bin_ids:texture_2d<u32>;
@group(0) @binding(2) var hdr:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> output:array<atomic<u32>>;
@compute @workgroup_size(8,8) fn validate(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=textureDimensions(visibility))){return;}atomicAdd(&output[0],1u);
  let key=textureLoad(visibility,vec2u(id.xy),0).x;let bin_id=textureLoad(bin_ids,vec2u(id.xy),0).x;
  let color=textureLoad(hdr,vec2u(id.xy),0);let valid=key!=0xffffffffu;
  if(valid){atomicAdd(&output[7],1u);let work=key&0x00ffffffu;
    if(work>=${RENDERING_LAB_PROGRAMS.length}u){atomicAdd(&output[1],1u);
    }else if(bin_id!=BINS[work]){atomicAdd(&output[2],1u);}
    if((key>>24u)>=${CUBE_TRIANGLE_COUNT}u){atomicAdd(&output[3],1u);}
    if(any(color!=color)||any(abs(color)>vec4f(65504.0))){atomicAdd(&output[4],1u);}
    if(color.a<0.0||color.a>1.001){atomicAdd(&output[5],1u);}
  }else{if(bin_id!=${GPU_SHADING_BIN_INVALID_ID}u){atomicAdd(&output[6],1u);}
    if(any(color!=color)||any(abs(color)>vec4f(65504.0))){atomicAdd(&output[8],1u);}}
}`:directSingle?`
const WIDTH:u32=${WIDTH}u; const HEIGHT:u32=${HEIGHT}u;
@group(0) @binding(0) var visibility:texture_2d<u32>;
@group(0) @binding(1) var reserved:texture_2d<u32>;
@group(0) @binding(2) var hdr:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> output:array<atomic<u32>>;
@compute @workgroup_size(8,8) fn validate(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=textureDimensions(visibility))){return;} atomicAdd(&output[0],1u);
  let key=textureLoad(visibility,vec2u(id.xy),0).x; let color=textureLoad(hdr,vec2u(id.xy),0);
  let valid=key!=0xffffffffu;
  if(valid){atomicAdd(&output[7],1u);if((key&0x00ffffffu)!=0u){atomicAdd(&output[1],1u);}
    if((key>>24u)>=${triangleCount}u){atomicAdd(&output[3],1u);}
    if(any(color!=color)||any(abs(color)>vec4f(65504.0))){atomicAdd(&output[4],1u);}
    if(abs(color.a-1.0)>0.001){atomicAdd(&output[5],1u);}
  }else{if(any(abs(color)>vec4f(0.00001))){atomicAdd(&output[8],1u);}}
}`:`
const WIDTH:u32=${WIDTH}u; const HEIGHT:u32=${HEIGHT}u; const EXPECTED_BIN:u32=${binIds[0]}u;
@group(0) @binding(0) var visibility:texture_2d<u32>;
@group(0) @binding(1) var bin_ids:texture_2d<u32>;
@group(0) @binding(2) var hdr:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> output:array<atomic<u32>>;
@compute @workgroup_size(8,8) fn validate(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=textureDimensions(visibility))){return;} atomicAdd(&output[0],1u);
  let key=textureLoad(visibility,vec2u(id.xy),0).x;let bin_id=textureLoad(bin_ids,vec2u(id.xy),0).x;
  let color=textureLoad(hdr,vec2u(id.xy),0);let valid=key!=0xffffffffu;
  if(valid){atomicAdd(&output[7],1u);if((key&0x00ffffffu)!=0u){atomicAdd(&output[1],1u);}
    if(bin_id!=EXPECTED_BIN){atomicAdd(&output[2],1u);}if((key>>24u)>=${triangleCount}u){atomicAdd(&output[3],1u);}
    if(any(color!=color)||any(abs(color)>vec4f(65504.0))){atomicAdd(&output[4],1u);}
    if(abs(color.a-1.0)>0.001){atomicAdd(&output[5],1u);}
  }else{if(bin_id!=${GPU_SHADING_BIN_INVALID_ID}u){atomicAdd(&output[6],1u);}
    if(any(abs(color)>vec4f(0.00001))){atomicAdd(&output[8],1u);}}
}`;
  const label=workload==="mixed-bins"?"MixedBins":workload==="basic-cube"?"BasicCube":
    workload==="unlit-vertex-color"?"UnlitVertexColor":workload==="unlit-texture"?"UnlitTexture":
    workload==="rendering-lab-fixed"?"RenderingLabFixed":"LifecycleResize";
  const validateModule=device.createShaderModule({label:`ADR-0013 ${label} visibility/HDR oracle`,code:validateSource});
  const extractModule=device.createShaderModule({label:`ADR-0013 ${label} bin heap/args oracle`,code:`
@group(0) @binding(0) var<storage,read> heap:array<u32>;
@group(0) @binding(1) var<storage,read> args:array<u32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(256) fn extract(@builtin(local_invocation_id) id:vec3u){
  if(id.x<256u){output[16u+id.x]=heap[id.x];}
  if(id.x<8u){output[272u+id.x]=heap[256u+id.x];}
  if(id.x<192u){output[280u+id.x]=args[id.x];}
}`});
  const [validateInfo,extractInfo]=await Promise.all([validateModule.getCompilationInfo(),extractModule.getCompilationInfo()]);
  assertNoCompilationErrors(validateInfo,`${label} validate oracle`);assertNoCompilationErrors(extractInfo,`${label} extract oracle`);
  const textureEntries:GPUBindGroupLayoutEntry[]=[
    {binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"uint"}},
    {binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"uint"}},
    {binding:2,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"unfilterable-float"}},
    {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}];
  const validateLayout=device.createBindGroupLayout({label:`ADR-0013 ${label} validate oracle layout`,entries:textureEntries});
  const storageEntries:GPUBindGroupLayoutEntry[]=[
    {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},
    {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},
    {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}];
  const extractLayout=device.createBindGroupLayout({label:`ADR-0013 ${label} extract oracle layout`,entries:storageEntries});
  const [validate,extract]=await Promise.all([
    device.createComputePipelineAsync({label:`ADR-0013 ${label} validate oracle`,layout:device.createPipelineLayout({bindGroupLayouts:[validateLayout]}),
      compute:{module:validateModule,entryPoint:"validate"}}),
    device.createComputePipelineAsync({label:`ADR-0013 ${label} extract oracle`,layout:device.createPipelineLayout({bindGroupLayouts:[extractLayout]}),
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

function validateBasicCube(bytes:Uint8Array,snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,
  camera:CubeCameraFrame):Readonly<Record<string,unknown>> {
  if(bytes.byteLength!==READBACK_BYTES)throw new Error(`BasicCube readback length ${bytes.byteLength} != ${READBACK_BYTES}`);
  const width=snapshot.context.width,height=snapshot.context.height,pixels=width*height;
  if(width!==WIDTH||height>HEIGHT)throw new Error(`BasicCube validation extent ${width}x${height} exceeds its frozen row layout`);
  const association=snapshot.associations[0];if(association===undefined||snapshot.associations.length!==1)
    throw new Error(`BasicCube expected one immutable shading association, found ${snapshot.associations.length}`);
  const binId=association.identity.binId,oracle=new Uint32Array(bytes.buffer,bytes.byteOffset+ORACLE_OFFSET,ORACLE_WORDS);
  assertEqual(oracle[0],pixels,"BasicCube oracle pixel count");
  ["work-slot routing","ShadingBinId routing","primitive range","finite HDR","HDR alpha","background bin clear"]
    .forEach((label,index)=>assertEqual(oracle[index+1],0,`BasicCube ${label}`));
  assertEqual(oracle[8],0,"BasicCube background HDR clear");
  const control=oracle.subarray(16,24),counters=oracle.subarray(24,280),args=oracle.subarray(280,472);
  if (snapshot.executionMode === "sparse-microtile") {
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.frameFlags/4],0,"BasicCube bin frame flags");
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.errorCount/4],0,"BasicCube bin error count");
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.finalizedGeneration/4],snapshot.generation,"BasicCube finalized generation");
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.layoutRevision/4],snapshot.layoutRevision,"BasicCube finalized layout revision");
  }
  const visibility=new DataView(bytes.buffer,bytes.byteOffset+VISIBILITY_OFFSET,VISIBILITY_BYTES);
  const binImage=bytes.subarray(BIN_OFFSET,BIN_OFFSET+BIN_BYTES),hdr=decodeHalfTexture(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES));
  const bounds=cubeScreenBounds(camera,width,height),expectedMicrotiles=new Set<number>(),actualMicrotiles=new Set<number>();
  let expectedPixels=0,visiblePixels=0,coverageMismatches=0,invalidKeys=0,workSlotMismatches=0,primitiveRangeErrors=0,
    binMismatches=0,backgroundBinErrors=0,backgroundHdrErrors=0,maxHdrError=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const pixel=y*WIDTH+x,key=visibility.getUint32(pixel*4,true),valid=key!==0xffffffff;
    const expected=(x+0.5)>bounds.minX&&(x+0.5)<bounds.maxX&&(y+0.5)>bounds.minY&&(y+0.5)<bounds.maxY;
    if(expected){expectedPixels++;expectedMicrotiles.add(Math.floor(y/8)*Math.ceil(width/8)+Math.floor(x/8));}
    if(valid){visiblePixels++;actualMicrotiles.add(Math.floor(y/8)*Math.ceil(width/8)+Math.floor(x/8));
      if((key&0x00ffffff)!==0)workSlotMismatches++;if((key>>>24)>=CUBE_TRIANGLE_COUNT)primitiveRangeErrors++;
      if(snapshot.executionMode === "sparse-microtile" && binImage[pixel]!==binId)binMismatches++;
    }else if(expected)invalidKeys++;
    if(valid!==expected)coverageMismatches++;
    const component=pixel*4;
    if(valid){const expectedHdr=[1.6,1,0.5,1];for(let c=0;c<4;c++)maxHdrError=Math.max(maxHdrError,Math.abs(hdr[component+c]!-expectedHdr[c]!));}
    else {if(snapshot.executionMode === "sparse-microtile" && binImage[pixel]!==GPU_SHADING_BIN_INVALID_ID)backgroundBinErrors++;
      if(hdr[component]!==0||hdr[component+1]!==0||hdr[component+2]!==0||hdr[component+3]!==0)backgroundHdrErrors++;}
  }
  assertEqual(coverageMismatches,0,"BasicCube analytic silhouette coverage");assertEqual(invalidKeys,0,"BasicCube missing expected pixels");
  assertEqual(workSlotMismatches,0,"BasicCube visibility work slot");assertEqual(primitiveRangeErrors,0,"BasicCube primitive range");
  assertEqual(binMismatches,0,"BasicCube bin image");assertEqual(backgroundBinErrors,0,"BasicCube background bin sentinel");
  assertEqual(backgroundHdrErrors,0,"BasicCube background HDR zero");assertAtMost(maxHdrError,0.003,"BasicCube HDR factor reference");
  let attempted=0,written=0,overflow=0,flags=0,inactiveDispatchXNonZero=0;
  if(snapshot.executionMode === "sparse-microtile") {
    assertEqual(actualMicrotiles.size,expectedMicrotiles.size,"BasicCube classified microtile count");
    for(const tile of actualMicrotiles)if(!expectedMicrotiles.has(tile))throw new Error(`BasicCube unexpected classified microtile ${tile}`);
    const counterBase=binId*GPU_SHADING_BIN_COUNTER_STRIDE/4;
    attempted=counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.attemptedCount/4]!;
    written=counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.writtenCount/4]!;
    overflow=counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.overflowCount/4]!;
    flags=counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.flags/4]!;
    assertEqual(attempted,expectedMicrotiles.size,"BasicCube attempted microtiles");assertEqual(written,expectedMicrotiles.size,"BasicCube written microtiles");
    assertEqual(overflow,0,"BasicCube overflow");assertEqual(flags,0,"BasicCube bin flags");
    assertArray(Array.from(args.subarray(binId*3,binId*3+3)),[expectedMicrotiles.size,1,1],"BasicCube indirect args");
    for(let candidate=0;candidate<64;candidate++)if(candidate!==binId){
      const dispatch=Array.from(args.subarray(candidate*3,candidate*3+3));if(dispatch[0]!==0)inactiveDispatchXNonZero++;
      assertArray(dispatch,[0,1,1],`BasicCube inactive bin ${candidate} indirect args`);
    }
  }
  const presentation=bytes.subarray(PRESENT_OFFSET,PRESENT_OFFSET+PRESENT_BYTES);let coloredPixels=0,backgroundDitheredPixels=0,
    backgroundAboveDither=0,opaquePixels=0,diagnosticMagenta=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const pixel=y*WIDTH+x,offset=pixel*4,
    valid=visibility.getUint32(pixel*4,true)!==0xffffffff;
    const nonBlack=presentation[offset]!+presentation[offset+1]!+presentation[offset+2]!>0;
    if(valid&&nonBlack)coloredPixels++;if(!valid&&nonBlack)backgroundDitheredPixels++;
    if(!valid&&(presentation[offset]!>1||presentation[offset+1]!>1||presentation[offset+2]!>1))backgroundAboveDither++;
    if(presentation[offset+3]===255)opaquePixels++;
    if(presentation[offset]!>=250&&presentation[offset+1]!<=5&&presentation[offset+2]!>=250)diagnosticMagenta++;
  }
  assertEqual(coloredPixels,visiblePixels,"BasicCube presentation colored coverage");
  assertEqual(backgroundAboveDither,0,"BasicCube background exceeds one-LSB SDR dither");
  assertEqual(opaquePixels,pixels,"BasicCube presentation opaque pixels");assertEqual(diagnosticMagenta,0,"BasicCube diagnostic magenta");
  assertEqual(oracle[7],visiblePixels,"BasicCube GPU/CPU visible pixel count");
  return Object.freeze({name:camera.distance===CUBE_NEAR_DISTANCE?"BasicCubeNear":"BasicCubeFar",passed:true,
    extent:Object.freeze([width,height]),camera:Object.freeze({distance:camera.distance,fovDegrees:camera.fovDegrees,position:camera.position,
      viewProjection:Array.from(camera.viewProjection),screenBounds:bounds}),
    coverage:Object.freeze({expectedPixels,visiblePixels,coverageMismatches,expectedMicrotiles:expectedMicrotiles.size,
      actualMicrotiles:actualMicrotiles.size}),visibility:Object.freeze({invalidKeys,workSlotMismatches,primitiveRangeErrors,binMismatches}),
    bin:Object.freeze({binId,attempted,written,overflow,flags,inactiveDispatchXNonZero}),
    background:Object.freeze({binSentinelErrors:backgroundBinErrors,hdrNonZeroPixels:backgroundHdrErrors,
      presentationDitheredPixels:backgroundDitheredPixels,presentationAboveOneLsbPixels:backgroundAboveDither}),
    hdr:Object.freeze({maxReferenceError:maxHdrError,
      fnv1a32:fnv1a32(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES))}),presentation:Object.freeze({coloredPixels,
      opaquePixels,diagnosticMagentaPixels:diagnosticMagenta,fnv1a32:fnv1a32(presentation)})});
}

function validateUnlitVertexColor(bytes:Uint8Array,snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,
  camera:CubeCameraFrame):Readonly<Record<string,unknown>> {
  if(bytes.byteLength!==READBACK_BYTES)throw new Error(`UnlitVertexColor readback length ${bytes.byteLength} != ${READBACK_BYTES}`);
  const association=snapshot.associations[0];if(association===undefined||snapshot.associations.length!==1)
    throw new Error(`UnlitVertexColor expected one shading association, found ${snapshot.associations.length}`);
  assertEqual(association.identity.programId,1,"UnlitVertexColor program identity");const binId=association.identity.binId;
  const oracle=new Uint32Array(bytes.buffer,bytes.byteOffset+ORACLE_OFFSET,ORACLE_WORDS);assertEqual(oracle[0],PIXELS,"UnlitVertexColor oracle pixels");
  ["work-slot routing","ShadingBinId routing","primitive range","finite HDR","HDR alpha","background bin clear"]
    .forEach((label,index)=>assertEqual(oracle[index+1],0,`UnlitVertexColor ${label}`));
  assertEqual(oracle[8],0,"UnlitVertexColor background HDR clear");
  const control=oracle.subarray(16,24),counters=oracle.subarray(24,280),args=oracle.subarray(280,472);
  if (snapshot.executionMode === "sparse-microtile") {
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.frameFlags/4],0,"UnlitVertexColor bin frame flags");
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.errorCount/4],0,"UnlitVertexColor bin errors");
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.finalizedGeneration/4],snapshot.generation,"UnlitVertexColor generation");
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.layoutRevision/4],snapshot.layoutRevision,"UnlitVertexColor layout revision");
  }
  const visibility=new DataView(bytes.buffer,bytes.byteOffset+VISIBILITY_OFFSET,VISIBILITY_BYTES);
  const binImage=bytes.subarray(BIN_OFFSET,BIN_OFFSET+BIN_BYTES),hdr=decodeHalfTexture(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES));
  const projected=VERTEX_COLOR_POSITIONS.map((position)=>projectScreen(camera.viewProjection,position[0],position[1],position[2]));
  const bounds=screenBounds(projected),expectedMicrotiles=new Set<number>(),actualMicrotiles=new Set<number>();
  let expectedPixels=0,visiblePixels=0,coverageMismatches=0,workSlotMismatches=0,primitiveRangeErrors=0,binMismatches=0,
    backgroundBinErrors=0,backgroundHdrErrors=0,maxHdrError=0,minColor=Infinity,maxColor=-Infinity;
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++){
    const pixel=y*WIDTH+x,key=visibility.getUint32(pixel*4,true),valid=key!==0xffffffff;
    const expected=(x+0.5)>bounds.minX&&(x+0.5)<bounds.maxX&&(y+0.5)>bounds.minY&&(y+0.5)<bounds.maxY;
    if(expected){expectedPixels++;expectedMicrotiles.add(Math.floor(y/8)*(WIDTH/8)+Math.floor(x/8));}
    if(valid){visiblePixels++;actualMicrotiles.add(Math.floor(y/8)*(WIDTH/8)+Math.floor(x/8));
      if((key&0x00ffffff)!==0)workSlotMismatches++;const primitive=key>>>24;
      if(primitive>=VERTEX_COLOR_TRIANGLE_COUNT)primitiveRangeErrors++;if(snapshot.executionMode === "sparse-microtile" && binImage[pixel]!==binId)binMismatches++;
      if(primitive<VERTEX_COLOR_TRIANGLE_COUNT){const triangle=VERTEX_COLOR_TRIANGLES[primitive]!,weights=barycentric2d(
        [x+0.5,y+0.5],projected[triangle[0]]!,projected[triangle[1]]!,projected[triangle[2]]!);
        const vertexColor=[0,1,2].map((component)=>weights[0]*VERTEX_COLOR_VALUES[triangle[0]]![component]!+
          weights[1]*VERTEX_COLOR_VALUES[triangle[1]]![component]!+weights[2]*VERTEX_COLOR_VALUES[triangle[2]]![component]!);
        const expectedHdr=[vertexColor[0]!*1.6,vertexColor[1]!*1,vertexColor[2]!*0.5,1],component=pixel*4;
        for(let c=0;c<4;c++)maxHdrError=Math.max(maxHdrError,Math.abs(hdr[component+c]!-expectedHdr[c]!));
        minColor=Math.min(minColor,hdr[component]!,hdr[component+1]!,hdr[component+2]!);
        maxColor=Math.max(maxColor,hdr[component]!,hdr[component+1]!,hdr[component+2]!);
      }
    } else {if(snapshot.executionMode === "sparse-microtile" && binImage[pixel]!==GPU_SHADING_BIN_INVALID_ID)backgroundBinErrors++;const component=pixel*4;
      if(hdr[component]!==0||hdr[component+1]!==0||hdr[component+2]!==0||hdr[component+3]!==0)backgroundHdrErrors++;}
    if(valid!==expected)coverageMismatches++;
  }
  assertEqual(coverageMismatches,0,"UnlitVertexColor analytic coverage");assertEqual(workSlotMismatches,0,"UnlitVertexColor work slot");
  assertEqual(primitiveRangeErrors,0,"UnlitVertexColor primitive range");assertEqual(binMismatches,0,"UnlitVertexColor bin routing");
  assertEqual(backgroundBinErrors,0,"UnlitVertexColor background bin sentinel");assertEqual(backgroundHdrErrors,0,"UnlitVertexColor background HDR");
  assertAtMost(maxHdrError,0.004,"UnlitVertexColor barycentric HDR reference error");
  if(maxColor-minColor<1)throw new Error(`UnlitVertexColor gradient range ${maxColor-minColor} is too small`);
  if(snapshot.executionMode === "sparse-microtile") { assertEqual(actualMicrotiles.size,expectedMicrotiles.size,"UnlitVertexColor microtile count");
  for(const tile of actualMicrotiles)if(!expectedMicrotiles.has(tile))throw new Error(`UnlitVertexColor unexpected microtile ${tile}`); }
  const counterBase=binId*GPU_SHADING_BIN_COUNTER_STRIDE/4,attempted=snapshot.executionMode === "sparse-microtile"?counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.attemptedCount/4]!:0,
    written=snapshot.executionMode === "sparse-microtile"?counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.writtenCount/4]!:0,
    overflow=snapshot.executionMode === "sparse-microtile"?counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.overflowCount/4]!:0,flags=snapshot.executionMode === "sparse-microtile"?counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.flags/4]!:0;
  if(snapshot.executionMode === "sparse-microtile") { assertEqual(attempted,expectedMicrotiles.size,"UnlitVertexColor attempted");assertEqual(written,expectedMicrotiles.size,"UnlitVertexColor written");
  assertEqual(overflow,0,"UnlitVertexColor overflow");assertEqual(flags,0,"UnlitVertexColor flags"); }
  if(snapshot.executionMode === "sparse-microtile") assertArray(Array.from(args.subarray(binId*3,binId*3+3)),[expectedMicrotiles.size,1,1],"UnlitVertexColor indirect args");
  let inactiveDispatchXNonZero=0;if(snapshot.executionMode === "sparse-microtile") for(let candidate=0;candidate<64;candidate++)if(candidate!==binId){
    const dispatch=Array.from(args.subarray(candidate*3,candidate*3+3));if(dispatch[0]!==0)inactiveDispatchXNonZero++;
    assertArray(dispatch,[0,1,1],`UnlitVertexColor inactive bin ${candidate}`);
  }
  const presentation=bytes.subarray(PRESENT_OFFSET,PRESENT_OFFSET+PRESENT_BYTES),colors=new Set<number>();
  let coloredPixels=0,backgroundAboveDither=0,opaquePixels=0,diagnosticMagenta=0;
  for(let pixel=0;pixel<PIXELS;pixel++){const offset=pixel*4,valid=visibility.getUint32(pixel*4,true)!==0xffffffff;
    const nonBlack=presentation[offset]!+presentation[offset+1]!+presentation[offset+2]!>0;
    if(valid&&nonBlack){coloredPixels++;colors.add(presentation[offset]!|(presentation[offset+1]!<<8)|(presentation[offset+2]!<<16));}
    if(!valid&&(presentation[offset]!>1||presentation[offset+1]!>1||presentation[offset+2]!>1))backgroundAboveDither++;
    if(presentation[offset+3]===255)opaquePixels++;
    if(presentation[offset]!>=250&&presentation[offset+1]!<=5&&presentation[offset+2]!>=250)diagnosticMagenta++;
  }
  assertEqual(coloredPixels,visiblePixels,"UnlitVertexColor presentation coverage");
  assertEqual(backgroundAboveDither,0,"UnlitVertexColor background exceeds one-LSB dither");
  assertEqual(opaquePixels,PIXELS,"UnlitVertexColor opaque presentation");assertEqual(diagnosticMagenta,0,"UnlitVertexColor diagnostic magenta");
  if(colors.size<256)throw new Error(`UnlitVertexColor produced only ${colors.size} presentation colors`);
  assertEqual(oracle[7],visiblePixels,"UnlitVertexColor GPU/CPU visible pixels");
  return Object.freeze({name:"UnlitVertexColor",passed:true,programId:association.identity.programId,binId,
    geometry:Object.freeze({vertices:VERTEX_COLOR_VERTEX_COUNT,triangles:VERTEX_COLOR_TRIANGLE_COUNT}),camera:Object.freeze({
      distance:camera.distance,fovDegrees:camera.fovDegrees,screenBounds:bounds}),coverage:Object.freeze({expectedPixels,visiblePixels,
      coverageMismatches,microtiles:expectedMicrotiles.size}),queue:Object.freeze({attempted,written,overflow,flags,inactiveDispatchXNonZero}),
    visibility:Object.freeze({workSlotMismatches,primitiveRangeErrors,binMismatches}),background:Object.freeze({binSentinelErrors:backgroundBinErrors,
      hdrNonZeroPixels:backgroundHdrErrors,presentationAboveOneLsbPixels:backgroundAboveDither}),hdr:Object.freeze({maxReferenceError:maxHdrError,
      minComponent:minColor,maxComponent:maxColor,fnv1a32:fnv1a32(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES))}),
    presentation:Object.freeze({coloredPixels,distinctRgbValues:colors.size,opaquePixels,diagnosticMagentaPixels:diagnosticMagenta,
      fnv1a32:fnv1a32(presentation)})});
}

function validateUnlitTexture(bytes:Uint8Array,snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,
  camera:CubeCameraFrame):Readonly<Record<string,unknown>> {
  if(bytes.byteLength!==READBACK_BYTES)throw new Error(`UnlitTexture readback length ${bytes.byteLength} != ${READBACK_BYTES}`);
  const association=snapshot.associations[0];if(association===undefined||snapshot.associations.length!==1)
    throw new Error(`UnlitTexture expected one shading association, found ${snapshot.associations.length}`);
  assertEqual(association.identity.programId,2,"UnlitTexture program identity");
  assertEqual(association.identity.textureBindingSetId,3,"UnlitTexture TextureBindingSet identity");const binId=association.identity.binId;
  const oracle=new Uint32Array(bytes.buffer,bytes.byteOffset+ORACLE_OFFSET,ORACLE_WORDS);assertEqual(oracle[0],PIXELS,"UnlitTexture oracle pixels");
  ["work-slot routing","ShadingBinId routing","primitive range","finite HDR","HDR alpha","background bin clear"]
    .forEach((label,index)=>assertEqual(oracle[index+1],0,`UnlitTexture ${label}`));assertEqual(oracle[8],0,"UnlitTexture background HDR clear");
  const control=oracle.subarray(16,24),counters=oracle.subarray(24,280),args=oracle.subarray(280,472);
  if (snapshot.executionMode === "sparse-microtile") {
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.frameFlags/4],0,"UnlitTexture bin frame flags");
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.errorCount/4],0,"UnlitTexture bin errors");
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.finalizedGeneration/4],snapshot.generation,"UnlitTexture generation");
    assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.layoutRevision/4],snapshot.layoutRevision,"UnlitTexture layout revision");
  }
  const visibility=new DataView(bytes.buffer,bytes.byteOffset+VISIBILITY_OFFSET,VISIBILITY_BYTES);
  const binImage=bytes.subarray(BIN_OFFSET,BIN_OFFSET+BIN_BYTES),hdr=decodeHalfTexture(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES));
  const projected=VERTEX_COLOR_POSITIONS.map((position)=>projectScreen(camera.viewProjection,position[0],position[1],position[2]));
  const bounds=screenBounds(projected),expectedMicrotiles=new Set<number>(),actualMicrotiles=new Set<number>(),sampledTexels=new Set<number>();
  let expectedPixels=0,visiblePixels=0,coverageMismatches=0,workSlotMismatches=0,primitiveRangeErrors=0,binMismatches=0,
    backgroundBinErrors=0,backgroundHdrErrors=0,maxHdrError=0;
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++){
    const pixel=y*WIDTH+x,key=visibility.getUint32(pixel*4,true),valid=key!==0xffffffff;
    const expected=(x+0.5)>bounds.minX&&(x+0.5)<bounds.maxX&&(y+0.5)>bounds.minY&&(y+0.5)<bounds.maxY;
    if(expected){expectedPixels++;expectedMicrotiles.add(Math.floor(y/8)*(WIDTH/8)+Math.floor(x/8));}
    if(valid){visiblePixels++;actualMicrotiles.add(Math.floor(y/8)*(WIDTH/8)+Math.floor(x/8));
      if((key&0x00ffffff)!==0)workSlotMismatches++;const primitive=key>>>24;
      if(primitive>=VERTEX_COLOR_TRIANGLE_COUNT)primitiveRangeErrors++;if(snapshot.executionMode === "sparse-microtile" && binImage[pixel]!==binId)binMismatches++;
      if(primitive<VERTEX_COLOR_TRIANGLE_COUNT){const triangle=VERTEX_COLOR_TRIANGLES[primitive]!,weights=barycentric2d(
        [x+0.5,y+0.5],projected[triangle[0]]!,projected[triangle[1]]!,projected[triangle[2]]!);
        const uv=[weights[0]*UNLIT_TEXTURE_UVS[triangle[0]]![0]+weights[1]*UNLIT_TEXTURE_UVS[triangle[1]]![0]+
          weights[2]*UNLIT_TEXTURE_UVS[triangle[2]]![0],weights[0]*UNLIT_TEXTURE_UVS[triangle[0]]![1]+
          weights[1]*UNLIT_TEXTURE_UVS[triangle[1]]![1]+weights[2]*UNLIT_TEXTURE_UVS[triangle[2]]![1]];
        const texelX=Math.max(0,Math.min(3,Math.floor(uv[0]!*4))),texelY=Math.max(0,Math.min(3,Math.floor(uv[1]!*4)));
        sampledTexels.add(texelY*4+texelX);const sample=unlitTextureTexel(texelX,texelY);
        const expectedHdr=[0.8*(sample[0]/255)*PRE_EXPOSURE,0.5*(sample[1]/255)*PRE_EXPOSURE,
          0.25*(sample[2]/255)*PRE_EXPOSURE,1],component=pixel*4;
        for(let c=0;c<4;c++)maxHdrError=Math.max(maxHdrError,Math.abs(hdr[component+c]!-expectedHdr[c]!));
      }
    } else {if(snapshot.executionMode === "sparse-microtile" && binImage[pixel]!==GPU_SHADING_BIN_INVALID_ID)backgroundBinErrors++;const component=pixel*4;
      if(hdr[component]!==0||hdr[component+1]!==0||hdr[component+2]!==0||hdr[component+3]!==0)backgroundHdrErrors++;}
    if(valid!==expected)coverageMismatches++;
  }
  assertEqual(coverageMismatches,0,"UnlitTexture analytic coverage");assertEqual(workSlotMismatches,0,"UnlitTexture work slot");
  assertEqual(primitiveRangeErrors,0,"UnlitTexture primitive range");assertEqual(binMismatches,0,"UnlitTexture bin routing");
  assertEqual(backgroundBinErrors,0,"UnlitTexture background bin sentinel");assertEqual(backgroundHdrErrors,0,"UnlitTexture background HDR");
  assertAtMost(maxHdrError,0.004,"UnlitTexture nearest-sample HDR reference error");assertEqual(sampledTexels.size,16,"UnlitTexture sampled texel coverage");
  if(snapshot.executionMode === "sparse-microtile") { assertEqual(actualMicrotiles.size,expectedMicrotiles.size,"UnlitTexture microtile count");
  for(const tile of actualMicrotiles)if(!expectedMicrotiles.has(tile))throw new Error(`UnlitTexture unexpected microtile ${tile}`); }
  const counterBase=binId*GPU_SHADING_BIN_COUNTER_STRIDE/4,attempted=snapshot.executionMode === "sparse-microtile"?counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.attemptedCount/4]!:0,
    written=snapshot.executionMode === "sparse-microtile"?counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.writtenCount/4]!:0,
    overflow=snapshot.executionMode === "sparse-microtile"?counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.overflowCount/4]!:0,flags=snapshot.executionMode === "sparse-microtile"?counters[counterBase+GPU_SHADING_BIN_COUNTER_OFFSETS.flags/4]!:0;
  if(snapshot.executionMode === "sparse-microtile") { assertEqual(attempted,expectedMicrotiles.size,"UnlitTexture attempted");assertEqual(written,expectedMicrotiles.size,"UnlitTexture written");
  assertEqual(overflow,0,"UnlitTexture overflow");assertEqual(flags,0,"UnlitTexture flags");
  assertArray(Array.from(args.subarray(binId*3,binId*3+3)),[expectedMicrotiles.size,1,1],"UnlitTexture indirect args"); }
  let inactiveDispatchXNonZero=0;if(snapshot.executionMode === "sparse-microtile") for(let candidate=0;candidate<64;candidate++)if(candidate!==binId){
    const dispatch=Array.from(args.subarray(candidate*3,candidate*3+3));if(dispatch[0]!==0)inactiveDispatchXNonZero++;
    assertArray(dispatch,[0,1,1],`UnlitTexture inactive bin ${candidate}`);
  }
  const presentation=bytes.subarray(PRESENT_OFFSET,PRESENT_OFFSET+PRESENT_BYTES),colors=new Set<number>();
  let coloredPixels=0,backgroundAboveDither=0,opaquePixels=0,diagnosticMagenta=0;
  for(let pixel=0;pixel<PIXELS;pixel++){const offset=pixel*4,valid=visibility.getUint32(pixel*4,true)!==0xffffffff;
    const nonBlack=presentation[offset]!+presentation[offset+1]!+presentation[offset+2]!>0;
    if(valid&&nonBlack){coloredPixels++;colors.add(presentation[offset]!|(presentation[offset+1]!<<8)|(presentation[offset+2]!<<16));}
    if(!valid&&(presentation[offset]!>1||presentation[offset+1]!>1||presentation[offset+2]!>1))backgroundAboveDither++;
    if(presentation[offset+3]===255)opaquePixels++;
    if(presentation[offset]!>=250&&presentation[offset+1]!<=5&&presentation[offset+2]!>=250)diagnosticMagenta++;
  }
  assertEqual(coloredPixels,visiblePixels,"UnlitTexture presentation coverage");
  assertEqual(backgroundAboveDither,0,"UnlitTexture background exceeds one-LSB dither");
  assertEqual(opaquePixels,PIXELS,"UnlitTexture opaque presentation");assertEqual(diagnosticMagenta,0,"UnlitTexture diagnostic magenta");
  if(colors.size<16)throw new Error(`UnlitTexture produced only ${colors.size} presentation colors`);
  assertEqual(oracle[7],visiblePixels,"UnlitTexture GPU/CPU visible pixels");
  return Object.freeze({name:"UnlitTexture",passed:true,programId:association.identity.programId,binId,
    texture:Object.freeze({bindingSetId:association.identity.textureBindingSetId,extent:[4,4],layer:1,sampler:"nearest-clamp",
      sampledTexelCount:sampledTexels.size}),geometry:Object.freeze({vertices:VERTEX_COLOR_VERTEX_COUNT,triangles:VERTEX_COLOR_TRIANGLE_COUNT}),
    camera:Object.freeze({distance:camera.distance,fovDegrees:camera.fovDegrees,screenBounds:bounds}),coverage:Object.freeze({expectedPixels,
      visiblePixels,coverageMismatches,microtiles:expectedMicrotiles.size}),queue:Object.freeze({attempted,written,overflow,flags,
      inactiveDispatchXNonZero}),visibility:Object.freeze({workSlotMismatches,primitiveRangeErrors,binMismatches}),
    background:Object.freeze({binSentinelErrors:backgroundBinErrors,hdrNonZeroPixels:backgroundHdrErrors,
      presentationAboveOneLsbPixels:backgroundAboveDither}),hdr:Object.freeze({maxReferenceError:maxHdrError,
      fnv1a32:fnv1a32(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES))}),presentation:Object.freeze({coloredPixels,
      distinctRgbValues:colors.size,opaquePixels,diagnosticMagentaPixels:diagnosticMagenta,fnv1a32:fnv1a32(presentation)})});
}

function validateRenderingLab(bytes:Uint8Array,snapshot:ReturnType<GpuShadingPublicationStore["currentSnapshot"]>,
  frameIndex:number):Readonly<Record<string,unknown>> {
  if(bytes.byteLength!==READBACK_BYTES)throw new Error(`RenderingLab readback length ${bytes.byteLength} != ${READBACK_BYTES}`);
  const oracle=new Uint32Array(bytes.buffer,bytes.byteOffset+ORACLE_OFFSET,ORACLE_WORDS);
  assertEqual(oracle[0],PIXELS,"RenderingLab oracle pixels");
  ["work-slot range","bin routing","primitive range","visible HDR finite","TAA history-lock alpha range","background bin sentinel"]
    .forEach((label,index)=>assertEqual(oracle[index+1],0,`RenderingLab ${label}`));
  assertEqual(oracle[8],0,"RenderingLab background HDR finite");
  const visiblePixels=oracle[7]!;if(visiblePixels<3000)throw new Error(`RenderingLab visible coverage too small: ${visiblePixels}`);
  const control=oracle.subarray(16,24),counters=oracle.subarray(24,280),args=oracle.subarray(280,472);
  assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.frameFlags/4],0,"RenderingLab frame flags");
  assertEqual(control[GPU_SHADING_BIN_CONTROL_OFFSETS.errorCount/4],0,"RenderingLab bin errors");
  const workPixels=new Uint32Array(RENDERING_LAB_PROGRAMS.length),visibility=new DataView(bytes.buffer,bytes.byteOffset+VISIBILITY_OFFSET,VISIBILITY_BYTES);
  const binImage=bytes.subarray(BIN_OFFSET,BIN_OFFSET+BIN_BYTES),activeBins=new Set<number>();
  for(let pixel=0;pixel<PIXELS;pixel++){const key=visibility.getUint32(pixel*4,true);if(key===0xffffffff)continue;
    const work=key&0x00ffffff;if(work<workPixels.length)workPixels[work]++;activeBins.add(binImage[pixel]!);}
  for(let index=0;index<workPixels.length;index++)if(workPixels[index]===0)throw new Error(`RenderingLab work ${index} is invisible`);
  let attemptedTotal=0,writtenTotal=0;for(const association of snapshot.associations){const binId=association.identity.binId,
    base=binId*GPU_SHADING_BIN_COUNTER_STRIDE/4,attempted=counters[base+GPU_SHADING_BIN_COUNTER_OFFSETS.attemptedCount/4]!,
    written=counters[base+GPU_SHADING_BIN_COUNTER_OFFSETS.writtenCount/4]!,overflow=counters[base+GPU_SHADING_BIN_COUNTER_OFFSETS.overflowCount/4]!,
    flags=counters[base+GPU_SHADING_BIN_COUNTER_OFFSETS.flags/4]!;
    if(attempted===0)throw new Error(`RenderingLab active bin ${binId} produced no microtiles`);
    assertEqual(written,attempted,`RenderingLab bin ${binId} written`);assertEqual(overflow,0,`RenderingLab bin ${binId} overflow`);
    assertEqual(flags,0,`RenderingLab bin ${binId} flags`);assertArray(Array.from(args.subarray(binId*3,binId*3+3)),
      [attempted,1,1],`RenderingLab bin ${binId} indirect args`);attemptedTotal+=attempted;writtenTotal+=written;}
  const hdr=decodeHalfTexture(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES));let finitePixels=0,litPixels=0,maxLuminance=0;
  const presentation=bytes.subarray(PRESENT_OFFSET,PRESENT_OFFSET+PRESENT_BYTES),colors=new Set<number>();let opaque=0,magenta=0;
  for(let pixel=0;pixel<PIXELS;pixel++){const base=pixel*4,r=hdr[base]!,g=hdr[base+1]!,b=hdr[base+2]!;
    if(Number.isFinite(r)&&Number.isFinite(g)&&Number.isFinite(b))finitePixels++;const luminance=0.2126*r+0.7152*g+0.0722*b;
    if(luminance>0.01)litPixels++;maxLuminance=Math.max(maxLuminance,luminance);
    colors.add(presentation[base]!|(presentation[base+1]!<<8)|(presentation[base+2]!<<16));
    if(presentation[base+3]===255)opaque++;if(presentation[base]!>=250&&presentation[base+1]!<=5&&presentation[base+2]!>=250)magenta++;}
  assertEqual(finitePixels,PIXELS,"RenderingLab finite HDR pixels");if(litPixels<visiblePixels*0.5)throw new Error(
    `RenderingLab only lit ${litPixels}/${visiblePixels} visible pixels`);if(maxLuminance<=0.1)throw new Error("RenderingLab HDR has no lighting range");
  if(colors.size<64)throw new Error(`RenderingLab presentation produced only ${colors.size} colors`);
  assertEqual(opaque,PIXELS,"RenderingLab opaque presentation");assertEqual(magenta,0,"RenderingLab diagnostic magenta");
  const shadow=new Float32Array(bytes.buffer,bytes.byteOffset+SHADOW_OFFSET,SHADOW_BYTES/4);let shadowCovered=0,shadowMin=1,shadowMax=0;
  for(const depth of shadow){if(depth>0){shadowCovered++;shadowMin=Math.min(shadowMin,depth);shadowMax=Math.max(shadowMax,depth);}}
  if(shadowCovered<256)throw new Error(`RenderingLab shadow raster covered only ${shadowCovered} texels`);
  if(shadowMax-shadowMin<0.001)throw new Error("RenderingLab shadow atlas has no geometric depth range");
  return Object.freeze({name:`RenderingLabFixed/${frameIndex===0?"cold":frameIndex===1?"warm":"stable"}`,passed:true,
    frameIndex,programs:RENDERING_LAB_PROGRAMS,visiblePixels,workPixels:Object.freeze(Array.from(workPixels)),
    activeBins:Object.freeze(Array.from(activeBins).sort((a,b)=>a-b)),queue:Object.freeze({attempted:attemptedTotal,
      written:writtenTotal,overflow:0}),hdr:Object.freeze({finitePixels,litPixels,maxLuminance,
      fnv1a32:fnv1a32(bytes.subarray(HDR_OFFSET,HDR_OFFSET+HDR_BYTES))}),shadow:Object.freeze({coveredTexels:shadowCovered,
      minimumDepth:shadowMin,maximumDepth:shadowMax}),presentation:Object.freeze({distinctRgbValues:colors.size,opaquePixels:opaque,
      diagnosticMagentaPixels:magenta,fnv1a32:fnv1a32(presentation)})});
}

function cubeScreenBounds(camera:CubeCameraFrame,width=WIDTH,height=HEIGHT):Readonly<{minX:number;maxX:number;minY:number;maxY:number}> {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const x of [-1,1])for(const y of [-1,1]){const point=projectScreen(camera.viewProjection,x,y,1,width,height);
    minX=Math.min(minX,point[0]);maxX=Math.max(maxX,point[0]);minY=Math.min(minY,point[1]);maxY=Math.max(maxY,point[1]);}
  return Object.freeze({minX,maxX,minY,maxY});
}
function screenBounds(points:readonly (readonly [number,number])[]):Readonly<{minX:number;maxX:number;minY:number;maxY:number}> {
  return Object.freeze({minX:Math.min(...points.map((point)=>point[0])),maxX:Math.max(...points.map((point)=>point[0])),
    minY:Math.min(...points.map((point)=>point[1])),maxY:Math.max(...points.map((point)=>point[1]))});
}
function barycentric2d(point:readonly [number,number],a:readonly [number,number],b:readonly [number,number],
  c:readonly [number,number]):readonly [number,number,number] {
  const denominator=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  if(Math.abs(denominator)<1e-12)throw new Error("UnlitVertexColor projected triangle is degenerate");
  const u=((b[1]-c[1])*(point[0]-c[0])+(c[0]-b[0])*(point[1]-c[1]))/denominator;
  const v=((c[1]-a[1])*(point[0]-c[0])+(a[0]-c[0])*(point[1]-c[1]))/denominator;
  return Object.freeze([u,v,1-u-v] as const);
}
function projectScreen(matrix:ArrayLike<number>,x:number,y:number,z:number,width=WIDTH,height=HEIGHT):readonly [number,number] {
  const clipX=matrix[0]!*x+matrix[4]!*y+matrix[8]!*z+matrix[12]!;
  const clipY=matrix[1]!*x+matrix[5]!*y+matrix[9]!*z+matrix[13]!;
  const clipW=matrix[3]!*x+matrix[7]!*y+matrix[11]!*z+matrix[15]!;
  return Object.freeze([(clipX/clipW*0.5+0.5)*width,(0.5-clipY/clipW*0.5)*height] as const);
}
function coverageEvidence(scenario:Readonly<Record<string,unknown>>):Readonly<{visiblePixels:number;expectedPixels:number}> {
  const coverage=scenario.coverage;if(coverage===null||typeof coverage!=="object")throw new Error("BasicCube frame omitted coverage evidence");
  const value=coverage as {readonly visiblePixels?:unknown;readonly expectedPixels?:unknown};
  if(typeof value.visiblePixels!=="number"||typeof value.expectedPixels!=="number")throw new Error("BasicCube coverage evidence is malformed");
  return Object.freeze({visiblePixels:value.visiblePixels,expectedPixels:value.expectedPixels});
}

function validateCandidateTopology(value:unknown,scenario:string,executionMode:"none"|"direct-single-bin"|"sparse-microtile"):void {
  const dump=value as {readonly passes:readonly {readonly id:number;readonly name:string;readonly culled:boolean;
    readonly dependencies:readonly number[]}[];readonly resources:readonly {readonly name:string}[]};
  const byName=new Map(dump.passes.map((pass)=>[pass.name,pass])),requirePass=(name:string)=>{const pass=byName.get(name);
    if(pass===undefined||pass.culled)throw new Error(`${scenario} required live pass '${name}'`);return pass;};
  const visibility=requirePass("SparseShading/visibility MRT");
  const classifier=executionMode==="sparse-microtile"?requirePass("SparseShading/clear + classify"):null;
  const finalizer=executionMode==="sparse-microtile"?requirePass("SparseShading/finalize indirect"):null;
  const directStatus=executionMode==="direct-single-bin"?requirePass("SparseShading/clear DirectSingleBin status"):null;
  const outputClear=requirePass("SparseShading/clear sparse outputs");
  const resolve=requirePass("SparseShading/active-bin indirect resolve");
  const capture=requirePass("SparseShading/validation capture boundary");
  if (classifier!==null && finalizer!==null) {
    requireDependency(classifier,visibility,"visibility -> classifier");requireDependency(finalizer,classifier,"classifier -> finalizer");
    requireDependency(outputClear,finalizer,"finalizer -> output clear");
  } else {
    requireDependency(directStatus!,visibility,"visibility -> direct status");
    requireDependency(outputClear,directStatus!,"direct status -> output clear");
  }
  requireDependency(resolve,outputClear,"output clear -> resolve");
  const lighting=byName.get("SparseShading/light cluster producer");
  if(scenario.startsWith("RenderingLabFixed/")){
    const shadow=requirePass("SparseShading/shadow producer"),post=requirePass("RenderingLab production Tonemap");
    if(lighting===undefined||lighting.culled)throw new Error("RenderingLab required live light-cluster producer");
    requireDependency(resolve,lighting,"lighting -> resolve");requireDependency(resolve,shadow,"shadow -> resolve");
    requireDependency(capture,post,"post -> capture");
    const liveNames=dump.passes.filter((pass)=>!pass.culled).map((pass)=>pass.name);
    for(const requiredName of ["RenderingLab production HZB build","Occlusion confidence yk",
      "FX-06 final temporal validity classification","Three SSGI r186 horizon-bitfield trace",
      "SSGI joint spatial filter","SSGI unified temporal AO+GI resolve","SSGI joint bilateral full-resolution resolve",
      "receiver-local long-range GI provider","ScreenSpaceDiffuseResolve","OpaqueColorPyramid shared producer",
      "SSR trace uk","SSR stochastic hit shading","SSR recurrent specular denoise","SSR temporal reproject",
      "SSR specular correction","FX-06B Final TAA/TAAU resolve","RenderingLab submitted depth/camera history copy"])
      if(!liveNames.some((name)=>name.includes(requiredName)))throw new Error(`${scenario} missing production downstream pass '${requiredName}'`);
    if(liveNames.some((name)=>name.startsWith("SparseShading/downstream/")))throw new Error(
      `${scenario} retained a synthetic downstream wrapper`);
    const resourceNames=dump.resources.map((resource)=>resource.name);
    for(const requiredResource of ["sparse-shading/normal","sparse-shading/albedo-ao","sparse-shading/material",
      "sparse-shading/velocity","RenderingLab/current HZB","RenderingLab/temporal history input",
      "RenderingLab/temporal history output"])
      if(!resourceNames.includes(requiredResource))throw new Error(`${scenario} missing downstream resource '${requiredResource}'`);
    return;
  }
  const post=requirePass("SparseShading/downstream/post");
  if(scenario==="MixedBins"){
    if(lighting===undefined||lighting.culled)throw new Error("MixedBins required live light-cluster producer");
    requireDependency(resolve,lighting,"lighting -> resolve");
  } else if(lighting!==undefined&&!lighting.culled)throw new Error(`${scenario} unlit-only graph retained a live light-cluster producer`);
  requireDependency(post,resolve,"resolve -> post");requireDependency(capture,post,"post -> capture");
  const passNames=dump.passes.filter((pass)=>!pass.culled).map((pass)=>pass.name).join("\n");
  for(const forbidden of ["shadow producer","diagnostics finalize","diagnostics async copy","downstream/gtao","downstream/ssgi",
    "downstream/ssr","downstream/temporal"])if(passNames.includes(forbidden))throw new Error(`${scenario} feature-off pass '${forbidden}' is live`);
  const resourceNames=dump.resources.map((resource)=>resource.name);
  for(const forbidden of ["sparse-shading/normal","sparse-shading/albedo-ao","sparse-shading/material","sparse-shading/velocity",
    "sparse-shading/claims","sparse-shading/diagnostics","sparse-shading/diagnostics-readback"])
    if(resourceNames.includes(forbidden))throw new Error(`${scenario} feature-off resource '${forbidden}' exists`);
  if(scenario!=="MixedBins")for(const forbidden of ["candidate/light-database","candidate/cluster-headers",
    "candidate/cluster-indices","candidate/light-settings","candidate/environment-settings"])
    if(resourceNames.includes(forbidden))throw new Error(`${scenario} unlit-only resource '${forbidden}' exists`);
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
function requireResource<T>(value:T|null,label:string):T {if(value===null)throw new Error(`Missing required ${label}`);return value;}
function errorChain(value:unknown):string {const messages:string[]=[];let cursor:unknown=value;while(cursor instanceof Error){
  messages.push(cursor.message);cursor=(cursor as Error&{readonly cause?:unknown}).cause;}if(cursor!==undefined)messages.push(String(cursor));
  return messages.join(" <- ");}
