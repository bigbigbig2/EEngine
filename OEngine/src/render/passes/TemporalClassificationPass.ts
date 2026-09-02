import { counterByteOffset } from "../../debug/GpuFrameCounters.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../../gpu/GPUDescriptorCaches.js";
import { FULLSCREEN_TRIANGLE_VERTEX_WGSL } from "../../shaders/fullscreen_triangle.js";
import {
  TEMPORAL_CLASSIFICATION_FORMAT,
  TEMPORAL_CLASSIFICATION_WGSL,
  temporalEvidenceWgsl
} from "../../shaders/temporal_classification.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

const REACTIVE_INDEX = counterByteOffset("temporalReactivePixels") / 4;
const DISOCCLUDED_INDEX = counterByteOffset("temporalDisoccludedPixels") / 4;
const REJECTED_INDEX = counterByteOffset("temporalHistoryRejectedPixels") / 4;

export interface TemporalClassificationJob {
  readonly phase: "opaque" | "final";
  readonly width: number;
  readonly height: number;
  readonly metadataAvailable: boolean;
  readonly transparencyAvailable: boolean;
  readonly historyValid: boolean;
}

export interface TemporalClassificationInputs {
  readonly surfaceMetadata: ResourceId;
  readonly transparentReactive: ResourceId;
  readonly disocclusionConfidence: ResourceId;
  readonly counters?: ResourceId;
}

export interface TemporalClassificationOutputs {
  readonly classification: ResourceId;
  readonly counters: ResourceId | null;
}

const CLASSIFICATION_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-06 temporal classification/group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
  ]
};

const CLASSIFICATION_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "FX-06 temporal classification",
  layout: {
    label: "FX-06 temporal classification/layout",
    bindGroupLayouts: [CLASSIFICATION_GROUP]
  },
  vertex: {
    module: { label: "FX-06 fullscreen triangle", code: FULLSCREEN_TRIANGLE_VERTEX_WGSL },
    entryPoint: "main"
  },
  fragment: {
    module: { label: "FX-06 temporal classification", code: TEMPORAL_CLASSIFICATION_WGSL },
    entryPoint: "main",
    targets: [{ format: TEMPORAL_CLASSIFICATION_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

const EVIDENCE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-06 temporal evidence/group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
  ]
};

const EVIDENCE_PIPELINE: CachedComputePipelineDescriptor = {
  label: "FX-06 temporal sampled evidence",
  layout: {
    label: "FX-06 temporal sampled evidence/layout",
    bindGroupLayouts: [EVIDENCE_GROUP]
  },
  compute: {
    module: {
      label: "FX-06 temporal sampled evidence",
      code: temporalEvidenceWgsl(REACTIVE_INDEX, DISOCCLUDED_INDEX, REJECTED_INDEX)
    },
    entryPoint: "main"
  }
};

/** Builds the unified reactive/motion-valid signal consumed by Temporal. */
export class TemporalClassificationPass {
  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(
    graph: FrameGraph,
    job: TemporalClassificationJob,
    inputs: TemporalClassificationInputs
  ): TemporalClassificationOutputs {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    let classification = -1;
    const classify = graph.add(
      `FX-06 ${job.phase} temporal validity classification`,
      { job, width, height },
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const settings = new Uint32Array([
          data.job.metadataAvailable ? 1 : 0,
          data.job.transparencyAvailable ? 1 : 0,
          0,
          0
        ]);
        const settingsBuffer = command.allocateTransientBufferAndLoad(
          settings.buffer,
          GPUBufferUsage.UNIFORM
        );
        const pass = command.constructRenderPass({
          label: `FX-06 ${data.job.phase} temporal validity classification`,
          pipeline: CLASSIFICATION_PIPELINE,
          bindings: [[
            resolveTextureView(resources.get(inputs.surfaceMetadata)),
            resolveTextureView(resources.get(inputs.transparentReactive)),
            { buffer: settingsBuffer }
          ]],
          colorAttachments: [{
            view: resolveTextureView(resources.get(classification)),
            clearValue: { r: 1, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store"
          }]
        });
        pass.draw(3, 1, 0, 0);
        pass.end();
      }
    );
    classification = classify.create(`FX-06 ${job.phase} temporal classification`, {
      kind: "transient_texture",
      label: "FX-06 temporal classification rg8unorm",
      width,
      height,
      format: TEMPORAL_CLASSIFICATION_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    classify.read(inputs.surfaceMetadata);
    classify.read(inputs.transparentReactive);

    let counters: ResourceId | null = null;
    if (inputs.counters !== undefined) {
      const evidence = graph.add(
        "FX-06 Temporal sampled rejection evidence",
        { job, width, height },
        (data, resources, context) => {
          const command = requireCommand(context.encoder);
          const settings = new Uint32Array([
            data.job.historyValid ? 1 : 0,
            0,
            0,
            0
          ]);
          const settingsBuffer = command.allocateTransientBufferAndLoad(
            settings.buffer,
            GPUBufferUsage.UNIFORM
          );
          const pass = command.constructComputePass({
            label: "FX-06 Temporal sampled rejection evidence",
            pipeline: EVIDENCE_PIPELINE,
            bindings: [[
              resolveTextureView(resources.get(classification)),
              resolveTextureView(resources.get(inputs.disocclusionConfidence)),
              { buffer: requireBuffer(resources.get(inputs.counters!), "GPU counters") },
              { buffer: settingsBuffer }
            ]]
          });
          pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8), 1);
          pass.end();
        }
      );
      evidence.read(classification);
      evidence.read(inputs.disocclusionConfidence);
      evidence.read(inputs.counters);
      counters = evidence.write(inputs.counters);
      evidence.make_side_effect();
    }
    return Object.freeze({ classification, counters });
  }

  destroy(): void {}
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("TemporalClassificationPass requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`TemporalClassificationPass expected ${label} GPUBuffer`);
}
