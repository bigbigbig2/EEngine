import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  NATIVE_EXECUTION_BIN_STRIDE,
  NATIVE_EXECUTION_BIN_WORDS,
  NATIVE_EXECUTION_CLASSIFY_WGSL,
  NATIVE_EXECUTION_FINALIZE_WGSL,
  NATIVE_EXECUTION_HISTOGRAM_SHARDS,
  NATIVE_EXECUTION_PREFIX_WGSL,
  NATIVE_EXECUTION_SCAN_SIZE,
  NATIVE_EXECUTION_WORKGROUP_SIZE,
} from "../../shaders/native_execution_bins.js";

export interface NativeExecutionBin {
  readonly programIndex: number;
  readonly bindingSet: number;
}

export interface NativeExecutionBinsOptions {
  readonly graphics?: GraphicsContext;
  readonly width: number;
  readonly height: number;
  /** Complete immutable publication directory of unique (program, BindingSet) pairs. */
  readonly bins: readonly NativeExecutionBin[];
  /** May reduce the dispatch dimension for isolated 2D-dispatch tests. */
  readonly maxWorkgroupsPerDimension?: number;
}

export interface NativeExecutionBinsInputs {
  readonly visibility: GPUTextureView;
  readonly meshletWork: GPUBuffer;
  readonly frameInstances: GPUBuffer;
  readonly materialDirectory: GPUBuffer;
  readonly generation: number;
}

interface ScanLevel {
  readonly count: number;
  readonly input: number;
  readonly output: number;
  readonly sums: number;
}

export interface NativeExecutionBinsPlan {
  readonly mode: "empty" | "dense" | "compact";
  readonly pixels: number;
  readonly queueBytes: number;
  readonly scratchBytes: number;
  readonly scanLevels: readonly ScanLevel[];
  readonly maxGroups: number;
  readonly tiles: readonly [number, number];
  readonly dispatches: number;
}

function uint(value: number, name: string, nonzero = false): void {
  if (!Number.isSafeInteger(value) || value < (nonzero ? 1 : 0) || value >= 0xffffffff) {
    throw new RangeError(`${name} must be a ${nonzero ? "nonzero " : ""}finite u32`);
  }
}

export function nativeExecutionDispatch(count: number, maxGroups: number): readonly [number, number] {
  const x = Math.min(count, maxGroups);
  const y = count === 0 ? 0 : Math.ceil(count / maxGroups);
  if (!Number.isSafeInteger(count) || count < 0 || maxGroups < 1 || y > maxGroups) {
    throw new RangeError("Native execution work exceeds the negotiated 2D dispatch capacity");
  }
  return [x, y];
}

