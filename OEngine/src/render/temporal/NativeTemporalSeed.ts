import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { resolveGpuEncoder } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import { packNativeTemporalSeedView } from "../../gpu/FinalPixelAbi.js";
import { NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL } from "../../shaders/native_temporal_seed.js";
import { resolveTextureView } from "../RenderTargetViews.js";

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
}

export interface NativeTemporalSeedFrame {
  readonly seed: GPUTexture;
  readonly response: GPUTexture;
  readonly identity: GPUTexture;
  readonly previousIdentity: GPUTexture;
  readonly view: Uint8Array<ArrayBuffer>;
  readonly previousValid: boolean;
}

/** V5 Temporal owner, currently constructed only by the isolated closure.
 * Seed/response are reusable frame scratch; identity is the exact existing
 * four-lane history format. No Surface, Scene or material ownership here.
 * One command owns role/camera/jitter/P publication. Queue-ordered reuse is
 * legal with three submitted frames; resize/destroy retire at last-use fence.
 * Color/depth/moment histories join this transaction in Phase 4, not here. */
export class NativeTemporalSeed {
  private readonly pipeline: GPUComputePipeline;
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

  constructor(private readonly device: GPUDevice) {
    if (
      device.limits.maxStorageTexturesPerShaderStage < 4 ||
      device.limits.maxSampledTexturesPerShaderStage < 4
    ) {
      throw new RangeError("Native Seed requires the complete producer/consumer texture profile");
    }
    this.pipeline = device.createComputePipeline({
      label: "Temporal/Seed classification",
      layout: "auto",
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
    });
    return this.prepared;
  }

  private allocate(width: number, height: number): SeedAllocation {
    const textures: GPUTexture[] = [];
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
      return texture;
    };
    try {
      return {
        width,
        height,
        seed: create("rgba32float", "frame"),
        response: create("rgba8unorm", "response"),
        identities: [create("rgba32uint", "identity 0"), create("rgba32uint", "identity 1")],
      };
    } catch (error) {
      for (const texture of textures) {
        texture.destroy();
      }
      throw error;
    }
  }

  /** Binding this transaction to the actual shared command prevents callers
   * from advancing roles on encoding, abort or a deferred frame. */
  attach(command: ShadeGPUCommandContext): void {
    if (!this.prepared || this.attached || command.closed || command.device !== this.device) {
      throw new Error("Seed transaction requires one open command on its device");
    }
    this.attached = command;
    command.onBeforeFinish.addOne(() => {
      if (!this.classified) {
        throw new Error("Seed producer/consumer transaction is incomplete");
      }
    });
    command.onFinished.addOne(() => this.commit(command.gpuDone));
    command.onAborted.addOne(() => this.abort());
  }

  importProducts(graph: FrameGraph): { seed: ResourceId; response: ResourceId; identity: ResourceId } {
    if (!this.prepared) {
      throw new Error("Seed products require preparation");
    }
    const importTexture = (name: string, texture: GPUTexture): ResourceId =>
      graph.import_resource(name, { kind: "imported", domain: "internal-full" }, texture);
    return {
      seed: importTexture("Temporal/Seed", this.prepared.seed),
      response: importTexture("Temporal/Native response", this.prepared.response),
      identity: importTexture("Temporal/current identity", this.prepared.identity),
    };
  }

  addClassification(
    graph: FrameGraph,
    products: { seed: ResourceId; response: ResourceId; identity: ResourceId },
  ): ResourceId {
    if (!this.prepared || !this.pending) {
      throw new Error("Seed classification requires a prepared transaction");
    }
    const frame = this.prepared;
    const previous = graph.import_resource(
      "Temporal/previous identity",
      { kind: "imported", domain: "internal-full" },
      frame.previousIdentity,
    );
    let output = -1;
    const pass = graph.add("Temporal/Seed classification", {}, (_data, resources, context) => {
      const encoder = resolveGpuEncoder(context);
      if (!encoder || this.prepared !== frame || !this.attached || this.classified) {
        throw new Error("Seed classification requires the current producer/consumer command");
      }
      const group = this.groups.create(this.device, {
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: resolveTextureView(frame.seed) },
          { binding: 1, resource: resolveTextureView(frame.response) },
          { binding: 2, resource: resolveTextureView(frame.identity) },
          { binding: 3, resource: resolveTextureView(frame.previousIdentity) },
          { binding: 4, resource: resolveTextureView(resources.get(output)) },
        ],
      });
      const compute = encoder.beginComputePass({ label: "Temporal/Seed classification" });
      compute.setPipeline(this.pipeline);
      compute.setBindGroup(0, group);
      compute.dispatchWorkgroups(Math.ceil(this.pending!.width / 8), Math.ceil(this.pending!.height / 8));
      compute.end();
      this.classified = true;
    });
    pass.read(products.seed);
    pass.read(products.response);
    pass.read(products.identity);
    pass.read(previous);
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
    const bytes = (set: SeedAllocation | null): number => (set ? set.width * set.height * 52 : 0);
    return this.retiredBytes + bytes(this.active) + (this.pending !== this.active ? bytes(this.pending) : 0);
  }

  private retire(set: SeedAllocation | null, fence: Promise<void> | null): void {
    if (!set) {
      return;
    }
    const bytes = set.width * set.height * 52;
    const release = (): void => {
      set.seed.destroy();
      set.response.destroy();
      for (const texture of set.identities) {
        texture.destroy();
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
