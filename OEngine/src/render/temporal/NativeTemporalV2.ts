import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { NativeTemporalSeed } from "./NativeTemporalSeed.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { Fsr3RcasPass, packFsr3RcasConstants } from "../passes/fsr3/Fsr3RcasPass.js";
import {
  NATIVE_TEMPORAL_V2_ANALYZE_WGSL,
  NATIVE_TEMPORAL_V2_RESOLVE_WGSL,
} from "../../shaders/native_temporal_v2.js";

interface NativeHistories {
  readonly width: number;
  readonly height: number;
  readonly color: readonly [GPUTexture, GPUTexture];
  readonly depth: readonly [GPUTexture, GPUTexture];
  readonly state: readonly [GPUTexture, GPUTexture];
}

export interface NativeTemporalV2Frame {
  readonly width: number;
  readonly height: number;
  readonly jitter: readonly [number, number];
  readonly reset: boolean;
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

/** Isolated complete V5 candidate; production selection waits for the Phase4
 * quality gate. Color/depth/state move together only after successful submit.
 * Identity and camera are provided by Seed on that same command transaction.
 * Queue-ordered ping-pong supports three in-flight submissions; the last-use
 * fence owns resize/abort/destroy retirement. */
export class NativeTemporalV2 {
  private readonly groups = new GpuBindGroupCache();
  private readonly analyze: Pipeline;
  private readonly resolve: Pipeline;
  private readonly rcas: Fsr3RcasPass;
  private readonly constants: GPUBuffer;
  private readonly rcasConstants: GPUBuffer;
  private readonly rcasExposure: GPUTexture;
  private active: NativeHistories | null = null;
  private candidate: NativeHistories | null = null;
  private pending: NativeTemporalV2Frame | null = null;
  private previousJitter: readonly [number, number] = [0, 0];
  private index: 0 | 1 = 0;
  private pendingIndex: 0 | 1 = 0;
  private valid = false;
  private generationValue = 0;
  private encoded = false;
  private analyzed = false;
  private attached: ShadeGPUCommandContext | null = null;
  private seedOwner: NativeTemporalSeed | null = null;
  private lastFence: Promise<void> | null = null;
  private retiredBytes = 0;
  private destroyed = false;
  private permanentLive = true;

