import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { NativeTemporalSeed } from "./NativeTemporalSeed.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { Fsr3RcasPass, packFsr3RcasConstants } from "../passes/fsr3/Fsr3RcasPass.js";
import {
  NATIVE_TEMPORAL_V2_MEASURE_WGSL,
  NATIVE_TEMPORAL_V2_EXPOSURE_WGSL,
  NATIVE_TEMPORAL_V2_ANALYZE_WGSL,
  NATIVE_TEMPORAL_V2_SHADING_PYRAMID_WGSL,
  NATIVE_TEMPORAL_V2_RESOLVE_WGSL,
} from "../../shaders/native_temporal_amd.js";

interface NativeHistories {
  readonly width: number;
  readonly height: number;
  readonly color: readonly [GPUTexture, GPUTexture];
  readonly depth: readonly [GPUTexture, GPUTexture];
  readonly luma: readonly [GPUTexture, GPUTexture];
  readonly lumaHistory: readonly [GPUTexture, GPUTexture];
  readonly confidence: readonly [GPUTexture, GPUTexture];
  readonly frameInfo: readonly [GPUTexture, GPUTexture];
}

export interface NativeTemporalV2Frame {
  readonly width: number;
  readonly height: number;
  readonly jitter: readonly [number, number];
  readonly reset: boolean;
  readonly frameTimeMs?: number;
  readonly cameraFar?: number;
  readonly cameraInfiniteFar?: boolean;
  readonly historyReadIndex?: 0 | 1;
}

export interface NativeTemporalV2Input {
  readonly color: ResourceId;
  readonly seed: ResourceId;
  readonly response: ResourceId;
  readonly identity: ResourceId;
  readonly previousIdentity: ResourceId;
  readonly preExposure: ResourceId;
  readonly priorExposure: ResourceId;
  readonly width: number;
  readonly height: number;
}

type Binder = <T extends object>(name: string, resolve: (owner: NativeTemporalV2) => T) => T;
interface Pipeline {
  readonly pipeline: GPUComputePipeline;
  readonly layout: GPUBindGroupLayout;
}

/** AMD SDK 1.1.4-based native 1:1 reconstruction owner. Color, luma, confidence, exposure and raw depth move together only after successful submit.
 * Identity and camera are provided by Seed on that same command transaction.
 * Queue-ordered ping-pong supports three in-flight submissions; the last-use
 * fence owns resize/abort/destroy retirement. */
export class NativeTemporalV2 {
  private readonly groups = new GpuBindGroupCache();
  private readonly measure: Pipeline;
  private readonly exposure: Pipeline;
  private readonly analyze: Pipeline;
  private readonly shadingPyramid: Pipeline;
  private readonly resolve: Pipeline;
  private readonly rcas: Fsr3RcasPass;
  private readonly constants: GPUBuffer;
  private readonly weights: GPUBuffer;
  private readonly rcasConstants: GPUBuffer;
  private readonly rcasExposure: GPUTexture;
  private readonly sampler: GPUSampler;
  private active: NativeHistories | null = null;
  private candidate: NativeHistories | null = null;
  private pending: NativeTemporalV2Frame | null = null;
  private previousJitter: readonly [number, number] = [0, 0];
  private index: 0 | 1 = 0;
  private pendingIndex: 0 | 1 = 0;
  private valid = false;
  private generationValue = 0;
  private encoded = false;
  private measured = false;
  private exposed = false;
  private analyzed = false;
  private attached: ShadeGPUCommandContext | null = null;
  private seedOwner: NativeTemporalSeed | null = null;
  private lastFence: Promise<void> | null = null;
  private retiredBytes = 0;
  private destroyed = false;
  private permanentLive = true;
  private readonly accountingHandles = new Map<GPUBuffer | GPUTexture, ResourceHandle>();

