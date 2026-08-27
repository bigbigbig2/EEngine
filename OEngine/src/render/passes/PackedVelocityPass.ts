import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  PACKED_VELOCITY_FORMAT,
  PACKED_VELOCITY_WGSL
} from "../../shaders/packed_velocity.js";
import { resolveTextureView } from "./MaterialExpandPass.js";
import {
  prepareVelocityMatrices,
  type VelocityCameraMatrices
} from "./VelocityPass.js";

const GROUP: GPUBindGroupLayoutDescriptor = {
  label: "Packed Velocity/group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 64 } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 64 } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
  ]
};

const PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Packed Velocity",
  layout: { label: "Packed Velocity/layout", bindGroupLayouts: [GROUP] },
  vertex: {
    module: { label: "Packed Velocity", code: PACKED_VELOCITY_WGSL },
    entryPoint: "packed_velocity_vs"
  },
  fragment: {
    module: { label: "Packed Velocity", code: PACKED_VELOCITY_WGSL },
    entryPoint: "packed_velocity_fs",
    targets: [{ format: PACKED_VELOCITY_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

export interface PackedVelocityJob {
  readonly width: number;
  readonly height: number;
  readonly currentCamera: VelocityCameraMatrices;
  readonly previousCamera: VelocityCameraMatrices;
  readonly scene: GpuSceneBindings;
}

export class PackedVelocityPass {
  private readonly inverseCurrent = new Float32Array(16);
  private readonly previousViewProjection = new Float32Array(16);
  private readonly unusedRotation = new Float32Array(16);
  private readonly inverseCurrentBuffer: GPUBuffer;
  private readonly previousViewProjectionBuffer: GPUBuffer;

  constructor(private readonly graphics: GraphicsContext) {
    this.inverseCurrentBuffer = createMatrixBuffer(graphics.device, "Packed Velocity/inverse current VP");
    this.previousViewProjectionBuffer = createMatrixBuffer(graphics.device, "Packed Velocity/previous VP");
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedVelocityJob,
    inputs: { depth: ResourceId; instanceId: ResourceId }
  ): ResourceId {
    const output = { velocity: -1 };
    const builder = graph.add(
      "Packed Velocity",
      job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        prepareVelocityMatrices(
          this.unusedRotation,
          this.inverseCurrent,
          this.previousViewProjection,
          data.currentCamera,
          data.previousCamera,
          data.width,
          data.height
        );
        writeGpuBuffer(
          this.graphics.device.queue,
          "Packed Velocity/inverse current VP",
          this.inverseCurrentBuffer,
          0,
          this.inverseCurrent
        );
        writeGpuBuffer(
          this.graphics.device.queue,
          "Packed Velocity/previous VP",
          this.previousViewProjectionBuffer,
          0,
          this.previousViewProjection
        );
        const pipeline = this.graphics.render_pipelines.obtain(PIPELINE);
        const group = this.graphics.bind_groups.obtain({
          layout: GROUP,
          entries: [
            resolveTextureView(resources.get(inputs.depth)),
            resolveTextureView(resources.get(inputs.instanceId)),
            { buffer: this.inverseCurrentBuffer },
            { buffer: this.previousViewProjectionBuffer },
            { buffer: data.scene.instances }
          ]
        });
        const pass = command.beginRenderPass({
          label: "Packed Velocity",
          colorAttachments: [{
            view: resolveTextureView(resources.get(output.velocity)),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store"
          }]
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3, 1, 0, 0);
        pass.end();
      }
    );
    output.velocity = builder.create("packed velocity", {
      kind: "transient_texture",
      label: "packed velocity",
      width: Math.max(1, job.width | 0),
      height: Math.max(1, job.height | 0),
      format: PACKED_VELOCITY_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    builder.read(inputs.depth);
    builder.read(inputs.instanceId);
    return output.velocity;
  }

  destroy(): void {
    this.inverseCurrentBuffer.destroy();
    this.previousViewProjectionBuffer.destroy();
  }
}

function createMatrixBuffer(device: GPUDevice, label: string): GPUBuffer {
  return device.createBuffer({
    label,
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedVelocityPass requires ShadeGPUCommandContext");
}
