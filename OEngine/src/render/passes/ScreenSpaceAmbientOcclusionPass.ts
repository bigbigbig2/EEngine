/**
 * ScreenSpaceAmbientOcclusionPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  counterByteOffset,
  GPU_COUNTER_BYTE_SIZE
} from "../../debug/GpuFrameCounters.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../../gpu/GPUDescriptorCaches.js";
import { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";
import {
  SSAO_ALBEDO_AO_FORMAT,
  SSAO_BENT_NORMAL_UPSAMPLE_WGSL,
  SSAO_BENT_NORMAL_FORMAT,
  SSAO_COMPOSITE_WGSL,
  SSAO_RAW_WGSL,
  SSAO_SPATIAL_WGSL,
  SSAO_TEMPORAL_WGSL,
  SSAO_VISIBILITY_FORMAT
} from "../../shaders/ssao.js";
import { HILBERT_NOISE_TEXTURE } from "../HilbertNoiseTexture.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "./MaterialExpandPass.js";

export { hilbertIndex } from "../HilbertNoiseTexture.js";

export type ScreenSpaceAmbientOcclusionInputs = {
  depth: ResourceId;
  normal: ResourceId;
  velocity: ResourceId;
  occlusionConfidence: ResourceId;
  albedoAo: ResourceId;
  camera: ResourceId;
  counters?: ResourceId;
};

export type ScreenSpaceAmbientOcclusionOutput = {
  rawVisibility: ResourceId;
  denoisedVisibility: ResourceId;
  visibility: ResourceId;
  occlusion: ResourceId;
  bentNormals: ResourceId;
  counters: ResourceId | null;
};

export type ScreenSpaceAmbientOcclusionJob = {
  samplers: GPUSamplerCache;
  frameIndex: number;
  historyValid: boolean;
  historyInputIndex: 0 | 1;
  historyOutputIndex: 0 | 1;
  width: number;
  height: number;
  intensity: number;
  falloff: number;
  sliceCount: number;
  stepCount: number;
  spatialStep: number;
  temporalBlend: number;
};

export class ScreenSpaceAmbientOcclusionPass {
  private readonly rawPipeline: CachedRenderPipelineDescriptor;
  private readonly spatialPipeline: CachedRenderPipelineDescriptor;
  private readonly temporalPipeline: CachedRenderPipelineDescriptor;
  private readonly compositePipeline: CachedRenderPipelineDescriptor;
  private readonly bentNormalUpsamplePipeline: CachedRenderPipelineDescriptor;
  private rawSettingsBuffer: GPUBuffer | null = null;
  private hilbertView: GPUTextureView | null = null;
  private readonly histories: [GPUTextureContext, GPUTextureContext] | null;
  private readonly device: GPUDevice;

  lastRan = false;
  lastRawPasses = 0;
  lastSpatialPasses = 0;
  lastTemporalPasses = 0;
  lastCompositePasses = 0;
  lastBentNormalUpsamplePasses = 0;

  constructor(
    private readonly graphics: GraphicsContext,
    readonly temporalEnabled = true,
    readonly resolutionScale: 0.5 | 1 = 1
  ) {
    const device = graphics.device;
    if (device === null) {
      throw new Error(
        "ScreenSpaceAmbientOcclusionPass: GraphicsContext has no device"
      );
    }
    this.device = device;
    this.rawPipeline = createSsaoRawPipelineDescriptor();
    this.spatialPipeline = createSsaoSpatialPipelineDescriptor();
    this.temporalPipeline = createSsaoTemporalPipelineDescriptor();
    this.compositePipeline = createSsaoCompositePipelineDescriptor();
    this.bentNormalUpsamplePipeline = createSsaoBentNormalUpsamplePipelineDescriptor();
    const descriptor: GPUTextureDescriptor = {
      label: "SSAO history",
      size: [1, 1, 1],
      format: SSAO_VISIBILITY_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    };
    this.histories = temporalEnabled
      ? [
          new GPUTextureContext(device, { ...descriptor, label: "SSAO history 0" }),
          new GPUTextureContext(device, { ...descriptor, label: "SSAO history 1" })
        ]
      : null;
  }

  init(): void {
    if (this.rawSettingsBuffer !== null) return;
    this.rawSettingsBuffer = this.device.createBuffer({
      label: "Renderer/SSAO raw settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.hilbertView = this.graphics.textures
      .obtain(HILBERT_NOISE_TEXTURE)
      .obtainView();
  }

  addToGraph(
    graph: FrameGraph,
    job: ScreenSpaceAmbientOcclusionJob,
    inputs: ScreenSpaceAmbientOcclusionInputs,
    historyBindings?: { readonly input: unknown; readonly output: unknown }
  ): ScreenSpaceAmbientOcclusionOutput {
    this.init();
    this.resetFrameEvidence();
    const fullWidth = Math.max(1, job.width | 0);
    const fullHeight = Math.max(1, job.height | 0);
    const width = Math.max(1, Math.ceil(fullWidth * this.resolutionScale));
    const height = Math.max(1, Math.ceil(fullHeight * this.resolutionScale));
    this.resize(width, height);

    if (this.temporalEnabled && historyBindings === undefined) {
      throw new Error("SSAO temporal history bindings are required");
    }

    let rawVisibility = -1;
    let bentNormals = -1;
    const self = this;
    const rawBuilder = graph.add(
      "SSAO raw GTAO lD",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        self.executeRaw(
          command,
          data.frameIndex,
          data.falloff,
          data.sliceCount,
          data.stepCount,
          {
          visibility: resolveTextureView(resources.get(rawVisibility)),
          bentNormals: resolveTextureView(resources.get(bentNormals)),
          depth: resolveDepthAttachmentView(resources.get(inputs.depth)),
          normal: resolveTextureView(resources.get(inputs.normal)),
          camera: resolveBuffer(resources.get(inputs.camera), "SSAO camera")
          }
        );
        self.lastRawPasses = 1;
      }
    );
    rawVisibility = rawBuilder.create("SSAO raw visibility", {
      kind: "transient_texture",
      label: "SSAO raw visibility lD",
      width,
      height,
      format: SSAO_VISIBILITY_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    bentNormals = rawBuilder.create("SSAO bent normals", {
      kind: "transient_texture",
      label: "SSAO bent normals lD",
      width,
      height,
      format: SSAO_BENT_NORMAL_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    rawBuilder.read(inputs.depth);
    rawBuilder.read(inputs.normal);
    rawBuilder.read(inputs.camera);

    let spatialVisibility = -1;
    const spatialBuilder = graph.add(
      "SSAO spatial filter XC",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        self.executeSpatial(command, data.spatialStep, {
          output: resolveTextureView(resources.get(spatialVisibility)),
          visibility: resolveTextureView(resources.get(rawVisibility)),
          depth: resolveDepthAttachmentView(resources.get(inputs.depth)),
          normal: resolveTextureView(resources.get(inputs.normal))
        });
        self.lastSpatialPasses = 1;
      }
    );
    spatialVisibility = spatialBuilder.create("SSAO filtered visibility", {
      kind: "transient_texture",
      label: "SSAO filtered visibility XC",
      width,
      height,
      format: SSAO_VISIBILITY_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    spatialBuilder.read(rawVisibility);
    spatialBuilder.read(inputs.depth);
    spatialBuilder.read(inputs.normal);

    let resolvedVisibility = spatialVisibility;
    if (this.temporalEnabled) {
      const historyInputResource = graph.import_resource(
        "ao_history",
        { kind: "imported", label: "ao_history" },
        historyBindings!.input
      );
      const historyOutputResource = graph.import_resource(
        "ao_output",
        { kind: "imported", label: "ao_output" },
        historyBindings!.output
      );
      const temporalBuilder = graph.add(
        "SSAO temporal resolve ZC",
        job,
        (data, resources, context) => {
          const command = requireShadeCommandContext(context.encoder);
          self.executeTemporal(
            command,
            data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
            data.historyValid,
            data.temporalBlend,
            {
              output: resolveTextureView(resources.get(resolvedVisibility)),
              current: resolveTextureView(resources.get(spatialVisibility)),
              history: resolveTextureView(resources.get(historyInputResource)),
              velocity: resolveTextureView(resources.get(inputs.velocity)),
              occlusionConfidence: resolveTextureView(
                resources.get(inputs.occlusionConfidence)
              )
            }
          );
          self.lastTemporalPasses = 1;
        }
      );
      temporalBuilder.read(spatialVisibility);
      temporalBuilder.read(historyInputResource);
      temporalBuilder.read(inputs.velocity);
      temporalBuilder.read(inputs.occlusionConfidence);
      resolvedVisibility = temporalBuilder.write(historyOutputResource);
    }

    let counters: ResourceId | null = null;
    if (inputs.counters !== undefined) {
      const evidenceBuilder = graph.add(
        "R5-Q00 GTAO sampled temporal evidence",
        {
          width,
          height,
          fullWidth,
          fullHeight,
          historyValid: this.temporalEnabled && job.historyValid
        },
        (data, resources, context) => {
          const command = requireShadeCommandContext(context.encoder);
          const settings = command.allocateTransientBufferAndLoad(
            new Uint32Array([
              data.historyValid ? 1 : 0,
              data.width,
              data.height,
              0
            ]).buffer,
            GPUBufferUsage.UNIFORM
          );
          const pass = command.constructComputePass({
            label: "R5-Q00 GTAO sampled temporal evidence",
            pipeline: GTAO_EVIDENCE_PIPELINE,
            bindings: [[
              resolveTextureView(resources.get(inputs.velocity)),
              resolveTextureView(resources.get(inputs.occlusionConfidence)),
              { buffer: requireBuffer(resources.get(inputs.counters!), "GTAO counters") },
              { buffer: settings }
            ]]
          });
          pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8), 1);
          pass.end();
        }
      );
      evidenceBuilder.read(inputs.velocity);
      evidenceBuilder.read(inputs.occlusionConfidence);
      evidenceBuilder.read(inputs.counters);
      counters = evidenceBuilder.write(inputs.counters);
      evidenceBuilder.make_side_effect();
    }

    let resolvedBentNormals = bentNormals;
    if (this.resolutionScale < 1) {
      const bentNormalUpsampleBuilder = graph.add(
        "SSAO bent-normal upsample",
        {},
        (_data, resources, context) => {
          const command = requireShadeCommandContext(context.encoder);
          self.executeBentNormalUpsample(command, {
            output: resolveTextureView(resources.get(resolvedBentNormals)),
            source: resolveTextureView(resources.get(bentNormals))
          });
          self.lastBentNormalUpsamplePasses = 1;
        }
      );
      bentNormalUpsampleBuilder.read(bentNormals);
      resolvedBentNormals = bentNormalUpsampleBuilder.create("SSAO full-resolution bent normals", {
        kind: "transient_texture",
        label: "SSAO full-resolution bent normals",
        width: fullWidth,
        height: fullHeight,
        format: SSAO_BENT_NORMAL_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
      });
    }

    let occlusion = -1;
    const compositeBuilder = graph.add(
      "SSAO alpha-min composite mD",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        self.executeComposite(
          command,
          job.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          data.intensity,
          {
          output: resolveTextureView(resources.get(occlusion)),
          visibility: resolveTextureView(resources.get(resolvedVisibility))
          }
        );
        self.lastCompositePasses = 1;
      }
    );
    compositeBuilder.read(resolvedVisibility);
    occlusion = compositeBuilder.write(inputs.albedoAo);

    return {
      rawVisibility,
      denoisedVisibility: spatialVisibility,
      visibility: resolvedVisibility,
      occlusion,
      bentNormals: resolvedBentNormals,
      counters
    };
  }

  historyTexture(index: 0 | 1): GPUTexture {
    if (this.histories === null) {
      throw new Error("SSAO temporal history is disabled");
    }
    return this.histories[index].gpu_texture;
  }

  resize(width: number, height: number): void {
    const resolvedWidth = Math.max(1, width | 0);
    const resolvedHeight = Math.max(1, height | 0);
    this.histories?.[0].resize(resolvedWidth, resolvedHeight);
    this.histories?.[1].resize(resolvedWidth, resolvedHeight);
  }

  get historyTextureCount(): number {
    return this.histories?.length ?? 0;
  }

  get historyBytes(): number {
    return this.histories?.reduce((sum, history) => sum + history.gpu_memory_usage, 0) ?? 0;
  }

  resetFrameEvidence(): void {
    this.lastRan = false;
    this.lastRawPasses = 0;
    this.lastSpatialPasses = 0;
    this.lastTemporalPasses = 0;
    this.lastCompositePasses = 0;
    this.lastBentNormalUpsamplePasses = 0;
  }

  private executeRaw(
    command: ShadeGPUCommandContext,
    frameIndex: number,
    falloff: number,
    sliceCount: number,
    stepCount: number,
    resources: {
      visibility: GPUTextureView;
      bentNormals: GPUTextureView;
      depth: GPUTextureView;
      normal: GPUTextureView;
      camera: GPUBuffer;
    }
  ): void {
    if (
      this.rawSettingsBuffer === null ||
      this.hilbertView === null
    ) {
      throw new Error("ScreenSpaceAmbientOcclusionPass not initialized");
    }
    const settings = new ArrayBuffer(16);
    const settingsView = new DataView(settings);
    settingsView.setUint32(0, frameIndex >>> 0, true);
    settingsView.setFloat32(4, Math.max(0.001, falloff), true);
    settingsView.setUint32(8, Math.max(1, Math.min(4, Math.round(sliceCount))), true);
    settingsView.setUint32(12, Math.max(1, Math.min(8, Math.round(stepCount))), true);
    writeGpuBuffer(
      this.device.queue,
      "SSAO/raw-settings",
      this.rawSettingsBuffer,
      0,
      settings
    );
    const pass = command.constructRenderPass({
      label: "SSAO raw GTAO lD",
      pipeline: this.rawPipeline,
      bindings: [[
        resources.depth,
        resources.normal,
        this.hilbertView,
        { buffer: resources.camera },
        { buffer: this.rawSettingsBuffer }
      ]],
      colorAttachments: [
        {
          view: resources.visibility,
          clearValue: { r: 1, g: 1, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        },
        {
          view: resources.bentNormals,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private executeSpatial(
    command: ShadeGPUCommandContext,
    spatialStep: number,
    resources: {
      output: GPUTextureView;
      visibility: GPUTextureView;
      depth: GPUTextureView;
      normal: GPUTextureView;
    }
  ): void {
    const settings = command.allocateTransientBufferAndLoad(
      new Int32Array([Math.max(1, Math.min(4, Math.round(spatialStep))), 0, 0, 0]).buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructRenderPass({
      label: "SSAO spatial filter XC",
      pipeline: this.spatialPipeline,
      bindings: [
        [resources.visibility, resources.depth, resources.normal],
        [{ buffer: settings }]
      ],
      colorAttachments: [
        {
          view: resources.output,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private executeTemporal(
    command: ShadeGPUCommandContext,
    sampler: GPUSampler,
    historyValid: boolean,
    temporalBlend: number,
    resources: {
      output: GPUTextureView;
      current: GPUTextureView;
      history: GPUTextureView;
      velocity: GPUTextureView;
      occlusionConfidence: GPUTextureView;
    }
  ): void {
    const settingsData = new ArrayBuffer(16);
    const settingsView = new DataView(settingsData);
    settingsView.setUint32(0, historyValid ? 1 : 0, true);
    settingsView.setFloat32(4, Math.max(0, Math.min(0.99, temporalBlend)), true);
    const settings = command.allocateTransientBufferAndLoad(
      settingsData,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructRenderPass({
      label: "SSAO temporal resolve ZC",
      pipeline: this.temporalPipeline,
      bindings: [[
        resources.current,
        resources.velocity,
        resources.occlusionConfidence,
        resources.history,
        sampler,
        { buffer: settings }
      ]],
      colorAttachments: [
        {
          view: resources.output,
          clearValue: { r: 1, g: 1, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private executeComposite(
    command: ShadeGPUCommandContext,
    sampler: GPUSampler,
    intensity: number,
    resources: {
      output: GPUTextureView;
      visibility: GPUTextureView;
    }
  ): void {
    const settings = command.allocateTransientBufferAndLoad(
      new Float32Array([Math.max(0, intensity), 0, 0, 0]).buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructRenderPass({
      label: "SSAO alpha-min composite mD",
      pipeline: this.compositePipeline,
      bindings: [[resources.visibility, sampler, { buffer: settings }]],
      colorAttachments: [
        {
          view: resources.output,
          loadOp: "load",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
    this.lastRan = true;
  }

  private executeBentNormalUpsample(
    command: ShadeGPUCommandContext,
    resources: { output: GPUTextureView; source: GPUTextureView }
  ): void {
    const pass = command.constructRenderPass({
      label: "SSAO bent-normal upsample",
      pipeline: this.bentNormalUpsamplePipeline,
      bindings: [[resources.source]],
      colorAttachments: [{
        view: resources.output,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  destroy(): void {
    this.rawSettingsBuffer?.destroy();
    this.rawSettingsBuffer = null;
    this.hilbertView = null;
    this.histories?.[0].destroy();
    this.histories?.[1].destroy();
  }
}

function createSsaoRawPipelineDescriptor(): CachedRenderPipelineDescriptor {
  const label = "Renderer/SSAO raw lD";
  return createSsaoPipelineDescriptor(
    label,
    SSAO_RAW_WGSL,
    [createSsaoRawGroupLayout()],
    [
      {
        format: SSAO_VISIBILITY_FORMAT,
        blend: {
          color: { operation: "add", srcFactor: "one", dstFactor: "zero" },
          alpha: { operation: "add", srcFactor: "one", dstFactor: "zero" }
        }
      },
      { format: SSAO_BENT_NORMAL_FORMAT }
    ]
  );
}

const AO_EVALUATED_INDEX = counterByteOffset("aoEvaluatedPixels") / 4;
const AO_HISTORY_ACCEPTED_INDEX = counterByteOffset("aoHistoryAcceptedPixels") / 4;
const AO_HISTORY_REJECTED_INDEX = counterByteOffset("aoHistoryRejectedPixels") / 4;

export const GTAO_EVIDENCE_WGSL = /* wgsl */ `
struct EvidenceSettings {
  history_valid: u32,
  ao_width: u32,
  ao_height: u32,
  _padding: u32,
};

@group(0) @binding(0) var velocity_source: texture_2d<f32>;
@group(0) @binding(1) var confidence_source: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> settings: EvidenceSettings;

fn largest_velocity(pixel: vec2i, dimensions: vec2i) -> vec2f {
  var result = textureLoad(velocity_source, clamp(pixel, vec2i(0), dimensions - vec2i(1)), 0).rg;
  var magnitude = dot(result, result);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let candidate = textureLoad(
        velocity_source,
        clamp(pixel + vec2i(x, y), vec2i(0), dimensions - vec2i(1)),
        0
      ).rg;
      let candidate_magnitude = dot(candidate, candidate);
      if (candidate_magnitude > magnitude) {
        result = candidate;
        magnitude = candidate_magnitude;
      }
    }
  }
  return result;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let ao_dimensions = vec2u(settings.ao_width, settings.ao_height);
  if (any(id.xy >= ao_dimensions)) { return; }
  atomicAdd(&counters[${AO_EVALUATED_INDEX}u], 1u);
  let full_dimensions = textureDimensions(velocity_source);
  let full_pixel = min(
    vec2i((vec2f(id.xy) / vec2f(ao_dimensions)) * vec2f(full_dimensions)),
    vec2i(full_dimensions) - vec2i(1)
  );
  let confidence = textureLoad(confidence_source, full_pixel, 0).r;
  let velocity_full = largest_velocity(full_pixel, vec2i(full_dimensions));
  let velocity = velocity_full * vec2f(ao_dimensions) / vec2f(full_dimensions);
  let velocity_confidence = clamp(1.0 - length(velocity) / 128.0, 0.0, 1.0);
  let history_pixel = vec2f(id.xy) + vec2f(0.5) - velocity;
  let in_bounds = all(history_pixel >= vec2f(0.0)) &&
    all(history_pixel < vec2f(ao_dimensions));
  let history_weight = velocity_confidence * confidence *
    select(0.0, 1.0, in_bounds && settings.history_valid != 0u);
  if (history_weight > 0.001) {
    atomicAdd(&counters[${AO_HISTORY_ACCEPTED_INDEX}u], 1u);
  } else {
    atomicAdd(&counters[${AO_HISTORY_REJECTED_INDEX}u], 1u);
  }
}
`;

