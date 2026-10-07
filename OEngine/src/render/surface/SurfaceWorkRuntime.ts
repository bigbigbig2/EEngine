import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { SurfaceDiagnosticsCapture } from "../../debug/SurfaceDiagnosticsCapture.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import type { SurfaceDiagnosticsMode, SurfaceDiagnosticsIdentity } from "../../gpu/SurfaceDiagnosticsAbi.js";
import {
  planSurfaceWorkCapacity,
  SURFACE_WORK_BUDGET_BYTES,
  SURFACE_WORK_COHERENCE_HEADER,
  type SurfaceWorkCapacity
} from "../../gpu/GpuSurfaceWorkAbi.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import { SurfaceLightingBindings } from "./SurfaceLightingBindings.js";
import { SurfaceRadiometryPass } from "./SurfaceRadiometryPass.js";
import type { SurfaceWorkInput } from "./SurfaceWorkTypes.js";
import { SURFACE_WORK_COVERAGE_WGSL } from "../../shaders/surface_work.js";
import { SURFACE_WORK_COHERENCE_WGSL } from "../../shaders/surface_work_coherence.js";
import { APPEARANCE_CLOSURE_CACHE_WGSL } from "../../shaders/appearance_closure_cache.js";
import { APPEARANCE_CACHE_HEADER } from "../../gpu/GpuAppearanceClosureCacheAbi.js";
import { SURFACE_WORK_LIGHTING_WGSL } from "../../shaders/surface_work_lighting.js";
import { SURFACE_WORK_RECONSTRUCT_WGSL } from "../../shaders/surface_work_reconstruct.js";
import { SurfaceDiagnosticsPass } from "./SurfaceDiagnosticsPass.js";
import { SURFACE_DIAGNOSTICS_BYTE_SIZE } from "../../gpu/SurfaceDiagnosticsAbi.js";
export type { SurfaceWorkFrame, SurfaceSignalRevisions } from "./SurfaceWorkTypes.js";
export interface SurfaceWorkProducts {
  readonly radiance: ResourceId;
  readonly reactiveMask: ResourceId;
  readonly control: ResourceId;
  readonly heaps: readonly ResourceId[];
  readonly signals: readonly ResourceId[];
  readonly metadata: ResourceId;
  readonly diagnostics?: ResourceId;
}

type SignalHistoryRevision = Readonly<{
  environment: number;
  light: number;
  shadow: number;
  sun: number;
  ao: number;
  view: number;
  scene: number;
  publication: number;
}>;

/** A finite resource profile, independent of scene/material counts. Geometry
 * completion is private to Appearance; every exact destination is indexed.
 * Rate admission is optional and cannot remove mandatory coverage. */