  constructor(private readonly device: GPUDevice) {
    if (
      device.limits.maxSampledTexturesPerShaderStage < 7 ||
      device.limits.maxStorageTexturesPerShaderStage < 3 ||
      device.limits.maxComputeWorkgroupStorageSize < 7232
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
    const shared: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      texture(1),
      texture(2),
      texture(3, "float"),
      texture(4),
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    ];
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
    this.analyze = pipeline("Native Temporal V2/Analyze", NATIVE_TEMPORAL_V2_ANALYZE_WGSL, [
      ...shared.filter(({ binding }) => binding !== 3 && binding !== 6),
      texture(7),
      texture(8, "uint"),
      texture(9, "uint"),
      texture(10),
      storage(11, "rgba16float"),
      storage(12, "r32float"),
      storage(14, "r32float"),
    ]);
    this.resolve = pipeline("Native Temporal V2/Resolve", NATIVE_TEMPORAL_V2_RESOLVE_WGSL, [
      ...shared,
      texture(7),
      storage(8, "rgba16float"),
      storage(9, "rg32float"),
    ]);
    this.rcas = new Fsr3RcasPass(device);
    const created: Array<GPUBuffer | GPUTexture> = [];
    try {
      this.constants = device.createBuffer({
        label: "Native Temporal V2/frame",
        size: 32,
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
    } catch (error) {
      for (const resource of created) {
        resource.destroy();
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
      (this.permanentLive ? 52 : 0) +
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
        extent > this.device.limits.maxTextureDimension2D ||
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
    const bytes = new ArrayBuffer(32);
    new Uint32Array(bytes).set([frame.width, frame.height, Number(valid), 0]);
    new Float32Array(bytes).set([...frame.jitter, ...(valid ? this.previousJitter : frame.jitter)], 4);
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
    const pair = (label: string, format: GPUTextureFormat): readonly [GPUTexture, GPUTexture] => {
      const create = (index: number): GPUTexture => {
        const texture = this.device.createTexture({
          label: `Native Temporal V2/${label}/${index}`,
          size: [width, height],
          format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        created.push(texture);
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
        state: pair("state", "rg32float"),
      };
    } catch (error) {
      for (const texture of created) {
        texture.destroy();
      }
      throw error;
    }
  }

  private history(name: "color" | "depth" | "state", role: "read" | "write"): GPUTexture {
    if (!this.candidate || !this.pending) {
      throw new Error("Native Temporal V2 has no prepared histories");
    }
    return this.candidate[name][role === "read" ? this.readIndex : this.writeIndex];
  }

  /** Bind Seed identity/camera and V2 color/depth/state to one real submission.
   * This replaces the Seed classifier proof only in the isolated V2 closure;
   * the production composition root has not selected this graph yet. */
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
    command.onBeforeFinish.addOne(() => {
      if (!this.encoded) {
        throw new Error("Native Temporal V2 submission lacks the complete graph");
      }
    });
    command.onFinished.addOne(() => this.commit(command.gpuDone));
    command.onAborted.addOne(() => this.abort());
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
    const previousColor = imported("previous color", (owner) => owner.history("color", "read"));
    const previousState = imported("previous state", (owner) => owner.history("state", "read"));
    const previousDepth = imported("previous depth", (owner) => owner.history("depth", "read"));
    const currentColor = imported("current color", (owner) => owner.history("color", "write"));
    const currentState = imported("current state", (owner) => owner.history("state", "write"));
    const currentDepth = imported("current depth", (owner) => owner.history("depth", "write"));
    const shared = [
      constants,
      input.color,
      input.seed,
      previousColor,
      previousState,
      input.preExposure,
      input.priorExposure,
    ];
    const entries = (
      ids: readonly number[],
      resources: { get(id: number): unknown },
      excluded: readonly number[] = [],
    ): GPUBindGroupEntry[] => {
      const result: GPUBindGroupEntry[] = [];
      for (let binding = 0; binding < ids.length; binding++) {
        if (excluded.includes(binding)) {
          continue;
        }
        const resource = resources.get(ids[binding]!);
        result.push({
          binding,
          resource:
            binding === 0 || binding === 5 || binding === 6
              ? { buffer: resource as GPUBuffer }
              : resolveTextureView(resource),
        });
      }
      return result;
    };
    const exposure = imported("sharpen exposure", (owner) => owner.rcasExposure);
    let exposureWritten = -1;
    let analysis = -1;
    let depth = -1;
    const analyzeIds = [...shared, input.response, input.identity, input.previousIdentity, previousDepth];
    const analyze = graph.add("Native Temporal V2/Analyze", {}, (_data, resources, context) => {
      if (this.analyzed || (this.attached && context.encoder !== this.attached)) {
        throw new Error("Native Temporal V2 Analyze requires its current single command");
      }
      this.dispatch(
        context.encoder as ShadeGPUCommandContext,
        this.analyze,
        [
          ...entries(analyzeIds, resources, [3, 6]),
          { binding: 11, resource: resolveTextureView(resources.get(analysis)) },
          { binding: 12, resource: resolveTextureView(resources.get(depth)) },
          { binding: 14, resource: resolveTextureView(resources.get(exposureWritten)) },
        ],
        input.width,
        input.height,
      );
      this.analyzed = true;
    });
    for (let binding = 0; binding < analyzeIds.length; binding++) {
      if (binding !== 3 && binding !== 6) {
        analyze.read(analyzeIds[binding]!);
      }
    }
    analysis = analyze.create("Native Temporal V2/analysis", {
      kind: "transient_texture",
      width: input.width,
      height: input.height,
      format: "rgba16float",
      domain: "internal-full",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    depth = analyze.write(currentDepth);
    exposureWritten = analyze.write(exposure);
    let color = -1;
    let state = -1;
    const resolveIds = [...shared, analysis];
    const resolve = graph.add("Native Temporal V2/Resolve", {}, (_data, resources, context) => {
      if (!this.analyzed || this.encoded || (this.attached && context.encoder !== this.attached)) {
        throw new Error("Native Temporal V2 Resolve requires its complete Analyze command");
      }
      this.dispatch(
        context.encoder as ShadeGPUCommandContext,
        this.resolve,
        [
          ...entries(resolveIds, resources),
          { binding: 8, resource: resolveTextureView(resources.get(color)) },
          { binding: 9, resource: resolveTextureView(resources.get(state)) },
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
    for (const id of resolveIds) {
      resolve.read(id);
    }
    if (this.seedOwner) {
      // CPU submission proof inspects these already-produced imported roles;
      // no additional shader bindings, sampling or physical pass is added.
      resolve.read(input.response);
      resolve.read(input.identity);
      resolve.read(input.previousIdentity);
    }
    // The analysis read retains its producer and all depth writes on that pass.
    color = resolve.write(currentColor);
    state = resolve.write(currentState);
    const sharpen = this.rcas.addToGraph(graph, {
      color,
      exposure: exposureWritten,
      constants: imported("RCAS constants", (owner) => owner.rcasConstants),
      width: input.width,
      height: input.height,
    });
    return sharpen;
  }

  private assertPreparedFrame(width: number, height: number): void {
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
  ): void {
    this.assertPreparedFrame(width, height);
    const pass = command.beginComputePass({ label: owner.pipeline.label });
    pass.setPipeline(owner.pipeline);
    pass.setBindGroup(0, this.groups.create(this.device, { layout: owner.layout, entries }));
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
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
    this.analyzed = false;
    this.attached = null;
    this.seedOwner = null;
  }
  private bytes(set: NativeHistories | null): number {
    return set ? set.width * set.height * 40 : 0;
  }
  private retire(set: NativeHistories | null, fence: Promise<void> | null): void {
    if (!set) {
      return;
    }
    const bytes = this.bytes(set);
    const release = (): void => {
      for (const pair of [set.color, set.depth, set.state]) {
        for (const texture of pair) {
          texture.destroy();
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
    const release = (): void => {
      this.constants.destroy();
      this.rcasConstants.destroy();
      this.rcasExposure.destroy();
      this.permanentLive = false;
    };
    if (this.lastFence) {
      void this.lastFence.then(release, release);
    } else {
      release();
    }
  }
}
