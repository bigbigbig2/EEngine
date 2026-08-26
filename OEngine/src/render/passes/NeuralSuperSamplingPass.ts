/**
 * NeuralSuperSamplingPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import { radicalInverse } from "../TemporalJitterController.js";
import {
  type NssActivation,
  type NssLayerLayout,
  type NssModel,
  obtainBuiltInNssModel
} from "../NssModel.js";
import {
  NSS_CONCAT_WGSL,
  NSS_COPY_FEEDBACK_WGSL,
  NSS_LAYER_WGSL,
  NSS_PREPROCESS_WGSL,
  NSS_RESOLVE_WGSL
} from "../../shaders/nss.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

const NSS_BODY = [
  { inChannels: 12, outChannels: 32 },
  { inChannels: 32, outChannels: 32, skip: "B" },
  { inChannels: 32, outChannels: 32 },
  { inChannels: 32, outChannels: 32, skip: "A" },
  { inChannels: 32, outChannels: 64 },
  { inChannels: 64, outChannels: 64 },
  { inChannels: 64, outChannels: 32 },
  { inChannels: 32, outChannels: 16 },
  { inChannels: 48, outChannels: 16, concatSkip: "A" },
  { inChannels: 16, outChannels: 16 },
  { inChannels: 48, outChannels: 16, concatSkip: "B" },
  { inChannels: 16, outChannels: 16, preOutput: true }
] as const;

const NSS_HEAD_OUTPUT_OFFSETS = [0, 1, 2, 3, 4, 5] as const;

export type NeuralSuperSamplingInputs = {
  colorCurrent: ResourceId;
  depthCurrent: ResourceId;
  velocity: ResourceId;
  disocclusionConfidence: ResourceId;
  colorHistory: ResourceId;
  output: ResourceId;
};

export type NeuralSuperSamplingJob = {
  renderResolution: readonly [number, number];
  outputResolution: readonly [number, number];
};

export type NssSettings = {
  jitter: readonly [number, number];
  renderResolution: readonly [number, number];
  outputResolution: readonly [number, number];
  jitterTileOffset: readonly [number, number];
  historyValidity: number;
  upscaleRatio: number;
  frameIndex: number;
  alphaBlendScale: number;
  thetaOverride: number;
  debugView: number;
  networkAccScale: number;
  feedbackScale: number;
  quantizeInputs: number;
  jitterSign: readonly [number, number];
};

export class NeuralSuperSamplingPass {
  readonly Jitter: [number, number] = [0, 0];
  readonly JitterDelta: [number, number] = [0, 0];
  reset_history = true;
  alpha_blend_scale = 1;
  theta_override = -1;
  debug_view = 0;
  network_acc_scale = 1;
  feedback_scale = 1;
  quantize_inputs = 1;
  jitter_sign_x = 1;
  jitter_sign_y = 1;

  private sequence = new Float64Array(32);
  private sequenceSize = 16;
  private frameCountValue = 0;
  private renderWidth = 0;
  private renderHeight = 0;
  private model: NssModel;
  private weightsBuffer: GPUBuffer;
  private biasesBuffer: GPUBuffer;
  private rescalesBuffer: GPUBuffer;
  private lutsBuffer: GPUBuffer;
  private layerConfigBuffers: GPUBuffer[];
  private readonly ping: [GPUTextureContext, GPUTextureContext];
  private readonly skips: [GPUTextureContext, GPUTextureContext];
  private readonly concat: GPUTextureContext;
  private readonly preOutput: GPUTextureContext;
  private readonly networkOutput: GPUTextureContext;
  private readonly feedbackHistory: [GPUTextureContext, GPUTextureContext];
  private readonly preprocessPipeline: CachedComputePipelineDescriptor;
  private readonly layerPipeline: CachedComputePipelineDescriptor;
  private readonly concatPipeline: CachedComputePipelineDescriptor;
  private readonly copyFeedbackPipeline: CachedComputePipelineDescriptor;
  private readonly resolvePipeline: CachedComputePipelineDescriptor;

  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("NeuralSuperSamplingPass: GraphicsContext has no device");
    }
    this.rebuildJitter();
    this.model = obtainBuiltInNssModel();
    validateModelArchitecture(this.model);
    this.weightsBuffer = createMappedBuffer(
      device,
      "Renderer/NSS weights",
      this.model.packWeights(),
      GPUBufferUsage.STORAGE
    );
    this.biasesBuffer = createMappedBuffer(
      device,
      "Renderer/NSS biases",
      this.model.packBiases(),
      GPUBufferUsage.STORAGE
    );
    this.rescalesBuffer = createMappedBuffer(
      device,
      "Renderer/NSS rescales",
      this.model.packRescales(),
      GPUBufferUsage.STORAGE
    );
    this.lutsBuffer = createMappedBuffer(
      device,
      "Renderer/NSS LUTs",
      this.model.packLuts(),
      GPUBufferUsage.STORAGE
    );
    this.layerConfigBuffers = this.model.getLayout().map((layout, index) =>
      createLayerConfigBuffer(
        device,
        layout,
        index >= NSS_BODY.length ? NSS_HEAD_OUTPUT_OFFSETS[index - NSS_BODY.length]! : 0,
        index
      )
    );

    const tensor = (label: string): GPUTextureContext => new GPUTextureContext(device, {
      label,
      size: [1, 1, 1],
      dimension: "3d",
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    const feedback = (label: string): GPUTextureContext => new GPUTextureContext(device, {
      label,
      size: [1, 1, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.networkOutput = tensor("Renderer/NSS network output");
    this.concat = tensor("Renderer/NSS concat");
    this.preOutput = tensor("Renderer/NSS pre-output");
    this.ping = [tensor("Renderer/NSS ping 0"), tensor("Renderer/NSS ping 1")];
    this.skips = [tensor("Renderer/NSS skip A"), tensor("Renderer/NSS skip B")];
    this.feedbackHistory = [feedback("Renderer/NSS feedback 0"), feedback("Renderer/NSS feedback 1")];

    this.preprocessPipeline = computePipeline("Renderer/NSS preprocess LC", NSS_PREPROCESS_WGSL, preprocessLayout());
    this.layerPipeline = computePipeline("Renderer/NSS layer PC", NSS_LAYER_WGSL, layerLayout());
    this.concatPipeline = computePipeline("Renderer/NSS concat wC", NSS_CONCAT_WGSL, concatLayout());
    this.copyFeedbackPipeline = computePipeline("Renderer/NSS feedback CC", NSS_COPY_FEEDBACK_WGSL, copyFeedbackLayout());
    this.resolvePipeline = computePipeline("Renderer/NSS resolve kC", NSS_RESOLVE_WGSL, resolveLayout());
  }

  set jitter_sequence_size(value: number) {
    this.sequenceSize = Math.max(1, Math.ceil(value));
    this.rebuildJitter();
  }

  get jitter_sequence_size(): number {
    return this.sequenceSize;
  }

  static recommended_jitter_sequence_size(upscaleRatio: number): number {
    return Math.max(1, Math.ceil(8 * upscaleRatio * upscaleRatio));
  }

  set frame_index(value: number) {
    const index = value % this.sequenceSize;
    const x = this.sequence[index * 2]!;
    const y = this.sequence[index * 2 + 1]!;
    this.JitterDelta[0] = this.Jitter[0] - x;
    this.JitterDelta[1] = this.Jitter[1] - y;
    this.Jitter[0] = x;
    this.Jitter[1] = y;
  }

  set frame_count(value: number) {
    this.frameCountValue = value;
  }

  get frame_count(): number {
    return this.frameCountValue;
  }

  set weights(value: NssModel) {
    validateModelArchitecture(value);
    const device = this.graphics.device;
    if (device === null) {
      throw new Error("NeuralSuperSamplingPass: GraphicsContext has no device");
    }
    const weightsBuffer = createMappedBuffer(
      device,
      "Renderer/NSS weights",
      value.packWeights(),
      GPUBufferUsage.STORAGE
    );
    const biasesBuffer = createMappedBuffer(
      device,
      "Renderer/NSS biases",
      value.packBiases(),
      GPUBufferUsage.STORAGE
    );
    const rescalesBuffer = createMappedBuffer(
      device,
      "Renderer/NSS rescales",
      value.packRescales(),
      GPUBufferUsage.STORAGE
    );
    const lutsBuffer = createMappedBuffer(
      device,
      "Renderer/NSS LUTs",
      value.packLuts(),
      GPUBufferUsage.STORAGE
    );
    const layerConfigBuffers = value.getLayout().map((layout, index) =>
      createLayerConfigBuffer(
        device,
        layout,
        index >= NSS_BODY.length ? NSS_HEAD_OUTPUT_OFFSETS[index - NSS_BODY.length]! : 0,
        index
      )
    );
    this.weightsBuffer.destroy();
    this.biasesBuffer.destroy();
    this.rescalesBuffer.destroy();
    this.lutsBuffer.destroy();
    for (const buffer of this.layerConfigBuffers) buffer.destroy();
    this.weightsBuffer = weightsBuffer;
    this.biasesBuffer = biasesBuffer;
    this.rescalesBuffer = rescalesBuffer;
    this.lutsBuffer = lutsBuffer;
    this.layerConfigBuffers = layerConfigBuffers;
    this.model = value;
    this.reset_history = true;
  }

  get weights(): NssModel {
    return this.model;
  }

  addToGraph(
    graph: FrameGraph,
    job: NeuralSuperSamplingJob,
    inputs: NeuralSuperSamplingInputs,
    frameBindings?: {
      readonly settings: NssSettings;
      readonly feedbackCurrent: unknown;
      readonly feedbackNext: unknown;
      readonly bindResource: (
        name: string,
        resolve: () => object
      ) => object;
    }
  ): ResourceId {
    const [renderWidth, renderHeight] = job.renderResolution;
    const [outputWidth, outputHeight] = job.outputResolution;
    if (frameBindings === undefined) this.resize(renderWidth, renderHeight);
    const currentFeedbackIndex = this.frameCountValue % 2;
    const nextFeedbackIndex = (this.frameCountValue + 1) % 2;
    const feedbackCurrent = importTexture(
      graph,
      "NSS feedback current",
      this.feedbackHistory[currentFeedbackIndex]!,
      frameBindings?.feedbackCurrent
    );
    let feedbackNext = importTexture(
      graph,
      "NSS feedback next",
      this.feedbackHistory[nextFeedbackIndex]!,
      frameBindings?.feedbackNext
    );
    const importInternal = (name: string, context: GPUTextureContext): ResourceId =>
      importTexture(
        graph,
        name,
        context,
        frameBindings?.bindResource(name, () => context.gpu_texture)
      );
    const ping: [ResourceId, ResourceId] = [
      importInternal("NSS ping 0", this.ping[0]),
      importInternal("NSS ping 1", this.ping[1])
    ];
    const skips: Record<"A" | "B", ResourceId> = {
      A: importInternal("NSS skip A", this.skips[0]),
      B: importInternal("NSS skip B", this.skips[1])
    };
    let concat = importInternal("NSS concat", this.concat);
    let preOutput = importInternal("NSS pre-output", this.preOutput);
    let networkOutput = importInternal("NSS network output", this.networkOutput);
    const settings = frameBindings?.settings ?? this.createSettings(job);
    const preprocess = this.addPreprocess(
      graph,
      settings,
      renderWidth,
      renderHeight,
      inputs,
      feedbackCurrent
    );

    let current = this.addLayer(graph, 0, settings, preprocess.tensor, ping[0]);
    skips.B = this.addLayer(graph, 1, settings, current, skips.B);
    current = this.addLayer(graph, 2, settings, skips.B, ping[0]);
    skips.A = this.addLayer(graph, 3, settings, current, skips.A);
    current = this.addLayer(graph, 4, settings, skips.A, ping[1]);
    current = this.addLayer(graph, 5, settings, current, ping[0]);
    current = this.addLayer(graph, 6, settings, current, ping[1]);
    current = this.addLayer(graph, 7, settings, current, ping[0]);
    concat = this.addConcat(graph, settings, current, skips.A, concat, 16, 48);
    current = this.addLayer(graph, 8, settings, concat, ping[1]);
    current = this.addLayer(graph, 9, settings, current, ping[0]);
    concat = this.addConcat(graph, settings, current, skips.B, concat, 16, 48);
    current = this.addLayer(graph, 10, settings, concat, ping[1]);
    preOutput = this.addLayer(graph, 11, settings, current, preOutput);
    for (let head = 0; head < NSS_HEAD_OUTPUT_OFFSETS.length; head++) {
      networkOutput = this.addLayer(
        graph,
        NSS_BODY.length + head,
        settings,
        preOutput,
        networkOutput
      );
    }
    feedbackNext = this.addCopyFeedback(graph, networkOutput, feedbackNext, renderWidth, renderHeight);
    void feedbackNext;
    const result = this.addResolve(
      graph,
      settings,
      networkOutput,
      preprocess.nearestOffset,
      inputs,
      outputWidth,
      outputHeight
    );
    if (frameBindings === undefined) this.reset_history = false;
    return result;
  }

  prepareFrame(job: NeuralSuperSamplingJob): NssSettings {
    this.resize(job.renderResolution[0], job.renderResolution[1]);
    const settings = this.createSettings(job);
    this.reset_history = false;
    return settings;
  }

  feedbackTexture(frameIndex: number, output: boolean): GPUTexture {
    return this.feedbackHistory[(frameIndex + (output ? 1 : 0)) % 2]!.gpu_texture;
  }

  destroy(): void {
    this.weightsBuffer.destroy();
    this.biasesBuffer.destroy();
    this.rescalesBuffer.destroy();
    this.lutsBuffer.destroy();
    for (const buffer of this.layerConfigBuffers) buffer.destroy();
    this.networkOutput.destroy();
    this.concat.destroy();
    this.preOutput.destroy();
    for (const texture of this.ping) texture.destroy();
    for (const texture of this.skips) texture.destroy();
    for (const texture of this.feedbackHistory) texture.destroy();
  }

  private rebuildJitter(): void {
    const sequence = new Float64Array(this.sequenceSize * 2);
    for (let index = 0; index < this.sequenceSize; index++) {
      sequence[index * 2] = radicalInverse(2, index + 1) - 0.5;
      sequence[index * 2 + 1] = radicalInverse(3, index + 1) - 0.5;
    }
    this.sequence = sequence;
  }

  private resize(width: number, height: number): void {
    if (this.renderWidth === width && this.renderHeight === height) return;
    this.renderWidth = width;
    this.renderHeight = height;
    const groups = (channels: number): number => Math.max(1, Math.ceil(channels / 4));
    for (const texture of this.ping) texture.resize(width, height, groups(64));
    for (const texture of this.skips) texture.resize(width, height, groups(32));
    this.concat.resize(width, height, groups(48));
    this.preOutput.resize(width, height, groups(16));
    this.networkOutput.resize(width, height, groups(24));
    for (const texture of this.feedbackHistory) texture.resize(width, height);
  }

  private createSettings(job: NeuralSuperSamplingJob): NssSettings {
    const historyValidity = this.reset_history ? 0 : 1;
    const [renderWidth] = job.renderResolution;
    const [outputWidth] = job.outputResolution;
    return {
      jitter: this.Jitter,
      renderResolution: job.renderResolution,
      outputResolution: job.outputResolution,
      jitterTileOffset: [
        Math.floor(this.Jitter[0] + 0.5) & 1,
        Math.floor(this.Jitter[1] + 0.5) & 1
      ],
      historyValidity,
      upscaleRatio: outputWidth / renderWidth,
      frameIndex: this.frameCountValue,
      alphaBlendScale: this.alpha_blend_scale,
      thetaOverride: this.theta_override,
      debugView: this.debug_view | 0,
      networkAccScale: this.network_acc_scale,
      feedbackScale: this.feedback_scale,
      quantizeInputs: this.quantize_inputs,
      jitterSign: [this.jitter_sign_x, this.jitter_sign_y]
    };
  }

  private addPreprocess(
    graph: FrameGraph,
    settings: NssSettings,
    width: number,
    height: number,
    inputs: NeuralSuperSamplingInputs,
    feedback: ResourceId
  ): { tensor: ResourceId; nearestOffset: ResourceId } {
    let tensor = -1;
    let nearestOffset = -1;
    const builder = graph.add("NSS preprocess LC", settings, (data, resources, context) => {
      const command = requireCommand(context.encoder);
      const settingsBuffer = createSettingsBuffer(command, data);
      const pass = command.constructComputePass({
        label: "NSS preprocess LC",
        pipeline: this.preprocessPipeline,
        bindings: [[
          this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          texture(resources, inputs.colorCurrent),
          texture(resources, inputs.depthCurrent),
          texture(resources, inputs.velocity),
          texture(resources, inputs.disocclusionConfidence),
          texture(resources, inputs.colorHistory),
          texture(resources, feedback),
          { buffer: settingsBuffer },
          texture(resources, tensor),
          texture(resources, nearestOffset)
        ]]
      });
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
      pass.end();
    });
    for (const input of [
      inputs.colorCurrent,
      inputs.depthCurrent,
      inputs.velocity,
      inputs.disocclusionConfidence,
      inputs.colorHistory,
      feedback
    ]) builder.read(input);
    tensor = builder.create("NSS input tensor", tensorDescriptor(width, height, 3));
    nearestOffset = builder.create("NSS nearest offset", {
      kind: "transient_texture",
      label: "NSS nearest offset rg8unorm",
      width,
      height,
      format: "rg8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    return { tensor, nearestOffset };
  }

  private addLayer(
    graph: FrameGraph,
    layerIndex: number,
    settings: NssSettings,
    input: ResourceId,
    output: ResourceId
  ): ResourceId {
    let written = output;
    const layer = this.model.layers[layerIndex]!;
    const builder = graph.add(
      `NSS layer ${layerIndex}`,
      { settings, layerIndex },
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const settingsBuffer = createSettingsBuffer(command, data.settings);
        const pass = command.constructComputePass({
          label: `NSS layer ${data.layerIndex}`,
          pipeline: this.layerPipeline,
          bindings: [[
            texture(resources, input),
            texture(resources, written),
            { buffer: this.weightsBuffer },
            { buffer: this.biasesBuffer },
            { buffer: this.rescalesBuffer },
            { buffer: this.lutsBuffer },
            { buffer: this.layerConfigBuffers[data.layerIndex]! },
            { buffer: settingsBuffer }
          ]]
        });
        pass.dispatchWorkgroups(
          Math.ceil(this.renderWidth / 8),
          Math.ceil(this.renderHeight / 8),
          Math.max(1, Math.ceil(layer.outChannels / 4))
        );
        pass.end();
      }
    );
    builder.read(input);
    written = builder.write(output);
    return written;
  }

  private addConcat(
    graph: FrameGraph,
    settings: NssSettings,
    inputA: ResourceId,
    inputB: ResourceId,
    output: ResourceId,
    splitChannels: number,
    outputChannels: number
  ): ResourceId {
    let written = output;
    const builder = graph.add(
      "NSS concat wC",
      { settings, splitGroups: Math.ceil(splitChannels / 4), outputChannels },
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const concatSettings = command.allocateTransientBufferAndLoad(
          new Uint32Array([data.splitGroups]).buffer,
          GPUBufferUsage.UNIFORM
        );
        const pass = command.constructComputePass({
          label: "NSS concat wC",
          pipeline: this.concatPipeline,
          bindings: [[
            texture(resources, inputA),
            texture(resources, inputB),
            texture(resources, written),
            { buffer: concatSettings }
          ]]
        });
        pass.dispatchWorkgroups(
          Math.ceil(this.renderWidth / 8),
          Math.ceil(this.renderHeight / 8),
          Math.max(1, Math.ceil(data.outputChannels / 4))
        );
        pass.end();
      }
    );
    builder.read(inputA);
    builder.read(inputB);
    written = builder.write(output);
    return written;
  }

  private addCopyFeedback(
    graph: FrameGraph,
    input: ResourceId,
    output: ResourceId,
    width: number,
    height: number
  ): ResourceId {
    let written = output;
    const builder = graph.add("NSS feedback CC", {}, (_data, resources, context) => {
      const command = requireCommand(context.encoder);
      const pass = command.constructComputePass({
        label: "NSS feedback CC",
        pipeline: this.copyFeedbackPipeline,
        bindings: [[texture(resources, input), texture(resources, written)]]
      });
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
      pass.end();
    });
    builder.read(input);
    written = builder.write(output);
    return written;
  }

  private addResolve(
    graph: FrameGraph,
    settings: NssSettings,
    networkOutput: ResourceId,
    nearestOffset: ResourceId,
    inputs: NeuralSuperSamplingInputs,
    outputWidth: number,
    outputHeight: number
  ): ResourceId {
    let output = inputs.output;
    const builder = graph.add("NSS resolve kC", settings, (data, resources, context) => {
      const command = requireCommand(context.encoder);
      const settingsBuffer = createSettingsBuffer(command, data);
      const pass = command.constructComputePass({
        label: "NSS resolve kC",
        pipeline: this.resolvePipeline,
        bindings: [[
          this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          texture(resources, networkOutput),
          texture(resources, inputs.colorCurrent),
          texture(resources, inputs.velocity),
          texture(resources, nearestOffset),
          texture(resources, inputs.colorHistory),
          { buffer: settingsBuffer },
          texture(resources, output)
        ]]
      });
      pass.dispatchWorkgroups(Math.ceil(outputWidth / 8), Math.ceil(outputHeight / 8), 1);
      pass.end();
    });
    for (const input of [
      networkOutput,
      inputs.colorCurrent,
      inputs.velocity,
      nearestOffset,
      inputs.colorHistory
    ]) builder.read(input);
    output = builder.write(inputs.output);
    return output;
  }
}

function validateModelArchitecture(model: NssModel): void {
  if (model.layers.length !== NSS_BODY.length + NSS_HEAD_OUTPUT_OFFSETS.length) {
    throw new Error(`NSS model layer count ${model.layers.length} does not match UC architecture`);
  }
  for (let index = 0; index < NSS_BODY.length; index++) {
    const expected = NSS_BODY[index]!;
    const actual = model.layers[index]!;
    if (actual.inChannels !== expected.inChannels || actual.outChannels !== expected.outChannels) {
      throw new Error(`NSS body layer ${index} channel shape mismatch`);
    }
  }
}

function createMappedBuffer(
  device: GPUDevice,
  label: string,
  values: ArrayBufferView,
  usage: GPUBufferUsageFlags
): GPUBuffer {
  const size = Math.max(4, (values.byteLength + 3) & ~3);
  const buffer = device.createBuffer({
    label,
    size,
    usage: usage | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint8Array(buffer.getMappedRange()).set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
  );
  buffer.unmap();
  return buffer;
}

function createLayerConfigBuffer(
  device: GPUDevice,
  layout: NssLayerLayout,
  outputLayerOffset: number,
  layerIndex: number
): GPUBuffer {
  const buffer = device.createBuffer({
    label: `Renderer/NSS layer ${layerIndex} config`,
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  const view = new DataView(buffer.getMappedRange());
  const values = [
    layout.inChannels,
    layout.outChannels,
    layout.kernelSize,
    layout.weightsOffsetU32,
    layout.biasOffsetF32,
    layout.rescaleOffsetF32,
    layout.lutOffsetU32,
    activationKind(layout.activation),
    outputLayerOffset,
    layout.hasBias ? 1 : 0,
    layout.hasLut ? 1 : 0
  ];
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  view.setInt32(44, layout.outputZeroPoint, true);
  buffer.unmap();
  return buffer;
}

function activationKind(value: NssActivation): number {
  switch (value) {
    case "identity": return 0;
    case "relu": return 1;
    case "leaky_relu": return 2;
    default: throw new Error(`Unsupported NSS activation '${String(value)}'`);
  }
}

function createSettingsBuffer(command: ShadeGPUCommandContext, settings: NssSettings): GPUBuffer {
  const buffer = new ArrayBuffer(80);
  const view = new DataView(buffer);
  view.setFloat32(0, settings.jitter[0], true);
  view.setFloat32(4, settings.jitter[1], true);
  view.setUint32(8, settings.renderResolution[0], true);
  view.setUint32(12, settings.renderResolution[1], true);
  view.setUint32(16, settings.outputResolution[0], true);
  view.setUint32(20, settings.outputResolution[1], true);
  view.setUint32(24, settings.jitterTileOffset[0], true);
  view.setUint32(28, settings.jitterTileOffset[1], true);
  view.setFloat32(32, settings.historyValidity, true);
  view.setFloat32(36, settings.upscaleRatio, true);
  view.setUint32(40, settings.frameIndex, true);
  view.setFloat32(44, settings.alphaBlendScale, true);
  view.setFloat32(48, settings.thetaOverride, true);
  view.setUint32(52, settings.debugView, true);
  view.setFloat32(56, settings.networkAccScale, true);
  view.setFloat32(60, settings.feedbackScale, true);
  view.setFloat32(64, settings.quantizeInputs, true);
  view.setFloat32(72, settings.jitterSign[0], true);
  view.setFloat32(76, settings.jitterSign[1], true);
  return command.allocateTransientBufferAndLoad(buffer, GPUBufferUsage.UNIFORM);
}

function importTexture(
  graph: FrameGraph,
  name: string,
  context: GPUTextureContext,
  resource?: unknown
): ResourceId {
  return graph.import_resource(
    name,
    { kind: "imported", label: name },
    resource ?? context.gpu_texture
  );
}

function tensorDescriptor(width: number, height: number, layers: number) {
  return {
    kind: "transient_texture" as const,
    label: "NSS tensor rgba16float",
    width,
    height,
    depthOrArrayLayers: layers,
    dimension: "3d" as const,
    format: "rgba16float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
  };
}

function texture(resources: { get(id: ResourceId): unknown }, id: ResourceId): GPUTextureView {
  return resolveTextureView(resources.get(id));
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (
    value && typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructComputePass" in value
  ) return value as ShadeGPUCommandContext;
  throw new Error("NeuralSuperSamplingPass: UC requires ShadeGPUCommandContext");
}

function computePipeline(
  label: string,
  code: string,
  group0: GPUBindGroupLayoutDescriptor
): CachedComputePipelineDescriptor {
  return {
    label,
    layout: { label: `${label} layout`, bindGroupLayouts: [group0] },
    compute: { module: { label, code }, entryPoint: "main" }
  };
}

function textureEntry(binding: number, dimension: GPUTextureViewDimension = "2d", sampleType: GPUTextureSampleType = "float"): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, texture: { sampleType, viewDimension: dimension } };
}
function storageTextureEntry(binding: number, format: GPUTextureFormat, dimension: GPUTextureViewDimension): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format, viewDimension: dimension } };
}
function bufferEntry(binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } };
}
function samplerEntry(binding: number): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } };
}

function preprocessLayout(): GPUBindGroupLayoutDescriptor {
  return { label: "Renderer/NSS preprocess group0", entries: [
    samplerEntry(0), textureEntry(1), textureEntry(2, "2d", "unfilterable-float"),
    textureEntry(3), textureEntry(4), textureEntry(5), textureEntry(6),
    bufferEntry(7, "uniform"), storageTextureEntry(8, "rgba16float", "3d"),
    storageTextureEntry(9, "rg8unorm", "2d")
  ] };
}

function layerLayout(): GPUBindGroupLayoutDescriptor {
  return { label: "Renderer/NSS layer group0", entries: [
    textureEntry(0, "3d"), storageTextureEntry(1, "rgba16float", "3d"),
    bufferEntry(2, "read-only-storage"), bufferEntry(3, "read-only-storage"),
    bufferEntry(4, "read-only-storage"), bufferEntry(5, "read-only-storage"),
    bufferEntry(6, "uniform"), bufferEntry(7, "uniform")
  ] };
}

function concatLayout(): GPUBindGroupLayoutDescriptor {
  return { label: "Renderer/NSS concat group0", entries: [
    textureEntry(0, "3d"), textureEntry(1, "3d"),
    storageTextureEntry(2, "rgba16float", "3d"), bufferEntry(3, "uniform")
  ] };
}

function copyFeedbackLayout(): GPUBindGroupLayoutDescriptor {
  return { label: "Renderer/NSS feedback group0", entries: [
    textureEntry(0, "3d"), storageTextureEntry(1, "rgba16float", "2d")
  ] };
}

function resolveLayout(): GPUBindGroupLayoutDescriptor {
  return { label: "Renderer/NSS resolve group0", entries: [
    samplerEntry(0), textureEntry(1, "3d"), textureEntry(2), textureEntry(3),
    textureEntry(4), textureEntry(5), bufferEntry(6, "uniform"),
    storageTextureEntry(7, "rgba16float", "2d")
  ] };
}
