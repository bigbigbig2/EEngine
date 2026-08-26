/**
 * 阴影光栅阶段：为需要投影的光源生成阴影图集内容。
 */

import type { Camera } from "../../camera/Camera.js";
import {
  MESHLET_INSTANCE_STRIDE_BYTES,
  MESHLET_LIST_ELEMENTS_OFFSET,
  type MeshletDrawList
} from "../../gpu/MeshletDrawList.js";
import type { MeshletGpuTable } from "../../gpu/MeshletGpuTable.js";
import type {
  GpuBufferSlice,
  SceneDatabase
} from "../../gpu/SceneDatabase.js";
import {
  SCENE_MESH_FRUSTUM_FILTER_WORKGROUP_SIZE,
  SCENE_MESH_FRUSTUM_FILTER_WGSL,
  SCENE_MESH_SPHERE_FILTER_WGSL,
  SCENE_MESH_SPHERE_FILTER_WORKGROUP_SIZE
} from "../../gpu/SceneDatabase.js";
import type { MaterialMetadataTable } from "../../gpu/MaterialMetadataTable.js";
import type { GPUMaterialRegistry } from "../../gpu/GPUMaterialContext.js";
import { MaterialMeshletDrawList } from "../../gpu/MaterialMeshletDrawList.js";
import {
  ShadeDrawMode,
  ShadeTransparencyMode
} from "../../material/enums.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { Scene } from "../../scene/Scene.js";
import {
  CULL_POLICY_REVERSED,
  collectActiveMaterialBuckets,
  listAlphaTestedActiveBuckets,
  listOpaqueActiveBuckets,
  primitiveStateForBucket
} from "../../material/materialBucketId.js";
import {
  POINT_SHADOW_OCTAHEDRAL_RESOLVE_WGSL,
  POINT_SHADOW_RESOLVE_SETTINGS_TYPE,
  SHADOW_ALPHA_RASTER_WGSL,
  SHADOW_DEPTH_CLEAR_WGSL,
  SHADOW_OPAQUE_RASTER_WGSL
} from "../../shaders/shadow_raster.js";
import { MATERIAL_SORT_DRAW_ARGS_BYTES } from "../../shaders/meshlet_material_sort.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import { GPUCollectionKind } from "../../gpu/GPUCollectionLimits.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../../gpu/GPUDescriptorCaches.js";
import { HILBERT_NOISE_TEXTURE } from "../HilbertNoiseTexture.js";
import type { GPUViewContext } from "../ViewContext.js";
import { WGSL_vec4f } from "../../core/WebGPUTypes.js";

const SHADOW_SPHERE_FILTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
  ]
};

const SHADOW_FRUSTUM_FILTER_GROUPS: readonly GPUBindGroupLayoutDescriptor[] = [
  {
    label: "",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" }
      }
    ]
  },
  {
    label: "",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      }
    ]
  }
];

const SHADOW_OPAQUE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
    ...[1, 2, 3, 4].map((binding) => ({
      binding,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    }))
  ]
};

const SHADOW_ALPHA_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
  ]
};

const SHADOW_ALPHA_GROUP1: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [0, 1, 2, 3, 4].map((binding) => ({
    binding,
    visibility: GPUShaderStage.VERTEX,
    buffer: { type: "read-only-storage" as GPUBufferBindingType }
  }))
};

const SHADOW_ALPHA_GROUP2: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } }
  ]
};

const SHADOW_POINT_RESOLVE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    }
  ]
};

function shadowComputeDescriptor(
  code: string,
  bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[]
): CachedComputePipelineDescriptor {
  return {
    label: "",
    layout: { label: "", bindGroupLayouts },
    compute: { module: { label: "", code }, entryPoint: "main" }
  };
}

const SHADOW_CLEAR_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "",
  layout: { label: "", bindGroupLayouts: [] },
  vertex: {
    module: { label: "", code: SHADOW_DEPTH_CLEAR_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "", code: SHADOW_DEPTH_CLEAR_WGSL },
    entryPoint: "fs_main",
    targets: []
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "always",
    stencilReadMask: 0,
    stencilWriteMask: 0
  }
};

