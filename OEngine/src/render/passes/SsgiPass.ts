/** Production FrameGraph owner for the pinned Three.js-derived SSGI path. */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { counterByteOffset, GPU_COUNTER_BYTE_SIZE } from "../../debug/GpuFrameCounters.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_SHADING_SURFACE_LITE_PROFILE,
  type GpuShadingSurfaceLiteProfile,
  gpuShadingSurfaceNormalPipelineConstants
} from "../../gpu/GpuComputeMaterialAbi.js";
import type { CachedComputePipelineDescriptor, CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR, type GPUSamplerCache } from "../../gpu/GPUSamplerCache.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import {
  SSGI_BENT_NORMAL_FORMAT,
  SSGI_CONFIDENCE_FORMAT,
  SSGI_INCIDENT_GI_FORMAT,
  SSGI_LINEAR_DEPTH_FORMAT,
  SSGI_LINEAR_DEPTH_WGSL,
  SSGI_RESOLVE_WGSL,
  SSGI_SPATIAL_WGSL,
  SSGI_TEMPORAL_WGSL,
  SSGI_TRACE_AO_FORMAT,
  SSGI_TRACE_GI_FORMAT,
  SSGI_VISIBILITY_FORMAT,
  THREE_SSGI_REVISION,
  THREE_SSGI_TRACE_WGSL
} from "../../shaders/ssgi.js";
import { resolveDepthAttachmentView, resolveTextureView } from "../RenderTargetViews.js";
import {
  screenSpaceDiffuseFrame,
  textureDomain,
  type PreExposureContract,
  type ScreenSpaceDiffuseSsgiFrame
} from "../pipeline/FrameProducts.js";

export interface SsgiInputs {
  readonly depth: ResourceId;
  readonly hzb: ResourceId;
  readonly normal: ResourceId;
  /** Frozen full-resolution pre-screen-space-diffuse radiance. */
  readonly radianceSource: ResourceId;
  readonly velocity?: ResourceId;
  readonly occlusionConfidence?: ResourceId;
  readonly surfaceValidity?: ResourceId;
  readonly camera: ResourceId;
  readonly counters?: ResourceId;
}

export interface SsgiJob {
  readonly samplers: GPUSamplerCache;
  readonly frameIndex: number;
  readonly historyValid: boolean;
  readonly width: number;
  readonly height: number;
  readonly radiusWorldUnits: number;
  readonly screenSpaceRadius: number;
  readonly samplingDomain: "world" | "screen";
  readonly thicknessWorldUnits: number;
  readonly aoIntensity: number;
  readonly giIntensity: number;
  readonly sliceCount: number;
  readonly stepCount: number;
  readonly spatialStep: number;
  readonly temporalBlend: number;
  readonly backfaceLighting: number;
  readonly historyGeneration: number;
  readonly preExposure: PreExposureContract;
  readonly historyPreExposureScale: number;
}

export interface SsgiHistoryBindings {
  readonly aoInput: unknown;
  readonly aoOutput: unknown;
  readonly giInput: unknown;
  readonly giOutput: unknown;
}

export interface SsgiOutput {
  readonly frame: ScreenSpaceDiffuseSsgiFrame;
  readonly rawAo: ResourceId;
  readonly spatialAo: ResourceId;
  readonly temporalAo: ResourceId;
  readonly rawGi: ResourceId;
  readonly temporalGi: ResourceId;
  readonly counters: ResourceId | null;
}

type HistorySet = Readonly<{ ao: GPUTextureContext; gi: GPUTextureContext }>;

export class SsgiPass {
  readonly algorithm = "three-ssgi-r186-oengine-wgsl" as const;
  readonly upstreamRevision = THREE_SSGI_REVISION;
  readonly historyTextureCount: number;
  private readonly device: GPUDevice;
  private readonly tracePipeline: CachedRenderPipelineDescriptor;
  private readonly spatialPipeline: CachedRenderPipelineDescriptor;
  private readonly temporalPipeline: CachedRenderPipelineDescriptor;
  private readonly resolvePipeline: CachedRenderPipelineDescriptor;
  private readonly linearDepthPipeline: CachedRenderPipelineDescriptor;
  private readonly histories: readonly [HistorySet, HistorySet] | null;
  private settingsBuffer: GPUBuffer | null = null;

  lastTracePasses = 0;
  lastSpatialPasses = 0;
  lastTemporalPasses = 0;
  lastResolvePasses = 0;

