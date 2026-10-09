import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import {
  LOCAL_LIGHT_ABI_VERSION,
  LOCAL_LIGHT_FRAME_BUDGET,
  LOCAL_LIGHT_HEADER_WORDS,
  LOCAL_LIGHT_INDEX_CAPACITY,
  LOCAL_LIGHT_MAX_ADMITTED,
  LOCAL_LIGHT_MODE,
  LOCAL_LIGHT_PARAMETERS_BYTES,
  LOCAL_LIGHT_PEAK_BUDGET,
  localLightId,
} from "../../gpu/GpuLocalLightWorkAbi.js";
import { LOCAL_LIGHT_SCAN_WGSL, LOCAL_LIGHT_WORK_WGSL } from "../../shaders/local_light_work.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { localLightWorkProduct, type LocalLightWorkProduct } from "../pipeline/FrameProducts.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GPULightCollection } from "../../gpu/LightDatabase.js";
import { POINT_LIGHT_DESCRIPTOR, SPOT_LIGHT_DESCRIPTOR } from "../../gpu/LightDatabase.js";

/** LightDatabase publishes contiguous typed slots in its staged frame transaction. */
export function localLightPublication(lights: GPULightCollection): LocalLightPublication {
  const points = lights.pointLights.count;
  const spots = lights.spotLights.count;
  if (points + spots > LOCAL_LIGHT_MAX_ADMITTED) {
    throw new RangeError("Local light admission exceeds the complete-list profile");
  }
  const ids = new Uint32Array(points + spots);
  for (let slot = 0; slot < points; slot++) {
    ids[slot] = localLightId(slot, 0);
  }
  for (let slot = 0; slot < spots; slot++) {
    ids[points + slot] = localLightId(slot, 1);
  }
  return {
    buffer: lights.buffer_data,
    revision: lights.publicationRevision,
    ids,
    currentRevision: () => lights.publicationRevision,
  };
}

export interface LocalLightPublication {
  readonly buffer: GPUBuffer;
  readonly revision: number;
  /** Exact staged-or-active DB slots; no old filtered list. */
  readonly ids: Uint32Array;
  readonly currentRevision: () => number;
}

export interface LocalLightView {
  readonly width: number;
  readonly height: number;
  readonly near: number;
  readonly far: number;
  readonly depthConversion: readonly [number, number];
  readonly projection: readonly [number, number, number, number];
  readonly view: ArrayLike<number>;
}

export interface LocalLightWorkRequest {
  readonly publication: LocalLightPublication;
  readonly view: LocalLightView;
  readonly frameIndex: number;
  readonly deviceEpoch: number;
  readonly visibility?: GPUTextureView;
  readonly depth?: GPUTextureView;
  /** NONE or SPARSE in production; DIRECT remains the complete overflow mode. */
  readonly mode: 0 | 1 | 2;
  readonly indexCapacity?: number;
  readonly taskBudget?: number;
}

interface ScanStage {
  readonly entry: "scan" | "add";
  readonly groups: number;
  readonly settings: Uint32Array<ArrayBuffer>;
}

interface Allocation {
  readonly parameters: GPUBuffer;
  readonly settings: GPUBuffer;
  readonly lookup: GPUBuffer;
  readonly data: GPUBuffer;
  readonly scratch: GPUBuffer;
  readonly indirect: GPUBuffer;
  readonly scans: GPUBuffer[];
  readonly bytes: number;
  readonly key: string;
  state: "free" | "prepared" | "encoded" | "submitted" | "destroyed";
  command?: ShadeGPUCommandContext;
  frame?: LocalLightWorkFrame;
}

/** A single immutable publication for the consumer of this encoded frame. */
export interface LocalLightWorkFrame {
  readonly parameters: GPUBuffer;
  readonly lookup: GPUBuffer;
  readonly data: GPUBuffer;
  readonly lightingEntries: readonly GPUBindGroupEntry[];
  readonly request: LocalLightWorkRequest;
  readonly reservedBytes: number;
}

/** Owns fenced frame products; borrows the staged DB and graph-produced winner/depth. */
export class LocalLightWorkGenerator {
  private readonly bindGroups = new GpuBindGroupCache();
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  private readonly allocations: Allocation[] = [];
  private readonly accountingHandles = new Map<GPUBuffer, ResourceHandle>();
  private readonly frames = new WeakMap<
    LocalLightWorkFrame,
    {
      allocation: Allocation;
      pairGroup: GPUBindGroup;
      scans: { stage: ScanStage; group: GPUBindGroup }[];
      taskScanCount: number;
      clusters: number;
    }
  >();
  private disposed = false;
  readonly ready: Promise<void>;