const SHADOW_POINT_RESOLVE_PIPELINE: CachedRenderPipelineDescriptor = {
  ...SHADOW_CLEAR_PIPELINE,
  layout: { label: "", bindGroupLayouts: [SHADOW_POINT_RESOLVE_GROUP] },
  vertex: {
    module: { label: "", code: POINT_SHADOW_OCTAHEDRAL_RESOLVE_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "", code: POINT_SHADOW_OCTAHEDRAL_RESOLVE_WGSL },
    entryPoint: "fs_main",
    targets: []
  }
};

const SHADOW_OPAQUE_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "",
  layout: { label: "", bindGroupLayouts: [SHADOW_OPAQUE_GROUP] },
  vertex: {
    module: { label: "", code: SHADOW_OPAQUE_RASTER_WGSL },
    entryPoint: "vs_main"
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "greater",
    depthBias: -1,
    depthBiasSlopeScale: -2
  }
};

const SHADOW_ALPHA_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [
      SHADOW_ALPHA_GROUP0,
      SHADOW_ALPHA_GROUP1,
      SHADOW_ALPHA_GROUP2
    ]
  },
  vertex: {
    module: { label: "", code: SHADOW_ALPHA_RASTER_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "", code: SHADOW_ALPHA_RASTER_WGSL },
    entryPoint: "fs_main",
    targets: []
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: SHADOW_OPAQUE_PIPELINE.depthStencil
};

export type ShadowRasterViewJob = {
  camera: Camera;
  viewport: readonly [number, number, number, number];
  depthView: GPUTextureView;
  scene: Scene;
  sceneDatabase: SceneDatabase;
  sceneDatabaseBuffer: GPUBuffer;
  meshTable: GpuBufferSlice;
  materialMetadata: MaterialMetadataTable;
  materialRegistry: GPUMaterialRegistry | null;
  meshlets: MeshletGpuTable;
  drawList: MeshletDrawList;
  meshCount: number;
  viewContext: GPUViewContext;
  depthTexture?: GPUTextureContext;
};

type PointShadowPreparationJob = Omit<ShadowRasterViewJob, "viewContext">;

/** 为方向光、聚光灯和点光源生成阴影图集，并复用 GPU 驱动的 Meshlet 裁剪结果。 */
export class ShadowRasterPass {
  private readonly sceneMeshFilterPipeline: GPUComputePipeline;
  private readonly sceneMeshSphereFilterPipeline: GPUComputePipeline;
  private readonly pointResolvePipeline: GPURenderPipeline;
  private readonly clearPipeline: GPURenderPipeline;
  private readonly opaquePipelines = new Map<GPUCullMode, GPURenderPipeline>();
  private readonly alphaPipelines = new Map<GPUCullMode, GPURenderPipeline>();
  private readonly materialDrawList: MaterialMeshletDrawList;
  private alphaNoiseView: GPUTextureView | null = null;

  lastDrawCount = 0;
  lastBucketPasses = 0;

