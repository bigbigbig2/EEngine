import { PreparedComputePipeline } from "../../gpu/PreparedPipeline.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { resolveGpuEncoder } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import { packNativeTemporalSeedView, NATIVE_TEMPORAL_ALLOCATION_BYTES } from "../../gpu/FinalPixelAbi.js";
import { NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL } from "../../shaders/native_temporal_seed.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";

export interface NativeTemporalSeedCamera {
  readonly view: ArrayLike<number>;
  readonly projection: ArrayLike<number>;
  readonly inverseView: ArrayLike<number>;
  readonly inverseProjection: ArrayLike<number>;
  readonly jitter: readonly [number, number];
  readonly preExposure: number;
}

interface SeedAllocation {
  readonly width: number;
  readonly height: number;
  readonly seed: GPUTexture;
  readonly response: GPUTexture;
  readonly identities: readonly [GPUTexture, GPUTexture];
  readonly handles: readonly ResourceHandle[];
}

export interface NativeTemporalSeedFrame {
  readonly seed: GPUTexture;
  readonly response: GPUTexture;
  readonly identity: GPUTexture;
  readonly previousIdentity: GPUTexture;
  readonly view: Uint8Array<ArrayBuffer>;
  readonly previousValid: boolean;
  readonly historyReadIndex: 0 | 1;
  readonly jitter: readonly [number, number];
}

export type NativeTemporalSeedGraphBinder = <T extends object>(
  name: string,
  resolve: (runtime: NativeTemporalSeed) => T,
) => T;

/** V5 Temporal owner shared by production Native and its direct consumers.
 * Seed/response are reusable frame scratch; identity is the exact existing
 * four-lane history format. No Surface, Scene or material ownership here.
 * One command owns identity role/camera/jitter publication. Physical P remains
 * with GPU Radiometry and FSR; this owner's CPU multiplier is not GPU exposure.
 * Queue-ordered reuse is
 * legal with three submitted frames; resize/destroy retire at last-use fence.
 * Native V2 joins its color/depth histories to the same command transaction. */
export class NativeTemporalSeed {
  async preparePipelines(): Promise<void> {
    await Promise.all([this.pipeline.prepare()]);
  }

  private readonly pipeline: PreparedComputePipeline;
  private readonly groups = new GpuBindGroupCache();
  private active: SeedAllocation | null = null;
  private pending: SeedAllocation | null = null;
  private prepared: NativeTemporalSeedFrame | null = null;
  private previous: NativeTemporalSeedCamera | null = null;
  private current: NativeTemporalSeedCamera | null = null;
  private policy: "native" | "upscale" | null = null;
  private pendingPolicy: "native" | "upscale" | null = null;
  private readIndex: 0 | 1 = 0;
  private writeIndex: 0 | 1 = 1;
  private lastFence: Promise<void> | null = null;
  private retiredBytes = 0;
  private invalid = true;
  private destroyed = false;
  private attached: ShadeGPUCommandContext | null = null;
  private classified = false;
  private consumer: "classification" | "native-resolve" | "surface-writer" = "classification";
  private submittedPreviousValid = false;

  /** Input validity of the prepared or most recently submitted frame. */
  get inputHistoryValid(): boolean {
    return this.prepared?.previousValid ?? this.submittedPreviousValid;
  }