/** Validate the complete working set before creating any resource. No pixel budget truncation. */
export function planNativeExecutionBins(
  limits: Pick<
    GPUSupportedLimits,
    | "maxComputeWorkgroupsPerDimension"
    | "maxBufferSize"
    | "maxStorageBufferBindingSize"
    | "maxComputeWorkgroupSizeX"
    | "maxComputeInvocationsPerWorkgroup"
    | "maxComputeWorkgroupStorageSize"
    | "maxStorageBuffersPerShaderStage"
    | "maxTextureDimension2D"
  >,
  options: NativeExecutionBinsOptions,
): NativeExecutionBinsPlan {
  uint(options.width, "Width", true);
  uint(options.height, "Height", true);
  if (options.width > limits.maxTextureDimension2D || options.height > limits.maxTextureDimension2D) {
    throw new RangeError("Native execution extent exceeds the negotiated texture limit");
  }
  const maxGroups = options.maxWorkgroupsPerDimension ?? limits.maxComputeWorkgroupsPerDimension;
  uint(maxGroups, "Dispatch limit", true);
  if (maxGroups > limits.maxComputeWorkgroupsPerDimension) {
    throw new RangeError("Native execution dispatch limit exceeds the device limit");
  }
  const bins = options.bins.length;
  uint(bins, "Bin count");
  const unique = new Set<string>();
  for (const bin of options.bins) {
    uint(bin.programIndex, "Program index");
    uint(bin.bindingSet, "Binding set");
    const key = `${bin.programIndex}/${bin.bindingSet}`;
    if (unique.has(key)) {
      throw new RangeError("Native execution bins must contain unique program/BindingSet pairs");
    }
    unique.add(key);
  }
  const pixels = options.width * options.height;
  uint(pixels, "Pixel count", true);
  const tiles = nativeExecutionDispatch(
    Math.ceil(options.width / 8) * Math.ceil(options.height / 8),
    maxGroups,
  );
  if (bins <= 1) {
    nativeExecutionDispatch(Math.ceil(pixels / NATIVE_EXECUTION_WORKGROUP_SIZE), maxGroups);
    return Object.freeze({
      mode: bins === 0 ? "empty" : "dense",
      pixels,
      queueBytes: 0,
      scratchBytes: 0,
      scanLevels: Object.freeze([]),
      maxGroups,
      tiles,
      dispatches: 0,
    });
  }
  if (
    limits.maxComputeWorkgroupSizeX < NATIVE_EXECUTION_SCAN_SIZE ||
    limits.maxComputeInvocationsPerWorkgroup < NATIVE_EXECUTION_SCAN_SIZE ||
    limits.maxComputeWorkgroupStorageSize < NATIVE_EXECUTION_SCAN_SIZE * 4 ||
    limits.maxStorageBuffersPerShaderStage < 6
  ) {
    throw new RangeError("Native execution bins require 256-lane scan and six storage bindings");
  }
  const queueWords = pixels + bins * NATIVE_EXECUTION_BIN_WORDS;
  uint(queueWords, "Queue word count", true);
  const levels: ScanLevel[] = [];
  nativeExecutionDispatch(Math.ceil(bins / NATIVE_EXECUTION_WORKGROUP_SIZE), maxGroups);
  let words = 4 + bins * NATIVE_EXECUTION_HISTOGRAM_SHARDS;
  let count = bins;
  let input = 0;
  while (true) {
    const output = words;
    words += count;
    const sums = words;
    const blocks = Math.ceil(count / NATIVE_EXECUTION_SCAN_SIZE);
    words += blocks;
    levels.push(Object.freeze({ count, input, output, sums }));
    nativeExecutionDispatch(blocks, maxGroups);
    if (blocks === 1) {
      break;
    }
    input = sums;
    count = blocks;
  }
  const maximum = Math.min(Number(limits.maxBufferSize), Number(limits.maxStorageBufferBindingSize));
  if (queueWords * 4 > maximum || words * 4 > maximum || bins * 8 > maximum) {
    throw new RangeError("Complete native execution working set exceeds negotiated buffer limits");
  }
  return Object.freeze({
    mode: "compact",
    pixels,
    queueBytes: queueWords * 4,
    scratchBytes: words * 4,
    scanLevels: Object.freeze(levels),
    maxGroups,
    tiles,
    dispatches: 2 * levels.length + 2,
  });
}

export interface NativeExecutionBinsBindings {
  /** Owned by this input snapshot; retire only after its encoder fence. */
  readonly settings: GPUBuffer;
  readonly group: GPUBindGroup;
}

/**
 * S1 non-production work generation. The caller owns the frame encoder, queue
 * submission and fences. encode() neither submits nor reads counters back.
 *
 * Cost Card (logical traffic, not measured DRAM): compact adds 4N + 32B queue,
 * ~128B bytes sharded histogram plus ~4B bytes scan scratch (B = bin count).
 * Two winner gathers/pixel, one index write+read, two global atomic reservations
 * per tile/distinct-bin, 2 count + 3 scatter workgroup barriers. A uniform tile
 * reserves 64 pixels at once; a 64-distinct tile pays up to 64 comparisons/lane
 * and one atomic/pixel/pass. Prefix has 17 shared barriers/block and O(B*32)
 * histogram reads, four dispatches at B<=256. No samples/history/cache.
 * Dense has zero management allocation/dispatch. Multi-bin break-even is the
 * measured avoided redundant full-screen work/divergence minus this tax; no
 * speedup is claimed. 0/50/100% reuse is inapplicable (no reuse mechanism).
 *
 * Reference: WickedEngine df44c3db4c4927492bc9c791eac715d98d7ed091, MIT,
 * visibility_resolveCS.hlsl::main, tile-local bin publication; FidelityFX
 * ParallelSort 0c539948c8d196ae338d91efbc8ca495f1ea0d1d, MIT,
 * FFX_ParallelSort.h count/reduce/scan/scatter stages. This is a local binning
 * algorithm, not a radix-sort port; no Wave/bindless/ExecuteIndirect assumption.
 */