  private readonly device: GPUDevice;

  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("ShadowRasterPass: GraphicsContext has no device");
    }
    this.device = device;
    this.materialDrawList = new MaterialMeshletDrawList(graphics);
    this.sceneMeshFilterPipeline = graphics.compute_pipelines.obtain(
      shadowComputeDescriptor(
        SCENE_MESH_FRUSTUM_FILTER_WGSL,
        SHADOW_FRUSTUM_FILTER_GROUPS
      )
    );
    this.sceneMeshSphereFilterPipeline = graphics.compute_pipelines.obtain(
      shadowComputeDescriptor(SCENE_MESH_SPHERE_FILTER_WGSL, [
        SHADOW_SPHERE_FILTER_GROUP
      ])
    );
    this.clearPipeline = graphics.render_pipelines.obtain(SHADOW_CLEAR_PIPELINE);
    this.pointResolvePipeline = graphics.render_pipelines.obtain(
      SHADOW_POINT_RESOLVE_PIPELINE
    );
  }

  /** 渲染一个阴影视图，返回本次提交的绘制数量。 */
  execute(command: ShadeGPUCommandContext, job: ShadowRasterViewJob): number {
    this.lastDrawCount = 0;
    this.lastBucketPasses = 0;

    const [x, y, width, height] = job.viewport;
    if (width <= 0 || height <= 0) return 0;

    job.drawList.beginVisibilityCycle(
      command,
      job.meshlets,
      job.sceneDatabase
    );
    if (!this.prepareFrustumMeshes(command, job)) return 0;

    return this.executePrepared(command, job);
  }

  executeFull(command: ShadeGPUCommandContext, job: ShadowRasterViewJob): number {
    const view = job.viewContext;
    const depthTexture = job.depthTexture;
    if (!depthTexture) {
      throw new Error("ShadowRasterPass.executeFull requires depthTexture");
    }

    this.lastDrawCount = 0;
    this.lastBucketPasses = 0;
    const [x, y, width, height] = job.viewport;
    if (width <= 0 || height <= 0) return 0;

    const encoder = command.gpu_encoder;
    const writeBuffer = adaptCommandWriter(command);
    const drawList = job.drawList;
    const hzb = view.hierarchical_z_buffer;
    const previousHzbView = hzb.obtainPreviousView();
    const materialBuffer = job.materialMetadata.buffer;
    if (!materialBuffer) return 0;

    // History 无效时必须保守地画出当前深度，再建立可供下一帧使用的 HZB；
    // 不能把“没有 previous”误当成“没有可见阴影工作”。
    if (!previousHzbView) {
      drawList.beginVisibilityCycle(command, job.meshlets, job.sceneDatabase);
      if (!this.prepareFrustumMeshes(command, job)) return 0;
      const drew = this.executePrepared(command, job);
      hzb.build(encoder, depthTexture, job.viewport);
      return drew;
    }

    drawList.beginVisibilityCycle(command, job.meshlets, job.sceneDatabase);
    if (!this.prepareFrustumMeshes(command, job)) return 0;

    this.clearViewport(encoder, job.depthView, job.viewport);

    const active = collectActiveMaterialBuckets(job.scene.instances.materials);
    const opaqueBuckets = listOpaqueActiveBuckets(active);
    const alphaBuckets = listAlphaTestedActiveBuckets(active);
    const scattered = drawList.dispatchBucketScatter(encoder, this.device, {
      sceneDatabaseBuffer: job.sceneDatabaseBuffer,
      materialsBuffer: materialBuffer,
      writeBuffer
    });
    if (!scattered) return 0;

    for (const bucket of opaqueBuckets) {
      const primitive = primitiveStateForBucket(
        bucket.draw_mode,
        bucket.draw_side,
        CULL_POLICY_REVERSED
      );
      if (!primitive || primitive.topology !== "triangle-list") continue;

      drawList.prepareBucketPassFromScatter();
      if (!drawList.dispatchInstanceCullDual(encoder, this.device, {
        command,
        bucketId: bucket.bucketId,
        previousCameraBuffer: view.gpu_previous_camera_state.buffer,
        sceneDatabaseBuffer: job.sceneDatabaseBuffer,
        hzbView: previousHzbView,
        writeBuffer
      })) continue;

      if (!drawList.dispatchExpand(
        encoder,
        this.device,
        job.sceneDatabaseBuffer,
        job.meshlets.meshMetaBuffer!,
        writeBuffer
      )) continue;

      if (!drawList.dispatchHzbCullDual(encoder, this.device, {
        currentCameraBuffer: view.camera.buffer,
        previousCameraBuffer: view.gpu_previous_camera_state.buffer,
        viewBuffer: view.uniform_buffer,
        sceneDatabaseBuffer: job.sceneDatabaseBuffer,
        meshletHeaders: job.meshlets.headerBuffer!,
        hzbView: previousHzbView,
        writeBuffer
      })) continue;

      drawList.dispatchFillDrawIndirectArgs(encoder, this.device);
      this.drawOpaqueCurrentList(command, job, primitive.cullMode ?? "none", bucket.bucketId);
    }

    hzb.build(encoder, depthTexture, job.viewport);
    const currentHzbView = hzb.obtainCurrentView();

    if (currentHzbView && drawList.prepareSecondChance({ device: this.device })) {
      const instanceOk = drawList.dispatchInstanceCull(encoder, this.device, {
        cameraBuffer: view.camera.buffer,
        sceneDatabaseBuffer: job.sceneDatabaseBuffer,
        hzbView: currentHzbView,
        writeBuffer,
        inputFromMaybe: true
      });
      const expandOk = instanceOk && drawList.dispatchExpand(
        encoder,
        this.device,
        job.sceneDatabaseBuffer,
        job.meshlets.meshMetaBuffer!,
        writeBuffer,
        { appendToMeshletMaybe: true }
      );
      const meshletOk = expandOk && drawList.dispatchHzbCull(
        encoder,
        this.device,
        {
          cameraBuffer: view.camera.buffer,
          sceneDatabaseBuffer: job.sceneDatabaseBuffer,
          resolutionW: width,
          resolutionH: height,
          meshletHeaders: job.meshlets.headerBuffer!,
          hzbView: currentHzbView,
          writeBuffer,
          secondChance: true
        }
      );
      const rebucketed = meshletOk && drawList.dispatchMeshletBucketScatter(
        encoder,
        this.device,
        {
          sceneDatabaseBuffer: job.sceneDatabaseBuffer,
          materialsBuffer: materialBuffer,
          writeBuffer
        }
      );

      if (rebucketed) {
        for (const bucket of opaqueBuckets) {
          const primitive = primitiveStateForBucket(
            bucket.draw_mode,
            bucket.draw_side,
            CULL_POLICY_REVERSED
          );
          if (!primitive || primitive.topology !== "triangle-list") continue;
          if (!drawList.dispatchMeshletBucketSlice(encoder, this.device, {
            command,
            bucketId: bucket.bucketId,
            writeBuffer
          })) continue;
          drawList.dispatchFillDrawIndirectArgs(encoder, this.device);
          this.drawOpaqueCurrentList(
            command,
            job,
            primitive.cullMode ?? "none",
            bucket.bucketId,
            true
          );
        }
      }
    }

    hzb.build(encoder, depthTexture, job.viewport);

    if (job.materialRegistry !== null && alphaBuckets.length > 0) {
      const alphaDrew = this.encodeAlphaTested(
        command,
        job,
        alphaBuckets,
        x,
        y,
        width,
        height
      );
      if (alphaDrew) hzb.build(encoder, depthTexture, job.viewport);
    }

    return this.lastBucketPasses;
  }

  private prepareFrustumMeshes(
    command: ShadeGPUCommandContext,
    job: ShadowRasterViewJob
  ): boolean {
    const filteredMeshes = job.drawList.prepareGpuMeshFilterOutput(
      job.meshlets,
      job.sceneDatabase,
      job.meshCount,
      this.device,
      command.gpu_encoder
    );
    if (!filteredMeshes || !job.materialMetadata.buffer) return false;

    const filterGroupCount = job.sceneDatabase.meshes.dispatch_group_count(
      SCENE_MESH_FRUSTUM_FILTER_WORKGROUP_SIZE
    );
    if (filterGroupCount > 0) {
      const filterInputGroup = this.graphics.bind_groups.obtain({
        layout: SHADOW_FRUSTUM_FILTER_GROUPS[0]!,
        entries: [
          { buffer: job.viewContext.camera.buffer },
          {
            buffer: job.sceneDatabaseBuffer,
            offset: 0,
            size: job.sceneDatabaseBuffer.size
          }
        ]
      });
      const filterOutputGroup = this.graphics.bind_groups.obtain({
        layout: SHADOW_FRUSTUM_FILTER_GROUPS[1]!,
        entries: [
          { buffer: filteredMeshes }
        ]
      });
      const filterPass = command.gpu_encoder.beginComputePass({
        label: "ShadowRasterPass/tb-eb-paged-frustum-filter"
      });
      filterPass.setPipeline(this.sceneMeshFilterPipeline);
      filterPass.setBindGroup(0, filterInputGroup);
      filterPass.setBindGroup(1, filterOutputGroup);
      filterPass.dispatchWorkgroups(filterGroupCount);
      filterPass.end();
    }
    this.graphics.collection_limits.record(
      command,
      GPUCollectionKind.Meshes,
      filteredMeshes
    );
    return true;
  }

  preparePointSphereMeshes(
    command: ShadeGPUCommandContext,
    job: PointShadowPreparationJob,
    sphere: ArrayLike<number>
  ): boolean {
    job.drawList.beginVisibilityCycle(
      command,
      job.meshlets,
      job.sceneDatabase
    );
    const filteredMeshes = job.drawList.prepareGpuMeshFilterOutput(
      job.meshlets,
      job.sceneDatabase,
      job.meshCount,
      this.device,
      command.gpu_encoder
    );
    if (!filteredMeshes) return false;

    const sphereBuffer = command.allocateTransientValueBuffer(
      WGSL_vec4f,
      [
        sphere[0] ?? 0,
        sphere[1] ?? 0,
        sphere[2] ?? 0,
        sphere[3] ?? 0
      ]
    );
    const groupCount = job.sceneDatabase.meshes.dispatch_group_count(
      SCENE_MESH_SPHERE_FILTER_WORKGROUP_SIZE
    );
    if (groupCount <= 0) return true;

    const bindGroup = this.graphics.bind_groups.obtain({
      layout: SHADOW_SPHERE_FILTER_GROUP,
      entries: [
        { buffer: sphereBuffer },
        {
          buffer: job.sceneDatabaseBuffer,
          offset: 0,
          size: job.sceneDatabaseBuffer.size
        },
        { buffer: filteredMeshes }
      ]
    });
    const pass = command.gpu_encoder.beginComputePass({
      label: "ShadowRasterPass/GM-paged-sphere-filter"
    });
    pass.setPipeline(this.sceneMeshSphereFilterPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(groupCount);
    pass.end();
    return true;
  }

  executePrepared(command: ShadeGPUCommandContext, job: ShadowRasterViewJob): number {
    this.lastDrawCount = 0;
    this.lastBucketPasses = 0;
    const [x, y, width, height] = job.viewport;
    if (width <= 0 || height <= 0) return 0;

    this.clearViewport(command.gpu_encoder, job.depthView, job.viewport);

    const active = collectActiveMaterialBuckets(job.scene.instances.materials);
    const opaqueBuckets = listOpaqueActiveBuckets(active);
    const alphaBuckets = listAlphaTestedActiveBuckets(active);
    const materialBuffer = job.materialMetadata.buffer;
    if (!materialBuffer) return 0;
    const scattered = job.drawList.dispatchBucketScatter(
      command.gpu_encoder,
      this.device,
      {
        sceneDatabaseBuffer: job.sceneDatabaseBuffer,
        materialsBuffer: materialBuffer,
        writeBuffer: adaptCommandWriter(command)
      }
    );
    if (!scattered) return 0;

    for (const bucket of opaqueBuckets) {
      const primitive = primitiveStateForBucket(
        bucket.draw_mode,
        bucket.draw_side,
        CULL_POLICY_REVERSED
      );
      if (!primitive || primitive.topology !== "triangle-list") continue;

      const bucketExtracted = job.drawList.dispatchBucketSlice(
        command.gpu_encoder,
        this.device,
        {
          command,
          bucketId: bucket.bucketId,
          writeBuffer: adaptCommandWriter(command)
        }
      );
      if (!bucketExtracted) continue;
      const expanded = job.drawList.dispatchExpand(
        command.gpu_encoder,
        this.device,
        job.sceneDatabaseBuffer,
        job.meshlets.meshMetaBuffer!,
        adaptCommandWriter(command)
      );
      if (!expanded || !job.drawList.elementsBuffer || !job.drawList.argsBuffer) {
        continue;
      }
      this.graphics.collection_limits.record(
        command,
        GPUCollectionKind.Meshlets,
        job.drawList.elementsBuffer
      );
      job.drawList.dispatchFillDrawIndirectArgs(command.gpu_encoder, this.device);

      this.drawOpaqueCurrentList(
        command,
        job,
        primitive.cullMode ?? "none",
        bucket.bucketId
      );
    }

    if (job.materialRegistry !== null && alphaBuckets.length > 0) {
      this.encodeAlphaTested(
        command,
        job,
        alphaBuckets,
        x,
        y,
        width,
        height
      );
    }

    return this.lastBucketPasses;
  }

  private drawOpaqueCurrentList(
    command: ShadeGPUCommandContext,
    job: ShadowRasterViewJob,
    cullMode: GPUCullMode,
    bucketId: number,
    secondChance = false
  ): boolean {
    const listBuffer = job.drawList.elementsBuffer;
    const argsBuffer = job.drawList.argsBuffer;
    if (!listBuffer || !argsBuffer) return false;
    const listSize = Math.min(
      listBuffer.size,
      Math.max(
        MESHLET_LIST_ELEMENTS_OFFSET + MESHLET_INSTANCE_STRIDE_BYTES,
        MESHLET_LIST_ELEMENTS_OFFSET + job.drawList.elementsByteSize
      )
    );
    const bindGroup = this.graphics.bind_groups.obtain({
      layout: SHADOW_OPAQUE_GROUP,
      entries: [
        { buffer: job.viewContext.camera.buffer },
        { buffer: job.meshlets.headerBuffer! },
        { buffer: job.meshlets.dataBuffer! },
        { buffer: listBuffer, size: listSize },
        {
          buffer: job.sceneDatabaseBuffer,
          offset: 0,
          size: job.sceneDatabaseBuffer.size
        }
      ]
    });
    const pass = command.gpu_encoder.beginRenderPass({
      label: secondChance
        ? `ShadowRasterPass/$M/second-bucket-${bucketId}`
        : `ShadowRasterPass/$M/bucket-${bucketId}`,
      colorAttachments: [],
      depthStencilAttachment: {
        view: job.depthView,
        depthLoadOp: "load",
        depthStoreOp: "store"
      }
    });
    pass.setViewport(
      job.viewport[0],
      job.viewport[1],
      job.viewport[2],
      job.viewport[3],
      0,
      1
    );
    pass.setPipeline(this.obtainOpaquePipeline(cullMode));
    pass.setBindGroup(0, bindGroup);
    pass.drawIndirect(argsBuffer, 0);
    pass.end();
    this.lastDrawCount += job.drawList.count;
    this.lastBucketPasses++;
    return true;
  }

  private encodeAlphaTested(
    command: ShadeGPUCommandContext,
    job: ShadowRasterViewJob,
    alphaBuckets: ReturnType<typeof listAlphaTestedActiveBuckets>,
    x: number,
    y: number,
    width: number,
    height: number
  ): boolean {
    const materialRegistry = job.materialRegistry;
    if (materialRegistry === null) return false;
    const allMaterials = job.scene.instances.materials;
    const alphaMaterialCapacity = allMaterials.reduce(
      (count, material) =>
        count +
        (material.transparency_mode === ShadeTransparencyMode.AlphaTested &&
        material.draw_mode === ShadeDrawMode.Triangles
          ? 1
          : 0),
      0
    );
    let anyDrew = false;
    for (const bucket of alphaBuckets) {
      const primitive = primitiveStateForBucket(
        bucket.draw_mode,
        bucket.draw_side,
        CULL_POLICY_REVERSED
      );
      if (!primitive || primitive.topology !== "triangle-list") continue;
      const materials = allMaterials.filter(
        (material) =>
          material.transparency_mode === bucket.transparency_mode &&
          material.draw_mode === bucket.draw_mode &&
          material.draw_side === bucket.draw_side
      );
      if (materials.length === 0) continue;

      const sliced = job.drawList.dispatchBucketSlice(
        command.gpu_encoder,
        this.device,
        {
          command,
          bucketId: bucket.bucketId,
          writeBuffer: adaptCommandWriter(command)
        }
      );
      if (!sliced) continue;
      const expanded = job.drawList.dispatchExpand(
        command.gpu_encoder,
        this.device,
        job.sceneDatabaseBuffer,
        job.meshlets.meshMetaBuffer!,
        adaptCommandWriter(command)
      );
      const meshletInput = job.drawList.elementsBuffer;
      if (!expanded || !meshletInput) continue;
      this.graphics.collection_limits.record(
        command,
        GPUCollectionKind.Meshlets,
        meshletInput
      );

      const grouped = this.materialDrawList.build(
        command,
        meshletInput,
        job.sceneDatabaseBuffer,
        materials,
        Math.max(alphaMaterialCapacity, materials.length)
      );
      if (!grouped) continue;

      const pipeline = this.obtainAlphaPipeline(primitive.cullMode ?? "none");
      const group1 = this.graphics.bind_groups.obtain({
        layout: SHADOW_ALPHA_GROUP1,
        entries: [
          { buffer: grouped.meshlets },
          { buffer: job.meshlets.headerBuffer! },
          { buffer: job.meshlets.dataBuffer! },
          { buffer: job.sceneDatabaseBuffer },
          { buffer: job.meshlets.meshMetaBuffer! }
        ]
      });
      const group2 = this.graphics.bind_groups.obtain({
        layout: SHADOW_ALPHA_GROUP2,
        entries: [
          { buffer: job.viewContext.camera.buffer },
          { buffer: job.viewContext.uniform_buffer },
          this.obtainAlphaNoiseView()
        ]
      });
      const pass = command.gpu_encoder.beginRenderPass({
        label: `ShadowRasterPass/JM/bucket-${bucket.bucketId}`,
        colorAttachments: [],
        depthStencilAttachment: {
          view: job.depthView,
          depthLoadOp: "load",
          depthStoreOp: "store"
        }
      });
      pass.setViewport(x, y, width, height, 0, 1);
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, group1);
      pass.setBindGroup(2, group2);
      for (let materialIndex = 0; materialIndex < materials.length; materialIndex++) {
        const materialContext = materialRegistry.obtain(
          materials[materialIndex]!
        );
        if (!materialContext.is_built) continue;
        const material = materialContext.obtainBindingData();
        pass.setBindGroup(0, this.graphics.bind_groups.obtain({
          layout: SHADOW_ALPHA_GROUP0,
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
      this.lastBucketPasses++;
      anyDrew = true;
    }
    return anyDrew;
  }

  resolvePointShadow(
    command: ShadeGPUCommandContext,
    sourceView: GPUTextureView,
    atlasView: GPUTextureView,
    layout: readonly [number, number, number, number],
    lightDistance: number,
    cubeNear: number
  ): void {
    const [x, y, width, height] = layout;
    const settingsBuffer = command.allocateTransientValueBuffer(
      POINT_SHADOW_RESOLVE_SETTINGS_TYPE,
      {
        atlas_offset: [x + 4, y + 4, width - 8, height - 8],
        light_params: [lightDistance, cubeNear, 0, 0]
      }
    );
    const bindGroup = this.graphics.bind_groups.obtain({
      layout: SHADOW_POINT_RESOLVE_GROUP,
      entries: [
        { buffer: settingsBuffer },
        sourceView
      ]
    });
    const pass = command.gpu_encoder.beginRenderPass({
      label: "ShadowRasterPass/Qj-octahedral-resolve",
      colorAttachments: [],
      depthStencilAttachment: {
        view: atlasView,
        depthLoadOp: "load",
        depthStoreOp: "store"
      }
    });
    pass.setViewport(x, y, width, height, 0, 1);
    pass.setPipeline(this.pointResolvePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private clearViewport(
    encoder: GPUCommandEncoder,
    depthView: GPUTextureView,
    viewport: readonly [number, number, number, number]
  ): void {
    const pass = encoder.beginRenderPass({
      label: "ShadowRasterPass/local-depth-clear-_b",
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: "load",
        depthStoreOp: "store"
      }
    });
    pass.setViewport(viewport[0], viewport[1], viewport[2], viewport[3], 0, 1);
    pass.setPipeline(this.clearPipeline);
    pass.draw(3);
    pass.end();
  }

  private obtainOpaquePipeline(cullMode: GPUCullMode): GPURenderPipeline {
    let pipeline = this.opaquePipelines.get(cullMode);
    if (pipeline) return pipeline;
    pipeline = this.graphics.render_pipelines.obtain(SHADOW_OPAQUE_PIPELINE, {
      topology: "triangle-list",
      cullMode
    });
    this.opaquePipelines.set(cullMode, pipeline);
    return pipeline;
  }

  obtainAlphaPipeline(cullMode: GPUCullMode): GPURenderPipeline {
    let pipeline = this.alphaPipelines.get(cullMode);
    if (pipeline) return pipeline;
    pipeline = this.graphics.render_pipelines.obtain(SHADOW_ALPHA_PIPELINE, {
      topology: "triangle-list",
      cullMode
    });
    this.alphaPipelines.set(cullMode, pipeline);
    return pipeline;
  }

  private obtainAlphaNoiseView(): GPUTextureView {
    this.alphaNoiseView ??= this.graphics.textures
      .obtain(HILBERT_NOISE_TEXTURE)
      .obtainView();
    return this.alphaNoiseView;
  }

  destroy(): void {
    this.alphaNoiseView = null;
    this.materialDrawList.destroy();
    this.opaquePipelines.clear();
    this.alphaPipelines.clear();
  }
}

function adaptCommandWriter(
  command: ShadeGPUCommandContext
): (
  buffer: GPUBuffer,
  offset: number,
  data: ArrayBuffer | ArrayBufferView,
  dataOffset?: number,
  size?: number
) => void {
  return (buffer, offset, data, dataOffset = 0, size) => {
    if (ArrayBuffer.isView(data)) {
      command.writeBuffer(
        buffer,
        offset,
        data.buffer as ArrayBuffer,
        data.byteOffset + dataOffset,
        size ?? data.byteLength - dataOffset
      );
      return;
    }
    command.writeBuffer(
      buffer,
      offset,
      data,
      dataOffset,
      size ?? data.byteLength - dataOffset
    );
  };
}