  constructor(
    private readonly device: GPUDevice,
    private readonly accounting?: ResourceAccounting,
  ) {
    if (
      device.limits.maxStorageTexturesPerShaderStage < 4 ||
      device.limits.maxSampledTexturesPerShaderStage < 4
    ) {
      throw new RangeError("Native Seed requires the complete producer/consumer texture profile");
    }
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { format: "rgba8unorm", access: "write-only" },
        },
      ],
    });
    this.pipeline = new PreparedComputePipeline(device, {
      label: "Temporal/Seed classification",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL }),
        entryPoint: "main",
      },
    });
    void device.lost.then(() => this.destroy());
  }

  prepare(
    width: number,
    height: number,
    policy: "native" | "upscale",
    camera: NativeTemporalSeedCamera,
    cut = false,
  ): NativeTemporalSeedFrame {
    if (this.destroyed || this.pending) {
      throw new Error("Seed owner is stopped or already prepared");
    }
    if (policy !== "native" && policy !== "upscale") {
      throw new RangeError("Unknown Seed domain");
    }
    if (
      width > this.device.limits.maxTextureDimension2D ||
      height > this.device.limits.maxTextureDimension2D ||
      Math.ceil(width / 8) > this.device.limits.maxComputeWorkgroupsPerDimension ||
      Math.ceil(height / 8) > this.device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("Seed extent exceeds negotiated texture/dispatch limits");
    }
    if (
      !Number.isFinite(camera.preExposure) ||
      camera.preExposure <= 0 ||
      camera.jitter.length !== 2 ||
      !camera.jitter.every(Number.isFinite)
    ) {
      throw new RangeError("Seed camera requires positive P and finite jitter");
    }
    const current: NativeTemporalSeedCamera = Object.freeze({
      view: Float32Array.from(camera.view),
      projection: Float32Array.from(camera.projection),
      inverseView: Float32Array.from(camera.inverseView),
      inverseProjection: Float32Array.from(camera.inverseProjection),
      jitter: Object.freeze([...camera.jitter]) as readonly [number, number],
      preExposure: camera.preExposure,
    });
    // Validate every camera before resources; matrices are already jittered.
    packNativeTemporalSeedView(width, height, false, [
      current.inverseProjection,
      current.inverseView,
      current.view,
      current.projection,
    ]);
    const reusable = this.active?.width === width && this.active.height === height && this.policy === policy;
    const previousValid = reusable && !this.invalid && !cut && this.previous !== null;
    const previous = previousValid ? this.previous! : current;
    const allocation = reusable ? this.active! : this.allocate(width, height);
    this.pending = allocation;
    this.current = current;
    this.pendingPolicy = policy;
    this.classified = false;
    this.prepared = Object.freeze({
      seed: allocation.seed,
      response: allocation.response,
      identity: allocation.identities[this.writeIndex],
      previousIdentity: allocation.identities[this.readIndex],
      view: packNativeTemporalSeedView(width, height, previousValid, [
        current.inverseProjection,
        current.inverseView,
        previous.view,
        previous.projection,
      ]),
      previousValid,
      historyReadIndex: this.readIndex,
      jitter: current.jitter,
    });
    return this.prepared;
  }

  private allocate(width: number, height: number): SeedAllocation {
    const textures: GPUTexture[] = [];
    const handles: ResourceHandle[] = [];
    const create = (format: GPUTextureFormat, label: string): GPUTexture => {
      const texture = this.device.createTexture({
        label: `Temporal Seed/${label}`,
        size: [width, height],
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
      textures.push(texture);
      const handle = this.accounting?.created(
        {
          kind: "texture",
          category: "resident",
          owner: "NativeTemporalSeed",
          bytes: width * height * (format === "rgba8unorm" ? 4 : 16),
          label: texture.label,
        },
        texture,
      );
      if (handle !== undefined) {
        handles.push(handle);
      }
      return texture;
    };
    try {
      return {
        width,
        height,
        seed: create("rgba32float", "frame"),
        response: create("rgba8unorm", "response"),
        identities: [create("rgba32uint", "identity 0"), create("rgba32uint", "identity 1")],
        handles,
      };
    } catch (error) {
      for (const texture of textures) {
        texture.destroy();
      }
      for (const handle of handles) {
        this.accounting?.destroyed(handle);
      }
      throw error;
    }
  }

  /** Binding this transaction to the actual shared command prevents callers
   * from advancing roles on encoding, abort or a deferred frame. */
  attach(
    command: ShadeGPUCommandContext,
    consumer: "classification" | "native-resolve" | "surface-writer" = "classification",
  ): void {
    if (!this.prepared || this.attached || command.closed || command.device !== this.device) {
      throw new Error("Seed transaction requires one open command on its device");
    }
    if (consumer === "native-resolve" && this.pendingPolicy !== "native") {
      throw new Error("Native Resolve cannot consume an upscale Seed transaction");
    }
    this.attached = command;
    this.consumer = consumer;
    command.onBeforeFinish.addOne(() => this.assertCompleteFrame());
    command.onFinished.addOne(() => this.commit(command.gpuDone));
    command.onAborted.addOne(() => this.abort());
  }

  /** Renderer calls this directly before submit: signal observers alone do
   * not propagate validation errors through the command submission API. */
  assertCompleteFrame(): void {
    if (!this.prepared || !this.classified) {
      throw new Error("Seed producer/consumer transaction is incomplete");
    }
  }

  /** Native V2 consumes exact Seed roles on this command instead of a separate
   * classification dispatch. Encoding alone never advances the history role. */
  acceptNativeResolve(
    command: ShadeGPUCommandContext,
    products: Pick<NativeTemporalSeedFrame, "seed" | "response" | "identity" | "previousIdentity">,
  ): void {
    this.acceptProducts(command, products, "native-resolve");
  }

  /** With AA disabled, the complete Surface writer proves identity publication.
   * No unused full-screen classification or color history is needed. */
  acceptSurfaceWrite(
    command: ShadeGPUCommandContext,
    products: Pick<NativeTemporalSeedFrame, "seed" | "response" | "identity">,
  ): void {
    this.acceptProducts(command, products, "surface-writer");
  }

  private acceptProducts(
    command: ShadeGPUCommandContext,
    products: Pick<NativeTemporalSeedFrame, "seed" | "response" | "identity"> &
      Partial<Pick<NativeTemporalSeedFrame, "previousIdentity">>,
    consumer: "native-resolve" | "surface-writer",
  ): void {
    if (
      !this.prepared ||
      this.attached !== command ||
      command.closed ||
      this.consumer !== consumer ||
      this.classified
    ) {
      throw new Error("Seed publication requires the current complete command");
    }
    for (const name of ["seed", "response", "identity"] as const) {
      if (products[name] !== this.prepared[name]) {
        throw new Error("Seed publication consumed a stale or mismatched role");
      }
    }
    if (consumer === "native-resolve" && products.previousIdentity !== this.prepared.previousIdentity) {
      throw new Error("Native Resolve consumed a stale or mismatched Seed role");
    }
    this.classified = true;
  }

  get frame(): NativeTemporalSeedFrame {
    if (!this.prepared) {
      throw new Error("Seed frame is not prepared");
    }
    return this.prepared;
  }

  assertPreparedFrame(width: number, height: number): void {
    if (this.pending?.width !== width || this.pending.height !== height) {
      throw new Error("Seed physical products do not match the frame");
    }
  }

  importProducts(
    graph: FrameGraph,
    bind: NativeTemporalSeedGraphBinder = (_name, resolve) => resolve(this),
  ): { seed: ResourceId; response: ResourceId; identity: ResourceId } {
    if (!this.prepared) {
      throw new Error("Seed products require preparation");
    }
    const importTexture = (name: string, texture: GPUTexture): ResourceId =>
      graph.import_resource(name, { kind: "imported", domain: "internal-full" }, texture);
    return {
      seed: importTexture(
        "Temporal/Seed",
        bind("seed", (runtime) => runtime.frame.seed),
      ),
      response: importTexture(
        "Temporal/Native response",
        bind("response", (runtime) => runtime.frame.response),
      ),
      identity: importTexture(
        "Temporal/current identity",
        bind("identity", (runtime) => runtime.frame.identity),
      ),
    };
  }

  addClassification(
    graph: FrameGraph,
    products: {
      seed: ResourceId;
      response: ResourceId;
      identity: ResourceId;
      previousIdentity?: ResourceId;
    },
    bind: NativeTemporalSeedGraphBinder = (_name, resolve) => resolve(this),
    debugOnly = false,
  ): ResourceId {
    if (!this.prepared || !this.pending) {
      throw new Error("Seed classification requires a prepared transaction");
    }
    const previous =
      products.previousIdentity ??
      graph.import_resource(
        "Temporal/previous identity",
        { kind: "imported", domain: "internal-full" },
        bind("previous-identity", (runtime) => runtime.frame.previousIdentity),
      );
    let output = -1;
    const pass = graph.add("Temporal/Seed classification", {}, (_data, resources, context) => {
      const encoder = resolveGpuEncoder(context);
      if (
        !encoder ||
        !this.pending ||
        !this.attached ||
        (!debugOnly && (this.classified || this.consumer !== "classification"))
      ) {
        throw new Error("Seed classification requires the current producer/consumer command");
      }
      const group = this.groups.create(this.device, {
        layout: this.pipeline.requirePrepared().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: resolveTextureView(resources.get(products.seed)) },
          { binding: 1, resource: resolveTextureView(resources.get(products.response)) },
          { binding: 2, resource: resolveTextureView(resources.get(products.identity)) },
          { binding: 3, resource: resolveTextureView(resources.get(previous)) },
          { binding: 4, resource: resolveTextureView(resources.get(output)) },
        ],
      });
      const compute = encoder.beginComputePass({ label: "Temporal/Seed classification" });
      compute.setPipeline(this.pipeline.requirePrepared());
      compute.setBindGroup(0, group);
      compute.dispatchWorkgroups(Math.ceil(this.pending!.width / 8), Math.ceil(this.pending!.height / 8));
      compute.end();
      if (!debugOnly) {
        this.classified = true;
      }
    });
    pass.read(products.seed);
    pass.read(products.response);
    pass.read(products.identity);
    pass.read(previous);
    // Identity publication remains a successful scene-frame fact even with AA off.
    if (!debugOnly) {
      pass.make_side_effect();
    }
    output = pass.create("Temporal/classified Seed mask", {
      kind: "transient_texture",
      domain: "internal-full",
      width: this.pending.width,
      height: this.pending.height,
      format: "rgba8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    return output;
  }

  private commit(fence: Promise<void>): void {
    if (!this.pending || !this.classified) {
      throw new Error("Seed commit lacks complete products");
    }
    if (this.pending !== this.active) {
      this.retire(this.active, this.lastFence);
    }
    this.active = this.pending;
    this.submittedPreviousValid = this.frame.previousValid;
    this.previous = this.current;
    this.policy = this.pendingPolicy;
    this.readIndex = this.writeIndex;
    this.writeIndex = this.readIndex === 0 ? 1 : 0;
    this.lastFence = fence;
    this.invalid = false;
    this.clearPending();
  }

  abort(): void {
    if (this.attached && !this.attached.closed) {
      this.attached.abort(new Error("Seed transaction aborted"));
      return;
    }
    if (this.pending !== this.active) {
      this.retire(this.pending, null);
    }
    this.clearPending();
  }

  private clearPending(): void {
    this.pending = null;
    this.prepared = null;
    this.current = null;
    this.pendingPolicy = null;
    this.attached = null;
    this.classified = false;
  }

  invalidate(): void {
    if (this.pending || this.destroyed) {
      throw new Error("Seed invalidation requires a live frame boundary");
    }
    this.invalid = true;
  }

  get allocatedBytes(): number {
    const bytes = (set: SeedAllocation | null): number =>
      set ? set.width * set.height * NATIVE_TEMPORAL_ALLOCATION_BYTES : 0;
    return this.retiredBytes + bytes(this.active) + (this.pending !== this.active ? bytes(this.pending) : 0);
  }

  /** A successfully submitted empty frame has no Seed consumer. Keep the
   * owner reusable, but retire its last scene allocation at that scene's fence. */
  releaseHistory(): void {
    if (this.pending || this.destroyed) {
      throw new Error("Seed release requires a live frame boundary");
    }
    this.retire(this.active, this.lastFence);
    this.active = null;
    this.previous = null;
    this.policy = null;
    this.invalid = true;
    this.submittedPreviousValid = false;
    this.groups.clear();
  }

  private retire(set: SeedAllocation | null, fence: Promise<void> | null): void {
    if (!set) {
      return;
    }
    const bytes = set.width * set.height * NATIVE_TEMPORAL_ALLOCATION_BYTES;
    for (const handle of set.handles) {
      this.accounting?.setRetired(handle, fence !== null);
    }
    const release = (): void => {
      set.seed.destroy();
      set.response.destroy();
      for (const texture of set.identities) {
        texture.destroy();
      }
      for (const handle of set.handles) {
        this.accounting?.destroyed(handle);
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
    this.abort();
    this.retire(this.active, this.lastFence);
    this.active = null;
    this.groups.clear();
    this.destroyed = true;
  }
}
