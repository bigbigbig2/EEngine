/**
 * 可见性阶段：执行实例与 Meshlet 裁剪、间接工作生成和可见性缓冲区光栅化。
 */

import { VISIBILITY_MESHLET_WGSL } from "../../shaders/visibility_meshlet.js";
import { VISIBILITY_ALPHA_TESTED_WGSL } from "../../shaders/visibility_alpha_tested.js";
import { LPV_CAMERA_TYPE } from "../../shaders/lpv_indirect_diffuse.js";
import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import type { Scene } from "../../scene/Scene.js";
import type { RenderTargets } from "../RenderTargets.js";
import type { FrameGraph, FrameGraphContext } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { MeshletGpuTable } from "../../gpu/MeshletGpuTable.js";
import {
  MESHLET_DRAW_VERTEX_COUNT,
  MESHLET_INSTANCE_STRIDE_BYTES,
  MESHLET_LIST_ELEMENTS_OFFSET,
  type MeshletDrawList
} from "../../gpu/MeshletDrawList.js";
import {
  SCENE_MESH_FRUSTUM_FILTER_WGSL,
  SCENE_MESH_FRUSTUM_FILTER_WORKGROUP_SIZE,
  type GpuBufferSlice,
  type SceneDatabase
} from "../../gpu/SceneDatabase.js";
import {
  MATERIAL_META_TYPE,
  type MaterialMetadataTable
} from "../../gpu/MaterialMetadataTable.js";
import type { GPUMaterialRegistry } from "../../gpu/GPUMaterialContext.js";
import { HILBERT_NOISE_TEXTURE } from "../HilbertNoiseTexture.js";
import {
  MaterialMeshletDrawList,
  type MaterialMeshletCommandContext
} from "../../gpu/MaterialMeshletDrawList.js";
import {
  collectActiveMaterialBuckets,
  listAlphaTestedActiveBuckets,
  listOpaqueActiveBuckets,
  primitiveStateForBucket,
  singleOpaquePrimitive,
  type ActiveMaterialBucket
} from "../../material/materialBucketId.js";
import {
  ShadeDrawMode,
  ShadeDrawSide,
  ShadeTransparencyMode
} from "../../material/enums.js";
import { MATERIAL_SORT_DRAW_ARGS_BYTES } from "../../shaders/meshlet_material_sort.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { GPU_VIEW_TYPE } from "../ViewManager.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import { GPUCollectionKind } from "../../gpu/GPUCollectionLimits.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../../gpu/GPUDescriptorCaches.js";
import { VIS_MESH_CLEAR_SENTINEL } from "../VisibilityBufferContract.js";
import {
  GPU_QUEUE_OVERFLOW_BITS
} from "../../debug/GpuFrameCounters.js";
import {
  GpuListCounterAccumulator
} from "../../debug/GpuListCounterAccumulator.js";

export { VIS_MESH_CLEAR_SENTINEL } from "../VisibilityBufferContract.js";

export const VISIBILITY_NB_STEPS = [
  "collect material buckets (transparency × draw_mode × side)",
  "register depth + color ID targets into FrameGraph",
  "prepare mesh list (tb / KA)",
  "per opaque bucket: indirect instance cull (dispatchIndirect)",
  "expand meshlets (sp) → meshlets positive",
  "raster Ab → depth + r32uint IDs",
  "alpha tested db: Bp material sort -> av/sv hashed raster"
] as const;

export const VISIBILITY_RT = {
  triangleId: "color_attachments[0] r32uint",
  meshId: "color_attachments[1] r32uint",
  depth: "depth32float reverse-Z (greater, clear 0)"
} as const;

const VISIBILITY_FILTER_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
  ]
};

const VISIBILITY_FILTER_GROUP1: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [{
    binding: 0,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: "storage" }
  }]
};

const VISIBILITY_FILTER_PIPELINE: CachedComputePipelineDescriptor = {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [VISIBILITY_FILTER_GROUP0, VISIBILITY_FILTER_GROUP1]
  },
  compute: {
    module: { label: "", code: SCENE_MESH_FRUSTUM_FILTER_WGSL },
    entryPoint: "main"
  }
};

const VISIBILITY_MESHLET_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size }
    },
    ...[1, 2, 3, 4, 5].map((binding) => ({
      binding,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    }))
  ]
};

const VISIBILITY_ALPHA_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: MATERIAL_META_TYPE.size }
    }
  ]
};

const VISIBILITY_ALPHA_GROUP1: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [0, 1, 2, 3, 4].map((binding) => ({
    binding,
    visibility: GPUShaderStage.VERTEX,
    buffer: { type: "read-only-storage" as GPUBufferBindingType }
  }))
};

const VISIBILITY_ALPHA_GROUP2: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: GPU_VIEW_TYPE.size }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "uint", viewDimension: "2d" }
    }
  ]
};

const VISIBILITY_MESHLET_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "",
  layout: { label: "", bindGroupLayouts: [VISIBILITY_MESHLET_GROUP] },
  vertex: {
    module: { label: "", code: VISIBILITY_MESHLET_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "", code: VISIBILITY_MESHLET_WGSL },
    entryPoint: "fs_main",
    targets: [{ format: "r32uint" }, { format: "r32uint" }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "greater"
  }
};

const VISIBILITY_ALPHA_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [
      VISIBILITY_ALPHA_GROUP0,
      VISIBILITY_ALPHA_GROUP1,
      VISIBILITY_ALPHA_GROUP2
    ]
  },
  vertex: {
    module: { label: "", code: VISIBILITY_ALPHA_TESTED_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "", code: VISIBILITY_ALPHA_TESTED_WGSL },
    entryPoint: "fs_main",
    targets: [{ format: "r32uint" }, { format: "r32uint" }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "greater"
  }
};

export const MATERIAL_EXPAND = {
  passLabel: "Material Draw",
  bindGroups: "material BG0 + view BG1 + scene/meshlet BG2",
  draw: "fullscreen/draw(3) per opaque material context"
} as const;

export const VISIBILITY_MIGRATION_GAP: readonly string[] = [];

export type VisibilityJob = {
  camera: PerspectiveCamera;
  gpuCameraBuffer?: GPUBuffer | null;
  gpuPreviousCameraBuffer?: GPUBuffer | null;
  gpuViewBuffer?: GPUBuffer | null;
  scene: Scene;
  targets: RenderTargets;
  meshCount?: number;
  meshlets?: MeshletGpuTable | null;
  drawList?: MeshletDrawList | null;
  meshTable?: GpuBufferSlice | null;
  transformTable?: GpuBufferSlice | null;
  sceneDatabase?: SceneDatabase | null;
  materialMetadata?: MaterialMetadataTable | null;
  materialRegistry?: GPUMaterialRegistry | null;
  enableFrustumCull?: boolean;
  hzbView?: GPUTextureView | null;
  viewportWidth?: number;
  viewportHeight?: number;
  enableHzbCull?: boolean;
  enableInstanceCull?: boolean;
  clearTargets?: boolean;
  secondChance?: boolean;
  alphaTestedPass?: boolean;
  gpuCounterBuffer?: GPUBuffer | null;
};