  constructor(
    private readonly graphics: GraphicsContext,
    readonly temporalEnabled: boolean,
    readonly resolutionScale: 0.5 | 1,
    surfaceProfile: GpuShadingSurfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE
  ) {
    if (graphics.device === null) throw new Error("SsgiPass requires an initialized GPUDevice");
    this.device = graphics.device;
    this.tracePipeline = pipeline("Renderer/Three SSGI r186 horizon-bitfield trace", THREE_SSGI_TRACE_WGSL,
      [traceLayout()], [{ format: SSGI_TRACE_AO_FORMAT }, { format: SSGI_TRACE_GI_FORMAT }], surfaceProfile);
    this.spatialPipeline = pipeline("Renderer/SSGI joint spatial filter", SSGI_SPATIAL_WGSL,
      [spatialLayout()], [{ format: SSGI_TRACE_AO_FORMAT }, { format: SSGI_TRACE_GI_FORMAT }], surfaceProfile);
    this.temporalPipeline = pipeline("Renderer/SSGI unified temporal resolve", SSGI_TEMPORAL_WGSL,
      [temporalLayout()], [{ format: SSGI_TRACE_AO_FORMAT }, { format: SSGI_TRACE_GI_FORMAT }], surfaceProfile);
    this.resolvePipeline = pipeline("Renderer/SSGI joint bilateral full-resolution resolve", SSGI_RESOLVE_WGSL,
      [resolveLayout()], [
        { format: SSGI_VISIBILITY_FORMAT },
        { format: SSGI_BENT_NORMAL_FORMAT },
        { format: SSGI_INCIDENT_GI_FORMAT },
        { format: SSGI_CONFIDENCE_FORMAT }
      ], surfaceProfile);
    this.linearDepthPipeline = pipeline("Renderer/SSGI linear depth", SSGI_LINEAR_DEPTH_WGSL,
      [linearDepthLayout()], [{ format: SSGI_LINEAR_DEPTH_FORMAT }], surfaceProfile);
    this.histories = temporalEnabled ? [this.createHistorySet(0), this.createHistorySet(1)] : null;
    this.historyTextureCount = this.histories === null ? 0 : 4;
  }

