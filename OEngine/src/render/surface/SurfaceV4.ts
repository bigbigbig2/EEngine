import { encodeScgiNativeWindow, type ScgiNativeWindowInput } from "../gi/ScgiNativeWindow.js";
import { scgiLightingGatherWgsl } from "../../shaders/scgi_lighting_gather.js";
import { PreparedComputePipeline } from "../../gpu/PreparedPipeline.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import { SSSR_RECEIVER_BYTES } from "../reflections/SssrAbi.js";
import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import type { ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { resolveGpuEncoder } from "../../framegraph/FrameGraph.js";
import type { GpuNativeMaterialPublication } from "../../gpu/GpuNativeMaterialPublication.js";
import { GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS } from "../../gpu/GpuMeshletRasterWorkAbi.js";
import {
  NATIVE_SURFACE_SETTINGS_BYTES,
  FINAL_PIXEL_SURFACE_SETTINGS_BYTES,
} from "../../shaders/native_surface.js";
import { NATIVE_TEMPORAL_SEED_VIEW_BYTES } from "../../gpu/FinalPixelAbi.js";
import { NATIVE_TEMPORAL_BACKGROUND_WGSL } from "../../shaders/native_temporal_seed.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import { NativeExecutionBins, type NativeExecutionBinsBindings } from "./NativeExecutionBins.js";

export interface NativeSurfaceGeometry {
  readonly meshletWork: GPUBuffer;
  readonly arena: GPUBuffer;
  readonly vertexPayload: GPUBuffer;
  readonly instances: GPUBuffer;
  /** geometry, meshlet, vertex-index and triangle word bases in the existing asset publication. */
  readonly source: readonly [number, number, number, number];
  /** vertex payload base, reserved, reserved, FrameGeometryArena header word (filtered flag allowed). */
  readonly sourcePayload: readonly [number, number, number, number];
  readonly productHeap?: GPUBuffer;
  readonly productBanks?: readonly [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer];
}

export interface NativeSurfaceRoute {
  readonly programIndex: number;
  readonly bindingSet: number;
  readonly materialEntries: readonly GPUBindGroupEntry[];
  /** Validated dynamic/nonlocal inputs in native program input order; geometry slots are ignored. */
  readonly frameInputs: Float32Array<ArrayBuffer>;
  readonly unlit: boolean;
}

export interface NativeSurfaceFrame {
  readonly scgi?: ScgiNativeWindowInput;
  readonly virtualFeedback?: GPUBuffer;
  readonly reflections?: { readonly receivers: GPUBuffer; readonly maxAlpha: number };
  readonly width: number;
  readonly height: number;
  readonly generation: number;
  /** Production queue generation is GPU-authored; no CPU control readback. */
  readonly generationSource?: GPUBuffer;
  readonly frameIndex: number;
  readonly cameraPosition: readonly [number, number, number];
  /** GPU radiometry product; COPY_SRC enables a 4-byte GPU copy into frame uniforms. */
  readonly preExposure: GPUBuffer;
  readonly viewMatrix: ArrayLike<number>;
  /** Current jittered GPU camera publication, copied into the Native uniform. */
  readonly camera: GPUBuffer;
  /** Optional FrameGraph-owned final HDR. Surface never destroys a borrowed output. */
  readonly output?: GPUTexture;
  readonly visibility: GPUTexture;
  readonly depth: GPUTexture;
  /** Optional provider-owned pre-exposed HDR initialization image. Default is black. */
  readonly background?: GPUTexture;
  readonly geometry: NativeSurfaceGeometry;
  readonly publication: GpuNativeMaterialPublication;
  /** Lighting group entries use native_surface.ts bindings 0..11, including real AO and VSM. */
  readonly lightingEntries: readonly GPUBindGroupEntry[];
  /** Unique (programIndex, bindingSet) resources, never one route per material instance. */
  readonly routes: readonly NativeSurfaceRoute[];
  /** Demanded Temporal input. Owned by the Aux owner, not by SurfaceV4. */
  readonly reactive?: GPUTexture;
  /** Temporal owns production Seed outputs and successful-submit view roles. */
  readonly temporal?: {
    readonly seed: GPUTexture;
    readonly identity: GPUTexture;
    readonly view: Uint8Array<ArrayBuffer>;
  };
}

export interface NativeSurfaceGraphProducts {
  readonly hdr: ResourceId;
  /** Written resource version, suitable for the subsequent Temporal read. */
  readonly reactive?: ResourceId;
  readonly seed?: ResourceId;
  readonly identity?: ResourceId;
}

interface RouteState {
  readonly pipeline: GPUComputePipeline;
  readonly groups: readonly GPUBindGroup[];
  readonly constants: GPUBuffer;
  readonly inputs: GPUBuffer;
  readonly feedback?: { readonly layout: GPUBindGroupLayout; readonly entries: readonly GPUBindGroupEntry[] };
}

interface ExtentState {
  readonly allocation: ExtentAllocation;
  readonly width: number;
  readonly height: number;
  readonly publication: GpuNativeMaterialPublication;
  readonly bins: NativeExecutionBins;
  readonly hdr: GPUTexture;
  readonly ownsHdr: boolean;
  readonly settings: GPUBuffer;
  readonly shadingView: GPUBuffer;
  readonly preExposure: GPUBuffer;
  readonly camera: GPUBuffer;
  readonly resources: GPUBuffer[];
  readonly generationSource?: GPUBuffer;
  readonly routes: RouteState[];
  readonly identity: readonly unknown[];
  readonly background: GPUTexture | undefined;
  readonly reactive: GPUTexture | undefined;
  readonly binBindings: NativeExecutionBinsBindings | null;
  readonly backgroundSeedGroup?: GPUBindGroup;
  readonly reflectionReceivers?: GPUBuffer;
}

/** Storage depends on extent/code, while frame products are late-bound. References
 * include submitted binding snapshots until their actual completion fences. */
interface ExtentAllocation {
  readonly width: number;
  readonly height: number;
  readonly publication: GpuNativeMaterialPublication;
  readonly borrowedOutput: boolean;
  readonly bins: NativeExecutionBins;
  readonly settings: GPUBuffer;
  readonly shadingView: GPUBuffer;
  readonly resources: GPUBuffer[];
  readonly routeBuffers: ReadonlyArray<Readonly<{ constants: GPUBuffer; inputs: GPUBuffer }>>;
  readonly ownedHdr: GPUTexture | null;
  readonly temporalView?: GPUBuffer;
  binSettings?: GPUBuffer;
  references: number;
}

/**
 * Native opaque production owner. It borrows
 * Geometry/material/Lighting resources, owns HDR/execution scratch and submits
 * nothing. RendererCore owns lifecycle; FrameProgram binds the macro products.
 * Publication readiness/commit is independent; aborting a frame cannot publish
 * a candidate or advance Temporal history. Stable resource identities reuse
 * pipelines, groups and scratch. Resize/rebind retires against the last fence.
 */
export class SurfaceV4 {
  private readonly bindGroups = new GpuBindGroupCache();
  private scgiFrame: NativeSurfaceFrame | null = null;
  private readonly giGatherPipelines = new Map<boolean, GPUComputePipeline>();
  async prepareGiPipeline(product: boolean): Promise<void> {
    if (this.giGatherPipelines.has(product)) {
      return;
    }
    const module = this.device.createShaderModule({
      label: "SCGI/lighting gather",
      code: scgiLightingGatherWgsl(product),
    });
    const pipeline = await this.device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    this.giGatherPipelines.set(product, pipeline);
  }
  get ready(): Promise<void> {
    return this.backgroundSeedPipeline?.prepare() ?? Promise.resolve();
  }
  async preparePipelines(background: boolean): Promise<void> {
    if (background) {
      await this.ready;
    }
  }
  private neutralEntries: readonly GPUBindGroupEntry[] | null = null;
  private neutralEnvironmentEntries: readonly GPUBindGroupEntry[] | null = null;
  private neutralEnvironmentTexture: GPUTexture | null = null;
  private neutralBuffers: readonly GPUBuffer[] = [];
  private neutralTextures: readonly GPUTexture[] = [];
  private state: ExtentState | null = null;
  private preparedState: ExtentState | null = null;
  private prepared = false;
  private preparing = false;
  private prepareEpoch = 0;
  private encoded = false;
  private destroyed = false;
  private lastCompletion: Promise<void> = Promise.resolve();
  private readonly retired = new Set<ExtentState>();
  // Attachment changes replace bind groups, not the ordered GPU scratch queue.
  // References include submitted retired states until their exact fences settle.
  private readonly accountingHandles = new Map<GPUBuffer | GPUTexture, ResourceHandle>();
  private readonly backgroundSeedPipeline?: PreparedComputePipeline;

  constructor(
    private readonly device: GPUDevice,
    private readonly reactive = false,
    private readonly graphics?: GraphicsContext,
    /** Nonproduction V5 closure until an explicit FrameProgram cutover. */
    private readonly finalPixel = false,
  ) {
    if (finalPixel) {
      if (!reactive || device.limits.maxStorageTexturesPerShaderStage < 4) {
        throw new RangeError("Final Pixel requires HDR and all three Temporal products");
      }
      this.backgroundSeedPipeline = new PreparedComputePipeline(device, {
        label: "Final Pixel/empty scene Seed",
        layout: "auto",
        compute: {
          module: device.createShaderModule({ code: NATIVE_TEMPORAL_BACKGROUND_WGSL }),
          entryPoint: "main",
        },
      });
    }
    void device.lost.then(() => this.destroy());
  }

  get neutralLightingEntries(): readonly GPUBindGroupEntry[] {
    if (this.destroyed) {
      throw new Error("SurfaceV4 cannot allocate provider defaults after teardown");
    }
    if (this.neutralEntries !== null) {
      return this.neutralEntries;
    }
    const shadowConstants = this.device.createBuffer({
      label: "SurfaceV4/disabled VSM constants",
      size: 256,
      usage: GPUBufferUsage.UNIFORM,
    });
    const shadowVisibility = this.device.createTexture({
      label: "SurfaceV4/disabled VSM atlas",
      size: [1, 1],
      format: "depth32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const sampler = this.device.createSampler({ label: "SurfaceV4/VSM point sampler" });
    const ao = this.device.createTexture({
      label: "SurfaceV4/neutral AO",
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: ao },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.neutralBuffers = [shadowConstants];
    this.neutralBuffers.forEach((buffer) => this.track(buffer, "buffer", buffer.size));
    this.track(shadowVisibility, "texture", 4);
    this.track(ao, "texture", 4);
    this.neutralTextures = [shadowVisibility, ao];
    this.neutralEntries = [
      { binding: 8, resource: { buffer: shadowConstants } },
      { binding: 10, resource: createNativeTextureView(shadowVisibility) },
      { binding: 11, resource: createNativeTextureView(ao) },
      { binding: 16, resource: sampler },
    ];
    return this.neutralEntries;
  }

  /** Absent environment radiance contributes exactly zero to every IBL lobe.
   * The same zero texel supplies diffuse/specular/DFG; no convolution is needed. */
  get absentEnvironmentSpecular(): GPUTexture {
    void this.absentEnvironmentEntries;
    return this.neutralEnvironmentTexture!;
  }
  get absentEnvironmentEntries(): readonly GPUBindGroupEntry[] {
    if (this.destroyed) {
      throw new Error("SurfaceV4 cannot allocate provider defaults after teardown");
    }
    if (this.neutralEnvironmentEntries !== null) {
      return this.neutralEnvironmentEntries;
    }
    const texture = this.device.createTexture({
      label: "SurfaceV4/absent environment radiance",
      size: [1, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.neutralEnvironmentTexture = texture;
    this.track(texture, "texture", 8);
    const view = createNativeTextureView(texture);
    const sampler = this.device.createSampler({
      label: "SurfaceV4/absent environment sampler",
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.neutralEnvironmentEntries = [
      { binding: 5, resource: view },
      { binding: 6, resource: view },
      { binding: 7, resource: view },
      { binding: 15, resource: sampler },
    ];
    return this.neutralEnvironmentEntries;
  }

  get hdr(): GPUTexture {
    if (!this.prepared || this.preparedState === null) {
      throw new Error("SurfaceV4 has no prepared HDR product");
    }
    return this.preparedState.hdr;
  }

  get executionBins(): NativeExecutionBins {
    if (!this.prepared || this.preparedState === null) {
      throw new Error("SurfaceV4 has no prepared execution bins");
    }
    return this.preparedState.bins;
  }

  get allocatedBytes(): number {
    const allocations = new Set<ExtentAllocation>();
    if (this.state !== null) {
      allocations.add(this.state.allocation);
    }
    if (this.preparedState !== null) {
      allocations.add(this.preparedState.allocation);
    }
    for (const state of this.retired) {
      allocations.add(state.allocation);
    }
    let total =
      this.neutralBuffers.reduce((total, buffer) => total + buffer.size, 0) +
      (this.neutralEntries === null ? 0 : 8) +
      (this.neutralEnvironmentTexture === null ? 0 : 8);
    for (const allocation of allocations) {
      total += allocation.width * allocation.height * Number(allocation.ownedHdr !== null) * 8;
      total += allocation.bins.allocatedBytes;
      total += allocation.resources.reduce((bytes, buffer) => bytes + buffer.size, 0);
    }
    return total;
  }

  canPrepareFrame(): boolean {
    return !this.destroyed && !this.prepared && !this.preparing;
  }

  async prepareFrame(frame: NativeSurfaceFrame): Promise<void> {
    if (this.destroyed || this.prepared || this.preparing) {
      throw new Error("SurfaceV4 is stopped or already prepared");
    }
    this.validate(frame);
    this.preparing = true;
    const epoch = ++this.prepareEpoch;
    let bins: NativeExecutionBins | null = null;
    try {
      await this.ready;
      await frame.publication.ready;
      if (this.reusableAllocation(frame) === null) {
        bins = new NativeExecutionBins(this.device, {
          width: frame.width,
          height: frame.height,
          bins: frame.publication.bins,
          finalPixel: this.finalPixel,
          window:
            frame.scgi === undefined
              ? undefined
              : [frame.scgi.lighting.plan.windowWidth, frame.scgi.lighting.plan.windowRows],
        });
        await bins.ready;
      }
      if (this.destroyed || epoch !== this.prepareEpoch) {
        throw new Error("SurfaceV4 prepare was superseded");
      }
      this.preparing = false;
      this.prepareFrameNow(frame, bins ?? undefined);
    } finally {
      this.preparing = false;
      if (bins !== null && this.preparedState?.bins !== bins) {
        bins.destroy();
      }
    }
  }

  /** Production has already admitted all PSOs; late-bound graph products need no await. */
  prepareFrameNow(frame: NativeSurfaceFrame, preparedBins?: NativeExecutionBins): void {
    if (this.destroyed || this.prepared || this.preparing) {
      throw new Error("SurfaceV4 is stopped or already prepared");
    }
    this.validate(frame);
    // Synchronous preparation consumes descriptors and uploads numeric values
    // before returning. No CPU descriptor is retained by a GPU consumer.
    this.preparing = true;
    const epoch = ++this.prepareEpoch;
    let candidate: ExtentState | null = null;
    try {
      if (this.destroyed || epoch !== this.prepareEpoch) {
        throw new Error("SurfaceV4 prepare was superseded");
      }
      const resourceIdentity = (entries: readonly GPUBindGroupEntry[]): unknown[] =>
        entries.flatMap((entry) => {
          const resource = entry.resource as GPUBufferBinding;
          return resource.buffer === undefined
            ? [entry.binding, entry.resource]
            : [entry.binding, resource.buffer, resource.offset ?? 0, resource.size ?? resource.buffer.size];
        });
      const identity: unknown[] = [
        frame.width,
        frame.height,
        frame.scgi?.lighting.plan.windowWidth,
        frame.scgi?.lighting.plan.windowRows,
        frame.output,
        frame.reflections?.receivers,
        frame.publication,
        frame.visibility,
        frame.depth,
        frame.background,
        frame.reactive,
        frame.temporal?.seed,
        frame.temporal?.identity,
        frame.preExposure,
        frame.camera,
        frame.generationSource,
        ...Object.values(frame.geometry).flat(),
        ...resourceIdentity(frame.lightingEntries),
        ...frame.routes.flatMap((route) => [
          route.programIndex,
          route.bindingSet,
          route.unlit,
          ...resourceIdentity(route.materialEntries),
        ]),
      ];
      if (
        this.state === null ||
        this.state.identity.length !== identity.length ||
        this.state.identity.some((value, index) => value !== identity[index])
      ) {
        // Immutable shader layouts and physical bindings are validated when
        // they change; finite frame-varying values still validate every frame.
        this.validateProfiles(frame);
        candidate = this.createState(frame, identity, preparedBins);
        if (this.destroyed || epoch !== this.prepareEpoch) {
          throw new Error("SurfaceV4 stopped during prepare");
        }
      }
      const state = candidate ?? this.state!;
      for (const route of state.routes) {
        if (route.feedback) {
          if (!frame.virtualFeedback) {
            throw new Error("VT Surface requires a live feedback binding");
          }
          (route.groups as GPUBindGroup[])[2] = this.bindGroups.create(this.device, {
            layout: route.feedback.layout,
            entries: [...route.feedback.entries, { binding: 1, resource: { buffer: frame.virtualFeedback } }],
          });
        }
      }
      const data = new ArrayBuffer(
        this.finalPixel ? FINAL_PIXEL_SURFACE_SETTINGS_BYTES : NATIVE_SURFACE_SETTINGS_BYTES,
      );
      const words = new Uint32Array(data);
      const floats = new Float32Array(data);
      words.set(frame.geometry.source, 0);
      words.set(frame.geometry.sourcePayload, 4);
      words.set([frame.width, frame.height, frame.frameIndex, frame.generation], 8);
      floats.set([...frame.cameraPosition, 1], 12);
      for (let index = 0; index < 16; index++) {
        floats[16 + index] = frame.viewMatrix[index]!;
      }
      if (frame.temporal) {
        new Uint8Array(data).set(frame.temporal.view, NATIVE_SURFACE_SETTINGS_BYTES);
        this.device.queue.writeBuffer(state.allocation.temporalView!, 0, frame.temporal.view);
      }
      this.device.queue.writeBuffer(state.settings, 0, data);
      this.device.queue.writeBuffer(
        state.shadingView,
        0,
        new Uint32Array([frame.width, frame.height, frame.frameIndex, 0]),
      );
      if (state.binBindings !== null) {
        state.bins.updateGeneration(state.binBindings, frame.generation);
      }
      state.routes.forEach((route, index) => {
        if (frame.reflections) {
          this.device.queue.writeBuffer(route.constants, 12, new Float32Array([frame.reflections.maxAlpha]));
        }
        if (frame.scgi === undefined) {
          this.device.queue.writeBuffer(route.constants, 4, new Uint32Array([0, 0]));
        }
        const values = frame.routes[index]!.frameInputs;
        this.device.queue.writeBuffer(route.inputs, 0, values);
      });
      // Preparation owns a candidate. Only the submitted frame can replace the
      // active extent; abort/retry must leave the previous extent usable.
      this.scgiFrame = frame;
      this.preparedState = state;
      candidate = null;
      this.prepared = true;
      this.encoded = false;
    } catch (error) {
      if (candidate !== null) {
        this.release(candidate);
      }
      throw error;
    } finally {
      this.preparing = false;
    }
  }

  private validate(frame: NativeSurfaceFrame): void {
    if (frame.output !== undefined) {
      const required =
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
      if (
        frame.output.width !== frame.width ||
        frame.output.height !== frame.height ||
        frame.output.depthOrArrayLayers !== 1 ||
        frame.output.format !== "rgba16float" ||
        (frame.output.usage & required) !== required ||
        frame.output === frame.background
      ) {
        throw new RangeError(
          "SurfaceV4 HDR output requires the complete initialization/write profile and a distinct source",
        );
      }
    }
    if (this.reactive !== (frame.reactive !== undefined)) {
      throw new Error("SurfaceV4 demanded reactive profile must match its physical outputs");
    }
    if (this.finalPixel !== (frame.temporal !== undefined)) {
      throw new Error("Surface physical Seed profile must match its outputs");
    }
    if (frame.temporal) {
      const temporalWords = new Uint32Array(frame.temporal.view.buffer, frame.temporal.view.byteOffset);
      if (
        frame.temporal.view.byteLength !== NATIVE_TEMPORAL_SEED_VIEW_BYTES ||
        frame.temporal.seed.format !== "rgba32float" ||
        frame.temporal.identity.format !== "rgba32uint" ||
        temporalWords[64] !== frame.width ||
        temporalWords[65] !== frame.height ||
        temporalWords[66]! > 1 ||
        !new Float32Array(frame.temporal.view.buffer, frame.temporal.view.byteOffset, 64).every(
          Number.isFinite,
        )
      ) {
        throw new RangeError("Final Pixel Seed violates its frozen ABI");
      }
      for (const texture of [frame.temporal.seed, frame.temporal.identity]) {
        if (
          texture.width !== frame.width ||
          texture.height !== frame.height ||
          texture.depthOrArrayLayers !== 1 ||
          (texture.usage & GPUTextureUsage.STORAGE_BINDING) === 0
        ) {
          throw new RangeError("Final Pixel Seed requires complete writable extent");
        }
      }
    }
    for (const dimension of [frame.width, frame.height]) {
      if (
        !Number.isSafeInteger(dimension) ||
        dimension < 1 ||
        dimension > this.device.limits.maxTextureDimension2D
      ) {
        throw new RangeError("SurfaceV4 extent exceeds negotiated limits");
      }
      if (Math.ceil(dimension / 8) > this.device.limits.maxComputeWorkgroupsPerDimension) {
        throw new RangeError("SurfaceV4 extent exceeds the background/dense dispatch limit");
      }
    }
    if (
      !Number.isSafeInteger(frame.generation) ||
      frame.generation < 1 ||
      frame.generation > 0xffffffff ||
      !Number.isSafeInteger(frame.frameIndex) ||
      frame.frameIndex < 0 ||
      frame.frameIndex > 0xffffffff
    ) {
      throw new RangeError("SurfaceV4 frame context must be complete u32 values");
    }
    if (
      frame.preExposure.size < 4 ||
      frame.camera.size < PACKED_CAMERA_TYPE.size ||
      (frame.camera.usage & GPUBufferUsage.COPY_SRC) === 0 ||
      (frame.preExposure.usage & GPUBufferUsage.COPY_SRC) === 0 ||
      frame.viewMatrix.length !== 16 ||
      ![...frame.cameraPosition, ...Array.from(frame.viewMatrix)].every((value) =>
        Number.isFinite(Math.fround(value)),
      )
    ) {
      throw new RangeError("SurfaceV4 requires finite camera and a GPU pre-exposure product");
    }
    for (const image of [
      frame.visibility,
      frame.depth,
      ...(frame.background ? [frame.background] : []),
      ...(frame.reactive ? [frame.reactive] : []),
    ]) {
      if (image.width !== frame.width || image.height !== frame.height || image.depthOrArrayLayers !== 1) {
        throw new RangeError("Native Surface input products must share the render extent");
      }
    }
    if (
      frame.visibility.format !== "r32uint" ||
      frame.depth.format !== "depth32float" ||
      (frame.background && frame.background.format !== "rgba16float") ||
      (frame.reactive && frame.reactive.format !== "rgba8unorm")
    ) {
      throw new RangeError("Native Surface winner/Aux formats violate their consumer contract");
    }
    for (const image of [frame.visibility, frame.depth]) {
      if ((image.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) {
        throw new RangeError("SurfaceV4 sampled input products require TEXTURE_BINDING usage");
      }
    }
    if (frame.background && (frame.background.usage & GPUTextureUsage.COPY_SRC) === 0) {
      throw new RangeError("SurfaceV4 background initialization image requires COPY_SRC usage");
    }
    if (
      frame.reactive !== undefined &&
      (frame.reactive.usage &
        (GPUTextureUsage.STORAGE_BINDING | (this.finalPixel ? 0 : GPUTextureUsage.RENDER_ATTACHMENT))) !==
        (GPUTextureUsage.STORAGE_BINDING | (this.finalPixel ? 0 : GPUTextureUsage.RENDER_ATTACHMENT))
    ) {
      throw new RangeError("SurfaceV4 reactive product requires STORAGE_BINDING and RENDER_ATTACHMENT usage");
    }
    const geometry = frame.geometry;
    if (
      (geometry.productHeap === undefined) !== (geometry.productBanks === undefined) ||
      (geometry.productBanks !== undefined && geometry.productBanks.length !== 4)
    ) {
      throw new Error("Virtual Geometry requires its complete heap and four-bank publication");
    }
    for (const buffer of [
      geometry.meshletWork,
      geometry.arena,
      geometry.vertexPayload,
      geometry.instances,
      frame.publication.data,
      ...(geometry.productHeap === undefined ? [] : [geometry.productHeap, ...geometry.productBanks!]),
    ]) {
      if (
        buffer.size < 4 ||
        buffer.size > Number(this.device.limits.maxStorageBufferBindingSize) ||
        (buffer.usage & GPUBufferUsage.STORAGE) === 0
      ) {
        throw new RangeError("SurfaceV4 borrowed GPU data requires STORAGE usage");
      }
    }
    for (const source of [geometry.source, geometry.sourcePayload]) {
      if (
        source.length !== 4 ||
        source.some((word) => !Number.isSafeInteger(word) || word < 0 || word > 0xffffffff)
      ) {
        throw new RangeError("SurfaceV4 geometry directories require four complete u32 words");
      }
    }
    const bins = frame.publication.bins;
    if (
      bins.length !== frame.routes.length ||
      bins.some(
        (bin, index) =>
          bin.programIndex !== frame.routes[index]!.programIndex ||
          bin.bindingSet !== frame.routes[index]!.bindingSet,
      )
    ) {
      throw new Error("SurfaceV4 routes must cover the complete publication bins in order");
    }
    for (const route of frame.routes) {
      if (!route.frameInputs.every(Number.isFinite)) {
        throw new RangeError("Native frame inputs must contain finite values");
      }
    }
  }

  /** Verify the compiled physical profile before allocating an extent candidate. */
  private validateProfiles(frame: NativeSurfaceFrame): void {
    if (
      frame.reflections &&
      (!Number.isFinite(frame.reflections.maxAlpha) ||
        frame.reflections.maxAlpha <= 0 ||
        frame.reflections.maxAlpha > 1 ||
        frame.reflections.receivers.size < frame.width * frame.height * SSSR_RECEIVER_BYTES ||
        frame.width * frame.height * SSSR_RECEIVER_BYTES > this.device.limits.maxStorageBufferBindingSize ||
        (frame.reflections.receivers.usage & (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)) !==
          (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST))
    ) {
      throw new RangeError("Native reflection receiver requires the complete writable viewport");
    }
    const compact = frame.publication.bins.length > 1;
    const product = frame.geometry.productHeap !== undefined;
    const settingsBytes = this.finalPixel
      ? FINAL_PIXEL_SURFACE_SETTINGS_BYTES
      : NATIVE_SURFACE_SETTINGS_BYTES;
    if (
      settingsBytes > this.device.limits.maxUniformBufferBindingSize ||
      settingsBytes > Number(this.device.limits.maxBufferSize)
    ) {
      throw new RangeError("SurfaceV4 frame settings exceed negotiated uniform limits");
    }
    for (const route of frame.routes) {
      const descriptor = frame.publication.descriptor(route.programIndex);
      if (
        descriptor.groups.length !== 4 ||
        descriptor.workgroupSize !== 64 ||
        descriptor.entryPoint !== "main"
      ) {
        throw new Error("SurfaceV4 requires its complete four-group native shader profile");
      }
      const geometry = descriptor.groups[0]!;
      const lighting = descriptor.groups[1]!;
      const material = descriptor.groups[2]!;
      const geometryBindings = [
        0,
        1,
        2,
        3,
        4,
        5,
        7,
        ...(this.reactive ? [8] : []),
        ...(this.finalPixel ? [6, 9] : []),
        ...(product ? [10, 11, 12, 13, 14] : []),
        ...(frame.reflections ? [15] : []),
      ];
      const usesVt = frame.publication.entries.some(
        (entry) => entry.programIndex === route.programIndex && entry.program.virtualTextures,
      );
      const materialBindings = [0, 3, 4, ...(usesVt ? [1] : []), ...(compact ? [2] : [])];
      if (
        geometry.length !== geometryBindings.length ||
        geometryBindings.some((binding) => !geometry.some((entry) => entry.binding === binding)) ||
        material.length !== materialBindings.length ||
        materialBindings.some((binding) => !material.some((entry) => entry.binding === binding))
      ) {
        throw new Error(
          "SurfaceV4 dense/compact, reactive or Product shader profile is incompatible with its resources",
        );
      }
      if ((lighting.length === 0) !== route.unlit) {
        throw new Error("SurfaceV4 Unlit route must match the compiled lighting profile");
      }
      for (const [group, bindings, type] of [
        [geometry, [0], "uniform"],
        [geometry, [1, 2, 3, 4, ...(product ? [10, 11, 12, 13, 14] : [])], "read-only-storage"],
        [geometry, frame.reflections ? [15] : [], "storage"],
        [material, [0, ...(compact ? [2] : [])], "read-only-storage"],
        [material, usesVt ? [1] : [], "storage"],
        [material, [3, 4], "uniform"],
      ] as const) {
        for (const binding of bindings) {
          if (group.find((entry) => entry.binding === binding)?.buffer?.type !== type) {
            throw new Error("SurfaceV4 native buffer access does not match its binding ABI");
          }
        }
      }
      if (
        geometry.find((entry) => entry.binding === 5)?.texture?.sampleType !== "uint" ||
        geometry.find((entry) => entry.binding === 7)?.storageTexture?.format !== "rgba16float" ||
        (this.reactive &&
          geometry.find((entry) => entry.binding === 8)?.storageTexture?.format !== "rgba8unorm") ||
        (this.finalPixel &&
          (geometry.find((entry) => entry.binding === 6)?.storageTexture?.format !== "rgba32float" ||
            geometry.find((entry) => entry.binding === 9)?.storageTexture?.format !== "rgba32uint"))
      ) {
        throw new Error("SurfaceV4 native image bindings do not match winner/HDR/reactive formats");
      }
      let storageBuffers = 0;
      let uniforms = 0;
      let sampled = 0;
      let storageTextures = 0;
      let samplers = 0;
      for (const group of descriptor.groups) {
        if (group.length > this.device.limits.maxBindingsPerBindGroup) {
          throw new RangeError("SurfaceV4 binding group exceeds negotiated limits");
        }
        for (const entry of group) {
          if (entry.buffer !== undefined) {
            if (entry.buffer.type === "uniform") {
              uniforms++;
            } else {
              storageBuffers++;
            }
          }
          if (entry.texture !== undefined) {
            sampled++;
          }
          if (entry.storageTexture !== undefined) {
            storageTextures++;
          }
          if (entry.sampler !== undefined) {
            samplers++;
          }
        }
      }
      if (
        descriptor.groups.length > this.device.limits.maxBindGroups ||
        storageBuffers > this.device.limits.maxStorageBuffersPerShaderStage ||
        uniforms > this.device.limits.maxUniformBuffersPerShaderStage ||
        sampled > this.device.limits.maxSampledTexturesPerShaderStage ||
        storageTextures > this.device.limits.maxStorageTexturesPerShaderStage ||
        samplers > this.device.limits.maxSamplersPerShaderStage
      ) {
        throw new RangeError("SurfaceV4 complete shader resources exceed negotiated limits");
      }
      const program = frame.publication.entries.find(
        (entry) => entry.programIndex === route.programIndex,
      )!.program;
      const inputBytes = Math.max(16, program.inputCount * 16);
      let requiredInputs = 0;
      program.inputs.forEach((input, index) => {
        if (input.domain === "dynamic" || input.domain === "nonlocal") {
          requiredInputs = (index + 1) * 16;
        }
      });
      if (
        route.frameInputs.byteLength % 16 !== 0 ||
        route.frameInputs.byteLength < requiredInputs ||
        route.frameInputs.byteLength > inputBytes ||
        inputBytes > this.device.limits.maxUniformBufferBindingSize ||
        inputBytes > Number(this.device.limits.maxBufferSize)
      ) {
        throw new RangeError("SurfaceV4 frame inputs must cover the compiled dynamic input profile");
      }
      this.validateEntries(
        lighting.filter((entry) => entry.binding !== 4),
        frame.lightingEntries.filter(
          (entry) => entry.binding !== 4 && lighting.some((expected) => expected.binding === entry.binding),
        ),
      );
      this.validateEntries(descriptor.groups[3]!, route.materialEntries);
    }
  }

  private validateEntries(
    layout: readonly GPUBindGroupLayoutEntry[],
    entries: readonly GPUBindGroupEntry[],
  ): void {
    if (
      entries.length !== layout.length ||
      new Set(entries.map((entry) => entry.binding)).size !== entries.length
    ) {
      throw new Error("SurfaceV4 binding resources must exactly cover their compiled profile");
    }
    for (const expected of layout) {
      const actual = entries.find((entry) => entry.binding === expected.binding);
      if (actual === undefined) {
        throw new Error("SurfaceV4 binding resources omit a compiled input");
      }
      if (expected.buffer !== undefined) {
        const resource = actual.resource as GPUBufferBinding;
        const uniform = expected.buffer.type === "uniform";
        const usage = uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE;
        const offset = resource.offset ?? 0;
        const size = resource.size ?? (resource.buffer?.size ?? 0) - offset;
        const alignment = uniform
          ? this.device.limits.minUniformBufferOffsetAlignment
          : this.device.limits.minStorageBufferOffsetAlignment;
        const limit = uniform
          ? this.device.limits.maxUniformBufferBindingSize
          : this.device.limits.maxStorageBufferBindingSize;
        if (
          resource.buffer === undefined ||
          (resource.buffer.usage & usage) === 0 ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset % alignment !== 0 ||
          !Number.isSafeInteger(size) ||
          size < Math.max(4, expected.buffer.minBindingSize ?? 0) ||
          size % 4 !== 0 ||
          size > Number(limit) ||
          offset + size > resource.buffer.size
        ) {
          throw new RangeError(
            "SurfaceV4 borrowed buffer binding violates its size, access or alignment profile",
          );
        }
      }
    }
  }

  private reusableAllocation(frame: NativeSurfaceFrame): ExtentAllocation | null {
    const allocation = this.state?.allocation;
    if (
      allocation !== undefined &&
      allocation.width === frame.width &&
      allocation.height === frame.height &&
      allocation.bins.plan.windowTiles[0] ===
        Math.ceil((frame.scgi?.lighting.plan.windowWidth ?? frame.width) / 8) &&
      allocation.bins.plan.windowTiles[1] ===
        Math.ceil((frame.scgi?.lighting.plan.windowRows ?? frame.height) / 8) &&
      allocation.publication === frame.publication &&
      allocation.borrowedOutput === (frame.output !== undefined)
    ) {
      return allocation;
    }
    return null;
  }

  private createState(
    frame: NativeSurfaceFrame,
    identity: readonly unknown[],
    preparedBins?: NativeExecutionBins,
  ): ExtentState {
    const previous = this.reusableAllocation(frame);
    const bins =
      previous?.bins ??
      preparedBins ??
      new NativeExecutionBins(this.device, {
        graphics: this.graphics,
        width: frame.width,
        height: frame.height,
        bins: frame.publication.bins,
        finalPixel: this.finalPixel,
        window:
          frame.scgi === undefined
            ? undefined
            : [frame.scgi.lighting.plan.windowWidth, frame.scgi.lighting.plan.windowRows],
      });
    const resources: GPUBuffer[] = previous?.resources ?? [];
    let allocation: ExtentAllocation | null = previous;
    let binBindings: NativeExecutionBinsBindings | null = null;
    let hdr: GPUTexture | null = null;
    const buffer = (size: number, values?: Uint32Array): GPUBuffer => {
      const result = this.device.createBuffer({
        label: "SurfaceV4/frame uniforms",
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: values !== undefined,
      });
      resources.push(result);
      this.track(result, "buffer", size);
      if (values !== undefined) {
        new Uint32Array(result.getMappedRange()).set(values);
        result.unmap();
      }
      return result;
    };
    try {
      if (previous === null && preparedBins === undefined && this.graphics === undefined) {
        throw new Error("Synchronous SurfaceV4 construction requires the admitted graphics pipeline cache");
      }
      const settings =
        previous?.settings ??
        buffer(this.finalPixel ? FINAL_PIXEL_SURFACE_SETTINGS_BYTES : NATIVE_SURFACE_SETTINGS_BYTES);
      const temporalView = this.finalPixel
        ? (previous?.temporalView ?? buffer(NATIVE_TEMPORAL_SEED_VIEW_BYTES))
        : undefined;
      const shadingView = previous?.shadingView ?? buffer(16);
      hdr =
        previous?.ownedHdr ??
        frame.output ??
        this.device.createTexture({
          label: "SurfaceV4/HDR",
          size: [frame.width, frame.height],
          format: "rgba16float",
          usage:
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
      if (previous === null && hdr !== frame.output) {
        this.track(hdr, "texture", frame.width * frame.height * 8);
      }
      const geometryEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: settings } },
        { binding: 1, resource: { buffer: frame.geometry.meshletWork } },
        { binding: 2, resource: { buffer: frame.geometry.arena } },
        { binding: 3, resource: { buffer: frame.geometry.vertexPayload } },
        { binding: 4, resource: { buffer: frame.geometry.instances } },
        { binding: 5, resource: createNativeTextureView(frame.visibility) },
        { binding: 7, resource: createNativeTextureView(hdr) },
      ];
      if (frame.reactive !== undefined) {
        geometryEntries.push({ binding: 8, resource: createNativeTextureView(frame.reactive) });
      }
      if (frame.temporal) {
        geometryEntries.push(
          { binding: 6, resource: createNativeTextureView(frame.temporal.seed) },
          { binding: 9, resource: createNativeTextureView(frame.temporal.identity) },
        );
      }
      if (frame.geometry.productHeap !== undefined) {
        if (frame.geometry.productBanks === undefined) {
          throw new Error("Virtual Geometry requires its complete four-bank source publication");
        }
        geometryEntries.push({ binding: 10, resource: { buffer: frame.geometry.productHeap } });
        frame.geometry.productBanks.forEach((bank, index) =>
          geometryEntries.push({ binding: 11 + index, resource: { buffer: bank } }),
        );
      }
      if (frame.reflections) {
        geometryEntries.push({ binding: 15, resource: { buffer: frame.reflections.receivers } });
      }
      const lightingEntries = [
        ...frame.lightingEntries.filter((entry) => entry.binding !== 4),
        { binding: 4, resource: { buffer: shadingView } },
      ];
      const routes: RouteState[] = [];
      frame.routes.forEach((route, bin) => {
        const pipeline = frame.publication.pipeline(route.programIndex);
        const descriptor = frame.publication.descriptor(route.programIndex);
        const constants =
          previous?.routeBuffers[bin]!.constants ?? buffer(16, new Uint32Array([bin, 0, 0, 0]));
        const program = frame.publication.entries.find(
          (entry) => entry.programIndex === route.programIndex,
        )!.program;
        const inputs = previous?.routeBuffers[bin]!.inputs ?? buffer(Math.max(16, program.inputCount * 16));
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: frame.publication.data } },
          { binding: 3, resource: { buffer: constants } },
          { binding: 4, resource: { buffer: inputs } },
        ];
        if (program.virtualTextures) {
          if (!frame.virtualFeedback) {
            throw new Error("Native VT program requires its frame feedback owner");
          }
          entries.push({ binding: 1, resource: { buffer: frame.virtualFeedback } });
        }
        if (bins.queue !== null) {
          entries.push({ binding: 2, resource: { buffer: bins.queue } });
        }
        const groups = [
          this.bindGroups.create(this.device, { layout: pipeline.layouts[0]!, entries: geometryEntries }),
          this.bindGroups.create(this.device, {
            layout: pipeline.layouts[1]!,
            entries: lightingEntries.filter((entry) =>
              descriptor.groups[1]!.some((expected) => expected.binding === entry.binding),
            ),
          }),
          this.bindGroups.create(this.device, { layout: pipeline.layouts[2]!, entries }),
          this.bindGroups.create(this.device, {
            layout: pipeline.layouts[3]!,
            entries: route.materialEntries,
          }),
        ];
        routes.push({
          pipeline: pipeline.pipeline,
          groups,
          constants,
          inputs,
          ...(program.virtualTextures
            ? {
                feedback: {
                  layout: pipeline.layouts[2]!,
                  entries: entries.filter((entry) => entry.binding !== 1),
                },
              }
            : {}),
        });
      });
      binBindings =
        bins.plan.mode === "compact"
          ? bins.createBindings(
              {
                visibility: createNativeTextureView(frame.visibility),
                meshletWork: frame.geometry.meshletWork,
                frameInstances: frame.geometry.instances,
                materialDirectory: frame.publication.data,
                generation: frame.generation,
                ...(frame.temporal
                  ? {
                      temporal: {
                        view: temporalView!,
                        seed: createNativeTextureView(frame.temporal.seed),
                        response: createNativeTextureView(frame.reactive!),
                        identity: createNativeTextureView(frame.temporal.identity),
                      },
                    }
                  : {}),
              },
              previous?.binSettings,
            )
          : null;
      allocation ??= {
        width: frame.width,
        height: frame.height,
        publication: frame.publication,
        borrowedOutput: frame.output !== undefined,
        bins,
        settings,
        shadingView,
        resources,
        routeBuffers: routes.map(({ constants, inputs }) => ({ constants, inputs })),
        ownedHdr: frame.output === undefined ? hdr : null,
        temporalView,
        binSettings: binBindings?.settings,
        references: 0,
      };
      allocation.references++;
      return {
        allocation,
        width: frame.width,
        height: frame.height,
        publication: frame.publication,
        bins,
        hdr,
        ownsHdr: frame.output === undefined,
        settings,
        shadingView,
        preExposure: frame.preExposure,
        camera: frame.camera,
        generationSource: frame.generationSource,
        resources,
        routes,
        identity,
        background: frame.background,
        reflectionReceivers: frame.reflections?.receivers,
        reactive: frame.reactive,
        binBindings,
        ...(this.finalPixel && bins.plan.mode === "empty"
          ? {
              backgroundSeedGroup: this.device.createBindGroup({
                layout: this.backgroundSeedPipeline!.requirePrepared().getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: temporalView! } },
                  { binding: 1, resource: createNativeTextureView(frame.temporal!.seed) },
                  { binding: 2, resource: createNativeTextureView(frame.reactive!) },
                  { binding: 3, resource: createNativeTextureView(frame.temporal!.identity) },
                  { binding: 4, resource: createNativeTextureView(frame.visibility) },
                ],
              }),
            }
          : {}),
      };
    } catch (error) {
      if (binBindings !== null) {
        bins.releaseBindings(binBindings);
      }
      if (previous !== null) {
        throw error;
      }
      if (hdr !== frame.output) {
        if (hdr) {
          this.releaseResource(hdr);
        }
      }
      resources.forEach((resource) => this.releaseResource(resource));
      bins.destroy();
      throw error;
    }
  }

  encode(encoder: GPUCommandEncoder): void {
    if (!this.prepared || this.encoded || this.preparedState === null) {
      throw new Error("SurfaceV4 requires one encoding of a prepared frame");
    }
    const state = this.preparedState;
    if (state.reflectionReceivers) {
      encoder.clearBuffer(state.reflectionReceivers, 0, state.width * state.height * SSSR_RECEIVER_BYTES);
    }
    encoder.copyBufferToBuffer(state.preExposure, 0, state.settings, 60, 4);
    encoder.copyBufferToBuffer(
      state.camera,
      PACKED_CAMERA_TYPE.fields.find((field) => field.name === "view_projection_matrix_inverse")!.offset,
      state.settings,
      144,
      64,
    );
    if (state.generationSource !== undefined) {
      encoder.copyBufferToBuffer(
        state.generationSource,
        GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS.generation,
        state.settings,
        44,
        4,
      );
      if (state.binBindings !== null) {
        encoder.copyBufferToBuffer(
          state.generationSource,
          GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS.generation,
          state.binBindings.settings,
          16,
          4,
        );
      }
    }
    if (state.binBindings !== null) {
      state.bins.encode(encoder, state.binBindings);
    }
    const target = state.hdr;
    const attachments: GPURenderPassColorAttachment[] = [];
    if (state.background !== undefined) {
      encoder.copyTextureToTexture({ texture: state.background }, { texture: target }, [
        state.width,
        state.height,
      ]);
    } else {
      attachments.push({
        view: createNativeTextureView(target),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      });
    }
    if (state.reactive !== undefined && !this.finalPixel) {
      attachments.push({
        view: createNativeTextureView(state.reactive),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      });
    }
    if (state.backgroundSeedGroup) {
      const background = encoder.beginComputePass({ label: "Final Pixel/empty scene Seed" });
      background.setPipeline(this.backgroundSeedPipeline!.requirePrepared());
      background.setBindGroup(0, state.backgroundSeedGroup);
      background.dispatchWorkgroups(Math.ceil(state.width / 8), Math.ceil(state.height / 8));
      background.end();
    }
    if (attachments.length !== 0) {
      const initialize = encoder.beginRenderPass({
        label: "SurfaceV4/HDR and Aux initialization",
        colorAttachments: attachments,
      });
      initialize.end();
    }
    const frame = this.scgiFrame!;
    const windowCount =
      frame.scgi === undefined
        ? 1
        : Math.ceil(state.width / frame.scgi.lighting.plan.windowWidth) *
          Math.ceil(state.height / frame.scgi.lighting.plan.windowRows);
    for (let window = 0; window < windowCount; window++) {
      let extent: readonly [number, number, number, number] = [0, 0, state.width, state.height];
      if (frame.scgi !== undefined) {
        extent = encodeScgiNativeWindow(
          frame.scgi,
          window,
          frame.geometry,
          frame.visibility,
          frame.lightingEntries,
          state.settings,
          this.giGatherPipelines.get(frame.geometry.productHeap !== undefined),
        );
      }
      for (const route of state.routes) {
        if (frame.scgi !== undefined) {
          const values = new Uint32Array([extent[0] | (extent[1] << 16), window * state.routes.length]);
          frame.scgi.command.writeBuffer(route.constants, 4, values.buffer, 0, values.byteLength);
        }
      }
      const pass = encoder.beginComputePass({ label: "SurfaceV4/native winner shading" });
      for (const [bin, route] of state.routes.entries()) {
        pass.setPipeline(route.pipeline);
        route.groups.forEach((group, index) => pass.setBindGroup(index, group));
        if (state.bins.queue !== null) {
          pass.dispatchWorkgroupsIndirect(state.bins.queue, state.bins.indirectOffset(bin, window));
        } else {
          pass.dispatchWorkgroups(Math.ceil(extent[2] / 8), Math.ceil(extent[3] / 8));
        }
      }
      pass.end();
    }
    this.encoded = true;
  }

  /** Macro dependency seam; callers declare every upstream product, including provider writes. */
  addToGraph(
    graph: FrameGraph,
    dependencies: readonly ResourceId[],
    reactive?: ResourceId,
    temporal?: { seed: ResourceId; identity: ResourceId },
  ): NativeSurfaceGraphProducts {
    if (!this.prepared) {
      throw new Error("SurfaceV4 frame must be prepared before graph construction");
    }
    if (this.reactive !== (reactive !== undefined)) {
      throw new Error("SurfaceV4 graph must declare every demanded reactive output");
    }
    if (this.finalPixel !== (temporal !== undefined)) {
      throw new Error("Surface graph must declare both Seed and identity writers");
    }
    const state = this.preparedState;
    const hdr = graph.import_resource(
      "SurfaceV4/HDR",
      { kind: "imported", domain: "internal-full" },
      this.hdr,
    );
    const pass = graph.add("SurfaceV4/native opaque", {}, (_data, _resources, context) => {
      const encoder = resolveGpuEncoder(context);
      if (encoder === undefined) {
        throw new Error("SurfaceV4 requires the frame's GPU command encoder");
      }
      if (this.preparedState !== state) {
        throw new Error("SurfaceV4 graph resources changed; rebuild the extent binding recipe");
      }
      this.encode(encoder);
    });
    dependencies.forEach((resource) => pass.read(resource));
    const output = pass.write(hdr);
    const reactiveOutput = reactive === undefined ? undefined : pass.write(reactive);
    return Object.freeze({
      hdr: output,
      reactive: reactiveOutput,
      seed: temporal ? pass.write(temporal.seed) : undefined,
      identity: temporal ? pass.write(temporal.identity) : undefined,
    });
  }

  commit(completion: Promise<void>): void {
    if (!this.prepared || !this.encoded || this.preparedState === null) {
      throw new Error("SurfaceV4 commit requires an encoded frame and its real submission fence");
    }
    const previous = this.state;
    this.state = this.preparedState;
    if (previous !== null && previous !== this.state) {
      this.retire(previous);
    }
    this.lastCompletion = completion;
    this.preparedState = null;
    this.prepared = false;
    this.encoded = false;
  }

  abort(): void {
    if (this.preparing) {
      ++this.prepareEpoch;
      return;
    }
    if (!this.prepared) {
      return;
    }
    if (this.preparedState !== null && this.preparedState !== this.state) {
      this.release(this.preparedState);
    }
    this.preparedState = null;
    this.prepared = false;
    this.encoded = false;
  }

  invalidate(): void {
    if (this.prepared || this.preparing) {
      throw new Error("SurfaceV4 cannot invalidate an active frame");
    }
    // No Surface history/cache exists. Temporal/effect owners invalidate their own products.
  }

  /** Retire the unused scene working set after an empty replacement submits.
   * Pipelines remain reusable; prior snapshots retain bindings until last use. */
  releaseFrameResources(): void {
    if (this.prepared || this.preparing || this.destroyed) {
      throw new Error("SurfaceV4 release requires a live frame boundary");
    }
    this.bindGroups.clear();
    if (this.state !== null) {
      const state = this.state;
      this.state = null;
      this.retire(state);
    }
  }

  private track(resource: GPUBuffer | GPUTexture, kind: "buffer" | "texture", bytes: number): void {
    const handle = this.graphics?.resource_accounting.created(
      { kind, category: "transient", owner: "SurfaceV4", bytes, label: resource.label },
      resource,
    );
    if (handle) {
      this.accountingHandles.set(resource, handle);
    }
  }

  private releaseResource(resource: GPUBuffer | GPUTexture): void {
    resource.destroy();
    const handle = this.accountingHandles.get(resource);
    if (handle) {
      this.graphics?.resource_accounting.destroyed(handle);
      this.accountingHandles.delete(resource);
    }
  }

  private release(state: ExtentState): void {
    if (state.binBindings !== null) {
      state.bins.releaseBindings(state.binBindings);
    }
    const allocation = state.allocation;
    allocation.references--;
    if (allocation.references === 0) {
      if (allocation.ownedHdr !== null) {
        this.releaseResource(allocation.ownedHdr);
      }
      allocation.bins.destroy();
      allocation.resources.forEach((resource) => this.releaseResource(resource));
    }
    this.retired.delete(state);
  }

  private retire(state: ExtentState): void {
    this.retired.add(state);
    if (this.state?.allocation !== state.allocation) state.bins.markStorageRetired();
    const resources: (GPUBuffer | GPUTexture)[] = [...state.resources];
    if (state.ownsHdr) {
      resources.push(state.hdr);
    }
    for (const resource of this.state?.allocation === state.allocation ? [] : resources) {
      const handle = this.accountingHandles.get(resource);
      if (handle) {
        this.graphics?.resource_accounting.setRetired(handle, true);
      }
    }
    void this.lastCompletion.then(
      () => this.release(state),
      () => this.release(state),
    );
  }

  destroy(): void {
    this.bindGroups.clear();
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    const releaseNeutral = () => {
      this.neutralBuffers.forEach((buffer) => this.releaseResource(buffer));
      this.neutralTextures.forEach((texture) => this.releaseResource(texture));
      this.neutralBuffers = [];
      this.neutralTextures = [];
      this.neutralEntries = null;
      if (this.neutralEnvironmentTexture !== null) {
        this.releaseResource(this.neutralEnvironmentTexture);
        this.neutralEnvironmentTexture = null;
      }
      this.neutralEnvironmentEntries = null;
    };
    void this.lastCompletion.then(releaseNeutral, releaseNeutral);
    ++this.prepareEpoch;
    this.prepared = false;
    if (this.preparedState !== null && this.preparedState !== this.state) {
      this.release(this.preparedState);
    }
    this.preparedState = null;
    if (this.state !== null) {
      const state = this.state;
      this.state = null;
      this.retire(state);
    }
  }
}
