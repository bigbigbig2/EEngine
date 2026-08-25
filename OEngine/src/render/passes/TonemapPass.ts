/**
 * TonemapPass：实现渲染管线中的独立渲染阶段。
 */

import {
  TONEMAP_SDR_WGSL,
  TONEMAP_UNADAPTED_DEFAULT_COMPENSATION
} from "../../shaders/tonemap_sdr.js";
import {
  TONEMAP_HDR_WGSL,
  TONEMAP_HDR_PEAK_NITS_DEFAULT,
  TONEMAP_HDR_PAPER_WHITE_NITS_DEFAULT
} from "../../shaders/tonemap_hdr.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

export const TONEMAP_STEPS = [
  "detect #Go matchMedia (dynamic-range: high)",
  "SDR $h: exposure * ACES * sRGB + triangle dither",
  "HDR qh: exposure * tonemap_gt7 * Rec709→2020→P3 * sRGB encode",
  "write display-p3 canvas / swapchain",
  "rebuild cached target descriptors when rgba16float/preferred format changes"
] as const;

export class TonemapPass {
  private canvasFormat: GPUTextureFormat;
  private sdrPipeline: CachedRenderPipelineDescriptor | null = null;
  private hdrPipeline: CachedRenderPipelineDescriptor | null = null;

  exposureCompensation = TONEMAP_UNADAPTED_DEFAULT_COMPENSATION;

  exposureValueOverride: number | null = null;

  hdrEnabled = false;

  peakNits = 80;
  paperWhiteNits = TONEMAP_HDR_PAPER_WHITE_NITS_DEFAULT;

  lastRan = false;
  lastExposureValue = 0;
  lastUsedHdr = false;
  lastPeakNits = 0;

  constructor(_device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.canvasFormat = canvasFormat;
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
    this.rebuildPipelines();
  }

  init(): void {
    this.rebuildPipelines();
  }

  private rebuildPipelines(): void {
    this.sdrPipeline = createTonemapPipelineDescriptor(
      "TonemapPass/$h",
      TONEMAP_SDR_WGSL,
      this.canvasFormat,
      createSdrGroupLayout()
    );
    this.hdrPipeline = createTonemapPipelineDescriptor(
      "TonemapPass/qh",
      TONEMAP_HDR_WGSL,
      this.canvasFormat,
      createHdrGroupLayout()
    );
  }

  addToGraph(
    graph: FrameGraph,
    resourceIds: {
      swapchain: ResourceId;
      hdr: ResourceId;
      exposure?: ResourceId;
    }
  ): void {
    const self = this;
    const label = this.hdrEnabled ? "Tonemap qh" : "Tonemap $h";
    const builder = graph.add(label, {}, (_data, res, ctx) => {
      const command = requireShadeCommandContext(ctx.encoder);
      self.executeCommand(
        command,
        {
          swapchain: resolveTextureView(res.get(resourceIds.swapchain)),
          hdr: resolveTextureView(res.get(resourceIds.hdr))
        },
        resourceIds.exposure === undefined
          ? undefined
          : resolveBuffer(res.get(resourceIds.exposure), "exposure")
      );
    });
    builder.read(resourceIds.hdr);
    if (resourceIds.exposure !== undefined) builder.read(resourceIds.exposure);
    builder.write(resourceIds.swapchain);
  }

  execute(
    command: ShadeGPUCommandContext,
    views: { swapchain: GPUTextureView; hdr: GPUTextureView },
    externalExposure?: GPUBuffer
  ): void {
    this.executeCommand(command, views, externalExposure);
  }

  private executeCommand(
    command: ShadeGPUCommandContext,
    views: { swapchain: GPUTextureView; hdr: GPUTextureView },
    externalExposure?: GPUBuffer
  ): void {
    if (!this.sdrPipeline || !this.hdrPipeline) {
      throw new Error("TonemapPass not init");
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
    const pipeline = useHdr ? this.hdrPipeline : this.sdrPipeline;
    const label = useHdr ? "Tonemap qh" : "Tonemap $h";
    const bindings: GPUBindingResource[] = [views.hdr];
    if (useHdr) {
      this.lastPeakNits = this.peakNits;
      const settingsBuffer = command.allocateTransientBufferAndLoad(
        new Float32Array([this.peakNits, this.paperWhiteNits, 0, 0]).buffer,
        GPUBufferUsage.UNIFORM
      );
      bindings.push({ buffer: settingsBuffer });
    }
    bindings.push({ buffer: exposureBuffer });

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
  }

  destroy(): void {
    this.sdrPipeline = null;
    this.hdrPipeline = null;
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

function createSdrGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "TonemapPass/$h group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
      }
    ]
  };
}

function createHdrGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "TonemapPass/qh group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
      }
    ]
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
