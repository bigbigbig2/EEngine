import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
  GPU_MATERIAL_TILE_WORK_ABI_VERSION,
  materialTileDispatchIndirectByteLength,
  materialTileWorkQueueBufferByteLength,
  nextGpuMaterialTileWorkGeneration
} from "../../gpu/GpuMaterialTileWorkAbi.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import { MATERIAL_TILE_CLASSIFICATION_WGSL } from "../../shaders/material_tile_classification.js";
import {
  materialTileClassificationFrame,
  textureDomain,
  type MaterialTileClassificationFrame,
  type VisibilityFrame
} from "../pipeline/FrameProducts.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export const MATERIAL_TILE_WIDTH = 8 as const;
export const MATERIAL_TILE_HEIGHT = 8 as const;

const GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 MaterialTileWork/group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
  ]
};

const MODULE = {
  label: "ADR-0009 MaterialTileWork portable classifier",
  code: MATERIAL_TILE_CLASSIFICATION_WGSL
} as const;

function pipeline(
  entryPoint: string,
  constants?: Record<string, number>,
  group: GPUBindGroupLayoutDescriptor = GROUP
): CachedComputePipelineDescriptor {
  return {
    label: `ADR-0009 MaterialTileWork/${entryPoint}`,
    layout: {
      label: "ADR-0009 MaterialTileWork/layout",
      bindGroupLayouts: [group]
    },
    compute: {
      module: MODULE,
      entryPoint,
      ...(constants === undefined ? {} : { constants })
    }
  };
}

const INITIALIZE = pipeline("initialize_material_tile_work");
const CLASSIFY = pipeline("classify_material_tiles");
const BUILD_INDIRECT = pipeline("build_material_tile_indirect");

export interface MaterialTileClassificationJob {
  readonly width: number;
  readonly height: number;
  readonly materials: GPUBuffer;
}

export interface MaterialTileClassificationInputs {
  readonly visibility: VisibilityFrame;
  readonly counters?: ResourceId;
}

/**
 * GPU classifier and indirect-argument producer. The authoritative lighting
 * consumer owns claims, consumed counts and final validation; this pass never
 * fabricates completion with a validation-only consumer.
 */
export class MaterialTileClassificationPass {
  private generation = 0;
  lastDispatchCount = 0;
  lastTileCount = 0;
  lastQueueCapacityBytes = 0;

  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(
    graph: FrameGraph,
    job: MaterialTileClassificationJob,
    inputs: MaterialTileClassificationInputs
  ): MaterialTileClassificationFrame {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const tileCount =
      Math.ceil(width / MATERIAL_TILE_WIDTH) *
      Math.ceil(height / MATERIAL_TILE_HEIGHT);
    const queueBytes = materialTileWorkQueueBufferByteLength(tileCount);
    const indirectBytes = materialTileDispatchIndirectByteLength();
    this.generation = nextGpuMaterialTileWorkGeneration(this.generation);
    const generation = this.generation;

    let queues = -1;
    let indirectArgs = -1;
    let control = -1;
    let settings = -1;
    let pixelClaims = -1;
    const builder = graph.add(
      "MaterialTileWork/classify + build indirect",
      Object.freeze({ ...job, generation }),
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const queueBuffer = requireBuffer(resources.get(queues), "queues");
        const indirectBuffer = requireBuffer(
          resources.get(indirectArgs),
          "indirect arguments"
        );
        const controlBuffer = requireBuffer(resources.get(control), "control");
        const settingsBuffer = requireBuffer(resources.get(settings), "settings");
        const claimsBuffer = requireBuffer(resources.get(pixelClaims), "pixel claims");
        command.clearBuffer(claimsBuffer);
        writeGpuBuffer(
          this.graphics.device.queue,
          "ADR-0009 MaterialTileWork/settings",
          settingsBuffer,
          0,
          new Uint32Array([
            width,
            height,
            tileCount,
            data.generation,
            inputs.counters === undefined ? 0 : 1,
            0,
            0,
            0
          ])
        );
        const bindGroup = this.graphics.bind_groups.obtain({
          layout: GROUP,
          entries: [
            resolveTextureView(resources.get(inputs.visibility.visibilityKey)),
            { buffer: requireBuffer(
              resources.get(inputs.visibility.meshletWork.records),
              "MeshletWork"
            ) },
            { buffer: data.materials },
            { buffer: queueBuffer },
            { buffer: indirectBuffer },
            { buffer: controlBuffer },
            { buffer: settingsBuffer }
          ]
        });
        encodeDirect(command, this.graphics, INITIALIZE, bindGroup, 1, 1);
        encodeDirect(
          command,
          this.graphics,
          CLASSIFY,
          bindGroup,
          Math.ceil(width / MATERIAL_TILE_WIDTH),
          Math.ceil(height / MATERIAL_TILE_HEIGHT)
        );
        encodeDirect(command, this.graphics, BUILD_INDIRECT, bindGroup, 1, 1);
        this.lastDispatchCount = 0;
        this.lastTileCount = tileCount;
        this.lastQueueCapacityBytes = queueBytes;
      }
    );
    queues = builder.create("material-tile-work/queues", {
      kind: "transient_buffer",
      label: "ADR-0009 MaterialTileWork/queues",
      size: queueBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    indirectArgs = builder.create("material-tile-work/indirect", {
      kind: "transient_buffer",
      label: "ADR-0009 MaterialTileWork/indirect",
      size: indirectBytes,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_SRC
    });
    control = builder.create("material-tile-work/control", {
      kind: "transient_buffer",
      label: "ADR-0009 MaterialTileWork/control",
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    settings = builder.create("material-tile-work/settings", {
      kind: "transient_buffer",
      label: "ADR-0009 MaterialTileWork/settings",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    pixelClaims = builder.create("material-tile-work/pixel-claims", {
      kind: "transient_buffer",
      label: "ADR-0009 MaterialTileWork/pixel claims",
      size: width * height * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    builder.read(inputs.visibility.visibilityKey);
    builder.read(inputs.visibility.meshletWork.records);
    builder.make_side_effect();
    return materialTileClassificationFrame({
      abiVersion: GPU_MATERIAL_TILE_WORK_ABI_VERSION,
      queues,
      indirectArgs,
      control,
      settings,
      pixelClaims,
      counters: inputs.counters ?? null,
      tileWidth: MATERIAL_TILE_WIDTH,
      tileHeight: MATERIAL_TILE_HEIGHT,
      tileCount,
      queueCapacityPerDispatchClass: tileCount,
      dispatchClassCount: GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
      generation,
      domain: textureDomain("internal-full", width, height, 1)
    });
  }

  destroy(): void {}
}

function encodeDirect(
  command: ShadeGPUCommandContext,
  graphics: GraphicsContext,
  descriptor: CachedComputePipelineDescriptor,
  bindGroup: GPUBindGroup,
  workgroupsX: number,
  workgroupsY: number
): void {
  const pass = command.beginComputePass({ label: descriptor.label });
  pass.setPipeline(graphics.compute_pipelines.obtain(descriptor));
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
  pass.end();
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("MaterialTileClassificationPass requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`MaterialTileClassificationPass expected ${label} GPUBuffer`);
}