const GTAO_EVIDENCE_PIPELINE: CachedComputePipelineDescriptor = {
  label: "R5-Q00 GTAO sampled temporal evidence",
  layout: {
    label: "R5-Q00 GTAO sampled temporal evidence/layout",
    bindGroupLayouts: [{
      label: "R5-Q00 GTAO sampled temporal evidence/group0",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE }
        },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
      ]
    }]
  },
  compute: {
    module: { label: "R5-Q00 GTAO sampled temporal evidence", code: GTAO_EVIDENCE_WGSL },
    entryPoint: "main"
  }
};

function createSsaoSpatialPipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsaoPipelineDescriptor(
    "Renderer/SSAO spatial XC",
    SSAO_SPATIAL_WGSL,
    [createSsaoSpatialTextureLayout(), createSsaoSpatialSettingsLayout()],
    [{ format: SSAO_VISIBILITY_FORMAT }]
  );
}

function createSsaoTemporalPipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsaoPipelineDescriptor(
    "Renderer/SSAO temporal ZC",
    SSAO_TEMPORAL_WGSL,
    [createSsaoTemporalGroupLayout()],
    [{ format: SSAO_VISIBILITY_FORMAT }]
  );
}

function createSsaoCompositePipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsaoPipelineDescriptor(
    "Renderer/SSAO alpha-min mD",
    SSAO_COMPOSITE_WGSL,
    [createSsaoCompositeGroupLayout()],
    [{
      format: SSAO_ALBEDO_AO_FORMAT,
      blend: {
        color: { operation: "add", srcFactor: "zero", dstFactor: "one" },
        alpha: { operation: "min", srcFactor: "one", dstFactor: "one" }
      }
    }]
  );
}

function createSsaoBentNormalUpsamplePipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsaoPipelineDescriptor(
    "Renderer/SSAO bent-normal upsample",
    SSAO_BENT_NORMAL_UPSAMPLE_WGSL,
    [{
      label: "Renderer/SSAO bent-normal upsample group0",
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "uint", viewDimension: "2d" }
      }]
    }],
    [{ format: SSAO_BENT_NORMAL_FORMAT }]
  );
}

function createSsaoPipelineDescriptor(
  label: string,
  code: string,
  bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[],
  targets: readonly (GPUColorTargetState | null)[],
  depth = false
): CachedRenderPipelineDescriptor {
  const module = { label, code };
  return {
    label,
    layout: { label: `${label} layout`, bindGroupLayouts },
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets },
    primitive: { topology: "triangle-list", cullMode: "none" },
    ...(depth
      ? {
          depthStencil: {
            format: "depth32float" as GPUTextureFormat,
            depthWriteEnabled: false,
            depthCompare: "not-equal" as GPUCompareFunction
          }
        }
      : {})
  };
}

function createSsaoRawGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSAO raw lD group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 4, visibility: fragment, buffer: { type: "uniform" } }
    ]
  };
}

function createSsaoSpatialTextureLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSAO spatial XC group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } }
    ]
  };
}

function createSsaoSpatialSettingsLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/SSAO spatial XC group1",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    }]
  };
}

function createSsaoTemporalGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSAO temporal ZC group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 4, visibility: fragment, sampler: { type: "filtering" } },
      { binding: 5, visibility: fragment, buffer: { type: "uniform" } }
    ]
  };
}

function createSsaoCompositeGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/SSAO alpha-min mD group0",
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
        buffer: { type: "uniform" }
      }
    ]
  };
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructRenderPass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("ScreenSpaceAmbientOcclusionPass: cached gD requires ShadeGPUCommandContext");
}

function resolveBuffer(resource: unknown, label: string): GPUBuffer {
  if (
    resource &&
    typeof resource === "object" &&
    "size" in resource &&
    "usage" in resource
  ) {
    return resource as GPUBuffer;
  }
  throw new Error(`ScreenSpaceAmbientOcclusionPass: expected GPUBuffer for ${label}`);
}

function requireBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object" && "size" in resource && "usage" in resource) {
    return resource as GPUBuffer;
  }
  throw new Error(`ScreenSpaceAmbientOcclusionPass: missing ${label} buffer`);
}