  addToGraph(
    graph: FrameGraph,
    job: SsgiJob,
    inputs: SsgiInputs,
    history?: SsgiHistoryBindings
  ): SsgiOutput {
    this.resetFrameEvidence();
    this.init();
    const fullWidth = Math.max(1, job.width | 0);
    const fullHeight = Math.max(1, job.height | 0);
    const width = Math.max(1, Math.ceil(fullWidth * this.resolutionScale));
    const height = Math.max(1, Math.ceil(fullHeight * this.resolutionScale));
    this.resize(width, height);
    if (
      this.temporalEnabled &&
      (history === undefined || inputs.velocity === undefined ||
        inputs.occlusionConfidence === undefined || inputs.surfaceValidity === undefined)
    ) {
      throw new Error("SsgiPass temporal history and motion/disocclusion inputs are required");
    }

    let linearDepth = -1;
    const linearBuilder = graph.add("SSGI linear view depth", {}, (_data, resources, context) => {
      const command = commandContext(context.encoder);
      const pass = command.constructRenderPass({
        label: "SSGI linear view depth",
        pipeline: this.linearDepthPipeline,
        bindings: [[
          resolveDepthAttachmentView(resources.get(inputs.depth)),
          { buffer: gpuBuffer(resources.get(inputs.camera), "SSGI camera") }
        ]],
        colorAttachments: [attachment(resources.get(linearDepth))]
      });
      pass.draw(3); pass.end();
    });
    linearDepth = linearBuilder.create("SSGI linear view depth", transientTexture(width, height, SSGI_LINEAR_DEPTH_FORMAT));
    linearBuilder.read(inputs.depth); linearBuilder.read(inputs.camera);

    let rawAo = -1; let rawGi = -1;
    const traceBuilder = graph.add("Three SSGI r186 horizon-bitfield trace", job, (data, resources, context) => {
      const command = commandContext(context.encoder);
      this.writeSettings(data, width, height);
      const pass = command.constructRenderPass({
        label: "Three SSGI r186 horizon-bitfield trace",
        pipeline: this.tracePipeline,
        bindings: [[
          resolveDepthAttachmentView(resources.get(inputs.depth)),
          view(resources.get(inputs.hzb)),
          view(resources.get(inputs.normal)),
          view(resources.get(inputs.radianceSource)),
          { buffer: gpuBuffer(resources.get(inputs.camera), "SSGI camera") },
          { buffer: this.settingsBuffer! }
        ]],
        colorAttachments: [attachment(resources.get(rawAo), { r: 1, g: 1, b: 0.5, a: 0.5 }), attachment(resources.get(rawGi))]
      });
      pass.draw(3); pass.end(); this.lastTracePasses = 1;
    });
    rawAo = traceBuilder.create("SSGI raw AO+bent moments", transientTexture(width, height, SSGI_TRACE_AO_FORMAT));
    rawGi = traceBuilder.create("SSGI raw incident GI+confidence", transientTexture(width, height, SSGI_TRACE_GI_FORMAT));
    for (const resource of [inputs.depth, inputs.hzb, inputs.normal, inputs.radianceSource, inputs.camera]) traceBuilder.read(resource);

    let counters: ResourceId | null = null;
    if (inputs.counters !== undefined) {
      const evidenceBuilder = graph.add(
        this.temporalEnabled
          ? "SSGI sampled trace/temporal evidence"
          : "SSGI sampled trace evidence",
        job,
        (data, resources, context) => {
          const command = commandContext(context.encoder);
          const values = new Uint32Array([
            data.historyValid ? 1 : 0,
            width,
            height,
            data.sliceCount * data.stepCount * 2
          ]);
          const settings = command.allocateTransientBufferAndLoad(
            values.buffer,
            GPUBufferUsage.UNIFORM
          );
          const bindings: GPUBindingResource[] = this.temporalEnabled
            ? [
                view(resources.get(inputs.velocity!)),
                view(resources.get(inputs.occlusionConfidence!)),
                { buffer: gpuBuffer(resources.get(inputs.counters!), "SSGI counters") },
                { buffer: settings }
              ]
            : [
                { buffer: gpuBuffer(resources.get(inputs.counters!), "SSGI counters") },
                { buffer: settings }
              ];
          const pass = command.constructComputePass({
            label: this.temporalEnabled
              ? "SSGI sampled trace/temporal evidence"
              : "SSGI sampled trace evidence",
            pipeline: this.temporalEnabled
              ? SSGI_TEMPORAL_EVIDENCE_PIPELINE
              : SSGI_TRACE_EVIDENCE_PIPELINE,
            bindings: [bindings]
          });
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
          pass.end();
        }
      );
      if (this.temporalEnabled) {
        evidenceBuilder.read(inputs.velocity!);
        evidenceBuilder.read(inputs.occlusionConfidence!);
      }
      evidenceBuilder.read(inputs.counters); counters = evidenceBuilder.write(inputs.counters);
      evidenceBuilder.make_side_effect();
    }

    let spatialAo = -1; let spatialGi = -1;
    const spatialBuilder = graph.add("SSGI joint spatial filter", job, (data, resources, context) => {
      const command = commandContext(context.encoder);
      const settings = command.allocateTransientBufferAndLoad(new Int32Array([data.spatialStep, 0, 0, 0]).buffer, GPUBufferUsage.UNIFORM);
      const pass = command.constructRenderPass({
        label: "SSGI joint spatial filter", pipeline: this.spatialPipeline,
        bindings: [[view(resources.get(rawAo)), view(resources.get(rawGi)), view(resources.get(linearDepth)), view(resources.get(inputs.normal)), { buffer: settings }]],
        colorAttachments: [attachment(resources.get(spatialAo)), attachment(resources.get(spatialGi))]
      });
      pass.draw(3); pass.end(); this.lastSpatialPasses = 1;
    });
    spatialAo = spatialBuilder.create("SSGI spatial AO+bent", transientTexture(width, height, SSGI_TRACE_AO_FORMAT));
    spatialGi = spatialBuilder.create("SSGI spatial incident GI", transientTexture(width, height, SSGI_TRACE_GI_FORMAT));
    for (const resource of [rawAo, rawGi, linearDepth, inputs.normal]) spatialBuilder.read(resource);

    let temporalAo = spatialAo; let temporalGi = spatialGi;
    if (this.temporalEnabled) {
      const aoInput = graph.import_resource("SSGI AO history input", { kind: "imported", label: "SSGI AO history input" }, history!.aoInput);
      const aoOutput = graph.import_resource("SSGI AO history output", { kind: "imported", label: "SSGI AO history output" }, history!.aoOutput);
      const giInput = graph.import_resource("SSGI GI history input", { kind: "imported", label: "SSGI GI history input" }, history!.giInput);
      const giOutput = graph.import_resource("SSGI GI history output", { kind: "imported", label: "SSGI GI history output" }, history!.giOutput);
      const temporalBuilder = graph.add("SSGI unified temporal AO+GI resolve", job, (data, resources, context) => {
        const command = commandContext(context.encoder);
        const values = new ArrayBuffer(16); const dv = new DataView(values);
        dv.setUint32(0, data.historyValid ? 1 : 0, true);
        dv.setFloat32(4, data.temporalBlend, true);
        dv.setFloat32(8, data.historyPreExposureScale, true);
        const settings = command.allocateTransientBufferAndLoad(values, GPUBufferUsage.UNIFORM);
        const pass = command.constructRenderPass({
          label: "SSGI unified temporal AO+GI resolve", pipeline: this.temporalPipeline,
          bindings: [[
            view(resources.get(spatialAo)), view(resources.get(spatialGi)),
            view(resources.get(aoInput)), view(resources.get(giInput)),
            view(resources.get(inputs.velocity!)), view(resources.get(inputs.occlusionConfidence!)),
            view(resources.get(inputs.surfaceValidity!)), data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
            { buffer: settings }
          ]],
          colorAttachments: [attachment(resources.get(temporalAo)), attachment(resources.get(temporalGi))]
        });
        pass.draw(3); pass.end(); this.lastTemporalPasses = 1;
      });
      for (const resource of [spatialAo, spatialGi, aoInput, giInput, inputs.velocity!, inputs.occlusionConfidence!, inputs.surfaceValidity!]) temporalBuilder.read(resource);
      temporalAo = temporalBuilder.write(aoOutput);
      temporalGi = temporalBuilder.write(giOutput);
    }

    let visibility = -1; let bentNormal = -1; let incidentGi = -1; let confidence = -1;
    const resolveBuilder = graph.add("SSGI joint bilateral full-resolution resolve", {}, (_data, resources, context) => {
      const command = commandContext(context.encoder);
      const pass = command.constructRenderPass({
        label: "SSGI joint bilateral full-resolution resolve", pipeline: this.resolvePipeline,
        bindings: [[
          view(resources.get(temporalAo)), view(resources.get(temporalGi)), view(resources.get(linearDepth)),
          resolveDepthAttachmentView(resources.get(inputs.depth)), view(resources.get(inputs.normal)),
          { buffer: gpuBuffer(resources.get(inputs.camera), "SSGI camera") }
        ]],
        colorAttachments: [attachment(resources.get(visibility), { r: 1, g: 0, b: 0, a: 0 }), attachment(resources.get(bentNormal)), attachment(resources.get(incidentGi)), attachment(resources.get(confidence))]
      });
      pass.draw(3); pass.end(); this.lastResolvePasses = 1;
    });
    visibility = resolveBuilder.create("SSGI screen ambient visibility", transientTexture(fullWidth, fullHeight, SSGI_VISIBILITY_FORMAT));
    bentNormal = resolveBuilder.create("SSGI bent normal", transientTexture(fullWidth, fullHeight, SSGI_BENT_NORMAL_FORMAT));
    incidentGi = resolveBuilder.create("SSGI incident diffuse GI", transientTexture(fullWidth, fullHeight, SSGI_INCIDENT_GI_FORMAT));
    confidence = resolveBuilder.create("SSGI confidence", transientTexture(fullWidth, fullHeight, SSGI_CONFIDENCE_FORMAT));
    for (const resource of [temporalAo, temporalGi, linearDepth, inputs.depth, inputs.normal, inputs.camera]) resolveBuilder.read(resource);

    return {
      frame: screenSpaceDiffuseFrame({
        mode: "ssgi", screenAmbientVisibility: visibility, bentNormal,
        incidentDiffuseGi: incidentGi, confidence,
        historyGeneration: job.historyGeneration, normalSpace: "world",
        preExposure: job.preExposure,
        domain: textureDomain("internal-full", fullWidth, fullHeight, 1)
      }) as ScreenSpaceDiffuseSsgiFrame,
      rawAo, spatialAo, temporalAo, rawGi, temporalGi,
      counters
    };
  }

