import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { PackedSceneRuntime } from "../../gpu/GpuPackedSceneRegistry.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../../gpu/GPUDescriptorCaches.js";
import { LPV_CAMERA_TYPE } from "../../shaders/lpv_indirect_diffuse.js";
import {
  PACKED_VISIBILITY_COMPUTE_WGSL,
  PACKED_VISIBILITY_FIXED_VERTEX_COUNT,
  PACKED_VISIBILITY_RASTER_WGSL,
  PACKED_VISIBILITY_WORKGROUP_SIZE
} from "../../shaders/packed_visibility.js";
import { VIS_MESH_CLEAR_SENTINEL } from "../VisibilityBufferContract.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "./MaterialExpandPass.js";

const COMPUTE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "Packed Visibility/compute group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 16 } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 256 } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } }
  ]
};

const RASTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "Packed Visibility/raster group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
    ...Array.from({ length: 7 }, (_, index) => ({
      binding: index + 1,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    }))
  ]
};

const COMPUTE_PIPELINE: CachedComputePipelineDescriptor = {
  label: "Packed Visibility/flat producer",
  layout: { label: "Packed Visibility/flat producer layout", bindGroupLayouts: [COMPUTE_GROUP] },
  compute: {
    module: { label: "Packed Visibility/flat producer", code: PACKED_VISIBILITY_COMPUTE_WGSL },
    entryPoint: "compact_packed_meshlets"
  }
};

const RASTER_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Packed Visibility/hardware consumer",
  layout: { label: "Packed Visibility/hardware consumer layout", bindGroupLayouts: [RASTER_GROUP] },
  vertex: {
    module: { label: "Packed Visibility/hardware consumer", code: PACKED_VISIBILITY_RASTER_WGSL },
    entryPoint: "raster_packed_meshlets"
  },
  fragment: {
    module: { label: "Packed Visibility/hardware consumer", code: PACKED_VISIBILITY_RASTER_WGSL },
    entryPoint: "write_packed_visibility",
    targets: [{ format: "r32uint" }, { format: "r32uint" }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "greater"
  }
};

export interface PackedVisibilityJob {
  readonly runtime: PackedSceneRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly countersEnabled: boolean;
}

export interface PackedVisibilityInputs {
  readonly camera: ResourceId;
  readonly counters: ResourceId;
  readonly triangleId: ResourceId;
  readonly instanceId: ResourceId;
  readonly depth: ResourceId;
}

/** R2 flat producer → existing Hardware drawIndirect consumer. */
export class PackedVisibilityPass {
  lastDrawIndirect = false;
  lastCandidateCapacity = 0;
  lastFixedVertexCount = PACKED_VISIBILITY_FIXED_VERTEX_COUNT;

  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityInputs
  ): ResourceId {
    const builder = graph.add(
      "Packed Visibility/flat producer + Hardware consumer",
      job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const camera = requireBuffer(resources.get(inputs.camera), "camera");
        const counters = requireBuffer(resources.get(inputs.counters), "GPU counters");
        command.clearBuffer(data.runtime.workQueue, 0, 16);
        command.clearBuffer(data.runtime.indirectArgs, 0, 16);
        const params = new Uint32Array([
          data.runtime.instanceBegin,
          data.runtime.instanceCount,
          data.runtime.candidateMeshletCapacity,
          data.countersEnabled ? 1 : 0
        ]);
        const paramsBuffer = command.allocateTransientBufferAndLoad(
          params.buffer,
          GPUBufferUsage.UNIFORM
        );
        const compute = command.constructComputePass({
          pipeline: COMPUTE_PIPELINE,
          bindings: [[
            { buffer: camera },
            { buffer: data.scene.instances },
            { buffer: data.assets.geometryRecords },
            { buffer: data.runtime.workQueue },
            { buffer: data.runtime.indirectArgs },
            { buffer: counters },
            { buffer: paramsBuffer }
          ]]
        });
        compute.dispatchWorkgroups(
          Math.ceil(data.runtime.instanceCount / PACKED_VISIBILITY_WORKGROUP_SIZE),
          1,
          1
        );
        compute.end();

        const pipeline = this.graphics.render_pipelines.obtain(RASTER_PIPELINE);
        const group = this.graphics.bind_groups.obtain({
          layout: RASTER_GROUP,
          entries: [
            { buffer: camera },
            { buffer: data.scene.instances },
            { buffer: data.assets.meshletRecords },
            { buffer: data.assets.meshletVertexIndices },
            { buffer: data.assets.meshletTriangleIndices },
            { buffer: data.assets.vertexStreamData },
            { buffer: data.assets.geometryRecords },
            { buffer: data.runtime.workQueue }
          ]
        });
        const render = command.beginRenderPass({
          label: "Packed Visibility/hardware drawIndirect",
          colorAttachments: [
            {
              view: resolveTextureView(resources.get(inputs.triangleId)),
              clearValue: { r: VIS_MESH_CLEAR_SENTINEL, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store"
            },
            {
              view: resolveTextureView(resources.get(inputs.instanceId)),
              clearValue: { r: VIS_MESH_CLEAR_SENTINEL, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store"
            }
          ],
          depthStencilAttachment: {
            view: resolveDepthAttachmentView(resources.get(inputs.depth)),
            depthClearValue: 0,
            depthLoadOp: "clear",
            depthStoreOp: "store"
          }
        });
        render.setPipeline(pipeline);
        render.setBindGroup(0, group);
        render.drawIndirect(data.runtime.indirectArgs, 0);
        render.end();
        this.lastDrawIndirect = true;
        this.lastCandidateCapacity = data.runtime.candidateMeshletCapacity;
      }
    );
    builder.read(inputs.camera);
    builder.read(inputs.counters);
    builder.write(inputs.triangleId);
    builder.write(inputs.instanceId);
    builder.write(inputs.depth);
    const counters = builder.write(inputs.counters);
    builder.make_side_effect();
    return counters;
  }
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedVisibilityPass requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`PackedVisibilityPass expected ${label} GPUBuffer`);
}
