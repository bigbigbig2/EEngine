import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { Fsr3PrepareInputsPass } from "./Fsr3PrepareInputsPass.js";
import { Fsr3LumaPyramidPass } from "./Fsr3LumaPyramidPass.js";
import { Fsr3ShadingChangePyramidPass } from "./Fsr3ShadingChangePyramidPass.js";
import { Fsr3ShadingChangePass } from "./Fsr3ShadingChangePass.js";
import { Fsr3PrepareReactivityPass } from "./Fsr3PrepareReactivityPass.js";
import { Fsr3LumaInstabilityPass } from "./Fsr3LumaInstabilityPass.js";
import { Fsr3AccumulatePass } from "./Fsr3AccumulatePass.js";
import { Fsr3RcasPass, packFsr3RcasConstants } from "./Fsr3RcasPass.js";
import { FSR3_UPSCALER_CONSTANTS_BYTES, packFsr3UpscalerConstants } from "./Fsr3UpscalerConstants.js";

// P_t and P_(t-1) remain on the GPU. The SDK constant is updated before any
// FSR stage reads it, in the same frame command encoder.
export const FSR3_PRE_EXPOSURE_RATIO_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> current_exposure:array<f32>;
@group(0) @binding(1) var<storage, read> prior_exposure:array<f32>;
@group(0) @binding(2) var<storage, read_write> constants:array<u32>;
@group(0) @binding(3) var<uniform> history_valid:u32;
@compute @workgroup_size(1)
fn main() {
  let current=current_exposure[0];
  let prior=prior_exposure[0];
  let valid=history_valid!=0u && current>0.0 && prior>0.0 &&
    current<1e6 && prior<1e6;
  constants[29]=bitcast<u32>(select(1.0,clamp(current/prior,1e-4,1e4),valid));
}
`;

interface Fsr3HistoryTextures {
  readonly color: [GPUTexture, GPUTexture];
  readonly luma: [GPUTexture, GPUTexture];
  readonly lumaHistory: [GPUTexture, GPUTexture];
  readonly accumulation: [GPUTexture, GPUTexture];
  readonly frameInfo: [GPUTexture, GPUTexture];
}

export interface Fsr3FrameInput {
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly jitter: readonly [number, number];
  readonly cameraNear: number;
  readonly cameraFar: number;
  readonly cameraFovY: number;
  readonly cameraInfiniteFar: boolean;
  readonly frameTimeMs: number;
  readonly reset: boolean;
  /** TemporalFabric's committed physical color role; supplied by production. */
  readonly historyReadIndex?: 0 | 1;
}

/** Resolve physical resources from the active frame, never from graph creation. */
export type Fsr3GraphResourceBinder = <T extends object>(
  name: string,
  resolve: (runtime: Fsr3UpscalerRuntime) => T,
) => T;

/** One FSR3 Upscaler owner and one graph chain inside the Renderer frame submit. */
export class Fsr3UpscalerRuntime {
  private readonly prepareInputs: Fsr3PrepareInputsPass;
  private readonly lumaPyramid: Fsr3LumaPyramidPass;
  private readonly shadingPyramid: Fsr3ShadingChangePyramidPass;
  private readonly shadingChange: Fsr3ShadingChangePass;
  private readonly prepareReactivity: Fsr3PrepareReactivityPass;
  private readonly lumaInstability: Fsr3LumaInstabilityPass;
  private readonly accumulate: Fsr3AccumulatePass;
  private readonly rcas: Fsr3RcasPass;
  private readonly constants: GPUBuffer;
  private readonly ratioLayout: GPUBindGroupLayout;
  private readonly ratioPipeline: GPUComputePipeline;
  private readonly rcasConstants: GPUBuffer;
  private readonly defaultMask: GPUTexture;
  private histories: Fsr3HistoryTextures | null = null;
  private lastSubmittedGpuDone: Promise<void> | null = null;
  private size: readonly [number, number, number, number] = [0, 0, 0, 0];
  /** Physical internal history extent; active render extent may shrink inside it. */
  private internalCapacity: readonly [number, number] = [0, 0];
  private index: 0 | 1 = 0;
  private generationValue = 0;
  private frameIndex = -1;
  private previousJitter: readonly [number, number] = [0, 0];
  private pending: { jitter: readonly [number, number]; frameIndex: number } | null = null;

  constructor(private readonly device: GPUDevice) {
    this.prepareInputs = new Fsr3PrepareInputsPass(device);
    this.lumaPyramid = new Fsr3LumaPyramidPass(device);
    this.shadingPyramid = new Fsr3ShadingChangePyramidPass(device);
    this.shadingChange = new Fsr3ShadingChangePass(device);
    this.prepareReactivity = new Fsr3PrepareReactivityPass(device);
    this.lumaInstability = new Fsr3LumaInstabilityPass(device);
    this.accumulate = new Fsr3AccumulatePass(device);
    this.rcas = new Fsr3RcasPass(device);
    this.constants = device.createBuffer({
      label: "FSR3 Upscaler constants",
      size: FSR3_UPSCALER_CONSTANTS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.ratioLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    this.ratioPipeline = device.createComputePipeline({
      label: "FSR3/GPU pre-exposure ratio",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.ratioLayout] }),
      compute: {
        module: device.createShaderModule({ code: FSR3_PRE_EXPOSURE_RATIO_WGSL }),
        entryPoint: "main",
      },
    });
    this.rcasConstants = device.createBuffer({
      label: "FSR3 RCAS constants",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.defaultMask = device.createTexture({
      label: "FSR3 default zero mask",
      size: [1, 1],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    device.queue.writeBuffer(this.rcasConstants, 0, packFsr3RcasConstants(0.2));
  }

  get generation(): number {
    return this.generationValue;
  }
  get readIndex(): 0 | 1 {
    return this.index;
  }
  get writeIndex(): 0 | 1 {
    return (1 - this.index) as 0 | 1;
  }

  canRetainHistory(
    renderWidth: number,
    renderHeight: number,
    outputWidth: number,
    outputHeight: number,
  ): boolean {
    return (
      this.histories !== null &&
      renderWidth <= this.internalCapacity[0] &&
      renderHeight <= this.internalCapacity[1] &&
      outputWidth === this.size[2] &&
      outputHeight === this.size[3]
    );
  }

  /** CPU-known shape check before a cached graph binds this frame's histories. */
  assertPreparedFrame(
    renderWidth: number,
    renderHeight: number,
    outputWidth: number,
    outputHeight: number,
  ): void {
    if (
      !this.pending ||
      !this.histories ||
      this.size[0] !== renderWidth ||
      this.size[1] !== renderHeight ||
      this.size[2] !== outputWidth ||
      this.size[3] !== outputHeight
    ) {
      throw new Error("FSR3 prepared frame does not match the Frame Program domain");
    }
    for (const [name, pair] of Object.entries(this.histories) as [
      keyof Fsr3HistoryTextures,
      [GPUTexture, GPUTexture],
    ][]) {
      if (pair[0] === pair[1]) throw new Error(`FSR3 ${name} read/write history aliases`);
      const width = name === "color" ? outputWidth : name === "frameInfo" ? 1 : this.internalCapacity[0];
      const height = name === "color" ? outputHeight : name === "frameInfo" ? 1 : this.internalCapacity[1];
      const format: GPUTextureFormat =
        name === "color" || name === "lumaHistory"
          ? "rgba16float"
          : name === "luma"
            ? "r16float"
            : name === "accumulation"
              ? "r8unorm"
              : "rgba32float";
      if (
        pair.some(
          (texture) => texture.width !== width || texture.height !== height || texture.format !== format,
        )
      ) {
        throw new Error(`FSR3 ${name} history descriptor changed`);
      }
    }
  }

  prepareFrame(command: ShadeGPUCommandContext, frame: Fsr3FrameInput): void {
    if (this.pending) throw new Error("FSR3 frame already prepared");
    const size = [frame.renderWidth, frame.renderHeight, frame.outputWidth, frame.outputHeight] as const;
    const previousSize = this.size;
    const capacityExceeded =
      frame.renderWidth > this.internalCapacity[0] || frame.renderHeight > this.internalCapacity[1];
    const outputChanged = frame.outputWidth !== previousSize[2] || frame.outputHeight !== previousSize[3];
    if (capacityExceeded || outputChanged || frame.reset || this.histories === null) this.allocate(size);
    else this.size = size;
    if (frame.historyReadIndex !== undefined) {
      if (
        !capacityExceeded &&
        !outputChanged &&
        !frame.reset &&
        this.frameIndex >= 0 &&
        this.index !== frame.historyReadIndex
      ) {
        throw new Error("FSR3 color history role differs from TemporalFabric");
      }
      this.index = frame.historyReadIndex;
    }
    if (
      !Number.isFinite(frame.cameraNear) ||
      frame.cameraNear <= 0 ||
      !Number.isFinite(frame.cameraFovY) ||
      frame.cameraFovY <= 0
    ) {
      throw new RangeError("FSR3 requires finite perspective camera near and vertical FOV");
    }
    const [width, height, outputWidth, outputHeight] = size;
    // Projection[8]/[9] offsets clip space. Perspective division and the
    // viewport Y flip make the actual screen displacement -jitter/2 pixels.
    const jitter: readonly [number, number] = [-frame.jitter[0] * 0.5, -frame.jitter[1] * 0.5];
    const previousJitter = this.frameIndex < 0 ? ([0, 0] as const) : this.previousJitter;
    const near = Math.min(frame.cameraNear, frame.cameraFar);
    const far = Math.max(frame.cameraNear, frame.cameraFar);
    const q = near / (far - near);
    const depthFactors: readonly [number, number, number, number] = frame.cameraInfiniteFar
      ? [
          -1.1920928955078125e-7,
          near,
          (Math.tan(frame.cameraFovY / 2) * width) / height,
          Math.tan(frame.cameraFovY / 2),
        ]
      : [-q, q * far, (Math.tan(frame.cameraFovY / 2) * width) / height, Math.tan(frame.cameraFovY / 2)];
    const phaseCount = Math.max(1, Math.trunc(8 * (outputWidth / width) ** 2));
    const nextFrameIndex = this.frameIndex + 1;
    const constants = packFsr3UpscalerConstants({
      renderSize: [width, height],
      previousFrameRenderSize: this.frameIndex < 0 ? [width, height] : [previousSize[0], previousSize[1]],
      upscaleSize: [outputWidth, outputHeight],
      previousFrameUpscaleSize:
        this.frameIndex < 0 ? [outputWidth, outputHeight] : [previousSize[2], previousSize[3]],
      maxRenderSize: this.internalCapacity,
      maxUpscaleSize: [outputWidth, outputHeight],
      deviceToViewDepth: depthFactors,
      jitterOffset: jitter,
      previousFrameJitterOffset: previousJitter,
      // Surface motion is current-minus-previous in UV; the SDK expects the
      // opposite sign. The input shader has the jittered-mv permutation.
      motionVectorScale: [-1, -1],
      downscaleFactor: [width / outputWidth, height / outputHeight],
      motionVectorJitterCancellation: [
        (previousJitter[0] - jitter[0]) / width,
        (previousJitter[1] - jitter[1]) / height,
      ],
      tanHalfFOV: (Math.tan(frame.cameraFovY / 2) * width) / height,
      jitterPhaseCount: phaseCount,
      deltaTime: Math.max(0, Math.min(1, frame.frameTimeMs / 1000)),
      // GPU ratio pass overwrites this field before any FSR stage consumes it.
      deltaPreExposure: 1,
      viewSpaceToMetersFactor: 1,
      frameIndex: nextFrameIndex,
      velocityFactor: 1,
      reactivenessScale: 1,
      shadingChangeScale: 1,
      accumulationAddedPerFrame: 1 / 3,
      minDisocclusionAccumulation: -1 / 3,
    });
    command.writeBuffer(this.constants, 0, constants, 0, constants.byteLength);
    this.pending = { jitter, frameIndex: nextFrameIndex };
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      color: ResourceId;
      depth: ResourceId;
      motion: ResourceId;
      reactiveMask: ResourceId;
      validityMask: ResourceId;
      preExposure: ResourceId;
      priorExposure: ResourceId;
      width: number;
      height: number;
      outputWidth: number;
      outputHeight: number;
      /** Diagnostic profile used by the validation Perf Host only. */
      enabled?: boolean;
    },
    bind: Fsr3GraphResourceBinder,
  ): ResourceId {
    if (!this.histories || !this.pending) throw new Error("FSR3 frame must be prepared before graph build");
    if (input.enabled === false) {
      if (input.width !== input.outputWidth || input.height !== input.outputHeight) {
        throw new Error("FSR3 bypass requires equal internal and output extents");
      }
      return input.color;
    }
    const imported = (
      name: string,
      resolve: (runtime: Fsr3UpscalerRuntime) => GPUTexture,
      domain?: "internal-full" | "output-full",
    ) =>
      graph.import_resource(
        name,
        { kind: "imported", label: name, ...(domain ? { domain } : {}) },
        bind(name, resolve),
      );
    const importedConstants = graph.import_resource(
      "FSR3/constants",
      { kind: "imported", label: "FSR3 constants" },
      bind("constants", (runtime) => runtime.constants),
    );
    const ratio = graph.add("FSR3/GPU pre-exposure ratio", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const valid = command.allocateTransientBufferAndLoad(
        new Uint32Array([this.frameIndex >= 0 ? 1 : 0]).buffer,
        GPUBufferUsage.UNIFORM,
      );
      const group = this.device.createBindGroup({
        layout: this.ratioLayout,
        entries: [
          { binding: 0, resource: { buffer: resources.get(input.preExposure) as GPUBuffer } },
          { binding: 1, resource: { buffer: resources.get(input.priorExposure) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(importedConstants) as GPUBuffer } },
          { binding: 3, resource: { buffer: valid } },
        ],
      });
      const pass = command.beginComputePass({ label: "FSR3/GPU pre-exposure ratio" });
      pass.setPipeline(this.ratioPipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    ratio.read(input.preExposure);
    ratio.read(input.priorExposure);
    const constants = ratio.write(importedConstants);
    const rcasConstants = graph.import_resource(
      "FSR3/RCAS constants",
      { kind: "imported", label: "FSR3 RCAS constants" },
      bind("rcas-constants", (runtime) => runtime.rcasConstants),
    );
    const defaultMask = imported("FSR3/default mask", (runtime) => runtime.defaultMask);
    const previousColor = imported(
      "FSR3/previous color",
      (runtime) => runtime.graphHistory("color", "read"),
      "output-full",
    );
    const currentColor = imported(
      "FSR3/current color",
      (runtime) => runtime.graphHistory("color", "write"),
      "output-full",
    );
    const previousLuma = imported(
      "FSR3/previous luma",
      (runtime) => runtime.graphHistory("luma", "read"),
      "internal-full",
    );
    const currentLuma = imported(
      "FSR3/current luma",
      (runtime) => runtime.graphHistory("luma", "write"),
      "internal-full",
    );
    const previousLumaHistory = imported(
      "FSR3/previous luma history",
      (runtime) => runtime.graphHistory("lumaHistory", "read"),
      "internal-full",
    );
    const currentLumaHistory = imported(
      "FSR3/current luma history",
      (runtime) => runtime.graphHistory("lumaHistory", "write"),
      "internal-full",
    );
    const previousAccumulation = imported(
      "FSR3/previous accumulation",
      (runtime) => runtime.graphHistory("accumulation", "read"),
      "internal-full",
    );
    const currentAccumulation = imported(
      "FSR3/current accumulation",
      (runtime) => runtime.graphHistory("accumulation", "write"),
      "internal-full",
    );
    const previousFrameInfo = imported("FSR3/previous frame info", (runtime) =>
      runtime.graphHistory("frameInfo", "read"),
    );
    const currentFrameInfo = imported("FSR3/current frame info", (runtime) =>
      runtime.graphHistory("frameInfo", "write"),
    );
    const prepared = this.prepareInputs.addToGraph(graph, {
      color: input.color,
      depth: input.depth,
      motion: input.motion,
      validityMask: input.validityMask,
      constants,
      currentLuma,
      width: input.width,
      height: input.height,
    });
    const luma = this.lumaPyramid.addToGraph(graph, {
      currentLuma: prepared.currentLuma,
      farthestDepth: prepared.farthestDepth,
      constants,
      previousFrameInfo,
      currentFrameInfo,
      width: input.width,
      height: input.height,
    });
    const spdMips = this.shadingPyramid.addToGraph(graph, {
      dilatedMotion: prepared.dilatedMotion,
      currentLuma: prepared.currentLuma,
      previousLuma,
      exposure: luma.frameInfo,
      constants,
      width: input.width,
      height: input.height,
    });
    const shadingChange = this.shadingChange.addToGraph(graph, {
      spdMips,
      constants,
      width: input.width,
      height: input.height,
    });
    const reactivity = this.prepareReactivity.addToGraph(graph, {
      reconstructedDepth: prepared.reconstructedDepth,
      dilatedMotion: prepared.dilatedMotion,
      dilatedDepth: prepared.dilatedDepth,
      reactiveMask: input.reactiveMask,
      transparencyMask: defaultMask,
      previousAccumulation,
      currentAccumulation,
      shadingChange,
      currentLuma: prepared.currentLuma,
      exposure: luma.frameInfo,
      constants,
      width: input.width,
      height: input.height,
      outputWidth: input.outputWidth,
      outputHeight: input.outputHeight,
    });
    const instability = this.lumaInstability.addToGraph(graph, {
      dilatedMotion: prepared.dilatedMotion,
      dilatedReactive: reactivity.masks,
      currentLuma: prepared.currentLuma,
      previousHistory: previousLumaHistory,
      currentHistory: currentLumaHistory,
      farthestDepthMip1: luma.farthestDepthMip1,
      exposure: luma.frameInfo,
      constants,
      width: input.width,
      height: input.height,
    });
    const accumulated = this.accumulate.addToGraph(graph, {
      color: input.color,
      dilatedMotion: prepared.dilatedMotion,
      lumaInstability: instability.instability,
      farthestDepthMip1: luma.farthestDepthMip1,
      dilatedReactive: reactivity.masks,
      newLocks: reactivity.newLocks,
      previousHistory: previousColor,
      currentHistory: currentColor,
      exposure: luma.frameInfo,
      constants,
      width: input.outputWidth,
      height: input.outputHeight,
    });
    return this.rcas.addToGraph(graph, {
      color: accumulated.color,
      exposure: luma.frameInfo,
      constants: rcasConstants,
      width: input.outputWidth,
      height: input.outputHeight,
    });
  }

  commit(gpuDone: Promise<void>): void {
    if (!this.pending) throw new Error("FSR3 frame was not prepared");
    this.index = this.writeIndex;
    this.previousJitter = this.pending.jitter;
    this.frameIndex = this.pending.frameIndex;
    this.pending = null;
    this.lastSubmittedGpuDone = gpuDone;
  }

  invalidate(): void {
    this.frameIndex = -1;
    this.pending = null;
  }

  private graphHistory(name: keyof Fsr3HistoryTextures, role: "read" | "write"): GPUTexture {
    if (!this.pending || !this.histories)
      throw new Error("FSR3 history binding requires an active prepared frame");
    return this.histories[name][role === "read" ? this.readIndex : this.writeIndex];
  }

  destroy(): void {
    this.destroyHistories();
    this.constants.destroy();
    this.rcasConstants.destroy();
    this.defaultMask.destroy();
  }

  private allocate(size: readonly [number, number, number, number]): void {
    this.destroyHistories();
    const [width, height, outputWidth, outputHeight] = size;
    if (
      width < 8 ||
      height < 8 ||
      width > this.device.limits.maxTextureDimension2D ||
      height > this.device.limits.maxTextureDimension2D ||
      outputWidth > this.device.limits.maxTextureDimension2D ||
      outputHeight > this.device.limits.maxTextureDimension2D
    ) {
      throw new RangeError("FSR3 render or output dimensions exceed the negotiated WebGPU limits");
    }
    const pair = (label: string, format: GPUTextureFormat, w: number, h: number): [GPUTexture, GPUTexture] =>
      [0, 1].map((index) =>
        this.device.createTexture({
          label: `FSR3/${label}/${index}`,
          size: [w, h],
          format,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.STORAGE_BINDING |
            (label === "frame info" ? GPUTextureUsage.COPY_DST : 0),
        }),
      ) as [GPUTexture, GPUTexture];
    this.histories = {
      color: pair("color", "rgba16float", outputWidth, outputHeight),
      luma: pair("luma", "r16float", width, height),
      lumaHistory: pair("luma history", "rgba16float", width, height),
      accumulation: pair("accumulation", "r8unorm", width, height),
      frameInfo: pair("frame info", "rgba32float", 1, 1),
    };
    for (const texture of this.histories.frameInfo) {
      this.device.queue.writeTexture(
        { texture },
        new Float32Array([-1, 1, 0, 0]),
        { bytesPerRow: 16 },
        [1, 1],
      );
    }
    this.size = size;
    this.internalCapacity = [width, height];
    this.index = 0;
    this.frameIndex = -1;
    this.previousJitter = [0, 0];
    this.generationValue++;
  }

  private destroyHistories(): void {
    if (!this.histories) return;
    const histories = this.histories;
    this.histories = null;
    const destroy = (): void => {
      for (const pair of Object.values(histories)) for (const texture of pair) texture.destroy();
    };
    const gpuDone = this.lastSubmittedGpuDone;
    if (gpuDone) void gpuDone.then(destroy, destroy);
    else destroy();
  }
}
