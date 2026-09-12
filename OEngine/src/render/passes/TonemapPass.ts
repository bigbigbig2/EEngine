/**
 * TonemapPass：实现渲染管线中的独立渲染阶段。
 */

import {
  tonemapSdrWgsl,
  TONEMAP_UNADAPTED_DEFAULT_COMPENSATION
} from "../../shaders/tonemap_sdr.js";
import {
  tonemapHdrWgsl,
  TONEMAP_HDR_PEAK_NITS_DEFAULT,
  TONEMAP_HDR_PAPER_WHITE_NITS_DEFAULT
} from "../../shaders/tonemap_hdr.js";
import {
  finalOutputBindingPlan,
  type FinalOutputShaderOptions
} from "../../shaders/final_output_input.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";

export interface FinalOutputJob {
  readonly lift: number;
  readonly gamma: number;
  readonly gain: number;
  readonly saturation: number;
  readonly contrast: number;
  readonly sharpeningStrength: number;
  readonly bloomIntensity: number;
  readonly samplers: GPUSamplerCache;
}

export const TONEMAP_STEPS = [
  "detect #Go matchMedia (dynamic-range: high)",
  "fuse optional Bloom composite + Color Grading + Sharpen into Final Output",
  "SDR: exposure * ACES * sRGB + triangle dither",
  "HDR: exposure * tonemap_gt7 * Rec709→2020→P3 * sRGB encode",
  "write display-p3 canvas / swapchain",
  "rebuild cached target descriptors when rgba16float/preferred format changes"
] as const;

export class TonemapPass {
  private canvasFormat: GPUTextureFormat;
  private readonly pipelines = new Map<string, CachedRenderPipelineDescriptor>();
  private readonly validFrameControl: GPUBuffer;

  exposureCompensation = TONEMAP_UNADAPTED_DEFAULT_COMPENSATION;

  exposureValueOverride: number | null = null;

  hdrEnabled = false;

  peakNits = 80;
  paperWhiteNits = TONEMAP_HDR_PAPER_WHITE_NITS_DEFAULT;

  lastRan = false;
  lastExposureValue = 0;
  lastUsedHdr = false;
  lastPeakNits = 0;
  lastBloomFused = false;
  lastColorGradingFused = false;
  lastSharpeningFused = false;