  constructor(
    private readonly device: GPUDevice,
    private readonly accounting?: ResourceAccounting
  ) {
    if (!device.features.has("texture-formats-tier1")) {
      throw new RangeError("Native Temporal V2 requires the negotiated AMD R16Float/R8Unorm profile");
    }
    if (
      device.limits.maxSampledTexturesPerShaderStage < 11 ||
      device.limits.maxStorageTexturesPerShaderStage < 4 ||
      device.limits.maxComputeWorkgroupStorageSize < 16384 ||
      device.limits.maxComputeInvocationsPerWorkgroup < 256 ||
      device.limits.maxComputeWorkgroupSizeX < 256 ||
      device.limits.maxComputeWorkgroupSizeY < 16
    ) {
      throw new RangeError("Native Temporal V2 requires its complete Analyze/Resolve profile");
    }
    const texture = (
      binding: number,
      sampleType: GPUTextureSampleType = "unfilterable-float",
    ): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, texture: { sampleType } });
    const storage = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { format, access: "write-only" },
    });
    const uniform: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" },
    };
    const buffer = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" },
    });
    const pipeline = (label: string, code: string, entries: GPUBindGroupLayoutEntry[]): Pipeline => {
      const layout = device.createBindGroupLayout({ label, entries });
      return {
        layout,
        pipeline: device.createComputePipeline({
          label,
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: { module: device.createShaderModule({ label, code }), entryPoint: "main" },
        }),
      };
    };
    this.measure = pipeline("Native Temporal V2/Measure", NATIVE_TEMPORAL_V2_MEASURE_WGSL, [
      uniform,
      texture(1),
      storage(2, "r16float"),
      storage(3, "r32float"),
      texture(4),
      storage(5, "r16float"),
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      storage(7, "r32uint"),
    ]);
    this.exposure = pipeline("Native Temporal V2/Exposure", NATIVE_TEMPORAL_V2_EXPOSURE_WGSL, [
      uniform,
      texture(1),
      texture(2),
      storage(3, "rgba32float"),
    ]);
    const filtered = (binding: number): GPUBindGroupLayoutEntry => texture(binding, "float");
    const sampler: GPUBindGroupLayoutEntry = {
      binding: 17,
      visibility: GPUShaderStage.COMPUTE,
      sampler: { type: "filtering" },
    };
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    this.shadingPyramid = pipeline(
      "Native Temporal V2/Shading Pyramid",
      NATIVE_TEMPORAL_V2_SHADING_PYRAMID_WGSL,
      [
        uniform,
        texture(1),
        texture(2),
        texture(3),
        texture(4),
        buffer(5),
        buffer(6),
        texture(7),
        texture(16, "uint"),
        storage(8, "rg16float"),
        storage(9, "rg16float"),
        storage(10, "rg16float"),
      ],
    );
    this.analyze = pipeline("Native Temporal V2/Analyze", NATIVE_TEMPORAL_V2_ANALYZE_WGSL, [
      uniform,
      texture(2),
      texture(4),
      texture(7),
      texture(8, "uint"),
      texture(9, "uint"),
      texture(10),
      storage(11, "rgba8unorm"),
      storage(12, "r32float"),
      filtered(13),
      storage(14, "r32float"),
      storage(15, "r8unorm"),
      texture(16, "uint"),
      filtered(19),
      filtered(20),
      filtered(21),
      sampler,
    ]);
    this.resolve = pipeline("Native Temporal V2/Resolve", NATIVE_TEMPORAL_V2_RESOLVE_WGSL, [
      uniform,
      texture(1),
      texture(2),
      filtered(3),
      texture(4),
      buffer(5),
      storage(6, "rgba16float"),
      buffer(8),
      texture(9),
      filtered(10),
      filtered(11),
      storage(13, "rgba16float"),
      filtered(14),
      sampler,
      { binding: 15, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      texture(16, "uint"),
      texture(18),
    ]);
    this.rcas = new Fsr3RcasPass(device);
    const created: Array<GPUBuffer | GPUTexture> = [];
    try {
      this.weights = device.createBuffer({
        label: "Native Temporal V2/filter weights",
        size: 96,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE,
      });
      created.push(this.weights);
      this.constants = device.createBuffer({
        label: "Native Temporal V2/frame",
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      created.push(this.constants);
      this.rcasConstants = device.createBuffer({
        label: "Native Temporal V2/RCAS constants",
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      created.push(this.rcasConstants);
      device.queue.writeBuffer(this.rcasConstants, 0, packFsr3RcasConstants(0.2));
      this.rcasExposure = device.createTexture({
        label: "Native Temporal V2/Sharpen exposure",
        size: [1, 1],
        format: "r32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });
      created.push(this.rcasExposure);
      this.track(this.weights, "buffer", 96);
      this.track(this.constants, "buffer", 48);
      this.track(this.rcasConstants, "buffer", 16);
      this.track(this.rcasExposure, "texture", 4);
    } catch (error) {
      for (const resource of created) {
        this.releaseResource(resource);
      }
      throw error;
    }
    void device.lost.then(() => this.destroy());
  }

  get generation(): number {
    return this.generationValue;
  }
  get readIndex(): 0 | 1 {
    return this.pending ? this.pendingIndex : this.index;
  }
  get writeIndex(): 0 | 1 {
    return (1 - this.readIndex) as 0 | 1;
  }
  get allocatedBytes(): number {
    return (
      this.retiredBytes +
      (this.permanentLive ? 164 : 0) +
      this.bytes(this.active) +
      (this.candidate !== this.active ? this.bytes(this.candidate) : 0)
    );
  }

  prepareFrame(command: Pick<ShadeGPUCommandContext, "writeBuffer">, frame: NativeTemporalV2Frame): void {
    if (this.destroyed || this.pending) {
      throw new Error("Native Temporal V2 frame is unavailable");
    }
    for (const extent of [frame.width, frame.height]) {
      if (
        !Number.isSafeInteger(extent) ||
        extent < 1 ||
        extent > Math.min(4096, this.device.limits.maxTextureDimension2D) ||
        Math.ceil(extent / 8) > this.device.limits.maxComputeWorkgroupsPerDimension
      ) {
        throw new RangeError("Native Temporal V2 extent exceeds negotiated limits");
      }
    }
    if (
      frame.jitter.length !== 2 ||
      !frame.jitter.every(Number.isFinite) ||
      (frame.historyReadIndex !== undefined && frame.historyReadIndex !== 0 && frame.historyReadIndex !== 1)
    ) {
      throw new RangeError("Native Temporal V2 requires finite jitter and exact history role");
    }
    const reusable = this.active?.width === frame.width && this.active.height === frame.height;
    const valid = reusable && this.valid && !frame.reset;
    if (valid && frame.historyReadIndex !== undefined && frame.historyReadIndex !== this.index) {
      throw new Error("Native Temporal V2 role differs from TemporalFabric");
    }
    const candidate = reusable ? this.active! : this.allocate(frame.width, frame.height);
    const readIndex = frame.historyReadIndex ?? this.index;
    const bytes = new ArrayBuffer(48);
    new Uint32Array(bytes).set([frame.width, frame.height, Number(valid), 0]);
    new Float32Array(bytes).set([...frame.jitter, ...(valid ? this.previousJitter : frame.jitter)], 4);
    const deltaTime = (frame.frameTimeMs ?? 1000 / 60) / 1000;
    const skyDepth = frame.cameraInfiniteFar ? 65504 : Math.min(frame.cameraFar ?? 1000, 65504);
    if (!Number.isFinite(deltaTime) || deltaTime < 0 || !Number.isFinite(skyDepth) || skyDepth <= 0) {
      if (candidate !== this.active) this.retire(candidate, null);
      throw new RangeError("Native Temporal V2 requires finite nonnegative time and a positive sky depth");
    }
    new Float32Array(bytes)[8] = Math.min(1, deltaTime);
    new Float32Array(bytes)[9] = skyDepth;
    try {
      command.writeBuffer(this.constants, 0, bytes, 0, bytes.byteLength);
    } catch (error) {
      if (candidate !== this.active) {
        this.retire(candidate, null);
      }
      throw error;
    }
    this.candidate = candidate;
    this.pending = { ...frame, jitter: [frame.jitter[0], frame.jitter[1]] };
    this.pendingIndex = readIndex;
    this.encoded = false;
  }

  private allocate(width: number, height: number): NativeHistories {
    const created: GPUTexture[] = [];
    const pair = (
      label: string,
      format: GPUTextureFormat,
      pairWidth = width,
      pairHeight = height,
    ): readonly [GPUTexture, GPUTexture] => {
      const create = (index: number): GPUTexture => {
        const texture = this.device.createTexture({
          label: `Native Temporal V2/${label}/${index}`,
          size: [pairWidth, pairHeight],
          format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        created.push(texture);
        const stride =
          format === "rgba32float"
            ? 16
            : format === "rgba16float"
              ? 8
              : format === "r32float"
                ? 4
                : format === "r16float"
                  ? 2
                  : 1;
        this.track(texture, "texture", pairWidth * pairHeight * stride);
        return texture;
      };
      return [create(0), create(1)];
    };
    try {
      return {
        width,
        height,
        color: pair("color", "rgba16float"),
        depth: pair("depth", "r32float"),
        luma: pair("luma", "r16float"),
        lumaHistory: pair("luma history", "rgba16float"),
        confidence: pair("confidence", "r8unorm"),
        frameInfo: pair("frame info", "rgba32float", 1, 1),
      };
    } catch (error) {
      for (const texture of created) {
        this.releaseResource(texture);
      }
      throw error;
    }
  }

  private history(
    name: "color" | "depth" | "luma" | "lumaHistory" | "confidence" | "frameInfo",
    role: "read" | "write",
  ): GPUTexture {
    if (!this.candidate || !this.pending) {
      throw new Error("Native Temporal V2 has no prepared histories");
    }
    return this.candidate[name][role === "read" ? this.readIndex : this.writeIndex];
  }

  /** Bind Seed identity/camera and V2 complete histories to one real submission.
   * Resolve is the physical Seed consumer; no native classifier is required. */
  attach(command: ShadeGPUCommandContext, seedOwner: NativeTemporalSeed): void {
    if (!this.pending || this.attached || command.closed || command.device !== this.device) {
      throw new Error("Native Temporal V2 requires one prepared command on its device");
    }
    seedOwner.assertPreparedFrame(this.pending.width, this.pending.height);
    const seed = seedOwner.frame;
    if (
      seed.historyReadIndex !== this.readIndex ||
      seed.jitter.some((value, axis) => value !== this.pending!.jitter[axis]) ||
      (!seed.previousValid && !this.pending.reset)
    ) {
      throw new Error("Native Temporal V2 and Seed require the same role, jitter and reset transaction");
    }
    seedOwner.attach(command, "native-resolve");
    this.attached = command;
    this.seedOwner = seedOwner;
    command.onBeforeFinish.addOne(() => this.assertCompleteFrame());
    command.onFinished.addOne(() => this.commit(command.gpuDone));
    command.onAborted.addOne(() => this.abort());
  }

  /** Submission validation is called directly by the Renderer, in addition
   * to lifecycle notifications, so a missing writer cannot be swallowed. */
  assertCompleteFrame(): void {
    if (!this.pending || !this.measured || !this.exposed || !this.analyzed || !this.encoded) {
      throw new Error("Native Temporal V2 submission lacks the complete graph");
    }
  }

  addToGraph(graph: FrameGraph, input: NativeTemporalV2Input, bind: Binder): ResourceId {
    if (typeof bind !== "function") {
      throw new TypeError("Native Temporal V2 requires an explicit frame resource binder");
    }
    this.assertPreparedFrame(input.width, input.height);
    const imported = (
      name: string,
      resolve: (owner: NativeTemporalV2) => GPUTexture | GPUBuffer,
    ): ResourceId =>
      graph.import_resource(`Native Temporal V2/${name}`, { kind: "imported" }, bind(name, resolve));
    const constants = imported("frame", (owner) => owner.constants);
    const filterWeights = imported("filter weights", (owner) => owner.weights);
    const previousColor = imported("previous color", (owner) => owner.history("color", "read"));
    const previousDepth = imported("previous depth", (owner) => owner.history("depth", "read"));
    const previousLuma = imported("previous luma", (owner) => owner.history("luma", "read"));
    const previousLumaHistory = imported("previous luma history", (owner) =>
      owner.history("lumaHistory", "read"),
    );
    const previousConfidence = imported("previous confidence", (owner) =>
      owner.history("confidence", "read"),
    );
    const previousInfo = imported("previous frame info", (owner) => owner.history("frameInfo", "read"));
    const currentColor = imported("current color", (owner) => owner.history("color", "write"));
    const currentDepth = imported("current depth", (owner) => owner.history("depth", "write"));
    const currentLuma = imported("current luma", (owner) => owner.history("luma", "write"));
    const currentLumaHistory = imported("current luma history", (owner) =>
      owner.history("lumaHistory", "write"),
    );
    const currentConfidence = imported("current confidence", (owner) => owner.history("confidence", "write"));
    const currentInfo = imported("current frame info", (owner) => owner.history("frameInfo", "write"));
    const sharpenExposure = imported("sharpen exposure", (owner) => owner.rcasExposure);
    type Binding = readonly [number, ResourceId, "buffer" | "texture"];
    const entries = (
      bindings: readonly Binding[],
      resources: { get(id: number): unknown },
    ): GPUBindGroupEntry[] => {
      const result: GPUBindGroupEntry[] = [];
      for (const [binding, id, kind] of bindings) {
        const resource = resources.get(id);
        result.push({
          binding,
          resource: kind === "buffer" ? { buffer: resource as GPUBuffer } : resolveTextureView(resource),
        });
      }
      return result;
    };
    const reads = (pass: ReturnType<FrameGraph["add"]>, bindings: readonly Binding[]): void => {
      for (const [, id] of bindings) {
        pass.read(id);
      }
    };
    const transient = (
      pass: ReturnType<FrameGraph["add"]>,
      name: string,
      format: GPUTextureFormat,
      width = input.width,
      height = input.height,
    ): ResourceId =>
      pass.create(`Native Temporal V2/${name}`, {
        kind: "transient_texture",
        width,
        height,
        format,
        domain: "internal-full",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });
    const commandFor = (context: { encoder: unknown }): ShadeGPUCommandContext => {
      this.assertPreparedFrame(input.width, input.height);
      if (this.attached && context.encoder !== this.attached) {
        throw new Error("Native Temporal V2 requires its current single command");
      }
      return context.encoder as ShadeGPUCommandContext;
    };
    const measureBindings: Binding[] = [
      [0, constants, "buffer"],
      [1, input.color, "texture"],
      [4, input.seed, "texture"],
    ];
    let weightProduct = -1;
    let luma = -1,
      logTiles = -1,
      farthest = -1,
      receivers = -1;
    const measure = graph.add("Native Temporal V2/Measure", {}, (_data, resources, context) => {
      const command = commandFor(context);
      if (this.measured) {
        throw new Error("Native Temporal V2 Measure requires a single writer");
      }
      this.dispatch(
        command,
        this.measure,
        entries(
          [
            ...measureBindings,
            [2, luma, "texture"],
            [3, logTiles, "texture"],
            [5, farthest, "texture"],
            [6, weightProduct, "buffer"],
            [7, receivers, "texture"],
          ],
          resources,
        ),
        input.width,
        input.height,
        64,
      );
      this.measured = true;
    });
    reads(measure, measureBindings);
    weightProduct = measure.write(filterWeights);
    receivers = transient(measure, "color receivers", "r32uint");
    luma = measure.write(currentLuma);
    logTiles = transient(
      measure,
      "log tiles",
      "r32float",
      Math.ceil(input.width / 64),
      Math.ceil(input.height / 64),
    );
    farthest = transient(
      measure,
      "farthest box metric",
      "r16float",
      Math.ceil(input.width / 2),
      Math.ceil(input.height / 2),
    );
    const exposureBindings: Binding[] = [
      [0, constants, "buffer"],
      [1, logTiles, "texture"],
      [2, previousInfo, "texture"],
    ];
    let info = -1;
    const exposure = graph.add("Native Temporal V2/Exposure", {}, (_data, resources, context) => {
      const command = commandFor(context);
      if (!this.measured || this.exposed) {
        throw new Error("Native Temporal V2 exposure requires complete Measure");
      }
      this.dispatch(
        command,
        this.exposure,
        entries([...exposureBindings, [3, info, "texture"]], resources),
        1,
        1,
        1,
      );
      this.exposed = true;
    });
    reads(exposure, exposureBindings);
    info = exposure.write(currentInfo);
    let shadingMips: ResourceId[] = [];
    const shadingBindings: Binding[] = [
      [0, constants, "buffer"],
      [1, luma, "texture"],
      [2, input.seed, "texture"],
      [3, previousLuma, "texture"],
      [4, info, "texture"],
      [5, input.preExposure, "buffer"],
      [6, input.priorExposure, "buffer"],
      [7, input.response, "texture"],
      [16, receivers, "texture"],
    ];
    const shading = graph.add("Native Temporal V2/Shading Pyramid", {}, (_data, resources, context) => {
      const command = commandFor(context);
      if (!this.exposed) {
        throw new Error("Native Temporal V2 shading requires complete exposure");
      }
      this.dispatch(
        command,
        this.shadingPyramid,
        entries(
          [
            ...shadingBindings,
            [8, shadingMips[0]!, "texture"],
            [9, shadingMips[1]!, "texture"],
            [10, shadingMips[2]!, "texture"],
          ],
          resources,
        ),
        input.width,
        input.height,
      );
    });
    reads(shading, shadingBindings);
    shadingMips = [2, 4, 8].map((scale) =>
      transient(
        shading,
        `shading mip ${scale}`,
        "rg16float",
        Math.ceil(input.width / scale),
        Math.ceil(input.height / scale),
      ),
    );
    const analyzeBindings: Binding[] = [
      [0, constants, "buffer"],
      [2, input.seed, "texture"],
      [4, info, "texture"],
      [7, input.response, "texture"],
      [8, input.identity, "texture"],
      [9, input.previousIdentity, "texture"],
      [10, previousDepth, "texture"],
      [13, previousConfidence, "texture"],
      [16, receivers, "texture"],
      [19, shadingMips[0]!, "texture"],
      [20, shadingMips[1]!, "texture"],
      [21, shadingMips[2]!, "texture"],
    ];
    let analysis = -1,
      depth = -1,
      confidence = -1,
      sharpenInfo = -1;
    const analyze = graph.add("Native Temporal V2/Analyze", {}, (_data, resources, context) => {
      const command = commandFor(context);
      if (!this.exposed || this.analyzed) {
        throw new Error("Native Temporal V2 Analyze requires complete exposure");
      }
      this.dispatch(
        command,
        this.analyze,
        [
          ...entries(
            [
              ...analyzeBindings,
              [11, analysis, "texture"],
              [12, depth, "texture"],
              [14, sharpenInfo, "texture"],
              [15, confidence, "texture"],
            ],
            resources,
          ),
          { binding: 17, resource: this.sampler },
        ],
        input.width,
        input.height,
      );
      this.analyzed = true;
    });
    reads(analyze, analyzeBindings);
    analysis = transient(analyze, "analysis", "rgba8unorm");
    depth = analyze.write(currentDepth);
    confidence = analyze.write(currentConfidence);
    sharpenInfo = analyze.write(sharpenExposure);
    const resolveBindings: Binding[] = [
      [0, constants, "buffer"],
      [1, input.color, "texture"],
      [2, input.seed, "texture"],
      [3, analysis, "texture"],
      [4, previousColor, "texture"],
      [5, input.preExposure, "buffer"],
      [8, input.priorExposure, "buffer"],
      [9, info, "texture"],
      [10, luma, "texture"],
      [11, previousLumaHistory, "texture"],
      [14, farthest, "texture"],
      [15, weightProduct, "buffer"],
      [16, receivers, "texture"],
      [18, input.response, "texture"],
    ];
    let color = -1,
      lumaHistory = -1;
    const resolve = graph.add("Native Temporal V2/Resolve", {}, (_data, resources, context) => {
      const command = commandFor(context);
      if (!this.analyzed || this.encoded) {
        throw new Error("Native Temporal V2 Resolve requires complete Analyze");
      }
      this.dispatch(
        command,
        this.resolve,
        [
          ...entries([...resolveBindings, [6, color, "texture"], [13, lumaHistory, "texture"]], resources),
          { binding: 17, resource: this.sampler },
        ],
        input.width,
        input.height,
      );
      if (this.seedOwner) {
        this.seedOwner.acceptNativeResolve(this.attached!, {
          seed: resources.get(input.seed) as GPUTexture,
          response: resources.get(input.response) as GPUTexture,
          identity: resources.get(input.identity) as GPUTexture,
          previousIdentity: resources.get(input.previousIdentity) as GPUTexture,
        });
      }
      this.encoded = true;
    });
    reads(resolve, resolveBindings);
    // Confidence has no same-frame shader consumer, but is part of the
    // complete successful-submission transaction and must remain live.
    resolve.read(confidence);
    if (this.seedOwner) {
      resolve.read(input.response);
      resolve.read(input.identity);
      resolve.read(input.previousIdentity);
    }
    color = resolve.write(currentColor);
    lumaHistory = resolve.write(currentLumaHistory);
    return this.rcas.addToGraph(graph, {
      color,
      exposure: sharpenInfo,
      constants: imported("RCAS constants", (owner) => owner.rcasConstants),
      width: input.width,
      height: input.height,
    });
  }

  jitterEvidence() {
    return { committed: this.previousJitter, pending: this.pending?.jitter ?? null, phaseCount: 8 };
  }

  canRetainHistory(width: number, height: number): boolean {
    return this.active?.width === width && this.active.height === height;
  }

  /** Retire the inactive domain after the replacement frame submits. */
  releaseHistory(): void {
    if (this.pending) {
      throw new Error("Native Temporal V2 history release requires a frame boundary");
    }
    this.retire(this.active, this.lastFence);
    this.active = null;
    this.valid = false;
    this.groups.clear();
  }

  assertPreparedFrame(width: number, height: number): void {
    if (!this.pending || this.pending.width !== width || this.pending.height !== height) {
      throw new Error("Native Temporal V2 graph domain differs from its prepared frame");
    }
  }

  private dispatch(
    command: ShadeGPUCommandContext,
    owner: Pipeline,
    entries: GPUBindGroupEntry[],
    width: number,
    height: number,
    divisor = 8,
  ): void {
    if (!this.pending) {
      throw new Error("Native Temporal V2 has no pending frame");
    }
    const pass = command.beginComputePass({ label: owner.pipeline.label });
    pass.setPipeline(owner.pipeline);
    pass.setBindGroup(0, this.groups.create(this.device, { layout: owner.layout, entries }));
    pass.dispatchWorkgroups(Math.ceil(width / divisor), Math.ceil(height / divisor));
    pass.end();
  }

  commit(fence: Promise<void>): void {
    if (this.attached && !this.attached.wasSubmitted) {
      throw new Error("Native Temporal V2 attached histories require successful submission");
    }
    if (!this.pending || !this.candidate || !this.encoded) {
      throw new Error("Native Temporal V2 commit requires the complete encoded graph");
    }
    if (this.candidate !== this.active) {
      this.retire(this.active, this.lastFence);
      this.generationValue++;
    }
    this.active = this.candidate;
    this.previousJitter = this.pending.jitter;
    this.index = this.writeIndex;
    this.valid = true;
    this.lastFence = fence;
    this.clearPending();
  }

  abort(): void {
    if (this.attached && !this.attached.closed) {
      this.attached.abort(new Error("Native Temporal V2 transaction aborted"));
      return;
    }
    if (this.candidate !== this.active) {
      this.retire(this.candidate, null);
    }
    this.clearPending();
  }
  invalidate(): void {
    if (this.pending) {
      throw new Error("Native Temporal V2 invalidation requires a frame boundary");
    }
    this.valid = false;
  }
  private clearPending(): void {
    this.candidate = null;
    this.pending = null;
    this.encoded = false;
    this.measured = false;
    this.exposed = false;
    this.analyzed = false;
    this.attached = null;
    this.seedOwner = null;
  }
  private bytes(set: NativeHistories | null): number {
    return set ? set.width * set.height * 46 + 32 : 0;
  }
  private track(resource: GPUBuffer | GPUTexture, kind: "buffer" | "texture", bytes: number): void {
    const handle = this.accounting?.created(
      { kind, bytes, owner: "NativeTemporalV2", category: "history", label: resource.label },
      resource
    );
    if (handle) {
      this.accountingHandles.set(resource, handle);
    }
  }
  private releaseResource(resource: GPUBuffer | GPUTexture): void {
    resource.destroy();
    const handle = this.accountingHandles.get(resource);
    if (handle) {
      this.accounting!.destroyed(handle);
      this.accountingHandles.delete(resource);
    }
  }
  private retire(set: NativeHistories | null, fence: Promise<void> | null): void {
    if (!set) {
      return;
    }
    const bytes = this.bytes(set);
    for (const pair of [set.color, set.depth, set.luma, set.lumaHistory, set.confidence, set.frameInfo]) {
      for (const texture of pair) {
        const handle = this.accountingHandles.get(texture);
        if (handle) {
          this.accounting!.setRetired(handle, fence !== null);
        }
      }
    }
    const release = (): void => {
      for (const pair of [set.color, set.depth, set.luma, set.lumaHistory, set.confidence, set.frameInfo]) {
        for (const texture of pair) {
          this.releaseResource(texture);
        }
      }
      if (fence) {
        this.retiredBytes -= bytes;
      }
    };
    if (fence) {
      this.retiredBytes += bytes;
      void fence.then(release, release);
    } else {
      release();
    }
  }
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.abort();
    this.retire(this.active, this.lastFence);
    this.active = null;
    this.groups.clear();
    for (const resource of [this.constants, this.weights, this.rcasConstants, this.rcasExposure]) {
      const handle = this.accountingHandles.get(resource);
      if (handle) {
        this.accounting!.setRetired(handle, this.lastFence !== null);
      }
    }
    const release = (): void => {
      this.releaseResource(this.constants);
      this.releaseResource(this.weights);
      this.releaseResource(this.rcasConstants);
      this.releaseResource(this.rcasExposure);
      this.permanentLive = false;
    };
    if (this.lastFence) {
      void this.lastFence.then(release, release);
    } else {
      release();
    }
  }
}
