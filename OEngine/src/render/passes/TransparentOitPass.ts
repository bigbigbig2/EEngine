/**
 * TransparentOitPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph, FrameGraphContext } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { MaterialMeshletDrawResult } from "../../gpu/MaterialMeshletDrawList.js";
import { MaterialMeshletDrawList } from "../../gpu/MaterialMeshletDrawList.js";
import type { MeshletDrawList } from "../../gpu/MeshletDrawList.js";
import type { GPUMaterialRegistry } from "../../gpu/GPUMaterialContext.js";
import { MATERIAL_EXPAND_GROUP0 } from "../../gpu/GPUMaterialContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  SHADOW_COMPARISON_SAMPLER_DESCRIPTOR
} from "../../gpu/GPUSamplerCache.js";
import type { ShadeMaterial } from "../../material/ShadeMaterial.js";
import {
  ShadeDrawMode,
  ShadeDrawSide,
  ShadeTransparencyMode
} from "../../material/enums.js";
import {
  materialBucketId,
  primitiveStateForBucket
} from "../../material/materialBucketId.js";
import type { Scene } from "../../scene/Scene.js";
import {
  OIT_COMPOSITE_WGSL,
  OIT_FORWARD_BRICK4_WGSL,
  OIT_FORWARD_IBL_WGSL,
  OIT_MOMENTS_FORMAT,
  OIT_MOMENTS_WGSL,
  OIT_OPTICAL_DEPTH_FORMAT,
  OIT_RESOLVED_FORMAT
} from "../../shaders/transparent_oit.js";
import { MATERIAL_SORT_DRAW_ARGS_BYTES } from "../../shaders/meshlet_material_sort.js";
import { HDR_COLOR_FORMAT } from "../RenderTargets.js";
import { ShadeIndirectLightingMode } from "../ShadeIndirectLightingMode.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "./MaterialExpandPass.js";

const VERTEX_FRAGMENT = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
const STORAGE_READ = {
  visibility: VERTEX_FRAGMENT,
  buffer: { type: "read-only-storage" as const }
};
const UNIFORM_VERTEX_FRAGMENT = {
  visibility: VERTEX_FRAGMENT,
  buffer: { type: "uniform" as const }
};
const UNFILTERABLE_VERTEX_FRAGMENT = {
  visibility: VERTEX_FRAGMENT,
  texture: { sampleType: "unfilterable-float" as const }
};

const OIT_MATERIAL_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "OIT/fm material group",
  entries: Array.from(MATERIAL_EXPAND_GROUP0.entries, (entry) => ({
    ...entry,
    visibility: VERTEX_FRAGMENT
  }))
};

const OIT_MESHLET_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "OIT/dv meshlet scene group",
  entries: [0, 1, 2, 3, 4].map((binding) => ({ binding, ...STORAGE_READ }))
};

const OIT_MOMENTS_VIEW_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "OIT/BA camera view group",
  entries: [
    { binding: 0, ...UNIFORM_VERTEX_FRAGMENT },
    { binding: 1, ...UNIFORM_VERTEX_FRAGMENT }
  ]
};

const OIT_FORWARD_IBL_VIEW_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "OIT/yA IBL camera moments group",
  entries: [
    { binding: 0, ...UNIFORM_VERTEX_FRAGMENT },
    { binding: 1, ...UNIFORM_VERTEX_FRAGMENT },
    { binding: 2, ...UNFILTERABLE_VERTEX_FRAGMENT },
    { binding: 3, ...UNFILTERABLE_VERTEX_FRAGMENT },
    {
      binding: 4,
      visibility: VERTEX_FRAGMENT,
      texture: { sampleType: "float" }
    },
    {
      binding: 5,
      visibility: VERTEX_FRAGMENT,
      sampler: { type: "filtering" }
    }
  ]
};

const OIT_FORWARD_BRICK4_VIEW_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "OIT/yA Brick4 camera moments group",
  entries: [
    { binding: 0, ...UNIFORM_VERTEX_FRAGMENT },
    { binding: 1, ...UNIFORM_VERTEX_FRAGMENT },
    { binding: 2, ...UNFILTERABLE_VERTEX_FRAGMENT },
    { binding: 3, ...UNFILTERABLE_VERTEX_FRAGMENT },
    { binding: 4, ...STORAGE_READ },
    {
      binding: 5,
      visibility: VERTEX_FRAGMENT,
      texture: { sampleType: "float" }
    },
    {
      binding: 6,
      visibility: VERTEX_FRAGMENT,
      sampler: { type: "filtering" }
    }
  ]
};

const OIT_LIGHTING_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "OIT/Ph clustered lighting group",
  entries: [
    { binding: 0, visibility: VERTEX_FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: VERTEX_FRAGMENT, texture: { sampleType: "float" } },
    { binding: 2, visibility: VERTEX_FRAGMENT, buffer: { type: "uniform" } },
    { binding: 3, visibility: VERTEX_FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: VERTEX_FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: VERTEX_FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 6, visibility: VERTEX_FRAGMENT, sampler: { type: "comparison" } }
  ]
};

const OIT_COMPOSITE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "OIT/kp right static_copy",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
  ]
};

const MOMENTS_TARGETS: readonly GPUColorTargetState[] = [
  {
    format: OIT_OPTICAL_DEPTH_FORMAT,
    blend: {
      color: { operation: "add", srcFactor: "one", dstFactor: "one" },
      alpha: { operation: "add", srcFactor: "one", dstFactor: "one" }
    }
  },
  {
    format: OIT_MOMENTS_FORMAT,
    blend: {
      color: { operation: "add", srcFactor: "one", dstFactor: "one" },
      alpha: { operation: "add", srcFactor: "one", dstFactor: "one" }
    }
  }
];

const FORWARD_TARGET: GPUColorTargetState = {
  format: OIT_RESOLVED_FORMAT,
  blend: {
    color: { operation: "add", srcFactor: "one", dstFactor: "one" },
    alpha: { operation: "add", srcFactor: "one", dstFactor: "one" }
  }
};

const DEPTH_STATE: GPUDepthStencilState = {
  format: "depth32float",
  depthCompare: "greater",
  depthWriteEnabled: false
};

const OIT_COMPOSITE_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "OIT/kp composite",
  layout: { label: "OIT/kp layout", bindGroupLayouts: [OIT_COMPOSITE_GROUP] },
  vertex: {
    module: { label: "OIT/kp", code: OIT_COMPOSITE_WGSL },
    entryPoint: "vs_main",
    buffers: []
  },
  fragment: {
    module: { label: "OIT/kp", code: OIT_COMPOSITE_WGSL },
    entryPoint: "fs_main",
    targets: [{
      format: HDR_COLOR_FORMAT,
      blend: {
        color: { operation: "add", srcFactor: "one", dstFactor: "src-alpha" },
        alpha: { operation: "add", srcFactor: "one", dstFactor: "zero" }
      }
    }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

type PreparedSide = {
  materials: ShadeMaterial[];
  draw: MaterialMeshletDrawResult;
  primitive: GPUPrimitiveState;
};

export type TransparentOitJob = {
  width: number;
  height: number;
  scene: Scene;
  materials: GPUMaterialRegistry;
  drawList: MeshletDrawList;
  indirectLightingMode: number;
};

export type TransparentOitInputs = {
  hdr: ResourceId;
  depth: ResourceId;
  hzb: ResourceId;
  camera: ResourceId;
  view: ResourceId;
  sceneDatabase: ResourceId;
  geometryMetadata: ResourceId;
  meshletHeaders: ResourceId;
  meshletData: ResourceId;
  lightDatabase: ResourceId;
  environment: ResourceId;
  clusterParameters: ResourceId;
  clusterLookup: ResourceId;
  clusterData: ResourceId;
  shadowAtlas: ResourceId;
  splitSum: ResourceId;
  brick4LightMap?: ResourceId;
};

export class TransparentOitPass {
  private readonly device: GPUDevice;
  private readonly frontDrawList: MaterialMeshletDrawList;
  private readonly doubleDrawList: MaterialMeshletDrawList;
  private readonly momentPipelines = new Map<GPUCullMode, GPURenderPipeline>();
  private readonly iblPipelines = new Map<GPUCullMode, GPURenderPipeline>();
  private readonly brick4Pipelines = new Map<GPUCullMode, GPURenderPipeline>();
  private compositePipeline: GPURenderPipeline | null = null;
  private frontPrepared: PreparedSide | null = null;
  private doublePrepared: PreparedSide | null = null;

  lastRan = false;
  lastMaterialCount = 0;
  lastMomentPasses = 0;
  lastForwardPasses = 0;

  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    if (!device) throw new Error("TransparentOitPass: GraphicsContext has no device");
    this.device = device;
    this.frontDrawList = new MaterialMeshletDrawList(graphics);
    this.doubleDrawList = new MaterialMeshletDrawList(graphics);
  }

  addToGraph(
    graph: FrameGraph,
    job: TransparentOitJob,
    inputs: TransparentOitInputs
  ): ResourceId {
    const frontMaterials = transparentMaterials(job.scene, ShadeDrawSide.Front);
    const doubleMaterials = transparentMaterials(job.scene, ShadeDrawSide.Double);
    this.lastMaterialCount = frontMaterials.length + doubleMaterials.length;
    this.frontPrepared = null;
    this.doublePrepared = null;
    this.lastRan = false;
    this.lastMomentPasses = 0;
    this.lastForwardPasses = 0;
    if (this.lastMaterialCount === 0) return inputs.hdr;

    const prepareBuilder = graph.add(
      "OIT/Bp transparent material sort",
      { job, inputs, frontMaterials, doubleMaterials },
      (data, resources, context) => {
        const command = requireCommandContext(context);
        const encoder = requireEncoder(context);
        const hzb = texture(resources.get(data.inputs.hzb));
        const camera = buffer(resources.get(data.inputs.camera));
        const sceneDatabase = buffer(resources.get(data.inputs.sceneDatabase));
        const meshletHeaders = buffer(resources.get(data.inputs.meshletHeaders));
        const geometryMetadata = buffer(resources.get(data.inputs.geometryMetadata));
        const capacity = data.frontMaterials.length + data.doubleMaterials.length;
        this.frontPrepared = this.prepareSide(
          command, encoder, data.job, data.frontMaterials, ShadeDrawSide.Front,
          this.frontDrawList, capacity, camera, sceneDatabase, meshletHeaders,
          geometryMetadata, hzb
        );
        this.doublePrepared = this.prepareSide(
          command, encoder, data.job, data.doubleMaterials, ShadeDrawSide.Double,
          this.doubleDrawList, capacity, camera, sceneDatabase, meshletHeaders,
          geometryMetadata, hzb
        );
      }
    );
    for (const id of [inputs.hzb, inputs.camera, inputs.sceneDatabase, inputs.meshletHeaders, inputs.geometryMetadata]) {
      prepareBuilder.read(id);
    }
    prepareBuilder.make_side_effect();

    const frontMomentsData = { optical: -1, moments: -1 };
    const frontMomentsBuilder = graph.add(
      "emval/OIT moments front",
      frontMomentsData,
      (data, resources, context) => {
        this.encodeMoments(
          context,
          this.frontPrepared,
          resources.get(data.optical),
          resources.get(data.moments),
          resources.get(inputs.depth),
          resources.get(inputs.camera),
          resources.get(inputs.view),
          resources.get(inputs.meshletHeaders),
          resources.get(inputs.meshletData),
          resources.get(inputs.sceneDatabase),
          resources.get(inputs.geometryMetadata),
          true,
          job.materials
        );
      }
    );
    frontMomentsData.optical = frontMomentsBuilder.create("OIT depth", textureDescriptor(job, OIT_OPTICAL_DEPTH_FORMAT));
    frontMomentsData.moments = frontMomentsBuilder.create("OIT moments", textureDescriptor(job, OIT_MOMENTS_FORMAT));
    for (const id of [inputs.depth, inputs.camera, inputs.view, inputs.meshletHeaders, inputs.meshletData, inputs.sceneDatabase, inputs.geometryMetadata]) frontMomentsBuilder.read(id);

    let opticalDepth = frontMomentsData.optical;
    let moments = frontMomentsData.moments;
    const doubleMomentsData = { opticalIn: opticalDepth, momentsIn: moments, opticalOut: -1, momentsOut: -1 };
    const doubleMomentsBuilder = graph.add(
      "emval/OIT moments double",
      doubleMomentsData,
      (data, resources, context) => {
        this.encodeMoments(
          context,
          this.doublePrepared,
          resources.get(data.opticalOut),
          resources.get(data.momentsOut),
          resources.get(inputs.depth),
          resources.get(inputs.camera),
          resources.get(inputs.view),
          resources.get(inputs.meshletHeaders),
          resources.get(inputs.meshletData),
          resources.get(inputs.sceneDatabase),
          resources.get(inputs.geometryMetadata),
          false,
          job.materials
        );
      }
    );
    doubleMomentsBuilder.read(doubleMomentsData.opticalIn);
    doubleMomentsBuilder.read(doubleMomentsData.momentsIn);
    doubleMomentsData.opticalOut = doubleMomentsBuilder.write(doubleMomentsData.opticalIn);
    doubleMomentsData.momentsOut = doubleMomentsBuilder.write(doubleMomentsData.momentsIn);
    opticalDepth = doubleMomentsData.opticalOut;
    moments = doubleMomentsData.momentsOut;
    for (const id of [inputs.depth, inputs.camera, inputs.view, inputs.meshletHeaders, inputs.meshletData, inputs.sceneDatabase, inputs.geometryMetadata]) doubleMomentsBuilder.read(id);

    const frontForwardData = { resolved: -1 };
    const frontForwardBuilder = graph.add(
      "push_to_storage/OIT forward front",
      frontForwardData,
      (data, resources, context) => {
        this.encodeForward(
          context, this.frontPrepared, resources.get(data.resolved),
          resources.get(inputs.depth), resources.get(moments), resources.get(opticalDepth),
          resources, inputs, true, job
        );
      }
    );
    frontForwardData.resolved = frontForwardBuilder.create("OIT resolved", textureDescriptor(job, OIT_RESOLVED_FORMAT));
    this.readForwardInputs(frontForwardBuilder, inputs, moments, opticalDepth, job.indirectLightingMode);

    let resolved = frontForwardData.resolved;
    const doubleForwardData = { resolvedIn: resolved, resolvedOut: -1 };
    const doubleForwardBuilder = graph.add(
      "push_to_storage/OIT forward double",
      doubleForwardData,
      (data, resources, context) => {
        this.encodeForward(
          context, this.doublePrepared, resources.get(data.resolvedOut),
          resources.get(inputs.depth), resources.get(moments), resources.get(opticalDepth),
          resources, inputs, false, job
        );
      }
    );
    doubleForwardBuilder.read(doubleForwardData.resolvedIn);
    doubleForwardData.resolvedOut = doubleForwardBuilder.write(doubleForwardData.resolvedIn);
    resolved = doubleForwardData.resolvedOut;
    this.readForwardInputs(doubleForwardBuilder, inputs, moments, opticalDepth, job.indirectLightingMode);

    const compositeData = { hdrIn: inputs.hdr, hdrOut: -1, resolved, opticalDepth };
    const compositeBuilder = graph.add(
      "OIT/kp resolve to HDR",
      compositeData,
      (data, resources, context) => {
        const encoder = requireEncoder(context);
        this.compositePipeline ??= this.graphics.render_pipelines.obtain(OIT_COMPOSITE_PIPELINE);
        const pass = encoder.beginRenderPass({
          label: "OIT/kp resolve to HDR",
          colorAttachments: [{ view: texture(resources.get(data.hdrOut)), loadOp: "load", storeOp: "store" }]
        });
        pass.setPipeline(this.compositePipeline);
        this.graphics.setPipelineBindings(pass, OIT_COMPOSITE_PIPELINE, [[
          texture(resources.get(data.opticalDepth)),
          texture(resources.get(data.resolved))
        ]]);
        pass.draw(3);
        pass.end();
        this.lastRan = true;
      }
    );
    compositeBuilder.read(compositeData.hdrIn);
    compositeBuilder.read(resolved);
    compositeBuilder.read(opticalDepth);
    compositeData.hdrOut = compositeBuilder.write(compositeData.hdrIn);
    return compositeData.hdrOut;
  }

  private prepareSide(
    command: ShadeGPUCommandContext,
    encoder: GPUCommandEncoder,
    job: TransparentOitJob,
    materials: ShadeMaterial[],
    side: number,
    materialDrawList: MaterialMeshletDrawList,
    materialCapacity: number,
    camera: GPUBuffer,
    sceneDatabase: GPUBuffer,
    meshletHeaders: GPUBuffer,
    geometryMetadata: GPUBuffer,
    hzb: GPUTextureView
  ): PreparedSide | null {
    if (materials.length === 0) return null;
    const primitive = primitiveStateForBucket(ShadeDrawMode.Triangles, side);
    if (!primitive) return null;
    const writeBuffer = simpleWriteBuffer(command);
    if (!job.drawList.dispatchBucketSlice(encoder, this.device, {
      command,
      bucketId: materialBucketId(ShadeTransparencyMode.Transparent, ShadeDrawMode.Triangles, side),
      writeBuffer
    })) return null;
    if (!job.drawList.dispatchInstanceCull(encoder, this.device, {
      cameraBuffer: camera,
      sceneDatabaseBuffer: sceneDatabase,
      hzbView: hzb,
      writeBuffer
    })) return null;
    if (!job.drawList.dispatchExpand(encoder, this.device, sceneDatabase, geometryMetadata, writeBuffer)) return null;
    if (!job.drawList.dispatchHzbCull(encoder, this.device, {
      cameraBuffer: camera,
      sceneDatabaseBuffer: sceneDatabase,
      resolutionW: job.width,
      resolutionH: job.height,
      meshletHeaders,
      hzbView: hzb,
      writeBuffer
    })) return null;
    const input = job.drawList.elementsBuffer;
    if (!input) return null;
    const draw = materialDrawList.build(command, input, sceneDatabase, materials, materialCapacity);
    return draw ? { materials, draw, primitive } : null;
  }

  private encodeMoments(
    context: FrameGraphContext,
    prepared: PreparedSide | null,
    optical: unknown,
    moments: unknown,
    depth: unknown,
    camera: unknown,
    view: unknown,
    headers: unknown,
    data: unknown,
    sceneDatabase: unknown,
    geometryMetadata: unknown,
    clear: boolean,
    materials: GPUMaterialRegistry
  ): void {
    const encoder = requireEncoder(context);
    const pass = encoder.beginRenderPass({
      label: "emval",
      colorAttachments: [
        attachment(optical, clear),
        attachment(moments, clear)
      ],
      depthStencilAttachment: { view: resolveDepthAttachmentView(depth), depthReadOnly: true }
    });
    if (prepared) {
      const pipeline = this.obtainMomentsPipeline(prepared.primitive.cullMode ?? "none");
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, this.meshletBindGroup(pipeline, prepared, headers, data, sceneDatabase, geometryMetadata));
      pass.setBindGroup(2, this.graphics.bind_groups.obtain({
        layout: OIT_MOMENTS_VIEW_GROUP,
        entries: [{ buffer: buffer(camera) }, { buffer: buffer(view) }]
      }));
      this.drawMaterials(pass, pipeline, prepared, materials);
      this.lastMomentPasses++;
    }
    pass.end();
  }

  private encodeForward(
    context: FrameGraphContext,
    prepared: PreparedSide | null,
    resolved: unknown,
    depth: unknown,
    moments: unknown,
    opticalDepth: unknown,
    resources: { get(id: ResourceId): unknown },
    inputs: TransparentOitInputs,
    clear: boolean,
    job: TransparentOitJob
  ): void {
    const encoder = requireEncoder(context);
    const brick4 = job.indirectLightingMode === ShadeIndirectLightingMode.Brick4;
    const pass = encoder.beginRenderPass({
      label: "push_to_storage",
      colorAttachments: [attachment(resolved, clear)],
      depthStencilAttachment: { view: resolveDepthAttachmentView(depth), depthReadOnly: true }
    });
    if (prepared) {
      const pipeline = this.obtainForwardPipeline(prepared.primitive.cullMode ?? "none", brick4);
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, this.meshletBindGroup(
        pipeline, prepared,
        resources.get(inputs.meshletHeaders), resources.get(inputs.meshletData),
        resources.get(inputs.sceneDatabase), resources.get(inputs.geometryMetadata)
      ));
      const viewEntries: GPUBindingResource[] = [
        { buffer: buffer(resources.get(inputs.camera)) },
        { buffer: buffer(resources.get(inputs.view)) },
        texture(moments),
        texture(opticalDepth)
      ];
      if (brick4) {
        if (inputs.brick4LightMap === undefined) throw new Error("TransparentOitPass: Brick4 light map is missing");
        viewEntries.push({ buffer: buffer(resources.get(inputs.brick4LightMap)) });
      }
      viewEntries.push(
        texture(resources.get(inputs.splitSum)),
        this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR)
      );
      pass.setBindGroup(2, this.graphics.bind_groups.obtain({
        layout: brick4 ? OIT_FORWARD_BRICK4_VIEW_GROUP : OIT_FORWARD_IBL_VIEW_GROUP,
        entries: viewEntries
      }));
      pass.setBindGroup(3, this.graphics.bind_groups.obtain({
        layout: OIT_LIGHTING_GROUP,
        entries: [
          { buffer: buffer(resources.get(inputs.lightDatabase)) },
          texture(resources.get(inputs.environment)),
          { buffer: buffer(resources.get(inputs.clusterParameters)) },
          { buffer: buffer(resources.get(inputs.clusterLookup)) },
          { buffer: buffer(resources.get(inputs.clusterData)) },
          texture(resources.get(inputs.shadowAtlas)),
          this.graphics.samplers.obtain(SHADOW_COMPARISON_SAMPLER_DESCRIPTOR)
        ]
      }));
      this.drawMaterials(pass, pipeline, prepared, job.materials);
      this.lastForwardPasses++;
    }
    pass.end();
  }

  private readForwardInputs(
    builder: { read(id: ResourceId): ResourceId },
    inputs: TransparentOitInputs,
    moments: ResourceId,
    opticalDepth: ResourceId,
    mode: number
  ): void {
    for (const id of [
      inputs.depth, inputs.camera, inputs.view, inputs.sceneDatabase,
      inputs.geometryMetadata, inputs.meshletHeaders, inputs.meshletData,
      inputs.lightDatabase, inputs.environment, inputs.clusterParameters,
      inputs.clusterLookup, inputs.clusterData, inputs.shadowAtlas,
      inputs.splitSum, moments, opticalDepth
    ]) builder.read(id);
    if (mode === ShadeIndirectLightingMode.Brick4 && inputs.brick4LightMap !== undefined) {
      builder.read(inputs.brick4LightMap);
    }
  }

  private meshletBindGroup(
    pipeline: GPURenderPipeline,
    prepared: PreparedSide,
    headers: unknown,
    data: unknown,
    sceneDatabase: unknown,
    geometryMetadata: unknown
  ): GPUBindGroup {
    return this.graphics.bind_groups.obtain({
      layout: OIT_MESHLET_GROUP,
      entries: [
        { buffer: prepared.draw.meshlets },
        { buffer: buffer(headers) },
        { buffer: buffer(data) },
        { buffer: buffer(sceneDatabase) },
        { buffer: buffer(geometryMetadata) }
      ]
    });
  }

  private drawMaterials(
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    prepared: PreparedSide,
    materials: GPUMaterialRegistry
  ): void {
    for (let index = 0; index < prepared.materials.length; index++) {
      const context = materials.obtain(prepared.materials[index]!);
      if (!context.is_built) continue;
      pass.setBindGroup(0, context.obtainMaterialExpandBindGroup(pipeline));
      pass.drawIndirect(prepared.draw.commands, index * MATERIAL_SORT_DRAW_ARGS_BYTES);
    }
  }

  private obtainMomentsPipeline(cullMode: GPUCullMode): GPURenderPipeline {
    let pipeline = this.momentPipelines.get(cullMode);
    if (pipeline) return pipeline;
    pipeline = this.graphics.render_pipelines.obtain({
      label: "OIT/BA moments",
      layout: { label: "OIT/BA layout", bindGroupLayouts: [OIT_MATERIAL_GROUP, OIT_MESHLET_GROUP, OIT_MOMENTS_VIEW_GROUP] },
      vertex: { module: { label: "OIT/lv", code: OIT_MOMENTS_WGSL }, entryPoint: "vs_main", buffers: [] },
      fragment: { module: { label: "OIT/mv", code: OIT_MOMENTS_WGSL }, entryPoint: "fs_main", targets: [...MOMENTS_TARGETS] },
      primitive: { topology: "triangle-list", cullMode },
      depthStencil: DEPTH_STATE
    });
    this.momentPipelines.set(cullMode, pipeline);
    return pipeline;
  }

  private obtainForwardPipeline(cullMode: GPUCullMode, brick4: boolean): GPURenderPipeline {
    const cache = brick4 ? this.brick4Pipelines : this.iblPipelines;
    let pipeline = cache.get(cullMode);
    if (pipeline) return pipeline;
    const code = brick4 ? OIT_FORWARD_BRICK4_WGSL : OIT_FORWARD_IBL_WGSL;
    pipeline = this.graphics.render_pipelines.obtain({
      label: brick4 ? "OIT/yA Brick4" : "OIT/yA IBL",
      layout: {
        label: "OIT/yA layout",
        bindGroupLayouts: [
          OIT_MATERIAL_GROUP,
          OIT_MESHLET_GROUP,
          brick4 ? OIT_FORWARD_BRICK4_VIEW_GROUP : OIT_FORWARD_IBL_VIEW_GROUP,
          OIT_LIGHTING_GROUP
        ]
      },
      vertex: { module: { label: "OIT/lv", code }, entryPoint: "vs_main", buffers: [] },
      fragment: { module: { label: "OIT/yA", code }, entryPoint: "fs_main", targets: [FORWARD_TARGET] },
      primitive: { topology: "triangle-list", cullMode },
      depthStencil: DEPTH_STATE
    });
    cache.set(cullMode, pipeline);
    return pipeline;
  }

  destroy(): void {
    this.frontDrawList.destroy();
    this.doubleDrawList.destroy();
    this.momentPipelines.clear();
    this.iblPipelines.clear();
    this.brick4Pipelines.clear();
    this.compositePipeline = null;
  }
}

function transparentMaterials(scene: Scene, side: number): ShadeMaterial[] {
  return scene.instances.materials.filter((material) =>
    material.transparency_mode === ShadeTransparencyMode.Transparent &&
    material.draw_mode === ShadeDrawMode.Triangles &&
    material.draw_side === side
  );
}

function textureDescriptor(job: { width: number; height: number }, format: GPUTextureFormat) {
  return {
    kind: "transient_texture" as const,
    label: `OIT ${format}`,
    width: Math.max(1, job.width | 0),
    height: Math.max(1, job.height | 0),
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  };
}

function attachment(resource: unknown, clear: boolean): GPURenderPassColorAttachment {
  return {
    view: texture(resource),
    clearValue: [0, 0, 0, 0],
    loadOp: clear ? "clear" : "load",
    storeOp: "store"
  };
}

function requireEncoder(context: FrameGraphContext): GPUCommandEncoder {
  if (!context.gpu_encoder) throw new Error("TransparentOitPass: no GPU encoder");
  return context.gpu_encoder;
}

function requireCommandContext(context: FrameGraphContext): ShadeGPUCommandContext {
  const value = context.encoder;
  if (
    value && typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: boolean }).isGPUCommandContext === true
  ) return value as ShadeGPUCommandContext;
  throw new Error("TransparentOitPass: Bp requires ShadeGPUCommandContext");
}

function simpleWriteBuffer(command: ShadeGPUCommandContext) {
  return (target: GPUBuffer, offset: number, value: ArrayBuffer | ArrayBufferView): void => {
    if (ArrayBuffer.isView(value)) {
      command.writeBuffer(target, offset, value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
    } else {
      command.writeBuffer(target, offset, value, 0, value.byteLength);
    }
  };
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) return value as GPUBuffer;
  throw new Error("TransparentOitPass: expected GPUBuffer");
}