type UploadCmd = {
  writeBuffer: (
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBuffer | ArrayBufferView,
    dataOffset?: number,
    size?: number
  ) => void;
};

/**
 * GPU 驱动可见性阶段。
 *
 * 先在计算管线中筛选实例和 Meshlet，再通过间接绘制把几何标识写入可见性缓冲区和深度缓冲区。
 */
export class VisibilityPass {
  private device: GPUDevice;
  private readonly graphics: GraphicsContext;
  private pipelineMeshletByCull = new Map<GPUCullMode, GPURenderPipeline>();
  private sceneMeshFilterPipeline: GPUComputePipeline | null = null;
  private readonly alphaPipelines = new Map<GPUCullMode, GPURenderPipeline>();
  private readonly alphaMaterialDrawList: MaterialMeshletDrawList;
  private readonly gpuListCounters = new GpuListCounterAccumulator();
  private alphaNoiseView: GPUTextureView | null = null;

  lastDrawCount = 0;
  lastUsedMeshletPath = false;
  lastUsedDrawIndirect = false;
  lastUsedSceneTableModel = false;
  lastFrustumCulled = 0;
  lastFrustumUnculled = 0;
  lastHzbCullRan = false;
  lastExpandRan = false;
  lastInstanceCullRan = false;
  lastDispatchIndirectUsed = false;
  lastSecondChance = false;
  lastClearTargets = true;
  lastDualMaybeRan = false;
  lastMeshletDualMaybeRan = false;
  lastGpuSpRan = false;
  lastBlellochScanRan = false;
  lastPrevCameraVpUsed = false;
  lastOpaqueBucketCount = 0;
  lastActiveBucketCount = 0;
  lastMeshletCullMode: GPUCullMode = "none";
  lastBucketPrimitiveHomogeneous = true;
  lastActiveBuckets: ActiveMaterialBucket[] = [];
  lastBucketPasses = 0;
  lastMultiBucketPass = false;
  lastAlphaBucketCount = 0;
  lastAlphaBucketPasses = 0;
  lastAlphaTestedPass = false;
  lastMaterialMetadataUsed = false;
  lastBucketExtractRan = false;
  lastBucketScatterRan = false;
  lastSceneMeshFilterRan = false;