export class NativeExecutionBins {
  private readonly bindGroups = new GpuBindGroupCache();
  readonly plan: NativeExecutionBinsPlan;
  readonly bins: readonly NativeExecutionBin[];
  readonly queue: GPUBuffer | null = null;
  /** words 0/1: malformed winner / scatter invariant failure; must be zero. */
  readonly scratch: GPUBuffer | null = null;
  private readonly baseAllocatedBytes: number;
  readonly ready: Promise<void>;
  private readonly resources: GPUBuffer[] = [];
  private readonly accountingHandles = new Map<GPUBuffer, ResourceHandle>();
  private readonly accounting?: ResourceAccounting;
  private readonly bindings = new Set<NativeExecutionBinsBindings>();
  private readonly bindingSettings = new Map<GPUBuffer, number>();
  private classifyLayout: GPUBindGroupLayout | null = null;
  private countPipeline: GPUComputePipeline | null = null;
  private scatterPipeline: GPUComputePipeline | null = null;
  private scanPipeline: GPUComputePipeline | null = null;
  private addPipeline: GPUComputePipeline | null = null;
  private finalizePipeline: GPUComputePipeline | null = null;
  private readonly scanGroups: GPUBindGroup[] = [];
  private finalizeGroup: GPUBindGroup | null = null;
  private knownBins: GPUBuffer | null = null;
  private state: "preparing" | "ready" | "retiring" | "destroyed" = "preparing";
  private readonly width: number;
  private readonly height: number;
  private readonly generationWord = new Uint32Array(1);