export class SurfaceWorkRuntime {
  private readonly scratch: SurfaceFrameResources;
  private readonly providers: SurfaceLightingBindings;
  private readonly radiometry: SurfaceRadiometryPass;
  private readonly coverage: GPUComputePipeline;
  private readonly finalize: GPUComputePipeline;
  private readonly coherencePrefix: GPUComputePipeline;
  private readonly coherenceScatter: GPUComputePipeline;
  private readonly closureNominate: GPUComputePipeline;
  private readonly closureArguments: GPUComputePipeline;
  private readonly closurePublish: GPUComputePipeline;
  private readonly lighting: GPUComputePipeline;
  private readonly reconstruct: GPUComputePipeline;
  private readonly diagnostics: SurfaceDiagnosticsPass;
  private readonly fallbackUniform: GPUBuffer;
  private readonly fallbackPages: GPUBuffer;
  private readonly fallbackAo: GPUBuffer;
  private readonly fallbackDepth: GPUTexture;
  private readonly fallbackTransmission: GPUTexture;
  private readonly fallbackHistory: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly parameters = new Uint32Array(32);
  private readonly viewParameters = new Uint32Array(4);
  private readonly coherenceParameters = new Uint32Array(128);
  private readonly closureParameters = new Uint32Array(12);
  private readonly closureLayoutParameters = new Uint32Array(3);
  private prepared = false;
  private destroyed = false;
  private capacity: SurfaceWorkCapacity | null = null;
  private mode: SurfaceDiagnosticsMode = "off";
  private capture: SurfaceDiagnosticsCapture | null = null;
  private identity: Omit<SurfaceDiagnosticsIdentity, "frameId"> = { runId: "default", deviceEpoch: 0 };
  private reuse = true;
  private appearanceCacheReuse = true;
  private signalHistoryReuse = true;
  private spatialReuse = true;
  private overlayCapacity: number | null = null;
  private coherenceCapacity: number | undefined;
  private cachePerBin: number | undefined;
  private cacheSubmittedFrames = 0;
  private cacheNamespace = 0;
  private signalHistories: readonly [readonly GPUBuffer[], readonly GPUBuffer[]] | null = null;
  private signalHistorySize: readonly [number, number] = [0, 0];
  private signalHistoryReadIndex: 0 | 1 = 0;
  private signalHistoryWriteIndex: 0 | 1 = 1;
  private signalHistoryValid = false;
  private signalHistoryRevision: SignalHistoryRevision | null = null;
  private pendingSignalHistoryRevision: SignalHistoryRevision | null = null;
  private signalHistoryProduced = false;
  private signalHistoryGpuDone: Promise<void> | null = null;
  private signalHistoryDoneSettled = true;
  private signalHistoryActiveBytes = 0;
  private signalHistoryRetiredBytes = 0;
  private signalHistoryHandles: readonly ResourceHandle[] = [];
  constructor(
    private readonly device: GPUDevice,
    private readonly accounting?: ResourceAccounting
  ) {
    this.scratch = new SurfaceFrameResources(device, accounting, SURFACE_WORK_BUDGET_BYTES);
    this.providers = new SurfaceLightingBindings(device, this.scratch, accounting);
    this.radiometry = new SurfaceRadiometryPass(device, this.scratch);
    const pipeline = (label: string, code: string, entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({
        label,
        layout: "auto",
        compute: { module: device.createShaderModule({ label, code }), entryPoint }
      });
    this.coverage = pipeline("Surface/coverage", SURFACE_WORK_COVERAGE_WGSL, "coverage");
    this.finalize = pipeline("Surface/work arguments", SURFACE_WORK_COVERAGE_WGSL, "finalize");
    this.coherencePrefix = pipeline("Surface/template packets", SURFACE_WORK_COHERENCE_WGSL, "prefix");
    this.coherenceScatter = pipeline("Surface/template indices", SURFACE_WORK_COHERENCE_WGSL, "scatter");
    this.closureNominate = pipeline(
      "Surface/exact closure nomination",
      APPEARANCE_CLOSURE_CACHE_WGSL,
      "nominate"
    );
    this.closureArguments = pipeline(
      "Surface/exact closure arguments",
      APPEARANCE_CLOSURE_CACHE_WGSL,
      "arguments"
    );
    this.closurePublish = pipeline(
      "Surface/exact closure publication",
      APPEARANCE_CLOSURE_CACHE_WGSL,
      "publish"
    );
    this.lighting = pipeline("Surface/closed lighting", SURFACE_WORK_LIGHTING_WGSL, "lighting");
    this.reconstruct = pipeline("Surface/closed reconstruct", SURFACE_WORK_RECONSTRUCT_WGSL, "reconstruct");
    this.fallbackUniform = device.createBuffer({
      label: "Surface/disabled provider uniform",
      size: 256,
      usage: GPUBufferUsage.UNIFORM
    });
    this.fallbackPages = device.createBuffer({
      label: "Surface/disabled shadow pages",
      size: 32,
      usage: GPUBufferUsage.STORAGE
    });
    this.fallbackAo = device.createBuffer({
      label: "Surface/disabled AO",
      size: 4,
      usage: GPUBufferUsage.STORAGE
    });
    this.fallbackDepth = device.createTexture({
      label: "Surface/disabled shadow atlas",
      size: [1, 1],
      format: "depth32float",
      usage: GPUTextureUsage.TEXTURE_BINDING
    });
    this.fallbackTransmission = device.createTexture({
      label: "Surface/disabled transmission",
      size: [1, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING
    });
    this.fallbackHistory = device.createBuffer({
      label: "Surface/disabled signal history",
      size: 4,
      usage: GPUBufferUsage.STORAGE
    });
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    this.diagnostics = new SurfaceDiagnosticsPass(device, this.scratch, (command, source, frameId) => {
      if (this.capture === null || this.mode !== "detailed") {
        return;
      }
      const capture = this.capture;
      const ticket = capture.encodeReadback(command.gpu_encoder, source, { ...this.identity, frameId });
      if (ticket !== null) {
        command.recordReadback("surface-diagnostics", SURFACE_DIAGNOSTICS_BYTE_SIZE);
        command.onFinished.addOne(() => capture.markSubmitted(ticket));
        command.onAborted.addOne((_context: ShadeGPUCommandContext, cause: unknown) =>
          capture.cancel(ticket, cause)
        );
      }
    });
  }
  private plan(width: number, height: number, publication?: GpuAppearancePublication): SurfaceWorkCapacity {
    return planSurfaceWorkCapacity(
      width,
      height,
      this.device.limits,
      publication?.exactDagVaryingFields ?? 32767,
      publication?.exactDagScratchBytes ?? 16 * 1024 * 1024,
      publication?.surfaceHasLit ?? true,
      publication?.surfaceTemplateCount ?? 1,
      publication !== undefined && publication.surfaceCoherenceSetMask === 0 ? 0 : this.coherenceCapacity,
      this.reuse && this.appearanceCacheReuse && (publication?.surfaceCacheCandidateCount ?? 0) > 0,
      this.cachePerBin,
      this.reuse && this.signalHistoryReuse && (publication?.surfaceHasLit ?? true),
      publication?.surfaceCacheKeyWords ?? 96
    );
  }
  private recipe(capacity: SurfaceWorkCapacity): string {
    const namespace = this.cacheNamespace + Number(this.cacheSubmittedFrames >= 0xfffffffe);
    return `/${capacity.workStrideBytes}/${capacity.scratchBytes}/${capacity.closureCache.perBin}/${capacity.closureCache.keyWords}/${capacity.closureCache.slots}/${capacity.signalHistoryBytes}/${namespace}`;
  }
  canPrepareFrame(width: number, height: number, publication?: GpuAppearancePublication): boolean {
    const capacity = this.plan(width, height, publication);
    return this.scratch.canPrepare(width, height, capacity.scratchBytes, this.recipe(capacity),
      this.signalHistoryOverlap(width, height, capacity.signalHistoryBytes));
  }
  private signalHistoryOverlap(width: number, height: number, requiredBytes: number): number {
    const same = this.signalHistories !== null && requiredBytes > 0 &&
      this.signalHistorySize[0] === width && this.signalHistorySize[1] === height;
    return this.signalHistoryRetiredBytes + (same ? this.signalHistoryActiveBytes :
      requiredBytes + (this.signalHistoryDoneSettled ? 0 : this.signalHistoryActiveBytes));
  }
  private retireSignalHistories(): void {
    const old = this.signalHistories;
    this.signalHistories = null;
    this.signalHistoryValid = false;
    this.signalHistoryRevision = null;
    if (old === null) {
      return;
    }
    const bytes = this.signalHistoryActiveBytes;
    const handles = this.signalHistoryHandles;
    this.signalHistoryHandles = [];
    this.signalHistoryActiveBytes = 0;
    this.signalHistoryRetiredBytes += bytes;
    handles.forEach((handle) => this.accounting!.setRetired(handle, true));
    this.scratch.setExternalMemory(0, this.signalHistoryRetiredBytes);
    const destroy = (): void => {
      old.forEach((slot) => slot.forEach((buffer) => buffer.destroy()));
      handles.forEach((handle) => this.accounting!.destroyed(handle));
      this.signalHistoryRetiredBytes -= bytes;
      this.scratch.setExternalMemory(this.signalHistoryActiveBytes, this.signalHistoryRetiredBytes);
    };
    if (this.signalHistoryDoneSettled) {
      destroy();
    } else {
      void this.signalHistoryGpuDone!.then(destroy, destroy);
    }
  }
  private prepareSignalHistories(width: number, height: number, capacity: SurfaceWorkCapacity): void {
    const bytes = capacity.signalHistoryBytes;
    if (bytes === 0) {
      this.retireSignalHistories();
      return;
    }
    if (
      this.signalHistories !== null &&
      this.signalHistorySize[0] === width &&
      this.signalHistorySize[1] === height
    ) {
      return;
    }
    this.retireSignalHistories();
    this.signalHistoryActiveBytes = bytes;
    this.scratch.setExternalMemory(bytes, this.signalHistoryRetiredBytes);
    this.signalHistories = [0, 1].map((slot) =>
      Array.from({ length: 5 }, (_, bank) => this.device.createBuffer({
        label: `Surface/signal history/${slot}/${bank}`,
        size: bank < 4 ? capacity.signalBytes : capacity.signalHistoryRecipeBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      }))
    ) as unknown as readonly [readonly GPUBuffer[], readonly GPUBuffer[]];
    this.signalHistoryHandles = this.accounting === undefined ? [] : this.signalHistories.flatMap((slot, index) =>
      slot.map((buffer, bank) => this.accounting!.created({ kind: "buffer", category: "history",
        owner: "Surface/signal history", bytes: buffer.size, label: `Surface/signal history/${index}/${bank}` }, buffer)));
    this.signalHistorySize = [width, height];
    this.signalHistoryReadIndex = 0;
    this.signalHistoryWriteIndex = 1;
    this.signalHistoryValid = false;
  }
  private historyRevision(input: SurfaceWorkInput): SignalHistoryRevision {
    return Object.freeze({
      environment: input.revisions.environment,
      light: input.revisions.light,
      shadow: input.revisions.shadow,
      sun: input.revisions.sun,
      ao: input.revisions.ao ?? 0,
      view: input.viewRevision.value,
      scene: input.nonlocalRevision.value,
      publication: input.publication.surfaceCacheGeneration
    });
  }
  /**
   * Provider revisions invalidate only the signal layers that consume them.
   * Temporal Facts still performs the per-pixel identity/motion rejection;
   * this mask only describes frame-wide provider validity.
   */
  private signalHistoryMask(input: SurfaceWorkInput): number {
    const committed = this.signalHistoryRevision;
    if (!this.signalHistoryValid || committed === null || this.signalHistories === null) {
      return 0;
    }
    const current = this.historyRevision(input);
    if (current.scene !== committed.scene || current.publication !== committed.publication) return 0;
    let mask = 0;
    // Direct diffuse/specular/coat share the provider set and conservative
    // view dependency of the direct BRDF path.
    if (
      current.light === committed.light &&
      current.shadow === committed.shadow &&
      current.sun === committed.sun &&
      current.view === committed.view
    ) {
      mask |= (1 << 0) | (1 << 2) | (1 << 4);
    }
    // Irradiance is view independent; environment specular and coat retain the
    // camera dependency used by their reflection/DFG lookups.
    if (current.environment === committed.environment) mask |= 1 << 1;
    if (current.environment === committed.environment && current.view === committed.view) {
      mask |= (1 << 3) | (1 << 5);
    }
    return mask;
  }
  prepareFrame(width: number, height: number, _generation = 0, publication?: GpuAppearancePublication): void {
    if (this.destroyed || this.prepared) {
      throw new Error("SurfaceWork frame is already prepared or destroyed");
    }
    const capacity = this.plan(width, height, publication);
    if (!this.scratch.canPrepare(width, height, capacity.scratchBytes, this.recipe(capacity),
      this.signalHistoryOverlap(width, height, capacity.signalHistoryBytes))) {
      throw new Error("Surface resize must wait for submitted scratch retirement");
    }
    const recipe = this.recipe(capacity);
    if (this.cacheSubmittedFrames >= 0xfffffffe) {
      // A cell has at most one writer per submitted frame. Recreate the complete
      // resource namespace before any cell generation could wrap, with the same
      // fence/quota protocol as resize. No GPU readback controls current work.
      this.cacheNamespace++;
      this.cacheSubmittedFrames = 0;
    }
    this.scratch.prepare(width, height, recipe);
    this.prepareSignalHistories(width, height, capacity);
    this.signalHistoryProduced = false;
    this.pendingSignalHistoryRevision = null;
    this.capacity = capacity;
    this.prepared = true;
  }
  capacityEvidence(): SurfaceWorkCapacity | null {
    return this.capacity;
  }
  importUnlitProviders(
    graph: FrameGraph,
    bind: SurfaceResourceBinding
  ): ReturnType<SurfaceLightingBindings["importUnlitProviders"]> {
    return this.providers.importUnlitProviders(graph, bind);
  }
  setReuseEnabled(enabled: boolean): void {
    if (this.prepared) {
      throw new Error("Cannot change Surface rates during a frame");
    }
    this.reuse = enabled;
    if (!enabled) {
      this.signalHistoryValid = false;
      this.signalHistoryRevision = null;
    }
  }
  /** Independent optional strategies share the same producer and fallback.
   * This also permits all-cost attribution without changing material math. */
  setReuseStrategies(options: Readonly<{ appearanceCache: boolean; signalHistory: boolean; spatial: boolean }>): void {
    if (this.prepared) {
      throw new Error("Cannot change Surface reuse strategies during a frame");
    }
    this.appearanceCacheReuse = options.appearanceCache;
    this.signalHistoryReuse = options.signalHistory;
    this.spatialReuse = options.spatial;
    if (!options.signalHistory) {
      this.signalHistoryValid = false;
      this.signalHistoryRevision = null;
    }
  }
  setOverlayCapacity(tiles: number | null): void {
    if (
      this.prepared ||
      (tiles !== null && (!Number.isSafeInteger(tiles) || tiles < 0 || tiles > 0xffffffff))
    ) {
      throw new RangeError("Invalid Surface optional tile capacity");
    }
    this.overlayCapacity = tiles;
  }
  setDiagnosticsMode(mode: SurfaceDiagnosticsMode): void {
    if (this.prepared) {
      throw new Error("Cannot change Surface diagnostics during a frame");
    }
    this.mode = mode;
  }
  setCoherenceCapacity(capacity: number | undefined): void {
    if (this.prepared || (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 0))) {
      throw new RangeError("Invalid or in-frame Surface coherence capacity change");
    }
    this.coherenceCapacity = capacity;
  }
  setClosureCacheCapacity(perBin: number | undefined): void {
    if (
      this.prepared ||
      (perBin !== undefined && (!Number.isSafeInteger(perBin) || perBin < 0 || perBin > 65536))
    ) {
      throw new RangeError("Invalid or in-frame Appearance cache capacity change");
    }
    this.cachePerBin = perBin;
  }
  setDiagnosticsCapture(
    capture: SurfaceDiagnosticsCapture | null,
    identity: Omit<SurfaceDiagnosticsIdentity, "frameId"> = { runId: "default", deviceEpoch: 0 }
  ): void {
    if (this.prepared) {
      throw new Error("Cannot change Surface capture during a frame");
    }
    this.capture = capture;
    this.identity = identity;
  }
  private writeSettings(
    command: ShadeGPUCommandContext,
    buffer: GPUBuffer,
    input: SurfaceWorkInput,
    capacity: SurfaceWorkCapacity,
    bank: number,
    set = 0,
    coverage = false,
    reserved = 0,
    appearancePhase = 0
  ): void {
    const offsets = input.publication.surfaceMetadataOffsets;
    const values = this.parameters;
    values.set([
      input.width,
      input.height,
      bank,
      capacity.bankRows,
      capacity.bankPixels,
      capacity.tilesX,
      capacity.bankTiles,
      capacity.tileBase,
      capacity.queueBase,
      capacity.recipeBase,
      set,
      offsets.exactFieldOffsets,
      offsets.constantFields,
      offsets.constants,
      offsets.routes,
      offsets.runtimeInputs,
      input.publication.exactDagLanes,
      input.publication.surfaceWorkScratchWords,
      this.mode === "detailed" ? 1 : 0,
      input.frame.generation,
      input.frame.sourceGeometry,
      input.frame.sourceMeshlet,
      input.frame.sourceMeshletVertices,
      input.frame.sourceMeshletTriangles,
      input.frame.sourceVertexData,
      capacity.hotWords,
      0,
      input.frame.geometryArenaHeader,
      Math.min(this.overlayCapacity ?? capacity.bankTiles, capacity.bankTiles),
      (this.reuse && this.spatialReuse ? 1 : 0) | (appearancePhase << 30),
      offsets.radiometry,
      reserved
    ]);
    if (coverage) {
      values[20] = offsets.materialLookupCount;
      values[21] = offsets.materialLookup;
    }
    command.writeBuffer(buffer, 0, values.buffer, 0, 128);
  }
  /** S0 publishes values and their versions before every direct history reader.
   * The returned temporary is also the sole Surface lane product at S5. */
  addPublicationToGraph(
    graph: FrameGraph,
    input: {
      publication: GpuAppearancePublication;
      metadata: ResourceId;
      camera: ResourceId;
      textureBanks: readonly (readonly ResourceId[])[];
      frame: Readonly<{ value: number }>;
      bind: SurfaceResourceBinding;
    }
  ): { metadata: ResourceId; temporary: ResourceId } {
    const code = graph.import_resource(
      "Surface/Appearance instruction data",
      { kind: "imported" },
      input.bind("Surface/Appearance instruction data", () => input.publication.exactDagCode)
    );
    const products = input.publication.exactDagProducts.map((buffer, bank) =>
      graph.import_resource(
        "Surface/Appearance products " + bank,
        { kind: "imported" },
        input.bind("Surface/Appearance products " + bank, () => buffer)
      )
    );
    const temporary = this.scratch.importBuffer(
      graph,
      input.bind,
      "Surface/Appearance live lanes",
      input.publication.exactDagScratchBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    );
    const node = graph.add("Surface/publication values and versions", {}, (_data, resources, context) =>
      input.publication.encodeWorkPublication(
        context.encoder as ShadeGPUCommandContext,
        resources.get(temporary) as GPUBuffer,
        input.frame.value,
        resources.get(input.camera) as GPUBuffer,
        input.publication.requiresUniformResources
          ? input.textureBanks.map((banks) =>
              banks.map((id) => this.scratch.resolveTextureView(resources.get(id) as object))
            )
          : undefined,
        this.mode === "detailed"
      )
    );
    for (const id of [
      code,
      input.metadata,
      input.camera,
      ...(input.publication.requiresUniformResources ? [...products, ...input.textureBanks.flat()] : [])
    ])
      node.read(id);
    return { metadata: node.write(input.metadata), temporary: node.write(temporary) };
  }

  addToGraph(graph: FrameGraph, input: SurfaceWorkInput): SurfaceWorkProducts {
    if (!this.prepared || this.capacity === null) {
      throw new Error("SurfaceWork requires prepared capacity");
    }
    const capacity = this.capacity;
    const factsMotion = input.factsMotion;
    const actual = this.plan(input.width, input.height, input.publication);
    if (this.recipe(actual) !== this.recipe(capacity)) {
      throw new Error("Surface publication changed after capacity preparation");
    }
    const bindings = new Map<string, object>();
    const bind: SurfaceResourceBinding = <T extends object>(name: string, resolve: () => T): T => {
      let value = bindings.get(name);
      if (value === undefined) {
        value = input.historyBinding(name, resolve);
        bindings.set(name, value);
      }
      return value as T;
    };
    const imported = (name: string, value: object): ResourceId =>
      graph.import_resource(
        name,
        { kind: "imported" },
        bind(name, () => value)
      );
    const storage = (name: string, bytes: number, extra = 0): ResourceId =>
      this.scratch.importBuffer(
        graph,
        bind,
        name,
        bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra
      );
    let control = storage("Surface/domain work control", capacity.controlBytes);
    let temporary = input.appearanceTemporary;
    let uniform = this.scratch.importBuffer(
      graph,
      bind,
      "Surface/work settings",
      128,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );
    let indirect = this.scratch.importBuffer(
      graph,
      bind,
      "Surface/work indirect",
      capacity.closureCache.perBin > 0 ? 2048 : 1536,
      GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
    );
    let view = this.scratch.importBuffer(
      graph,
      bind,
      "Surface/lighting view",
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );
    const heaps = Array.from({ length: 4 }, (_, bank) =>
      storage("Surface/closed heap " + bank, capacity.heapBytes)
    );
    const historyBuffer = (name: string, read: boolean, bank: number): ResourceId => graph.import_resource(
      name, { kind: "imported" }, bind(name, () => this.signalHistories === null ? this.fallbackHistory :
        this.signalHistories[read ? this.signalHistoryReadIndex : this.signalHistoryWriteIndex][bank]!));
    const signals = Array.from({ length: 4 }, (_, bank) => this.signalHistories === null
      ? storage("Surface/closed signals " + bank, capacity.signalBytes)
      : historyBuffer("Surface/closed signals " + bank, false, bank));
    const historyRead = Array.from({ length: 5 }, (_, bank) =>
      historyBuffer("Surface/signal history read " + bank, true, bank));
    let historyWrite = this.signalHistories === null ? null :
      historyBuffer("Surface/signal history owner recipes", false, 4);
    const code = imported("Surface/Appearance instruction data", input.publication.exactDagCode);
    const products = input.publication.exactDagProducts.map((buffer, bank) =>
      imported("Surface/Appearance products " + bank, buffer)
    );
    const fallbackUniform = imported("Surface/disabled provider parameters", this.fallbackUniform);
    const pages = imported("Surface/disabled shadow pages", this.fallbackPages);
    const depth = imported("Surface/disabled shadow atlas", this.fallbackDepth);
    const transmission = imported("Surface/disabled transmission", this.fallbackTransmission);
    const ao = input.scalarAo ?? imported("Surface/disabled AO", this.fallbackAo);
    let metadata = input.appearanceMetadata;
    const add = (
      label: string,
      reads: readonly ResourceId[],
      writes: readonly ResourceId[],
      encode: (resources: { get(id: ResourceId): unknown }, command: ShadeGPUCommandContext) => void
    ): ResourceId[] => {
      const node = graph.add(label, {}, (_data, resources, context) =>
        encode(resources, context.encoder as ShadeGPUCommandContext)
      );
      for (const id of reads) {
        node.read(id);
      }
      return writes.map((id) => node.write(id));
    };
    const bufferEntry = (
      resources: { get(id: ResourceId): unknown },
      binding: number,
      id: ResourceId
    ): GPUBindGroupEntry => ({ binding, resource: { buffer: resources.get(id) as GPUBuffer } });
    const textureEntry = (
      resources: { get(id: ResourceId): unknown },
      binding: number,
      id: ResourceId
    ): GPUBindGroupEntry => ({
      binding,
      resource: this.scratch.resolveTextureView(resources.get(id) as object)
    });
    const run = (
      command: ShadeGPUCommandContext,
      pipeline: GPUComputePipeline,
      groups: readonly (readonly GPUBindGroupEntry[])[],
      dispatch: (pass: GPUComputePassEncoder) => void,
      label = pipeline.label
    ): void => {
      const pass = command.beginComputePass({ label });
      pass.setPipeline(pipeline);
      groups.forEach((entries, index) =>
        pass.setBindGroup(index, this.scratch.obtainBindGroup(pipeline, index, entries))
      );
      dispatch(pass);
      pass.end();
    };
    {
      const previous = control;
      [control] = add("Surface/reset work control", [], [control], (resources, command) => {
        const buffer = resources.get(previous) as GPUBuffer;
        command.gpu_encoder!.clearBuffer(buffer, 0, 2048);
        if (capacity.histogramWords > 0) {
          command.gpu_encoder!.clearBuffer(buffer, capacity.histogramBase * 4, capacity.histogramWords * 4);
        }
        for (let bin = 0; bin < 16; bin++) {
          const at = bin * 8;
          this.coherenceParameters.set(
            [
              capacity.histogramBase + bin * capacity.templateCount * 3,
              capacity.coherenceIndexBase + bin * capacity.coherenceCapacity,
              (input.publication.surfaceCoherenceSetMask & (1 << bin % 4)) !== 0
                ? capacity.coherenceCapacity
                : 0,
              capacity.templateCount,
              0,
              capacity.coherenceCapacity > 0 &&
              (input.publication.surfaceCoherenceSetMask & (1 << bin % 4)) !== 0
                ? 1
                : 0,
              0,
              0
            ],
            at
          );
        }
        command.writeBuffer(
          buffer,
          SURFACE_WORK_COHERENCE_HEADER * 4,
          this.coherenceParameters.buffer,
          0,
          this.coherenceParameters.byteLength
        );
        const cache = capacity.closureCache;
        if (cache.perBin > 0) {
          // Request payload/map writes are demand-owned. Only table indices and
          // counters need reset; persistent store cells are never frame-cleared.
          command.gpu_encoder!.clearBuffer(buffer, cache.nominationBase * 4, cache.slots * 4);
          command.gpu_encoder!.clearBuffer(buffer, cache.binBase * 4, 32 * 2 * 4);
          this.closureParameters.set([
            cache.perBin,
            cache.slots,
            cache.mapBase,
            cache.requestBase,
            cache.nominationBase,
            cache.storeBase,
            cache.binBase,
            cache.queueBase,
            cache.argsBase,
            input.publication.surfaceCacheGeneration,
            input.publication.exactDagLanes,
            this.mode === "detailed" ? 1 : 0
          ]);
          this.closureLayoutParameters.set([cache.keyWords, cache.requestWords, cache.cellWords]);
          command.writeBuffer(buffer, (APPEARANCE_CACHE_HEADER + 24) * 4,
            this.closureLayoutParameters.buffer, 0, this.closureLayoutParameters.byteLength);
          command.writeBuffer(
            buffer,
            APPEARANCE_CACHE_HEADER * 4,
            this.closureParameters.buffer,
            0,
            this.closureParameters.byteLength
          );
        }
      }) as [ResourceId];
    }
    if (input.publication.surfaceHasLit) {
      metadata = this.radiometry.addToGraph(graph, {
        metadata,
        offset: input.publication.surfaceMetadataOffsets.radiometry,
        lightRecords: input.lightRecords,
        clusters: input.clusters.data,
        sun: input.physicalSun?.parameters ?? null,
        transmittance: input.physicalSun?.transmittance ?? null
      });
    }
    for (let bank = 0; bank < 4; bank++) {
      const heap = heaps[bank]!;
      const currentControl = control;
      const currentUniform = uniform;
      [heaps[bank], control, uniform] = add(
        "Surface/coverage bank " + bank,
        [input.visibility, input.meshletWork, metadata, code],
        [heap, control, uniform],
        (resources, command) => {
          this.writeSettings(
            command,
            resources.get(currentUniform) as GPUBuffer,
            input,
            capacity,
            bank,
            0,
            true
          );
          run(
            command,
            this.coverage,
            [
              [
                bufferEntry(resources, 0, currentUniform),
                textureEntry(resources, 1, input.visibility),
                bufferEntry(resources, 2, input.meshletWork),
                bufferEntry(resources, 3, metadata),
                bufferEntry(resources, 4, code),
                bufferEntry(resources, 5, heap),
                bufferEntry(resources, 6, currentControl)
              ]
            ],
            (pass) => pass.dispatchWorkgroups(capacity.bankTiles)
          );
        }
      ) as [ResourceId, ResourceId, ResourceId];
    }
    if (capacity.coherenceCapacity > 0) {
      const previous = control;
      [control] = add("Surface/template count prefix packets", [control], [control], (resources, command) => {
        run(command, this.coherencePrefix, [[bufferEntry(resources, 6, previous)]], (pass) =>
          pass.dispatchWorkgroups(16)
        );
      }) as [ResourceId];
    }
    {
      const currentControl = control;
      const currentUniform = uniform;
      [control, uniform] = add(
        "Surface/finalize work arguments",
        [control],
        [control, uniform],
        (resources, command) => {
          this.writeSettings(command, resources.get(currentUniform) as GPUBuffer, input, capacity, 0);
          run(
            command,
            this.finalize,
            [[bufferEntry(resources, 0, currentUniform), bufferEntry(resources, 6, currentControl)]],
            (pass) => pass.dispatchWorkgroups(1)
          );
        }
      ) as [ResourceId, ResourceId];
      const finalized = control;
      const previousIndirect = indirect;
      [indirect] = add("Surface/publish work arguments", [finalized], [indirect], (resources, command) =>
        command.gpu_encoder!.copyBufferToBuffer(
          resources.get(finalized) as GPUBuffer,
          0,
          resources.get(previousIndirect) as GPUBuffer,
          0,
          1536
        )
      ) as [ResourceId];
    }

    const appearancePhase = (phase: number): void => {
      for (let bank = 0; bank < 4; bank++) {
        for (let set = 0; set < 8; set++) {
          if (
            !(phase === 0 ? input.publication.surfaceWorkProfiles : input.publication.surfaceCacheProfiles)[
              set
            ]
          ) {
            continue;
          }
          const sourceIds = [
            input.frameAttributes,
            input.meshletWork,
            input.sourceHeap,
            input.vertexPayload,
            input.frameInstances,
            input.camera,
            ...(input.product === null ? [] : [input.product.heap, ...input.product.banks])
          ];
          const heap = heaps[bank]!;
          if (
            (phase === 1 || (phase === 0 &&
              (capacity.closureCache.perBin === 0 || !input.publication.surfaceCacheProfiles[set]))) &&
            capacity.coherenceCapacity > 0 &&
            (set & 1) !== 0 &&
            (input.publication.surfaceCoherenceSetMask & (1 << (set >> 1))) !== 0
          ) {
            const currentControl = control;
            const currentUniform = uniform;
            [control, uniform] = add(
              "Surface/template scatter bank " + bank + " set " + set,
              [heap, control, code, indirect],
              [control, uniform],
              (resources, command) => {
                this.writeSettings(
                  command,
                  resources.get(currentUniform) as GPUBuffer,
                  input,
                  capacity,
                  bank,
                  set
                );
                run(
                  command,
                  this.coherenceScatter,
                  [
                    [
                      bufferEntry(resources, 0, currentUniform),
                      bufferEntry(resources, 4, code),
                      bufferEntry(resources, 5, heap),
                      bufferEntry(resources, 6, currentControl)
                    ]
                  ],
                  (pass) =>
                    pass.dispatchWorkgroupsIndirect(
                      resources.get(indirect) as GPUBuffer,
                      (64 + (bank * 8 + set) * 4) * 4
                    )
                );
              }
            ) as [ResourceId, ResourceId];
          }
          const currentControl = control;
          const currentTemporary = temporary;
          const currentUniform = uniform;
          const currentIndirect = indirect;
          const textureBanks = input.textureBanks[Math.floor(set / 2)]!;
          const pipeline = input.publication.workPipeline(input.product !== null, (set & 1) === 0).pipeline;
          const results = add(
            "Surface/" +
              ["Geometry Appearance", "closure keys", "closure misses"][phase] +
              " bank " +
              bank +
              " set " +
              set,
            [
              heap,
              control,
              currentTemporary,
              code,
              metadata,
              currentIndirect,
              ...products,
              ...sourceIds,
              ...textureBanks
            ],
            [heap, control, temporary, uniform],
            (resources, command) => {
              this.writeSettings(
                command,
                resources.get(currentUniform) as GPUBuffer,
                input,
                capacity,
                bank,
                set,
                false,
                input.publication.exactDagProductBankWords,
                phase
              );
              const source = [
                bufferEntry(resources, 0, input.meshletWork),
                bufferEntry(resources, 1, input.sourceHeap),
                bufferEntry(resources, 2, input.vertexPayload),
                bufferEntry(resources, 3, input.frameInstances)
              ];
              if (input.product !== null) {
                source.push(bufferEntry(resources, 4, input.product.heap));
                input.product.banks.forEach((id, index) =>
                  source.push(bufferEntry(resources, 5 + index, id))
                );
              }
              source.push(
                bufferEntry(resources, 9, input.camera),
                bufferEntry(resources, 10, currentUniform)
              );
              const data = [
                bufferEntry(resources, 0, code),
                bufferEntry(resources, 1, metadata),
                bufferEntry(resources, 2, currentTemporary),
                bufferEntry(resources, 3, heap),
                bufferEntry(resources, 4, products[0]!),
                bufferEntry(resources, 5, products[1]!),
                bufferEntry(resources, 6, currentControl)
              ];
              const textures = input.publication.workTextureEntries(
                textureBanks.map((id) => this.scratch.resolveTextureView(resources.get(id) as object))
              );
              run(
                command,
                pipeline,
                [source, data, textures],
                (pass) =>
                  pass.dispatchWorkgroupsIndirect(
                    resources.get(currentIndirect) as GPUBuffer,
                    phase === 2 ? 1536 + (bank * 8 + set) * 16 : (64 + (bank * 8 + set) * 4) * 4
                  ),
                phase === 1
                  ? "Surface/closure key inputs"
                  : phase === 2
                    ? "Surface/unique closure evaluations"
                    : (set & 1) === 0
                      ? "Surface/fixed Appearance"
                      : "Surface/Geometry Appearance generic"
              );
            }
          );
          heaps[bank] = results[0]!;
          control = results[1]!;
          temporary = results[2]!;
          uniform = results[results.length - 1]!;
        }
      }
    };
    if (capacity.closureCache.perBin > 0) {
      appearancePhase(1);
      const requests = control;
      [control] = add(
        "Surface/nominate exact closure requests",
        [control],
        [control],
        (resources, command) => {
          run(command, this.closureNominate, [[bufferEntry(resources, 0, requests)]], (pass) =>
            pass.dispatchWorkgroups(32)
          );
        }
      ) as [ResourceId];
      const nominated = control;
      [control] = add("Surface/unique closure arguments", [control], [control], (resources, command) => {
        run(command, this.closureArguments, [[bufferEntry(resources, 0, nominated)]], (pass) =>
          pass.dispatchWorkgroups(1)
        );
      }) as [ResourceId];
      const args = control;
      const previousIndirect = indirect;
      [indirect] = add(
        "Surface/publish unique closure arguments",
        [control],
        [indirect],
        (resources, command) => {
          command.gpu_encoder!.copyBufferToBuffer(
            resources.get(args) as GPUBuffer,
            capacity.closureCache.argsBase * 4,
            resources.get(previousIndirect) as GPUBuffer,
            1536,
            512
          );
        }
      ) as [ResourceId];
      appearancePhase(2);
    }
    appearancePhase(0);
    if (capacity.closureCache.perBin > 0) {
      const consumed = control;
      // All slot refs have now been consumed into the existing field products.
      // Publication can evict here; Lighting/Reconstruct read those products.
      [control] = add(
        "Surface/commit exact closure values",
        [control, ...heaps],
        [control],
        (resources, command) => {
          run(command, this.closurePublish, [[bufferEntry(resources, 0, consumed)]], (pass) =>
            pass.dispatchWorkgroups(32)
          );
        }
      ) as [ResourceId];
    }
    if (input.publication.surfaceHasLit) {
      const sun = input.physicalSun?.parameters ?? fallbackUniform;
      const solarTransmission = input.physicalSun?.transmittance ?? transmission;
      const shadowUniform = input.shadow?.lightProjection ?? fallbackUniform;
      const shadowPages = input.shadow?.virtualPageTable ?? pages;
      const shadowDepth = input.shadow?.physicalAtlasDepth ?? depth;
      for (let bank = 0; bank < 4; bank++) {
        const currentControl = control;
        const currentUniform = uniform;
        const currentView = view;
        const heap = heaps[bank]!;
        const signal = signals[bank]!;
        const providerIds = [
          input.lightRecords,
          input.clusters.parameters,
          input.clusters.lookup,
          input.clusters.data,
          input.clusters.activeLightList,
          input.camera,
          input.environment.diffuse,
          input.environment.specular,
          input.environment.dfg,
          sun,
          solarTransmission,
          shadowUniform,
          shadowPages,
          shadowDepth,
          input.factsMask,
          input.visibility,
          factsMotion,
          ...historyRead
        ];
        [signals[bank], control, uniform, view] = add(
          "Surface/lighting bank " + bank,
          [heap, metadata, control, indirect, ...providerIds],
          [signal, control, uniform, view],
          (resources, command) => {
            const signalHistoryMask = this.reuse && this.signalHistoryReuse ? this.signalHistoryMask(input) : 0;
            if (this.signalHistories !== null) {
              this.pendingSignalHistoryRevision = this.historyRevision(input);
              this.signalHistoryProduced = true;
            }
            this.writeSettings(
              command,
              resources.get(currentUniform) as GPUBuffer,
              input,
              capacity,
              bank,
              0,
              false,
              (input.shadow === null ? 0 : 1) |
                (input.physicalSun === null ? 0 : 2) |
                signalHistoryMask << 2
            );
            this.viewParameters.set([input.width, input.height, input.frame.generation, 0]);
            command.writeBuffer(
              resources.get(currentView) as GPUBuffer,
              0,
              this.viewParameters.buffer,
              0,
              16
            );
            run(
              command,
              this.lighting,
              [
                [
                  bufferEntry(resources, 0, currentUniform),
                  bufferEntry(resources, 1, heap),
                  bufferEntry(resources, 2, metadata),
                  bufferEntry(resources, 3, currentControl),
                  bufferEntry(resources, 4, signal),
                  bufferEntry(resources, 5, historyRead[0]!),
                  bufferEntry(resources, 8, historyRead[1]!),
                  bufferEntry(resources, 9, historyRead[2]!),
                  bufferEntry(resources, 10, historyRead[3]!),
                  bufferEntry(resources, 11, historyRead[4]!),
                  textureEntry(resources, 6, input.factsMask),
                  textureEntry(resources, 7, factsMotion),
                  textureEntry(resources, 12, input.visibility),
                  textureEntry(resources, 13, input.environment.diffuse),
                  textureEntry(resources, 14, input.environment.specular),
                  textureEntry(resources, 15, input.environment.dfg),
                  bufferEntry(resources, 16, sun),
                  textureEntry(resources, 17, solarTransmission),
                  { binding: 18, resource: this.sampler }
                ],
                [
                  bufferEntry(resources, 0, input.lightRecords),
                  bufferEntry(resources, 2, input.clusters.parameters),
                  bufferEntry(resources, 3, input.clusters.lookup),
                  bufferEntry(resources, 4, input.clusters.data)
                ],
                [bufferEntry(resources, 0, currentView), bufferEntry(resources, 1, input.camera)],
                [
                  bufferEntry(resources, 0, shadowUniform),
                  bufferEntry(resources, 1, shadowPages),
                  textureEntry(resources, 2, shadowDepth)
                ]
              ],
              (pass) =>
                pass.dispatchWorkgroupsIndirect(resources.get(indirect) as GPUBuffer, (192 + bank * 4) * 4)
            );
          }
        ) as [ResourceId, ResourceId, ResourceId, ResourceId];
      }
    }
    if (input.publication.surfaceHasLit && historyWrite !== null) {
      this.signalHistoryProduced = true;
      const currentControl = control;
      const destination = historyWrite;
      historyWrite = add("Surface/publish signal owner recipes", [control, ...signals], [historyWrite],
        (resources, command) => command.gpu_encoder!.copyBufferToBuffer(
          resources.get(currentControl) as GPUBuffer, capacity.recipeBase * 4,
          resources.get(destination) as GPUBuffer, 0, capacity.signalHistoryRecipeBytes))[0]!;
    }
    let radiance!: ResourceId;
    let reactiveMask!: ResourceId;
    for (let bank = 0; bank < 4; bank++) {
      const currentControl = control;
      const currentUniform = uniform;
      const heap = heaps[bank]!;
      const signal = signals[bank]!;
      let outputRadiance!: ResourceId;
      let outputReactive!: ResourceId;
      const node = graph.add("Surface/reconstruct bank " + bank, {}, (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        this.writeSettings(
          command,
          resources.get(currentUniform) as GPUBuffer,
          input,
          capacity,
          bank,
          0,
          false,
          input.scalarAo === null ? 0 : 1
        );
        run(
          command,
          this.reconstruct,
          [
            [
              bufferEntry(resources, 0, currentUniform),
              bufferEntry(resources, 1, heap),
              bufferEntry(resources, 2, metadata),
              bufferEntry(resources, 3, currentControl),
              bufferEntry(resources, 4, signal),
              textureEntry(resources, 5, input.factsMask),
              bufferEntry(resources, 6, input.preExposure),
              textureEntry(resources, 7, outputRadiance),
              textureEntry(resources, 8, outputReactive),
              bufferEntry(resources, 9, ao)
            ]
          ],
          (pass) => pass.dispatchWorkgroups(capacity.tilesX, capacity.bankRows / 8)
        );
      });
      for (const id of [heap, signal, metadata, control, input.factsMask, input.preExposure, ao]) {
        node.read(id);
      }
      control = node.write(control);
      uniform = node.write(uniform);
      if (bank === 0) {
        outputRadiance = node.create("Surface/HDR reconstructed", {
          kind: "transient_texture",
          width: input.width,
          height: input.height,
          format: "rgba16float",
          usage:
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_SRC,
          domain: "internal-full"
        });
        outputReactive = node.create("Surface/reactive reconstructed", {
          kind: "transient_texture",
          width: input.width,
          height: input.height,
          format: "rgba8unorm",
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
          domain: "internal-full"
        });
      } else {
        outputRadiance = node.write(radiance);
        outputReactive = node.write(reactiveMask);
      }
      radiance = outputRadiance;
      reactiveMask = outputReactive;
    }
    const snapshot =
      this.mode === "detailed"
        ? this.diagnostics.addToGraph(graph, {
            control,
            after: radiance,
            capacity,
            domains: input.publication.surfaceDomainCount,
            frameId: input.diagnosticFrame,
            identity: this.identity,
            bind
          }).snapshot
        : undefined;
    return {
      radiance,
      reactiveMask,
      control,
      heaps: Object.freeze(heaps),
      signals: Object.freeze(signals),
      metadata,
      ...(snapshot === undefined ? {} : { diagnostics: snapshot })
    };
  }
  commit(gpuDone: Promise<void>, _generation = 0): void {
    if (!this.prepared) {
      throw new Error("SurfaceWork commit without prepare");
    }
    this.scratch.commit(gpuDone);
    this.signalHistoryGpuDone = gpuDone;
    this.signalHistoryDoneSettled = false;
    const settled = (): void => {
      if (this.signalHistoryGpuDone === gpuDone) {
        this.signalHistoryDoneSettled = true;
      }
    };
    void gpuDone.then(settled, settled);
    if (this.signalHistoryProduced && this.pendingSignalHistoryRevision !== null) {
      this.signalHistoryReadIndex = this.signalHistoryWriteIndex;
      this.signalHistoryWriteIndex = this.signalHistoryReadIndex === 0 ? 1 : 0;
      this.signalHistoryRevision = this.pendingSignalHistoryRevision;
      this.signalHistoryValid = true;
    }
    this.pendingSignalHistoryRevision = null;
    this.signalHistoryProduced = false;
    if (this.capacity!.closureCache.perBin > 0) {
      this.cacheSubmittedFrames++;
    }
    this.prepared = false;
  }
  abort(): void {
    this.prepared = false;
    this.pendingSignalHistoryRevision = null;
    this.signalHistoryProduced = false;
  }
  invalidate(): void {
    // Exact Appearance cells include their complete actual inputs and resource
    // routes. Unrelated temporal/camera invalidation must not flush these values;
    // resize, publication replacement and device teardown retain their owners.
    this.signalHistoryValid = false;
    this.signalHistoryRevision = null;
  }
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.scratch.destroy();
    this.retireSignalHistories();
    this.providers.destroy();
    this.radiometry.destroy();
    this.fallbackUniform.destroy();
    this.fallbackPages.destroy();
    this.fallbackAo.destroy();
    this.fallbackDepth.destroy();
    this.fallbackTransmission.destroy();
    this.fallbackHistory.destroy();
  }
}