  constructor(
    private readonly device: GPUDevice,
    readonly deviceEpoch: number,
    private readonly graphics?: GraphicsContext,
  ) {
    if (!Number.isInteger(deviceEpoch) || deviceEpoch < 0 || deviceEpoch > 0xffffffff) {
      throw new RangeError("LocalLightWork epoch must fit the GPU context");
    }
    if (
      device.limits.maxComputeInvocationsPerWorkgroup < 256 ||
      device.limits.maxComputeWorkgroupSizeX < 256 ||
      device.limits.maxComputeWorkgroupStorageSize < 1024 ||
      device.limits.maxStorageBuffersPerShaderStage < 5
    ) {
      throw new RangeError("LocalLightWork requires the portable scan and five-storage profile");
    }
    this.ready = this.createPipelines();
    void device.lost.then(() => this.destroy());
  }

  get allocatedBytes(): number {
    let bytes = 0;
    for (const allocation of this.allocations) {
      bytes += allocation.bytes;
    }
    return bytes;
  }

  get inFlightBytes(): number {
    let bytes = 0;
    for (const allocation of this.allocations) {
      if (allocation.state === "submitted") {
        bytes += allocation.bytes;
      }
    }
    return bytes;
  }

  private async createPipelines(): Promise<void> {
    const stages = [
      "bounds",
      "occupancy",
      "schedule",
      "count",
      "allocate",
      "scatter_schedule",
      "scatter",
      "finalize",
    ];
    const module = this.device.createShaderModule({ label: "LocalLightWork", code: LOCAL_LIGHT_WORK_WGSL });
    // Pair kernels omit writable indirect arguments to preserve indirect usage scopes.
    const layout = this.device.createBindGroupLayout({
      label: "LocalLightWork/frame",
      entries: [
        { binding: 0, visibility: 4, buffer: { type: "uniform" } },
        { binding: 1, visibility: 4, buffer: { type: "uniform" } },
        { binding: 2, visibility: 4, buffer: { type: "read-only-storage" } },
        ...[3, 4, 5, 6].map(
          (binding): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, buffer: { type: "storage" } }),
        ),
        { binding: 7, visibility: 4, texture: { sampleType: "uint" } },
        { binding: 8, visibility: 4, texture: { sampleType: "depth" } },
      ],
    });
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pairLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [
        this.device.createBindGroupLayout({
          label: "LocalLightWork/pair",
          entries: [
            { binding: 0, visibility: 4, buffer: { type: "uniform" } },
            { binding: 1, visibility: 4, buffer: { type: "uniform" } },
            { binding: 2, visibility: 4, buffer: { type: "read-only-storage" } },
            ...[3, 4, 5].map(
              (binding): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, buffer: { type: "storage" } }),
            ),
          ],
        }),
      ],
    });
    for (const entryPoint of stages) {
      const pipeline = await this.device.createComputePipelineAsync({
        label: `LocalLightWork/${entryPoint}`,
        layout: entryPoint === "count" || entryPoint === "scatter" ? pairLayout : pipelineLayout,
        compute: { module, entryPoint },
      });
      if (this.disposed) {
        throw new Error("LocalLightWork pipeline initialization cancelled");
      }
      this.pipelines.set(entryPoint, pipeline);
    }
    const scanModule = this.device.createShaderModule({
      label: "LocalLightWork/scan",
      code: LOCAL_LIGHT_SCAN_WGSL,
    });
    const scanLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [
        this.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 4, buffer: { type: "uniform" } },
            { binding: 1, visibility: 4, buffer: { type: "storage" } },
          ],
        }),
      ],
    });
    for (const entryPoint of ["scan", "add"]) {
      const pipeline = await this.device.createComputePipelineAsync({
        label: `LocalLightWork/${entryPoint}`,
        layout: scanLayout,
        compute: { module: scanModule, entryPoint },
      });
      if (this.disposed) {
        throw new Error("LocalLightWork scan initialization cancelled");
      }
      this.pipelines.set(entryPoint, pipeline);
    }
  }

  prepare(request: LocalLightWorkRequest): LocalLightWorkFrame {
    if (this.disposed || !this.pipelines.has("add")) {
      throw new Error("LocalLightWork is unavailable or not ready");
    }
    this.validate(request);
    request = {
      ...request,
      publication: { ...request.publication, ids: request.publication.ids.slice() },
      view: {
        ...request.view,
        view: Array.from(request.view.view),
        projection: [...request.view.projection],
        depthConversion: [...request.view.depthConversion],
      },
    };
    const { width, height } = request.view;
    const n = request.publication.ids.length;
    const sparse = request.mode === LOCAL_LIGHT_MODE.SPARSE && n > 0;
    const tiles = Math.ceil(width / 32) * Math.ceil(height / 32);
    const clusters = sparse ? tiles * 24 : 1;
    const capacity = sparse ? (request.indexCapacity ?? LOCAL_LIGHT_INDEX_CAPACITY) : 0;
    const bounds = 0;
    const taskCounts = 8 * n;
    const taskPrefix = taskCounts + n;
    const counts = taskPrefix + n;
    const cursors = counts + clusters;
    const occupancy = cursors + clusters;
    let scratchWords = occupancy + (sparse ? tiles : 1);
    const scanStages: ScanStage[] = [];
    const planScan = (source: number, destination: number, count: number): void => {
      const blocks = Math.ceil(count / 256);
      const sums = scratchWords;
      scratchWords += blocks;
      scanStages.push({
        entry: "scan",
        groups: blocks,
        settings: new Uint32Array([source, destination, sums, count]),
      });
      if (blocks > 1) {
        const offsets = scratchWords;
        scratchWords += blocks;
        planScan(sums, offsets, blocks);
        scanStages.push({
          entry: "add",
          groups: blocks,
          settings: new Uint32Array([offsets, destination, 0, count]),
        });
      }
    };
    if (sparse) {
      planScan(taskCounts, taskPrefix, n);
    }
    const taskScanCount = scanStages.length;
    if (sparse) {
      planScan(counts, cursors, clusters);
    }
    // A WGSL runtime array requires one element even when the logical payload is empty.
    const dataBytes = (LOCAL_LIGHT_HEADER_WORDS + Math.max(1, 2 * n + capacity)) * 4;
    const sizes = [128, 32, clusters * 8, dataBytes, Math.max(4, scratchWords * 4), 16];
    const bytes = sizes.reduce((sum, size) => sum + size, 0) + scanStages.length * 16;
    if (bytes > LOCAL_LIGHT_FRAME_BUDGET) {
      throw new RangeError("LocalLightWork view exceeds the negotiated 6MiB frame profile");
    }
    for (const size of sizes) {
      if (size > this.device.limits.maxStorageBufferBindingSize || size > this.device.limits.maxBufferSize) {
        throw new RangeError("LocalLightWork exceeds device buffer limits");
      }
    }
    const key = `${width}/${height}/${n}/${capacity}/${sparse}`;
    let allocation = this.allocations.find((value) => value.key === key && value.state === "free");
    if (!allocation) {
      for (const previous of [...this.allocations]) {
        if (
          previous.state === "free" &&
          (this.allocations.length >= 3 || this.allocatedBytes + bytes > LOCAL_LIGHT_PEAK_BUDGET)
        ) {
          this.release(previous);
        }
      }
      if (this.allocations.length >= 3 || this.allocatedBytes + bytes > LOCAL_LIGHT_PEAK_BUDGET) {
        throw new Error("LocalLightWork in-flight capacity exhausted; retain the real completion fence");
      }
      const create = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
        const buffer = this.device.createBuffer({
          label: `LocalLightWork/${label}`,
          size,
          usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        const handle = this.graphics?.resource_accounting.created(
          {
            kind: "buffer",
            category: "transient",
            owner: "LocalLightWork",
            bytes: size,
            label: buffer.label,
          },
          buffer,
        );
        if (handle) {
          this.accountingHandles.set(buffer, handle);
        }
        return buffer;
      };
      allocation = {
        parameters: create("parameters", sizes[0]!, GPUBufferUsage.UNIFORM),
        settings: create("settings", sizes[1]!, GPUBufferUsage.UNIFORM),
        lookup: create("lookup", sizes[2]!, GPUBufferUsage.STORAGE),
        data: create("data", sizes[3]!, GPUBufferUsage.STORAGE),
        scratch: create("scratch", sizes[4]!, GPUBufferUsage.STORAGE),
        indirect: create("indirect", sizes[5]!, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT),
        scans: scanStages.map(() => create("scan parameters", 16, GPUBufferUsage.UNIFORM)),
        bytes,
        key,
        state: "free",
      };
      this.allocations.push(allocation);
    }
    const packed = new ArrayBuffer(LOCAL_LIGHT_PARAMETERS_BYTES);
    const integers = new Uint32Array(packed);
    const floats = new Float32Array(packed);
    integers.set([
      width,
      height,
      Math.ceil(width / 32),
      Math.ceil(height / 32),
      this.deviceEpoch,
      request.frameIndex,
      request.publication.revision,
      n,
    ]);
    floats.set([request.view.near, request.view.far, ...request.view.depthConversion], 8);
    floats.set(request.view.projection, 12);
    floats.set(Array.from(request.view.view), 16);
    const header = new Uint32Array(LOCAL_LIGHT_HEADER_WORDS + n);
    header.set([
      LOCAL_LIGHT_ABI_VERSION,
      n === 0 ? 0 : request.mode,
      0,
      this.deviceEpoch,
      request.frameIndex,
      request.publication.revision,
      n,
      0,
      0,
      n,
      sparse ? clusters : 0,
      capacity,
      2 * n,
      0,
      0,
      request.taskBudget ?? 8 * LOCAL_LIGHT_INDEX_CAPACITY,
    ]);
    header.set(request.publication.ids, LOCAL_LIGHT_HEADER_WORDS);
    this.device.queue.writeBuffer(allocation.parameters, 0, packed);
    this.device.queue.writeBuffer(allocation.data, 0, header);
    this.device.queue.writeBuffer(
      allocation.settings,
      0,
      new Uint32Array([
        bounds,
        taskCounts,
        taskPrefix,
        counts,
        cursors,
        occupancy,
        this.device.limits.maxComputeWorkgroupsPerDimension,
        0,
      ]),
    );
    const scans = scanStages.map((stage, index) => {
      this.device.queue.writeBuffer(allocation!.scans[index]!, 0, stage.settings);
      return {
        stage,
        group: this.bindGroups.create(this.device, {
          layout: this.pipelines.get(stage.entry)!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: allocation!.scans[index]! } },
            { binding: 1, resource: { buffer: allocation!.scratch } },
          ],
        }),
      };
    });
    const pairGroup = this.bindGroups.create(this.device, {
      layout: this.pipelines.get("count")!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: allocation.parameters } },
        { binding: 1, resource: { buffer: allocation.settings } },
        { binding: 2, resource: { buffer: request.publication.buffer } },
        { binding: 3, resource: { buffer: allocation.data } },
        { binding: 4, resource: { buffer: allocation.scratch } },
        { binding: 5, resource: { buffer: allocation.lookup } },
      ],
    });
    allocation.state = "prepared";
    const frame: LocalLightWorkFrame = {
      parameters: allocation.parameters,
      lookup: allocation.lookup,
      data: allocation.data,
      request,
      reservedBytes: bytes,
      lightingEntries: [
        { binding: 0, resource: { buffer: request.publication.buffer } },
        { binding: 1, resource: { buffer: allocation.parameters } },
        { binding: 2, resource: { buffer: allocation.lookup } },
        { binding: 3, resource: { buffer: allocation.data } },
      ],
    };
    if (allocation.frame) {
      this.frames.delete(allocation.frame);
    }
    allocation.frame = frame;
    this.frames.set(frame, { allocation, pairGroup, scans, taskScanCount, clusters });
    return frame;
  }

  encode(
    command: ShadeGPUCommandContext,
    frame: LocalLightWorkFrame,
    inputs?: { visibility: GPUTextureView; depth: GPUTextureView },
  ): void {
    const state = this.frames.get(frame);
    if (
      this.disposed ||
      !state ||
      state.allocation.frame !== frame ||
      state.allocation.state !== "prepared" ||
      command.closed ||
      command.device !== this.device
    ) {
      throw new Error("LocalLightWork frame is stale or already encoded");
    }
    let submitted = 0;
    for (const allocation of this.allocations) {
      if (allocation.state === "submitted" || allocation.state === "encoded") {
        submitted++;
      }
    }
    if (submitted >= 2) {
      throw new Error("LocalLightWork requires completion before a third in-flight frame");
    }
    this.validate(frame.request);
    const allocation = state.allocation;
    allocation.state = "encoded";
    allocation.command = command;
    command.onAborted.addOne(() => {
      if (allocation.state === "encoded") {
        allocation.state = "free";
        allocation.command = undefined;
        if (this.disposed) {
          this.release(allocation);
        }
      }
    });
    command.onFinished.addOne(() => {
      allocation.state = "submitted";
      const completed = (): void => {
        allocation.state = "free";
        allocation.command = undefined;
        if (this.disposed) {
          this.release(allocation);
        }
      };
      void command.gpuDone.then(completed, completed);
    });
    const encoder = command.gpu_encoder;
    encoder.clearBuffer(allocation.scratch);
    encoder.clearBuffer(allocation.indirect);
    encoder.clearBuffer(allocation.lookup);
    if (frame.request.mode !== 2 || frame.request.publication.ids.length === 0) {
      return;
    }
    const visibility = inputs?.visibility ?? frame.request.visibility;
    const depth = inputs?.depth ?? frame.request.depth;
    if (!visibility || !depth) {
      throw new Error("LocalLightWork requires this frame's raw winner and depth");
    }
    const group = this.bindGroups.create(this.device, {
      layout: this.pipelines.get("bounds")!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: allocation.parameters } },
        { binding: 1, resource: { buffer: allocation.settings } },
        { binding: 2, resource: { buffer: frame.request.publication.buffer } },
        { binding: 3, resource: { buffer: allocation.data } },
        { binding: 4, resource: { buffer: allocation.scratch } },
        { binding: 5, resource: { buffer: allocation.lookup } },
        { binding: 6, resource: { buffer: allocation.indirect } },
        { binding: 7, resource: visibility },
        { binding: 8, resource: depth },
      ],
    });
    const dispatch = (entry: string, groups: number, y = 1, indirect = false): void => {
      const pass = encoder.beginComputePass({ label: `LocalLightWork/${entry}` });
      pass.setPipeline(this.pipelines.get(entry)!);
      pass.setBindGroup(0, indirect ? state.pairGroup : group);
      if (indirect) {
        pass.dispatchWorkgroupsIndirect(allocation.indirect, 0);
      } else {
        pass.dispatchWorkgroups(groups, y);
      }
      pass.end();
    };
    const scan = (start: number, end: number): void => {
      for (let index = start; index < end; index++) {
        const step = state.scans[index]!;
        const pass = encoder.beginComputePass({ label: `LocalLightWork/${step.stage.entry}` });
        pass.setPipeline(this.pipelines.get(step.stage.entry)!);
        pass.setBindGroup(0, step.group);
        pass.dispatchWorkgroups(step.stage.groups);
        pass.end();
      }
    };
    dispatch("bounds", Math.ceil(frame.request.publication.ids.length / 64));
    scan(0, state.taskScanCount);
    dispatch("schedule", 1);
    dispatch(
      "occupancy",
      Math.ceil(frame.request.view.width / 32),
      Math.ceil(frame.request.view.height / 32),
    );
    dispatch("count", 0, 1, true);
    scan(state.taskScanCount, state.scans.length);
    dispatch("allocate", Math.ceil(state.clusters / 64));
    dispatch("scatter_schedule", 1);
    dispatch("scatter", 0, 1, true);
    dispatch("finalize", Math.ceil(state.clusters / 64));
  }

  abort(frame: LocalLightWorkFrame): void {
    const allocation = this.frames.get(frame)?.allocation;
    if (allocation?.frame !== frame) {
      return;
    }
    if (allocation?.state === "prepared") {
      allocation.state = "free";
    } else if (allocation?.state === "encoded") {
      allocation.command!.abort(new Error("LocalLightWork frame aborted"));
    }
    this.frames.delete(frame);
  }

  /** Macro dependency only; scans and workgroup synchronization remain shader/module-owned. */
  addToGraph(
    graph: FrameGraph,
    job: { frame: LocalLightWorkFrame },
    products: { parameters: GPUBuffer; lookup: GPUBuffer; data: GPUBuffer },
    inputs: { visibility: ResourceId; depth: ResourceId; database: ResourceId },
  ): LocalLightWorkProduct {
    const parameters = graph.import_resource(
      "LocalLightWork/parameters",
      { kind: "imported" },
      products.parameters,
    );
    const lookup = graph.import_resource("LocalLightWork/lookup", { kind: "imported" }, products.lookup);
    const data = graph.import_resource("LocalLightWork/data", { kind: "imported" }, products.data);
    const node = graph.add("LocalLightWork/generate", job, (current, resources, context) => {
      this.encode(context.encoder as ShadeGPUCommandContext, current.frame, {
        visibility: resolveTextureView(resources.get(inputs.visibility)),
        depth: resolveTextureView(resources.get(inputs.depth)),
      });
    });
    for (const input of [inputs.visibility, inputs.depth, inputs.database]) {
      node.read(input);
    }
    node.read(parameters);
    return localLightWorkProduct({
      parameters,
      lookup: node.write(lookup),
      data: node.write(data),
      width: job.frame.request.view.width,
      height: job.frame.request.view.height,
      tileSize: 32,
      depthSlices: 24,
    });
  }

  private validate(request: LocalLightWorkRequest): void {
    const { view, publication } = request;
    if (request.deviceEpoch !== this.deviceEpoch || publication.revision !== publication.currentRevision()) {
      throw new Error("LocalLightWork stale epoch/publication");
    }
    if (
      ![view.width, view.height, request.frameIndex, publication.revision].every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
      ) ||
      view.width === 0 ||
      view.height === 0
    ) {
      throw new RangeError("LocalLightWork invalid frame context");
    }
    if (
      view.view.length !== 16 ||
      !Array.from(view.view).every(Number.isFinite) ||
      !view.projection.every(Number.isFinite) ||
      view.projection[0] <= 0 ||
      view.projection[1] <= 0 ||
      !view.depthConversion.every(Number.isFinite) ||
      !(view.near > 0 && view.far > view.near && Number.isFinite(view.far))
    ) {
      throw new RangeError("LocalLightWork requires a finite perspective view");
    }
    if (
      ![0, 1, 2].includes(request.mode) ||
      publication.ids.length > LOCAL_LIGHT_MAX_ADMITTED ||
      (request.mode === 0 && publication.ids.length !== 0)
    ) {
      throw new RangeError("LocalLightWork admission/mode exceeded");
    }
    const seen = new Set<number>();
    for (const tuple of publication.ids) {
      localLightId(tuple & 0xffffff, tuple >>> 24);
      const descriptor = tuple >>> 24 === 0 ? POINT_LIGHT_DESCRIPTOR : SPOT_LIGHT_DESCRIPTOR;
      if ((tuple & 0xffffff) >= descriptor.page_limit * descriptor.elements_per_page) {
        throw new RangeError("Local light slot exceeds the actual typed database table");
      }
      if (seen.has(tuple)) {
        throw new Error("Duplicate local light admission");
      }
      seen.add(tuple);
    }
    for (const value of [
      request.indexCapacity ?? LOCAL_LIGHT_INDEX_CAPACITY,
      request.taskBudget ?? 8 * LOCAL_LIGHT_INDEX_CAPACITY,
    ]) {
      if (!Number.isInteger(value) || value < 0 || value > 8 * LOCAL_LIGHT_INDEX_CAPACITY) {
        throw new RangeError("LocalLightWork invalid bounded capacity");
      }
    }
    const clusters = Math.ceil(view.width / 32) * Math.ceil(view.height / 32) * 24;
    if (
      Math.ceil(clusters / 64) * 64 * Math.max(1, publication.ids.length) > 0xffffffff ||
      Math.ceil(clusters / 64) > this.device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("LocalLightWork exceeds checked u32/dispatch profile");
    }
  }

  destroy(): void {
    this.bindGroups.clear();
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const allocation of [...this.allocations]) {
      if (allocation.state === "encoded") {
        allocation.command!.abort(new Error("LocalLightWork owner retired"));
      } else if (allocation.state !== "submitted") {
        this.release(allocation);
      }
    }
    this.pipelines.clear();
  }

  private release(allocation: Allocation): void {
    if (allocation.state === "destroyed") {
      return;
    }
    allocation.state = "destroyed";
    for (const buffer of [
      allocation.parameters,
      allocation.settings,
      allocation.lookup,
      allocation.data,
      allocation.scratch,
      allocation.indirect,
      ...allocation.scans,
    ]) {
      buffer.destroy();
      const handle = this.accountingHandles.get(buffer);
      if (handle) {
        this.graphics?.resource_accounting.destroyed(handle);
        this.accountingHandles.delete(buffer);
      }
    }
    const index = this.allocations.indexOf(allocation);
    if (index >= 0) {
      this.allocations.splice(index, 1);
    }
  }
}