  constructor(
    private readonly device: GPUDevice,
    options: NativeExecutionBinsOptions,
  ) {
    this.plan = planNativeExecutionBins(device.limits, options);
    this.accounting = options.graphics?.resource_accounting;
    this.width = options.width;
    this.height = options.height;
    this.bins = Object.freeze(options.bins.map((bin) => Object.freeze({ ...bin })));
    void device.lost.then(() => this.destroy());
    if (this.plan.mode !== "compact") {
      this.baseAllocatedBytes = 0;
      this.state = "ready";
      this.ready = Promise.resolve();
      return;
    }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    try {
      this.queue = this.buffer("queue", this.plan.queueBytes, storage | GPUBufferUsage.INDIRECT);
      this.scratch = this.buffer("scratch", this.plan.scratchBytes, storage);
      const known = new Uint32Array(this.bins.length * 2);
      this.bins.forEach((bin, index) => known.set([bin.programIndex, bin.bindingSet], index * 2));
      this.knownBins = this.buffer("known bins", known.byteLength, GPUBufferUsage.STORAGE, known);
      const classifyDescriptor: GPUBindGroupLayoutDescriptor = {
        label: "SurfaceV4/bins classify layout",
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
          ...[2, 3, 4, 5].map((binding) => ({
            binding,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "read-only-storage" as const },
          })),
          ...[6, 7].map((binding) => ({
            binding,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "storage" as const },
          })),
        ],
      };
      this.classifyLayout = device.createBindGroupLayout(classifyDescriptor);
      const scanDescriptor: GPUBindGroupLayoutDescriptor = {
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      };
      const scanLayout = device.createBindGroupLayout(scanDescriptor);
      const finalizeDescriptor: GPUBindGroupLayoutDescriptor = {
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      };
      const finalizeLayout = device.createBindGroupLayout(finalizeDescriptor);
      for (const [index, level] of this.plan.scanLevels.entries()) {
        const parent = this.plan.scanLevels[index + 1]?.output ?? 0;
        const settings = this.buffer(
          "scan settings",
          32,
          GPUBufferUsage.UNIFORM,
          new Uint32Array([
            level.count,
            level.input,
            level.output,
            level.sums,
            parent,
            this.bins.length,
            NATIVE_EXECUTION_HISTOGRAM_SHARDS,
            index === 0 ? 1 : 0,
          ]),
        );
        this.scanGroups.push(
          this.bindGroups.create(device, {
            layout: scanLayout,
            entries: [
              { binding: 0, resource: { buffer: settings } },
              { binding: 1, resource: { buffer: this.scratch } },
            ],
          }),
        );
      }
      const settings = this.buffer(
        "finalize settings",
        16,
        GPUBufferUsage.UNIFORM,
        new Uint32Array([
          this.bins.length,
          NATIVE_EXECUTION_HISTOGRAM_SHARDS,
          this.plan.scanLevels[0]!.output,
          this.plan.maxGroups,
        ]),
      );
      this.finalizeGroup = this.bindGroups.create(device, {
        layout: finalizeLayout,
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 1, resource: { buffer: this.scratch } },
          { binding: 2, resource: { buffer: this.knownBins } },
          { binding: 3, resource: { buffer: this.queue } },
        ],
      });
      const classify = device.createShaderModule({
        label: "SurfaceV4/bins classify",
        code: NATIVE_EXECUTION_CLASSIFY_WGSL,
      });
      const prefix = device.createShaderModule({
        label: "SurfaceV4/bins prefix",
        code: NATIVE_EXECUTION_PREFIX_WGSL,
      });
      const finalize = device.createShaderModule({
        label: "SurfaceV4/bins finalize",
        code: NATIVE_EXECUTION_FINALIZE_WGSL,
      });
      const classifyPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.classifyLayout] });
      const scanPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [scanLayout] });
      const finalizePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [finalizeLayout] });
      if (options.graphics !== undefined) {
        const pipeline = (
          code: string,
          entryPoint: string,
          layout: GPUBindGroupLayoutDescriptor,
        ): GPUComputePipeline =>
          options.graphics!.compute_pipelines.obtain({
            layout: { bindGroupLayouts: [layout] },
            compute: { module: { code }, entryPoint },
          });
        this.countPipeline = pipeline(NATIVE_EXECUTION_CLASSIFY_WGSL, "count", classifyDescriptor);
        this.scatterPipeline = pipeline(NATIVE_EXECUTION_CLASSIFY_WGSL, "scatter", classifyDescriptor);
        this.scanPipeline = pipeline(NATIVE_EXECUTION_PREFIX_WGSL, "scan", scanDescriptor);
        this.addPipeline = pipeline(NATIVE_EXECUTION_PREFIX_WGSL, "add", scanDescriptor);
        this.finalizePipeline = pipeline(NATIVE_EXECUTION_FINALIZE_WGSL, "finalize", finalizeDescriptor);
        this.state = "ready";
        this.ready = Promise.resolve();
      } else {
        this.ready = Promise.all([
          device.createComputePipelineAsync({
            layout: classifyPipelineLayout,
            compute: { module: classify, entryPoint: "count" },
          }),
          device.createComputePipelineAsync({
            layout: classifyPipelineLayout,
            compute: { module: classify, entryPoint: "scatter" },
          }),
          device.createComputePipelineAsync({
            layout: scanPipelineLayout,
            compute: { module: prefix, entryPoint: "scan" },
          }),
          device.createComputePipelineAsync({
            layout: scanPipelineLayout,
            compute: { module: prefix, entryPoint: "add" },
          }),
          device.createComputePipelineAsync({
            layout: finalizePipelineLayout,
            compute: { module: finalize, entryPoint: "finalize" },
          }),
        ])
          .then(([count, scatter, scan, add, finalize]) => {
            if (this.state !== "preparing") {
              throw new Error("Native execution bins were cancelled before readiness");
            }
            this.countPipeline = count;
            this.scatterPipeline = scatter;
            this.scanPipeline = scan;
            this.addPipeline = add;
            this.finalizePipeline = finalize;
            this.state = "ready";
          })
          .catch((error: unknown) => {
            this.destroy();
            throw error;
          });
        void this.ready.catch(() => undefined);
      }
      this.baseAllocatedBytes = this.resources.reduce((bytes, buffer) => bytes + buffer.size, 0);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  private buffer(label: string, size: number, usage: GPUBufferUsageFlags, data?: Uint32Array): GPUBuffer {
    const buffer = this.device.createBuffer({
      label: `SurfaceV4/bins ${label}`,
      size,
      usage,
      mappedAtCreation: data !== undefined,
    });
    this.resources.push(buffer);
    this.track(buffer);
    if (data !== undefined) {
      new Uint32Array(buffer.getMappedRange()).set(data);
      buffer.unmap();
    }
    return buffer;
  }

  private track(buffer: GPUBuffer): void {
    const handle = this.accounting?.created(
      {
        kind: "buffer",
        category: "transient",
        owner: "NativeExecutionBins",
        bytes: buffer.size,
        label: buffer.label,
      },
      buffer,
    );
    if (handle) {
      this.accountingHandles.set(buffer, handle);
    }
  }

  private releaseBuffer(buffer: GPUBuffer): void {
    buffer.destroy();
    const handle = this.accountingHandles.get(buffer);
    if (handle) {
      this.accounting?.destroyed(handle);
      this.accountingHandles.delete(buffer);
    }
  }

  get allocatedBytes(): number {
    return this.baseAllocatedBytes + this.bindingSettings.size * 32;
  }

  /** Create once per stable input identity and reuse on replay. */
  createBindings(inputs: NativeExecutionBinsInputs, reusedSettings?: GPUBuffer): NativeExecutionBinsBindings {
    if (this.state !== "ready" || this.plan.mode !== "compact") {
      throw new Error("Only ready compact native bins have classification bindings");
    }
    this.validateGeneration(inputs.generation);
    if (reusedSettings !== undefined && !this.bindingSettings.has(reusedSettings)) {
      throw new Error("Native bins cannot reuse settings from a released or different owner");
    }
    const settings =
      reusedSettings ??
      this.device.createBuffer({
        label: "SurfaceV4/bins frame settings",
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
    if (reusedSettings === undefined) {
      new Uint32Array(settings.getMappedRange()).set([
        this.width,
        this.height,
        this.bins.length,
        NATIVE_EXECUTION_HISTOGRAM_SHARDS,
        inputs.generation,
        Math.ceil(this.width / 8),
        this.bins.length * NATIVE_EXECUTION_BIN_WORDS,
        0,
      ]);
      settings.unmap();
      this.track(settings);
    }
    try {
      const group = this.bindGroups.create(this.device, {
        layout: this.classifyLayout!,
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 1, resource: inputs.visibility },
          { binding: 2, resource: { buffer: inputs.meshletWork } },
          { binding: 3, resource: { buffer: inputs.frameInstances } },
          { binding: 4, resource: { buffer: inputs.materialDirectory } },
          { binding: 5, resource: { buffer: this.knownBins! } },
          { binding: 6, resource: { buffer: this.scratch! } },
          { binding: 7, resource: { buffer: this.queue! } },
        ],
      });
      const bindings = Object.freeze({ settings, group });
      this.bindings.add(bindings);
      this.bindingSettings.set(settings, (this.bindingSettings.get(settings) ?? 0) + 1);
      return bindings;
    } catch (error) {
      if (reusedSettings === undefined) {
        this.releaseBuffer(settings);
      }
      throw error;
    }
  }

  private validateGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 0xffffffff) {
      throw new RangeError("Visibility generation must be a nonzero u32");
    }
  }

  /**
   * Update before encoding the next frame, after prior commands were submitted
   * or aborted. Queue ordering preserves prior submitted reads. This is a small
   * CPU-authored frame context upload, never a GPU readback/control round trip.
   */
  updateGeneration(bindings: NativeExecutionBinsBindings, generation: number): void {
    if (this.state !== "ready" || !this.bindings.has(bindings)) {
      throw new Error("Native execution generation update requires a live owner input snapshot");
    }
    this.validateGeneration(generation);
    this.generationWord[0] = generation;
    this.device.queue.writeBuffer(bindings.settings, 16, this.generationWord);
  }

  /** Caller must ensure the last encoding that used this snapshot has retired. */
  releaseBindings(bindings: NativeExecutionBinsBindings): void {
    if (this.bindings.delete(bindings)) {
      const references = this.bindingSettings.get(bindings.settings)! - 1;
      if (references === 0) {
        this.bindingSettings.delete(bindings.settings);
        this.releaseBuffer(bindings.settings);
      } else {
        this.bindingSettings.set(bindings.settings, references);
      }
    }
  }

  encode(encoder: GPUCommandEncoder, bindings?: NativeExecutionBinsBindings): void {
    if (this.state !== "ready") {
      throw new Error("Native execution bins are not ready");
    }
    if (this.plan.mode !== "compact") {
      return;
    }
    if (bindings === undefined || !this.bindings.has(bindings)) {
      throw new Error("Native execution bins require a live matching input snapshot");
    }
    encoder.clearBuffer(this.scratch!);
    // Index tails are not read: each consumer uses its GPU count. Every bin
    // record, including empty bins, is overwritten by finalize on every encode.
    const dispatch = (
      pipeline: GPUComputePipeline,
      group: GPUBindGroup,
      dimensions: readonly [number, number],
      label: string,
    ): void => {
      const pass = encoder.beginComputePass({ label: `SurfaceV4/bins ${label}` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(dimensions[0], dimensions[1]);
      pass.end();
    };
    dispatch(this.countPipeline!, bindings.group, this.plan.tiles, "count");
    for (const [index, level] of this.plan.scanLevels.entries()) {
      dispatch(
        this.scanPipeline!,
        this.scanGroups[index]!,
        nativeExecutionDispatch(Math.ceil(level.count / NATIVE_EXECUTION_SCAN_SIZE), this.plan.maxGroups),
        "scan",
      );
    }
    for (let index = this.plan.scanLevels.length - 2; index >= 0; index--) {
      const level = this.plan.scanLevels[index]!;
      dispatch(
        this.addPipeline!,
        this.scanGroups[index]!,
        nativeExecutionDispatch(Math.ceil(level.count / NATIVE_EXECUTION_SCAN_SIZE), this.plan.maxGroups),
        "add",
      );
    }
    dispatch(
      this.finalizePipeline!,
      this.finalizeGroup!,
      nativeExecutionDispatch(
        Math.ceil(this.bins.length / NATIVE_EXECUTION_WORKGROUP_SIZE),
        this.plan.maxGroups,
      ),
      "finalize",
    );
    dispatch(this.scatterPipeline!, bindings.group, this.plan.tiles, "scatter");
  }

  indirectOffset(bin: number): number {
    uint(bin, "Execution bin");
    if (bin >= this.bins.length || this.plan.mode !== "compact") {
      throw new RangeError("Native execution bin has no indirect queue record");
    }
    return bin * NATIVE_EXECUTION_BIN_STRIDE + 8;
  }

  /** No implicit fence or submit. Owner must await its actual last-use fence. */
  markStorageRetired(): void {
    this.accountingHandles.forEach((handle) => this.accounting?.setRetired(handle, true));
  }

  async retire(fence: Promise<unknown>): Promise<void> {
    this.state = "retiring";
    this.markStorageRetired();
    try {
      await fence;
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    this.bindGroups.clear();
    if (this.state === "destroyed") {
      return;
    }
    this.state = "destroyed";
    for (const settings of this.bindingSettings.keys()) {
      this.releaseBuffer(settings);
    }
    this.bindingSettings.clear();
    this.bindings.clear();
    for (const buffer of this.resources) {
      this.releaseBuffer(buffer);
    }
  }
}