  historyTexture(index: 0 | 1, kind: "ao" | "gi"): GPUTexture {
    if (this.histories === null) throw new Error("SSGI temporal history is disabled");
    return this.histories[index][kind].gpu_texture;
  }

  resize(width: number, height: number): void {
    for (const history of this.histories ?? []) { history.ao.resize(width, height); history.gi.resize(width, height); }
  }

  get historyBytes(): number {
    return (this.histories ?? []).reduce((sum, set) => sum + set.ao.gpu_memory_usage + set.gi.gpu_memory_usage, 0);
  }

  resetFrameEvidence(): void {
    this.lastTracePasses = 0; this.lastSpatialPasses = 0; this.lastTemporalPasses = 0; this.lastResolvePasses = 0;
  }

  destroy(): void {
    this.settingsBuffer?.destroy(); this.settingsBuffer = null;
    for (const history of this.histories ?? []) { history.ao.destroy(); history.gi.destroy(); }
  }

  private init(): void {
    this.settingsBuffer ??= this.device.createBuffer({ label: "SSGI trace settings", size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private writeSettings(job: SsgiJob, width: number, height: number): void {
    const data = new ArrayBuffer(64); const view = new DataView(data);
    view.setUint32(0, job.frameIndex >>> 0, true); view.setUint32(4, job.sliceCount >>> 0, true);
    view.setUint32(8, job.stepCount >>> 0, true); view.setUint32(12, this.temporalEnabled ? 1 : 0, true);
    view.setFloat32(16, job.radiusWorldUnits, true); view.setFloat32(20, job.thicknessWorldUnits, true);
    view.setFloat32(24, job.aoIntensity, true); view.setFloat32(28, job.giIntensity, true);
    view.setFloat32(32, job.backfaceLighting, true);
    view.setUint32(36, width >>> 0, true); view.setUint32(40, height >>> 0, true);
    view.setFloat32(44, job.screenSpaceRadius, true);
    view.setUint32(48, job.samplingDomain === "screen" ? 1 : 0, true);
    writeGpuBuffer(this.device.queue, "SSGI/trace-settings", this.settingsBuffer!, 0, data);
  }

  private createHistorySet(index: number): HistorySet {
    const make = (kind: "ao" | "gi", format: GPUTextureFormat) => new GPUTextureContext(this.device, {
      label: `SSGI ${kind} history ${index}`, size: [1, 1, 1], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    }, { accounting: this.graphics.resource_accounting, category: "history", owner: "SsgiPass" });
    return { ao: make("ao", SSGI_TRACE_AO_FORMAT), gi: make("gi", SSGI_TRACE_GI_FORMAT) };
  }
}

const SSGI_EVALUATED = counterByteOffset("ssgiEvaluatedPixels") / 4;
const SSGI_SAMPLES = counterByteOffset("ssgiTraceSamples") / 4;
const SSGI_ACCEPTED = counterByteOffset("ssgiHistoryAcceptedPixels") / 4;
const SSGI_REJECTED = counterByteOffset("ssgiHistoryRejectedPixels") / 4;
const SSGI_TEMPORAL_EVIDENCE_WGSL = /* wgsl */ `
struct Settings {
  history_valid: u32, width: u32, height: u32, samples: u32,
};
@group(0) @binding(0) var velocity_source: texture_2d<f32>;
@group(0) @binding(1) var confidence_source: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> settings: Settings;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.width || id.y >= settings.height) { return; }
  atomicAdd(&counters[${SSGI_EVALUATED}u], 1u);
  atomicAdd(&counters[${SSGI_SAMPLES}u], settings.samples);
  let full = textureDimensions(velocity_source);
  let trace_size = vec2f(f32(settings.width), f32(settings.height));
  let pixel = min(vec2u(vec2f(id.xy) / trace_size * vec2f(full)), full - 1u);
  let confidence = textureLoad(confidence_source, vec2i(pixel), 0).r;
  let velocity = textureLoad(velocity_source, vec2i(pixel), 0).rg;
  if (settings.history_valid != 0u && confidence > 0.001 && length(velocity) < 128.0) {
    atomicAdd(&counters[${SSGI_ACCEPTED}u], 1u);
  } else { atomicAdd(&counters[${SSGI_REJECTED}u], 1u); }
}
`;
const SSGI_TEMPORAL_EVIDENCE_PIPELINE: CachedComputePipelineDescriptor = {
  label: "SSGI sampled trace/temporal evidence",
  layout: { label: "SSGI temporal evidence/layout", bindGroupLayouts: [{ label: "SSGI temporal evidence/group0", entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
  ] }] },
  compute: { module: { label: "SSGI temporal evidence", code: SSGI_TEMPORAL_EVIDENCE_WGSL }, entryPoint: "main" }
};

const SSGI_TRACE_EVIDENCE_WGSL = /* wgsl */ `
struct Settings {
  history_valid: u32, width: u32, height: u32, samples: u32,
};
@group(0) @binding(0) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(1) var<uniform> settings: Settings;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.width || id.y >= settings.height) { return; }
  atomicAdd(&counters[${SSGI_EVALUATED}u], 1u);
  atomicAdd(&counters[${SSGI_SAMPLES}u], settings.samples);
}
`;
const SSGI_TRACE_EVIDENCE_PIPELINE: CachedComputePipelineDescriptor = {
  label: "SSGI sampled trace evidence",
  layout: { label: "SSGI trace evidence/layout", bindGroupLayouts: [{ label: "SSGI trace evidence/group0", entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
  ] }] },
  compute: { module: { label: "SSGI trace evidence", code: SSGI_TRACE_EVIDENCE_WGSL }, entryPoint: "main" }
};

function transientTexture(width: number, height: number, format: GPUTextureFormat) {
  return { kind: "transient_texture" as const, width, height, format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT };
}
function attachment(resource: unknown, clearValue: GPUColor = { r: 0, g: 0, b: 0, a: 0 }): GPURenderPassColorAttachment {
  return { view: view(resource), clearValue, loadOp: "clear", storeOp: "store" };
}
function view(resource: unknown): GPUTextureView { return resolveTextureView(resource as GPUTexture | GPUTextureView); }
function gpuBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object" && "size" in resource && "usage" in resource) return resource as GPUBuffer;
  throw new Error(`SsgiPass expected GPUBuffer for ${label}`);
}
function commandContext(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "constructRenderPass" in value) return value as ShadeGPUCommandContext;
  throw new Error("SsgiPass requires ShadeGPUCommandContext");
}
function pipeline(label: string, code: string, layouts: readonly GPUBindGroupLayoutDescriptor[], targets: readonly GPUColorTargetState[], profile: GpuShadingSurfaceLiteProfile): CachedRenderPipelineDescriptor {
  const constants = code.includes("OENGINE_SURFACE_NORMAL_MAX_VALUE")
    ? gpuShadingSurfaceNormalPipelineConstants(profile.normalEncoding)
    : null;
  return {
    label, layout: { label: `${label}/layout`, bindGroupLayouts: layouts },
    vertex: { module: { label, code }, entryPoint: "vs_main" },
    fragment: {
      module: { label, code },
      entryPoint: "fs_main",
      ...(constants === null ? {} : { constants }),
      targets
    },
    primitive: { topology: "triangle-list", cullMode: "none" }
  };
}
function traceLayout(): GPUBindGroupLayoutDescriptor { return layout("SSGI trace", ["depth", "float", "uint", "float", "uniform", "uniform"]); }
function spatialLayout(): GPUBindGroupLayoutDescriptor { return layout("SSGI spatial", ["float", "float", "float", "uint", "uniform"]); }
function resolveLayout(): GPUBindGroupLayoutDescriptor { return layout("SSGI resolve", ["float", "float", "float", "depth", "uint", "uniform"]); }
function linearDepthLayout(): GPUBindGroupLayoutDescriptor { return layout("SSGI linear depth", ["depth", "uniform"]); }
function temporalLayout(): GPUBindGroupLayoutDescriptor {
  return layout("SSGI temporal", ["float", "float", "float-filtering", "float-filtering", "float", "float", "float", "sampler", "uniform"]);
}
function layout(label: string, kinds: readonly string[]): GPUBindGroupLayoutDescriptor {
  return { label, entries: kinds.map((kind, binding) => {
    const visibility = GPUShaderStage.FRAGMENT;
    if (kind === "uniform") return { binding, visibility, buffer: { type: "uniform" as const } };
    if (kind === "sampler") return { binding, visibility, sampler: { type: "filtering" as const } };
    if (kind === "depth") return { binding, visibility, texture: { sampleType: "depth" as const } };
    if (kind === "uint") return { binding, visibility, texture: { sampleType: "uint" as const } };
    return { binding, visibility, texture: { sampleType: kind === "float-filtering" ? "float" as const : "unfilterable-float" as const } };
  }) };
}