  constructor(private readonly device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.canvasFormat = canvasFormat;
    this.validFrameControl = device.createBuffer({
      label: "Tonemap/valid frame-control fallback",
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(this.validFrameControl, 0, new Uint32Array(8));
  }

  get exposureValue(): number {
    if (this.exposureValueOverride !== null) return this.exposureValueOverride;
    return 1 + this.exposureCompensation;
  }

  set exposureValue(v: number) {
    this.exposureValueOverride = v;
  }

  setCanvasFormat(format: GPUTextureFormat): void {
    if (this.canvasFormat === format) return;
    this.canvasFormat = format;
    this.pipelines.clear();
  }

  init(): void {}

  addToGraph(
    graph: FrameGraph,
    resourceIds: {
      swapchain: ResourceId;
      hdr: ResourceId;
      bloom?: ResourceId;
      exposure?: ResourceId;
      /** GPU-authored correctness signal; invalid frames present diagnostic magenta. */
      diagnosticControl?: ResourceId;
    },
    options: FinalOutputShaderOptions,
    job: FinalOutputJob
  ): void {
    const self = this;
    const label = this.hdrEnabled ? "Final Output HDR" : "Final Output SDR";
    const builder = graph.add(label, job, (data, res, ctx) => {
      const command = requireShadeCommandContext(ctx.encoder);
      self.executeCommand(
        command,
        {
          swapchain: resolveTextureView(res.get(resourceIds.swapchain)),
          hdr: resolveTextureView(res.get(resourceIds.hdr)),
          bloom: resourceIds.bloom === undefined
            ? undefined
            : resolveTextureView(res.get(resourceIds.bloom))
        },
        options,
        data,
        resourceIds.exposure === undefined
          ? undefined
          : resolveBuffer(res.get(resourceIds.exposure), "exposure"),
        resourceIds.diagnosticControl === undefined
          ? undefined
          : resolveBuffer(res.get(resourceIds.diagnosticControl), "diagnostic control")
      );
    });
    builder.read(resourceIds.hdr);
    if (resourceIds.bloom !== undefined) builder.read(resourceIds.bloom);
    if (resourceIds.exposure !== undefined) builder.read(resourceIds.exposure);
    if (resourceIds.diagnosticControl !== undefined) {
      builder.read(resourceIds.diagnosticControl);
    }
    builder.write(resourceIds.swapchain);
  }

  execute(
    command: ShadeGPUCommandContext,
    views: { swapchain: GPUTextureView; hdr: GPUTextureView; bloom?: GPUTextureView },
    options: FinalOutputShaderOptions,
    job: FinalOutputJob,
    externalExposure?: GPUBuffer,
    diagnosticControl?: GPUBuffer
  ): void {
    this.executeCommand(
      command,
      views,
      options,
      job,
      externalExposure,
      diagnosticControl
    );
  }

  private executeCommand(
    command: ShadeGPUCommandContext,
    views: { swapchain: GPUTextureView; hdr: GPUTextureView; bloom?: GPUTextureView },
    options: FinalOutputShaderOptions,
    job: FinalOutputJob,
    externalExposure?: GPUBuffer,
    diagnosticControl?: GPUBuffer
  ): void {
    if (options.bloom !== (views.bloom !== undefined)) {
      throw new Error("TonemapPass Bloom specialization does not match its bindings");
    }

    this.lastRan = false;
    this.lastUsedHdr = this.hdrEnabled;
    let exposureBuffer = externalExposure;
    if (!exposureBuffer) {
      const value = this.exposureValue;
      this.lastExposureValue = value;
      exposureBuffer = command.allocateTransientBufferAndLoad(
        new Float32Array([value]).buffer,
        GPUBufferUsage.UNIFORM
      );
    }

    const useHdr = this.hdrEnabled;
    const pipeline = this.obtainPipeline(useHdr, options);
    const label = useHdr ? "Final Output HDR" : "Final Output SDR";
    const bindings: GPUBindingResource[] = [views.hdr];
    if (options.bloom) {
      bindings.push(
        views.bloom!,
        job.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR)
      );
    }
    if (options.bloom || options.sharpening || options.colorGrading) {
      const uniform = new Float32Array(16);
      uniform[0] = uniform[1] = uniform[2] = job.lift;
      uniform[4] = uniform[5] = uniform[6] = job.gamma;
      uniform[8] = uniform[9] = uniform[10] = job.gain;
      uniform[11] = job.saturation;
      uniform[12] = job.contrast;
      uniform[13] = job.sharpeningStrength;
      uniform[14] = job.bloomIntensity;
      bindings.push({
        buffer: command.allocateTransientBufferAndLoad(
          uniform.buffer,
          GPUBufferUsage.UNIFORM
        )
      });
    }
    if (useHdr) {
      this.lastPeakNits = this.peakNits;
      const settingsBuffer = command.allocateTransientBufferAndLoad(
        new Float32Array([this.peakNits, this.paperWhiteNits, 0, 0]).buffer,
        GPUBufferUsage.UNIFORM
      );
      bindings.push({ buffer: settingsBuffer });
    }
    bindings.push({ buffer: exposureBuffer });
    bindings.push({ buffer: diagnosticControl ?? this.validFrameControl });

    const pass = command.constructRenderPass({
      label,
      pipeline,
      bindings: [bindings],
      colorAttachments: [
        {
          view: views.swapchain,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3);
    pass.end();
    this.lastRan = true;
    this.lastBloomFused = options.bloom;
    this.lastColorGradingFused = options.colorGrading;
    this.lastSharpeningFused = options.sharpening;
  }

  private obtainPipeline(
    hdr: boolean,
    options: FinalOutputShaderOptions
  ): CachedRenderPipelineDescriptor {
    const key = `${hdr ? "hdr" : "sdr"}:${options.bloom ? 1 : 0}:${options.sharpening ? 1 : 0}:${options.colorGrading ? 1 : 0}`;
    let pipeline = this.pipelines.get(key);
    if (pipeline !== undefined) return pipeline;
    pipeline = createTonemapPipelineDescriptor(
      hdr ? "FinalOutput/HDR" : "FinalOutput/SDR",
      hdr ? tonemapHdrWgsl(options) : tonemapSdrWgsl(options),
      this.canvasFormat,
      createFinalOutputGroupLayout(options, hdr)
    );
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  destroy(): void {
    this.pipelines.clear();
    this.validFrameControl.destroy();
  }
}

function createTonemapPipelineDescriptor(
  label: string,
  code: string,
  targetFormat: GPUTextureFormat,
  group0: GPUBindGroupLayoutDescriptor
): CachedRenderPipelineDescriptor {
  const module = { label, code };
  return {
    label,
    layout: {
      label: `${label} layout`,
      bindGroupLayouts: [group0]
    },
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format: targetFormat }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" }
  };
}

function createFinalOutputGroupLayout(
  options: FinalOutputShaderOptions,
  hdr: boolean
): GPUBindGroupLayoutDescriptor {
  const plan = finalOutputBindingPlan(options);
  const entries: GPUBindGroupLayoutEntry[] = [{
    binding: plan.source,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType: "float", viewDimension: "2d" }
  }];
  if (plan.bloom !== null && plan.sampler !== null) {
    entries.push(
      {
        binding: plan.bloom,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: plan.sampler,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" }
      }
    );
  }
  if (plan.effects !== null) {
    entries.push({
      binding: plan.effects,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    });
  }
  let next = plan.next;
  if (hdr) {
    entries.push({
      binding: next++,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    });
  }
  entries.push(
    {
      binding: next++,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    },
    {
      binding: next,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "storage" }
    }
  );
  return {
    label: `FinalOutput/${hdr ? "HDR" : "SDR"} group0`,
    entries
  };
}

function resolveBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object") {
    if ("size" in resource && "usage" in resource) return resource as GPUBuffer;
    if ("buffer" in resource) {
      const buffer = (resource as { buffer?: unknown }).buffer;
      if (buffer && typeof buffer === "object" && "size" in buffer) {
        return buffer as GPUBuffer;
      }
    }
  }
  throw new Error(`TonemapPass: ${label} is not a GPUBuffer`);
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
  throw new Error("TonemapPass: cached $h/qh require ShadeGPUCommandContext");
}

export function detectHighDynamicRange(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(dynamic-range: high)").matches;
  } catch {
    return false;
  }
}

export function peakNitsForHdr(hdr: boolean): number {
  return hdr ? TONEMAP_HDR_PEAK_NITS_DEFAULT : 80;
}