  constructor(graphics: GraphicsContext) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("VisibilityPass: GraphicsContext has no device");
    }
    this.graphics = graphics;
    this.device = device;
    this.alphaMaterialDrawList = new MaterialMeshletDrawList(graphics);
  }

  init(): void {
    this.sceneMeshFilterPipeline = this.graphics.compute_pipelines.obtain(
      VISIBILITY_FILTER_PIPELINE
    );
    this.obtainMeshletPipeline("none");
    this.obtainAlphaPipeline("none");
  }

  private obtainMeshletPipeline(cullMode: GPUCullMode): GPURenderPipeline {
    let p = this.pipelineMeshletByCull.get(cullMode);
    if (p) return p;
    p = this.graphics.render_pipelines.obtain(VISIBILITY_MESHLET_PIPELINE, {
      topology: "triangle-list",
      cullMode
    });
    this.pipelineMeshletByCull.set(cullMode, p);
    return p;
  }

  private obtainAlphaPipeline(cullMode: GPUCullMode): GPURenderPipeline {
    let pipeline = this.alphaPipelines.get(cullMode);
    if (pipeline) return pipeline;
    pipeline = this.graphics.render_pipelines.obtain(VISIBILITY_ALPHA_PIPELINE, {
      topology: "triangle-list",
      cullMode
    });
    this.alphaPipelines.set(cullMode, pipeline);
    return pipeline;
  }

  private resolveMeshletPrimitive(scene: Scene): {
    cullMode: GPUCullMode;
    homogeneous: boolean;
    active: ActiveMaterialBucket[];
    opaque: ActiveMaterialBucket[];
    alpha: ActiveMaterialBucket[];
  } {
    const active = collectActiveMaterialBuckets(scene.instances.materials);
    const opaque = listOpaqueActiveBuckets(active);
    const alpha = listAlphaTestedActiveBuckets(active);
    const prim = singleOpaquePrimitive(opaque);
    if (prim && prim.cullMode) {
      return {
        cullMode: prim.cullMode,
        homogeneous: true,
        active,
        opaque,
        alpha
      };
    }
    return {
      cullMode: "none",
      homogeneous: opaque.length <= 1,
      active,
      opaque,
      alpha
    };
  }

  hasAlphaTestedMaterials(scene: Scene): boolean {
    const active = collectActiveMaterialBuckets(scene.instances.materials);
    return listAlphaTestedActiveBuckets(active).length > 0;
  }

  /** 向帧图登记可见性阶段及其输入、输出资源。 */
  addToGraph(
    graph: FrameGraph,
    job: VisibilityJob,
    resources: {
      meshId: ResourceId;
      triangleId: ResourceId;
      depth: ResourceId;
      hzb?: ResourceId;
      counters?: ResourceId;
    },
    passName = "Visibility"
  ): ResourceId | null {
    const self = this;
    const builder = graph.add(passName, job, (data, res, ctx) => {
      const encoder = ctx.gpu_encoder;
      if (!encoder) throw new Error("Visibility: no encoder");
      const triangleId = resolveTextureView(res.get(resources.triangleId));
      const meshId = resolveTextureView(res.get(resources.meshId));
      const depth = resolveTextureView(res.get(resources.depth), {
        dimension: "2d",
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1
      });
      self.executeEncoder(
        encoder,
        data.camera,
        data.scene,
        {
          meshId,
          triangleId,
          depth
        },
        {
          gpuCameraBuffer: data.gpuCameraBuffer ?? null,
          gpuPreviousCameraBuffer: data.gpuPreviousCameraBuffer ?? null,
          gpuViewBuffer: data.gpuViewBuffer ?? null,
          meshlets: data.meshlets ?? null,
          drawList: data.drawList ?? null,
          meshTable: data.meshTable ?? null,
          transformTable: data.transformTable ?? null,
          sceneDatabase: data.sceneDatabase ?? null,
          materialMetadata: data.materialMetadata ?? null,
          materialRegistry: data.materialRegistry ?? null,
          enableFrustumCull: data.enableFrustumCull !== false,
          hzbView: data.hzbView ?? null,
          viewportWidth: data.viewportWidth,
          viewportHeight: data.viewportHeight,
          enableHzbCull: data.enableHzbCull !== false,
          enableInstanceCull: data.enableInstanceCull !== false,
          clearTargets: data.clearTargets !== false,
          secondChance: data.secondChance === true,
          alphaTestedPass: data.alphaTestedPass === true,
          gpuCounterBuffer: resources.counters === undefined
            ? null
            : resolveGpuBuffer(res.get(resources.counters))
        },
        self.resolveUpload(ctx),
        self.resolveCommandContext(ctx)
      );
    });
    builder.read(resources.meshId);
    builder.write(resources.meshId);
    builder.read(resources.triangleId);
    builder.write(resources.triangleId);
    builder.read(resources.depth);
    builder.write(resources.depth);
    if (resources.hzb !== undefined) builder.read(resources.hzb);
    const nextCounters = resources.counters === undefined
      ? null
      : builder.write(resources.counters);
    builder.make_side_effect();
    return nextCounters;
  }

  /** 立即执行一次可见性渲染，主要供内部路径和独立验证使用。 */
  execute(
    encoder: GPUCommandEncoder,
    job: VisibilityJob,
    upload?: UploadCmd | ShadeGPUCommandContext
  ): void {
    this.executeEncoder(
      encoder,
      job.camera,
      job.scene,
      {
        meshId: job.targets.meshIdViewOrThrow,
        triangleId: job.targets.triangleIdViewOrThrow,
        depth: job.targets.depthViewOrThrow
      },
      {
        gpuCameraBuffer: job.gpuCameraBuffer ?? null,
        gpuPreviousCameraBuffer: job.gpuPreviousCameraBuffer ?? null,
        gpuViewBuffer: job.gpuViewBuffer ?? null,
        meshlets: job.meshlets ?? null,
        drawList: job.drawList ?? null,
        meshTable: job.meshTable ?? null,
        transformTable: job.transformTable ?? null,
        sceneDatabase: job.sceneDatabase ?? null,
        materialMetadata: job.materialMetadata ?? null,
        materialRegistry: job.materialRegistry ?? null,
        enableFrustumCull: job.enableFrustumCull !== false,
        hzbView: job.hzbView ?? null,
        viewportWidth: job.viewportWidth,
        viewportHeight: job.viewportHeight,
        enableHzbCull: job.enableHzbCull !== false,
        enableInstanceCull: job.enableInstanceCull !== false,
        clearTargets: job.clearTargets !== false,
        secondChance: job.secondChance === true,
        alphaTestedPass: job.alphaTestedPass === true,
        gpuCounterBuffer: job.gpuCounterBuffer ?? null
      },
      this.asUpload(upload),
      this.asCommandContext(upload)
    );
  }

  private resolveCommandContext(
    ctx: FrameGraphContext
  ): ShadeGPUCommandContext | null {
    return this.asCommandContext(ctx.encoder);
  }

  private asCommandContext(value: unknown): ShadeGPUCommandContext | null {
    if (
      value &&
      typeof value === "object" &&
      "isGPUCommandContext" in value &&
      (value as { isGPUCommandContext?: boolean }).isGPUCommandContext === true &&
      "gpu_encoder" in value &&
      "writeBuffer" in value &&
      "clearBuffer" in value
    ) {
      return value as ShadeGPUCommandContext;
    }
    return null;
  }

  private resolveUpload(ctx: FrameGraphContext): UploadCmd {
    const e = ctx.encoder;
    if (
      e &&
      typeof e === "object" &&
      "writeBuffer" in e &&
      typeof (e as ShadeGPUCommandContext).writeBuffer === "function"
    ) {
      return this.commandUpload(e as ShadeGPUCommandContext);
    }
    return this.queueUpload();
  }

  private asUpload(upload?: UploadCmd | ShadeGPUCommandContext): UploadCmd {
    const command = this.asCommandContext(upload);
    if (command) return this.commandUpload(command);
    if (upload && typeof upload.writeBuffer === "function") {
      return upload as UploadCmd;
    }
    return this.queueUpload();
  }

  private commandUpload(command: ShadeGPUCommandContext): UploadCmd {
    return {
      writeBuffer(buffer, bufferOffset, data, dataOffset = 0, size) {
        if (ArrayBuffer.isView(data)) {
          const byteLength = size ?? data.byteLength - dataOffset;
          command.writeBuffer(
            buffer,
            bufferOffset,
            data.buffer as ArrayBuffer,
            data.byteOffset + dataOffset,
            byteLength
          );
          return;
        }
        command.writeBuffer(
          buffer,
          bufferOffset,
          data,
          dataOffset,
          size ?? data.byteLength - dataOffset
        );
      }
    };
  }

  private queueUpload(): UploadCmd {
    const device = this.device;
    return {
      writeBuffer(buffer, bufferOffset, data, dataOffset = 0, size?) {
        if (ArrayBuffer.isView(data)) {
          const view = data;
          const byteLength = size ?? view.byteLength - dataOffset;
          const copy = new ArrayBuffer(byteLength);
          new Uint8Array(copy).set(
            new Uint8Array(
              view.buffer,
              view.byteOffset + dataOffset,
              byteLength
            )
          );
          writeGpuBuffer(
            device.queue,
            "VisibilityPass/upload-aligned-copy",
            buffer,
            bufferOffset,
            copy
          );
        } else {
          writeGpuBuffer(
            device.queue,
            "VisibilityPass/upload",
            buffer,
            bufferOffset,
            data,
            dataOffset,
            size
          );
        }
      }
    };
  }

  private executeEncoder(
    encoder: GPUCommandEncoder,
    camera: PerspectiveCamera,
    scene: Scene,
    views: {
      meshId: GPUTextureView;
      triangleId: GPUTextureView;
      depth: GPUTextureView;
    },
    opts: {
      gpuCameraBuffer: GPUBuffer | null;
      gpuPreviousCameraBuffer: GPUBuffer | null;
      gpuViewBuffer: GPUBuffer | null;
      meshlets: MeshletGpuTable | null;
      drawList: MeshletDrawList | null;
      meshTable: GpuBufferSlice | null;
      transformTable: GpuBufferSlice | null;
      sceneDatabase: SceneDatabase | null;
      materialMetadata: MaterialMetadataTable | null;
      materialRegistry: GPUMaterialRegistry | null;
      enableFrustumCull: boolean;
      hzbView: GPUTextureView | null;
      viewportWidth?: number;
      viewportHeight?: number;
      enableHzbCull: boolean;
      enableInstanceCull: boolean;
      clearTargets: boolean;
      secondChance: boolean;
      alphaTestedPass: boolean;
      gpuCounterBuffer: GPUBuffer | null;
    },
    upload: UploadCmd,
    command: ShadeGPUCommandContext | null
  ): void {
    if (this.pipelineMeshletByCull.size === 0) {
      throw new Error("VisibilityPass not init");
    }

    camera.update();
    this.lastDrawCount = 0;
    this.lastUsedDrawIndirect = false;
    this.lastUsedSceneTableModel = false;
    this.lastFrustumCulled = 0;
    this.lastFrustumUnculled = 0;
    this.lastHzbCullRan = false;
    this.lastExpandRan = false;
    this.lastInstanceCullRan = false;
    this.lastDispatchIndirectUsed = false;
    this.lastSecondChance = opts.secondChance;
    this.lastClearTargets = opts.clearTargets;
    this.lastDualMaybeRan = false;
    this.lastMeshletDualMaybeRan = false;
    this.lastGpuSpRan = false;
    this.lastBlellochScanRan = false;
    this.lastPrevCameraVpUsed = false;
    this.lastAlphaTestedPass = opts.alphaTestedPass;
    this.lastAlphaBucketPasses = 0;
    this.lastMaterialMetadataUsed = false;
    this.lastBucketExtractRan = false;
    this.lastBucketScatterRan = false;
    this.lastSceneMeshFilterRan = false;

    const bucketRes = this.resolveMeshletPrimitive(scene);
    this.lastActiveBuckets = bucketRes.active;
    this.lastActiveBucketCount = bucketRes.active.length;
    this.lastOpaqueBucketCount = bucketRes.opaque.length;
    this.lastAlphaBucketCount = bucketRes.alpha.length;
    this.lastBucketPrimitiveHomogeneous = bucketRes.homogeneous;
    this.lastMeshletCullMode = bucketRes.cullMode;
    this.lastBucketPasses = 0;
    this.lastMultiBucketPass = false;

    const meshlets = opts.meshlets;
    const drawList = opts.drawList;

    const canMeshlet =
      !!meshlets &&
      !!meshlets.headerBuffer &&
      !!meshlets.dataBuffer &&
      !!meshlets.meshMetaBuffer &&
      !!drawList &&
      !!opts.gpuCameraBuffer &&
      !!opts.sceneDatabase?.buffer &&
      !!opts.meshTable &&
      !!opts.transformTable;

    if (!canMeshlet || !drawList || !meshlets) {
      return;
    }
    const sceneDatabase = opts.sceneDatabase!;

    const writeBuf = (
      buffer: GPUBuffer,
      offset: number,
      data: ArrayBuffer | ArrayBufferView
    ) => upload.writeBuffer(buffer, offset, data);

    const marker =
      typeof (upload as ShadeGPUCommandContext).insertDebugMarker ===
      "function"
        ? (l: string) =>
            (upload as ShadeGPUCommandContext).insertDebugMarker!(l)
        : undefined;

    const vw = opts.viewportWidth ?? 1;
    const vh = opts.viewportHeight ?? 1;
    if (!opts.secondChance && !opts.alphaTestedPass) {
      if (!command) return;
      drawList.beginVisibilityCycle(command, meshlets, sceneDatabase);
    }

    if (
      !opts.secondChance &&
      opts.hzbView &&
      opts.gpuPreviousCameraBuffer
    ) {
      this.lastPrevCameraVpUsed = true;
    }

    if (opts.secondChance) {
      this.runMeshletBucketPass(encoder, {
        command,
        meshlets,
        drawList,
        opts,
        writeBuf,
        marker,
        vw,
        vh,
        bucket: null,
        clearTargets: false,
        passIndex: 0,
        views,
        secondBuckets: bucketRes.opaque
      });
      return;
    }

    if (opts.alphaTestedPass) {
      if (!command) return;
      const anyAlpha = this.runAlphaTestedPass(command, {
        transientCommand: command,
        scene,
        meshlets,
        drawList,
        opts,
        buckets: bucketRes.alpha,
        writeBuf,
        vw,
        vh,
        views
      });
      this.lastUsedMeshletPath = anyAlpha;
      return;
    }

    const opaqueBuckets = bucketRes.opaque;

    this.lastMultiBucketPass = opaqueBuckets.length > 1;
    const anyIndirect = this.runMultiBucketMeshletPasses(encoder, {
      command,
      meshlets,
      drawList,
      opts,
      writeBuf,
      marker,
      vw,
      vh,
      buckets: opaqueBuckets,
      clearFirst: opts.clearTargets,
      views
    });

    this.lastUsedMeshletPath = anyIndirect;
  }

  private runAlphaTestedPass(
    command: MaterialMeshletCommandContext,
    p: {
      transientCommand: ShadeGPUCommandContext | null;
      scene: Scene;
      meshlets: MeshletGpuTable;
      drawList: MeshletDrawList;
      opts: {
        gpuCameraBuffer: GPUBuffer | null;
        gpuViewBuffer: GPUBuffer | null;
        sceneDatabase: SceneDatabase | null;
        materialMetadata: MaterialMetadataTable | null;
        materialRegistry: GPUMaterialRegistry | null;
        hzbView: GPUTextureView | null;
        enableHzbCull: boolean;
        enableInstanceCull: boolean;
        gpuCounterBuffer: GPUBuffer | null;
      };
      buckets: ActiveMaterialBucket[];
      writeBuf: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
      vw: number;
      vh: number;
      views: {
        meshId: GPUTextureView;
        triangleId: GPUTextureView;
        depth: GPUTextureView;
      };
    }
  ): boolean {
    const { meshlets, drawList, opts, writeBuf, vw, vh, views } = p;
    if (!p.transientCommand) return false;
    const sceneDatabase = opts.sceneDatabase;
    const sceneDatabaseBuffer = sceneDatabase?.buffer ?? null;
    const materialBuffer = opts.materialMetadata?.buffer ?? null;
    const materialRegistry = opts.materialRegistry;
    if (
      !sceneDatabase ||
      !sceneDatabaseBuffer ||
      !materialBuffer ||
      !materialRegistry ||
      !opts.gpuCameraBuffer ||
      !opts.gpuViewBuffer ||
      !meshlets.headerBuffer ||
      !meshlets.dataBuffer ||
      !meshlets.meshMetaBuffer
    ) {
      return false;
    }

    const orderedBuckets = [ShadeDrawSide.Front, ShadeDrawSide.Double]
      .map((side) => p.buckets.find((bucket) => bucket.draw_side === side))
      .filter((bucket): bucket is ActiveMaterialBucket => bucket !== undefined);
    this.lastMultiBucketPass = orderedBuckets.length > 1;
    if (orderedBuckets.length === 0) return false;

    const materialsInScene = p.scene.instances.materials;
    const alphaMaterialCapacity = materialsInScene.reduce(
      (count, material) =>
        count +
        (material.transparency_mode === ShadeTransparencyMode.AlphaTested &&
        material.draw_mode === ShadeDrawMode.Triangles &&
        (material.draw_side === ShadeDrawSide.Front ||
          material.draw_side === ShadeDrawSide.Double)
          ? 1
          : 0),
      0
    );

    let anyPass = false;
    for (const bucket of orderedBuckets) {
      const materials = materialsInScene.filter(
        (material) =>
          material.transparency_mode === ShadeTransparencyMode.AlphaTested &&
          material.draw_mode === ShadeDrawMode.Triangles &&
          material.draw_side === bucket.draw_side
      );
      if (materials.length === 0) continue;

      const sliced = drawList.dispatchBucketSlice(
        command.gpu_encoder,
        this.device,
        {
          command: p.transientCommand,
          bucketId: bucket.bucketId,
          writeBuffer: writeBuf
        }
      );
      if (!sliced) continue;

      this.lastBucketExtractRan = true;
      if (opts.enableInstanceCull && opts.hzbView) {
        const culled = drawList.dispatchInstanceCull(command.gpu_encoder, this.device, {
          cameraBuffer: opts.gpuCameraBuffer,
          sceneDatabaseBuffer,
          hzbView: opts.hzbView,
          writeBuffer: writeBuf
        });
        if (!culled) continue;
        this.lastInstanceCullRan =
          this.lastInstanceCullRan || drawList.lastInstanceCullRan;
      }

      const expanded = drawList.dispatchExpand(
        command.gpu_encoder,
        this.device,
        sceneDatabaseBuffer,
        meshlets.meshMetaBuffer,
        writeBuf
      );
      if (!expanded) continue;
      this.lastExpandRan = true;
      this.lastGpuSpRan = this.lastGpuSpRan || drawList.lastGpuSpRan;
      const expandedMeshlets = drawList.elementsBuffer;
      if (expandedMeshlets !== null) {
        this.graphics.collection_limits.record(
          p.transientCommand,
          GPUCollectionKind.Meshlets,
          expandedMeshlets
        );
        if (opts.gpuCounterBuffer !== null) {
          this.gpuListCounters.encode(
            p.transientCommand,
            expandedMeshlets,
            opts.gpuCounterBuffer,
            {
              primary: "candidateClusters",
              overflowBit: GPU_QUEUE_OVERFLOW_BITS.meshletList
            }
          );
        }
      }

      if (opts.enableHzbCull && opts.hzbView) {
        const culled = drawList.dispatchHzbCull(command.gpu_encoder, this.device, {
          cameraBuffer: opts.gpuCameraBuffer,
          sceneDatabaseBuffer,
          resolutionW: vw,
          resolutionH: vh,
          meshletHeaders: meshlets.headerBuffer,
          hzbView: opts.hzbView,
          gpuCounterBuffer: opts.gpuCounterBuffer,
          writeBuffer: writeBuf
        });
        if (!culled) continue;
        this.lastHzbCullRan = this.lastHzbCullRan || drawList.lastHzbCullRan;
      }

      const inputMeshlets = drawList.elementsBuffer;
      if (!inputMeshlets) continue;
      if (opts.gpuCounterBuffer !== null) {
        this.gpuListCounters.encode(
          p.transientCommand,
          inputMeshlets,
          opts.gpuCounterBuffer,
          {
            primary: "selectedClusters",
            secondary: "alphaClusters",
            triangleField: "hwTriangles",
            trianglesPerElement: MESHLET_DRAW_VERTEX_COUNT / 3,
            overflowBit: GPU_QUEUE_OVERFLOW_BITS.meshletList
          }
        );
      }
      const grouped = this.alphaMaterialDrawList.build(
        command,
        inputMeshlets,
        sceneDatabaseBuffer,
        materials,
        alphaMaterialCapacity
      );
      if (!grouped) continue;

      const primitive = primitiveStateForBucket(
        bucket.draw_mode,
        bucket.draw_side
      );
      if (!primitive || primitive.topology !== "triangle-list") continue;
      const pipeline = this.obtainAlphaPipeline(primitive.cullMode ?? "none");
      const group1 = this.graphics.bind_groups.obtain({
        layout: VISIBILITY_ALPHA_GROUP1,
        entries: [
          { buffer: grouped.meshlets },
          { buffer: meshlets.headerBuffer },
          { buffer: meshlets.dataBuffer },
          { buffer: sceneDatabaseBuffer },
          { buffer: meshlets.meshMetaBuffer }
        ]
      });
      const group2 = this.graphics.bind_groups.obtain({
        layout: VISIBILITY_ALPHA_GROUP2,
        entries: [
          { buffer: opts.gpuCameraBuffer },
          { buffer: opts.gpuViewBuffer },
          this.obtainAlphaNoiseView()
        ]
      });
      const pass = command.gpu_encoder.beginRenderPass({
        label: `VisibilityPass/ov/bucket-${bucket.bucketId}`,
        colorAttachments: [
          {
            view: views.triangleId,
            loadOp: "load",
            storeOp: "store"
          },
          {
            view: views.meshId,
            loadOp: "load",
            storeOp: "store"
          }
        ],
        depthStencilAttachment: {
          view: views.depth,
          depthLoadOp: "load",
          depthStoreOp: "store"
        }
      });
      pass.setViewport(0, 0, vw, vh, 0, 1);
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, group1);
      pass.setBindGroup(2, group2);
      for (
        let materialIndex = 0;
        materialIndex < materials.length;
        materialIndex++
      ) {
        const materialContext = materialRegistry.obtain(
          materials[materialIndex]!
        );
        if (!materialContext.is_built) continue;
        const material = materialContext.obtainBindingData();
        pass.setBindGroup(0, this.graphics.bind_groups.obtain({
          layout: VISIBILITY_ALPHA_GROUP0,
          entries: [
            material.texture_diffuse,
            material.texture_diffuse_sampler,
            { buffer: materialContext.uniform_buffer }
          ]
        }));
        pass.drawIndirect(
          grouped.commands,
          materialIndex * MATERIAL_SORT_DRAW_ARGS_BYTES
        );
      }
      pass.end();

      this.lastAlphaBucketPasses++;
      this.lastBucketPasses++;
      this.lastUsedDrawIndirect = true;
      this.lastDispatchIndirectUsed = true;
      this.lastUsedSceneTableModel = true;
      anyPass = true;
    }
    return anyPass;
  }

  private runMultiBucketMeshletPasses(
    encoder: GPUCommandEncoder,
    p: {
      command: ShadeGPUCommandContext | null;
      meshlets: MeshletGpuTable;
      drawList: MeshletDrawList;
      opts: {
        gpuCameraBuffer: GPUBuffer | null;
        gpuPreviousCameraBuffer: GPUBuffer | null;
        gpuViewBuffer: GPUBuffer | null;
        meshlets: MeshletGpuTable | null;
        drawList: MeshletDrawList | null;
        meshTable: GpuBufferSlice | null;
        transformTable: GpuBufferSlice | null;
        sceneDatabase: SceneDatabase | null;
        materialMetadata?: MaterialMetadataTable | null;
        enableFrustumCull: boolean;
        hzbView: GPUTextureView | null;
        enableHzbCull: boolean;
        enableInstanceCull: boolean;
        secondChance: boolean;
        gpuCounterBuffer: GPUBuffer | null;
      };
      writeBuf: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
      marker?: (label: string) => void;
      vw: number;
      vh: number;
      buckets: ActiveMaterialBucket[];
      clearFirst: boolean;
      views: {
        meshId: GPUTextureView;
        triangleId: GPUTextureView;
        depth: GPUTextureView;
      };
    }
  ): boolean {
    const {
      meshlets,
      drawList,
      opts,
      writeBuf,
      marker,
      vw,
      vh,
      buckets,
      clearFirst,
      views
    } = p;
    const sceneDatabase = opts.sceneDatabase;
    if (sceneDatabase === null || !p.command || !opts.gpuCameraBuffer) {
      return false;
    }

    const materialsBuf =
      opts.materialMetadata?.buffer && opts.materialMetadata.slotCount > 0
        ? opts.materialMetadata.buffer
        : null;

    if (!materialsBuf || !opts.meshTable || buckets.length === 0) return false;

    const filtered = this.dispatchSceneMeshFilter(encoder, {
      cameraBuffer: opts.gpuCameraBuffer,
      sceneDatabase,
      meshlets,
      drawList,
      writeBuffer: writeBuf,
      command: p.command,
      gpuCounterBuffer: opts.gpuCounterBuffer
    });
    if (!filtered) return false;
    if (drawList.meshListBuffer !== null) {
      this.graphics.collection_limits.record(
        p.command,
        GPUCollectionKind.Meshes,
        drawList.meshListBuffer
      );
    }

    const scatterOk = drawList.dispatchBucketScatter(encoder, this.device, {
      sceneDatabaseBuffer: sceneDatabase.buffer,
      materialsBuffer: materialsBuf,
      writeBuffer: writeBuf
    });
    if (!scatterOk) return false;
    this.lastBucketScatterRan = true;
    this.lastMaterialMetadataUsed = true;

    let anyDrew = false;
    let clearNext = clearFirst;

    for (let bi = 0; bi < buckets.length; bi++) {
      const bucket = buckets[bi]!;
      const cullMode =
        primitiveStateForBucket(bucket.draw_mode, bucket.draw_side)
          ?.cullMode ?? "none";
      this.lastMeshletCullMode = cullMode;

      const drew = this.runMeshletBucketPass(encoder, {
        command: p.command,
        meshlets,
        drawList,
        opts,
        writeBuf,
        marker,
        vw,
        vh,
        bucket,
        clearTargets: clearNext,
        passIndex: bi,
        views,
        forceCullMode: cullMode,
        kaScatterReady: true
      });

      if (drew) {
        anyDrew = true;
        clearNext = false;
        this.lastBucketPasses++;
      }
    }

    return anyDrew;
  }

  private dispatchSceneMeshFilter(
    encoder: GPUCommandEncoder,
    opts: {
      cameraBuffer: GPUBuffer | null;
      sceneDatabase: SceneDatabase;
      meshlets: MeshletGpuTable;
      drawList: MeshletDrawList;
      writeBuffer: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
      command: ShadeGPUCommandContext | null;
      gpuCounterBuffer: GPUBuffer | null;
    }
  ): boolean {
    const pipeline = this.sceneMeshFilterPipeline;
    if (!pipeline || !opts.cameraBuffer) return false;
    const output = opts.drawList.prepareGpuMeshFilterOutput(
      opts.meshlets,
      opts.sceneDatabase,
      opts.sceneDatabase.meshCount,
      this.device,
      encoder
    );
    if (!output) return false;
    const groupCount = opts.sceneDatabase.meshes.dispatch_group_count(
      SCENE_MESH_FRUSTUM_FILTER_WORKGROUP_SIZE
    );
    if (groupCount <= 0) return false;
    const group0 = this.graphics.bind_groups.obtain({
      layout: VISIBILITY_FILTER_GROUP0,
      entries: [
        { buffer: opts.cameraBuffer },
        { buffer: opts.sceneDatabase.buffer }
      ]
    });
    const group1 = this.graphics.bind_groups.obtain({
      layout: VISIBILITY_FILTER_GROUP1,
      entries: [{ buffer: output }]
    });
    const pass = encoder.beginComputePass({
      label: "VisibilityPass/tb-eb-paged-frustum-filter"
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    pass.dispatchWorkgroups(groupCount);
    pass.end();
    if (opts.command !== null && opts.gpuCounterBuffer !== null) {
      this.gpuListCounters.encode(
        opts.command,
        output,
        opts.gpuCounterBuffer,
        {
          primary: "visibleInstances",
          inputField: "candidateInstances",
          rejectedField: "rejectedFrustum",
          inputCount: opts.sceneDatabase.meshCount,
          overflowBit: GPU_QUEUE_OVERFLOW_BITS.sceneMeshList,
          elementBytes: Uint32Array.BYTES_PER_ELEMENT
        }
      );
    }
    this.lastSceneMeshFilterRan = true;
    this.lastFrustumUnculled += opts.sceneDatabase.meshCount;
    return true;
  }

  private runMeshletBucketPass(
    encoder: GPUCommandEncoder,
    p: {
      command: ShadeGPUCommandContext | null;
      meshlets: MeshletGpuTable;
      drawList: MeshletDrawList;
      opts: {
        gpuCameraBuffer: GPUBuffer | null;
        gpuPreviousCameraBuffer: GPUBuffer | null;
        gpuViewBuffer: GPUBuffer | null;
        meshlets: MeshletGpuTable | null;
        drawList: MeshletDrawList | null;
        meshTable: GpuBufferSlice | null;
        transformTable: GpuBufferSlice | null;
        sceneDatabase: SceneDatabase | null;
        materialMetadata?: MaterialMetadataTable | null;
        enableFrustumCull: boolean;
        hzbView: GPUTextureView | null;
        enableHzbCull: boolean;
        enableInstanceCull: boolean;
        secondChance: boolean;
        gpuCounterBuffer: GPUBuffer | null;
      };
      writeBuf: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
      marker?: (label: string) => void;
      vw: number;
      vh: number;
      bucket: ActiveMaterialBucket | null;
      clearTargets: boolean;
      passIndex: number;
      views: {
        meshId: GPUTextureView;
        triangleId: GPUTextureView;
        depth: GPUTextureView;
      };
      forceCullMode?: GPUCullMode;
      kaScatterReady?: boolean;
      secondBuckets?: ActiveMaterialBucket[];
    }
  ): boolean {
    const {
      meshlets,
      drawList,
      opts,
      writeBuf,
      marker,
      vw,
      vh,
      bucket,
      clearTargets,
      passIndex,
      views,
      kaScatterReady
    } = p;
    const sceneDatabase = opts.sceneDatabase;
    if (sceneDatabase === null) return false;

    const materialsBuf =
      opts.materialMetadata?.buffer && opts.materialMetadata.slotCount > 0
        ? opts.materialMetadata.buffer
        : null;
    let directHbBucket = false;

    if (opts.secondChance) {
      drawList.prepareSecondChance({
        device: this.device,
        insertDebugMarker: marker
      });
      this.lastFrustumUnculled = drawList.lastUnculledCount;
      this.lastFrustumCulled = drawList.lastCulledCount;
      this.lastDualMaybeRan = drawList.lastDualMaybeRan;
    } else if (kaScatterReady && bucket && p.command) {
      if (drawList.meshListCount <= 0 && drawList.count <= 0) {
        return false;
      }
      directHbBucket =
        !!p.command &&
        opts.enableInstanceCull &&
        !!opts.hzbView &&
        !!opts.gpuPreviousCameraBuffer;
      if (directHbBucket) {
        drawList.prepareBucketPassFromScatter();
      } else {
        const sliced = drawList.dispatchBucketSlice(encoder, this.device, {
          command: p.command!,
          bucketId: bucket.bucketId,
          writeBuffer: writeBuf
        });
        if (!sliced) return false;
        this.lastBucketExtractRan = true;
      }
    } else {
      return false;
    }

    if (
      opts.enableInstanceCull &&
      opts.hzbView &&
      opts.meshTable
    ) {
      if (opts.secondChance) {
        const culled = drawList.dispatchInstanceCull(encoder, this.device, {
          cameraBuffer: opts.gpuCameraBuffer!,
          sceneDatabaseBuffer: opts.sceneDatabase!.buffer!,
          hzbView: opts.hzbView,
          writeBuffer: writeBuf,
          inputFromMaybe: true
        });
        if (!culled) return false;
      } else {
        if (!directHbBucket || !bucket || !opts.gpuPreviousCameraBuffer) {
          return false;
        }
        const dualOk = drawList.dispatchInstanceCullDual(
          encoder,
          this.device,
          {
            command: p.command!,
            bucketId: bucket.bucketId,
            previousCameraBuffer: opts.gpuPreviousCameraBuffer,
            sceneDatabaseBuffer: opts.sceneDatabase!.buffer!,
            hzbView: opts.hzbView,
            writeBuffer: writeBuf
          }
        );
        if (!dualOk) return false;
        if (drawList.meshPositiveBuffer !== null) {
          this.graphics.collection_limits.record(
            p.command!,
            GPUCollectionKind.Meshes,
            drawList.meshPositiveBuffer
          );
        }
      }
      this.lastInstanceCullRan =
        this.lastInstanceCullRan || drawList.lastInstanceCullRan;
      this.lastDualMaybeRan =
        this.lastDualMaybeRan || drawList.lastDualMaybeRan;
      this.lastDispatchIndirectUsed =
        this.lastDispatchIndirectUsed || drawList.lastDispatchIndirectUsed;
    }

    if (meshlets.meshMetaBuffer && opts.meshTable) {
      const expanded = drawList.dispatchExpand(
        encoder,
        this.device,
        opts.meshTable!.buffer,
        meshlets.meshMetaBuffer,
        writeBuf,
        opts.secondChance
          ? { appendToMeshletMaybe: true }
          : undefined
      );
      if (!expanded) return false;
      this.lastExpandRan = this.lastExpandRan || drawList.lastExpandRan;
      this.lastGpuSpRan = this.lastGpuSpRan || drawList.lastGpuSpRan;
      this.lastBlellochScanRan =
        this.lastBlellochScanRan || drawList.lastBlellochScanRan;
      this.lastDispatchIndirectUsed =
        this.lastDispatchIndirectUsed || drawList.lastDispatchIndirectUsed;
      const expandedMeshlets = drawList.elementsBuffer;
      if (p.command !== null && expandedMeshlets !== null) {
        this.graphics.collection_limits.record(
          p.command,
          GPUCollectionKind.Meshlets,
          expandedMeshlets
        );
        if (opts.gpuCounterBuffer !== null) {
          this.gpuListCounters.encode(
            p.command,
            expandedMeshlets,
            opts.gpuCounterBuffer,
            {
              primary: "candidateClusters",
              overflowBit: GPU_QUEUE_OVERFLOW_BITS.meshletList
            }
          );
        }
      }
    } else return false;

    if (
      opts.enableHzbCull &&
      opts.hzbView &&
      opts.meshTable &&
      opts.transformTable &&
      meshlets.headerBuffer &&
      drawList.count > 0
    ) {
      if (opts.secondChance) {
        const culled = drawList.dispatchHzbCull(encoder, this.device, {
          cameraBuffer: opts.gpuCameraBuffer!,
          sceneDatabaseBuffer: opts.sceneDatabase!.buffer!,
          resolutionW: vw,
          resolutionH: vh,
          meshletHeaders: meshlets.headerBuffer,
          hzbView: opts.hzbView,
          gpuCounterBuffer: opts.gpuCounterBuffer,
          writeBuffer: writeBuf,
          secondChance: true
        });
        if (!culled) return false;
      } else {
        if (!opts.gpuPreviousCameraBuffer || !opts.gpuViewBuffer) return false;
        const dualOk = drawList.dispatchHzbCullDual(
          encoder,
          this.device,
          {
            currentCameraBuffer: opts.gpuCameraBuffer!,
            previousCameraBuffer: opts.gpuPreviousCameraBuffer,
            viewBuffer: opts.gpuViewBuffer,
            sceneDatabaseBuffer: opts.sceneDatabase!.buffer!,
            meshletHeaders: meshlets.headerBuffer,
            hzbView: opts.hzbView,
            gpuCounterBuffer: opts.gpuCounterBuffer,
            writeBuffer: writeBuf
          }
        );
        if (!dualOk) return false;
      }
      this.lastHzbCullRan = this.lastHzbCullRan || drawList.lastHzbCullRan;
      this.lastMeshletDualMaybeRan =
        this.lastMeshletDualMaybeRan || drawList.lastMeshletDualMaybeRan;
      this.lastDispatchIndirectUsed =
        this.lastDispatchIndirectUsed || drawList.lastDispatchIndirectUsed;
    }

    if (opts.secondChance) {
      const secondBuckets = p.secondBuckets ?? [];
      const sceneDatabaseBuffer = opts.sceneDatabase?.buffer ?? null;
      if (
        !p.command ||
        !materialsBuf ||
        !sceneDatabaseBuffer ||
        secondBuckets.length === 0
      ) {
        return false;
      }

      const scattered = drawList.dispatchMeshletBucketScatter(
        encoder,
        this.device,
        {
          sceneDatabaseBuffer,
          materialsBuffer: materialsBuf,
          writeBuffer: writeBuf
        }
      );
      if (!scattered) return false;

      this.lastBucketScatterRan = true;
      this.lastMaterialMetadataUsed = true;
      this.lastDispatchIndirectUsed = true;
      this.lastMultiBucketPass = secondBuckets.length > 1;

      let anyDrew = false;
      for (const secondBucket of secondBuckets) {
        const sliced = drawList.dispatchMeshletBucketSlice(
          encoder,
          this.device,
          {
            command: p.command,
            bucketId: secondBucket.bucketId,
            writeBuffer: writeBuf
          }
        );
        if (!sliced) continue;

        this.lastBucketExtractRan = true;
        drawList.dispatchFillDrawIndirectArgs(encoder, this.device);
        const cullMode =
          primitiveStateForBucket(
            secondBucket.draw_mode,
            secondBucket.draw_side
          )?.cullMode ?? "none";
        this.lastMeshletCullMode = cullMode;

        const drew = this.drawActiveMeshletList(encoder, {
          drawList,
          meshlets,
          gpuCameraBuffer: opts.gpuCameraBuffer!,
          sceneDatabaseBuffer,
          views,
          cullMode,
          clearTargets: false,
          label: `Visibility/ID+Depth/second-bucket-${secondBucket.bucketId}`,
          bindGroupLabel: `Visibility/BG0-meshlet-second-b${secondBucket.bucketId}`,
          command: p.command,
          gpuCounterBuffer: opts.gpuCounterBuffer
        });
        if (drew) {
          anyDrew = true;
          this.lastBucketPasses++;
        }
      }
      return anyDrew;
    }

    drawList.dispatchFillDrawIndirectArgs(encoder, this.device);

    const useIndirect =
      drawList.count > 0 &&
      !!drawList.elementsBuffer &&
      !!drawList.argsBuffer &&
      !!opts.gpuCameraBuffer &&
      !!opts.sceneDatabase?.buffer &&
      !!meshlets.meshMetaBuffer;

    if (!useIndirect) {
      if (opts.secondChance) return false;
      return false;
    }

    const cullMode =
      p.forceCullMode ??
      (bucket
        ? (primitiveStateForBucket(bucket.draw_mode, bucket.draw_side)
            ?.cullMode ?? "none")
        : "none");
    return this.drawActiveMeshletList(encoder, {
      drawList,
      meshlets,
      gpuCameraBuffer: opts.gpuCameraBuffer!,
      sceneDatabaseBuffer: opts.sceneDatabase!.buffer!,
      views,
      cullMode,
      clearTargets,
      label: bucket
        ? `Visibility/ID+Depth/bucket-${bucket.bucketId}`
        : passIndex > 0
          ? `Visibility/ID+Depth/pass-${passIndex}`
          : "Visibility/ID+Depth",
      bindGroupLabel: `Visibility/BG0-meshlet-indirect-b${bucket?.bucketId ?? 0}`,
      command: p.command,
      gpuCounterBuffer: opts.gpuCounterBuffer
    });
  }

  private drawActiveMeshletList(
    encoder: GPUCommandEncoder,
    p: {
      drawList: MeshletDrawList;
      meshlets: MeshletGpuTable;
      gpuCameraBuffer: GPUBuffer;
      sceneDatabaseBuffer: GPUBuffer;
      views: {
        meshId: GPUTextureView;
        triangleId: GPUTextureView;
        depth: GPUTextureView;
      };
      cullMode: GPUCullMode;
      clearTargets: boolean;
      label: string;
      bindGroupLabel: string;
      command: ShadeGPUCommandContext | null;
      gpuCounterBuffer: GPUBuffer | null;
    }
  ): boolean {
    const { drawList, meshlets } = p;
    const listBuf = drawList.elementsBuffer;
    if (
      !listBuf ||
      !drawList.argsBuffer ||
      !meshlets.meshMetaBuffer ||
      !meshlets.headerBuffer ||
      !meshlets.dataBuffer
    ) {
      return false;
    }

    if (p.command !== null && p.gpuCounterBuffer !== null) {
      this.gpuListCounters.encode(
        p.command,
        listBuf,
        p.gpuCounterBuffer,
        {
          primary: "selectedClusters",
          secondary: "hwClusters",
          triangleField: "hwTriangles",
          trianglesPerElement: MESHLET_DRAW_VERTEX_COUNT / 3,
          overflowBit: GPU_QUEUE_OVERFLOW_BITS.meshletList
        }
      );
    }

    const loadOp: GPULoadOp = p.clearTargets ? "clear" : "load";
    const pass = encoder.beginRenderPass({
      label: p.label,
      colorAttachments: [
        {
          view: p.views.triangleId,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp,
          storeOp: "store"
        },
        {
          view: p.views.meshId,
          clearValue: {
            r: VIS_MESH_CLEAR_SENTINEL,
            g: 0,
            b: 0,
            a: 0
          },
          loadOp,
          storeOp: "store"
        }
      ],
      depthStencilAttachment: {
        view: p.views.depth,
        depthClearValue: 0,
        depthLoadOp: loadOp,
        depthStoreOp: "store"
      }
    });

    const listSize = Math.min(
      listBuf.size,
      Math.max(
        MESHLET_LIST_ELEMENTS_OFFSET + MESHLET_INSTANCE_STRIDE_BYTES,
        MESHLET_LIST_ELEMENTS_OFFSET + drawList.elementsByteSize
      )
    );
    const bindSize =
      drawList.hzbCullActive || drawList.instanceCullActive
        ? listBuf.size
        : listSize;
    const bg = this.graphics.bind_groups.obtain({
      layout: VISIBILITY_MESHLET_GROUP,
      entries: [
        { buffer: p.gpuCameraBuffer },
        { buffer: p.sceneDatabaseBuffer },
        { buffer: meshlets.meshMetaBuffer },
        {
          buffer: listBuf,
          offset: 0,
          size: bindSize
        },
        { buffer: meshlets.headerBuffer },
        { buffer: meshlets.dataBuffer }
      ]
    });
    const pipeline = this.obtainMeshletPipeline(p.cullMode);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.drawIndirect(drawList.argsBuffer, 0);
    pass.end();

    this.lastDrawCount += drawList.count;
    this.lastUsedDrawIndirect = true;
    this.lastUsedMeshletPath = true;
    this.lastUsedSceneTableModel = true;
    this.lastClearTargets = p.clearTargets;
    return true;
  }

  destroy(): void {
    this.pipelineMeshletByCull.clear();
    this.alphaPipelines.clear();
    this.alphaMaterialDrawList.destroy();
    this.alphaNoiseView = null;
    this.sceneMeshFilterPipeline = null;
  }

  private obtainAlphaNoiseView(): GPUTextureView {
    this.alphaNoiseView ??= this.graphics.textures
      .obtain(HILBERT_NOISE_TEXTURE)
      .obtainView();
    return this.alphaNoiseView;
  }
}

function resolveGpuBuffer(value: unknown): GPUBuffer {
  if (
    value &&
    typeof value === "object" &&
    "size" in value &&
    "usage" in value
  ) {
    return value as GPUBuffer;
  }
  throw new Error("VisibilityPass expected GPU counter buffer");
}
