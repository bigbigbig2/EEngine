import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import { scgiCacheScanWgsl, scgiCacheWgsl } from "../../shaders/scgi_cache.js";
import type { ScgiFrameTransaction } from "./ScgiRuntime.js";
import type { ScgiAllocationPlan } from "./ScgiCapacity.js";
import { assertScgiCacheCapabilities, scgiInteger } from "./ScgiCapacity.js";
import {
  SCGI_CACHE_DIRTY_CAPACITY,
  SCGI_CACHE_WORKGROUP_SIZE as W,
  scgiCacheScanDomains
} from "./ScgiCacheLayout.js";

export interface ScgiCacheSettings {
  readonly frame: number;
  readonly originEpoch: number;
  readonly camera: readonly [number, number, number];
  readonly voxelSize: number;
  readonly bounceEnabled: boolean;
  readonly evictionAge: number;
  readonly moveBudget: number;
  readonly normalCosine: number;
  readonly planeDistanceScale: number;
  readonly updateAge: number;
  /** Dimensionless short variance / meanScale² from ScgiFilter. */
  readonly varianceThreshold: number;
  /** ScgiInvalidation GPU product: count/overflow/change/reserved +32 regions.
   * This is independent of the CPU-authored local dirty input. */
  readonly gpuDirty?: GPUBuffer;
  readonly dirtyRegions?: readonly {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  }[];
}

interface Scan {
  readonly up: readonly GPUComputePipeline[];
  readonly down: readonly GPUComputePipeline[];
  readonly counts: readonly number[];
}

const ENTRIES = [
  "clear_claims",
  "begin",
  "maintain",
  "claim_requests",
  "resolve_requests",
  "classify_free",
  "scatter_free",
  "allocate",
  "classify_live",
  "scatter_live",
  "plan_moves",
  "snapshot_moves",
  "apply_moves",
  "finalize_requests",
  "classify_priority",
  "scatter_priority",
  "quotas",
  "select_updates",
  "finish"
] as const;

/** Cache algorithms borrow the SCGI transaction's arenas. No private resources,
 * queue submissions or readbacks. Call after runtime.encode and the request
 * producer, before anchors/estimation consume map/updateList. Creation compiles
 * physical-layout pipelines once; encode only records bounded GPU work. */
export class ScgiCache {
  private readonly encoded = new WeakSet<ScgiFrameTransaction>();
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>>();
  private readonly scanGroups = new WeakMap<GPUBuffer, GPUBindGroup>();
  private readonly argsGroups = new WeakMap<
    GPUBuffer,
    WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>
  >();
  private lastFrame = 0;
  private lastOriginEpoch = 0;

  private constructor(
    readonly device: GPUDevice,
    readonly plan: ScgiAllocationPlan,
    private readonly layout: GPUBindGroupLayout,
    private readonly scanLayout: GPUBindGroupLayout,
    private readonly argsLayout: GPUBindGroupLayout,
    private readonly pipelines: Readonly<Record<(typeof ENTRIES)[number], GPUComputePipeline>>,
    private readonly scans: ReadonlyMap<string, Scan>
  ) {}

  static async create(device: GPUDevice, plan: ScgiAllocationPlan): Promise<ScgiCache> {
    assertScgiCacheCapabilities(device.limits, plan);
    const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type }
    });
    const layout = device.createBindGroupLayout({
      label: "SCGI/cache world/scratch/previous",
      entries: [storage(0, "storage"), storage(1, "storage"), storage(2, "read-only-storage")]
    });
    const scanLayout = device.createBindGroupLayout({
      label: "SCGI/cache scan",
      entries: [storage(0, "storage")]
    });
    const argsLayout = device.createBindGroupLayout({
      entries: [
        storage(0, "storage"),
        storage(1, "storage"),
        storage(2, "read-only-storage"),
        storage(3, "storage")
      ]
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const argsPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [argsLayout] });
    const scanPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [scanLayout] });
    const queue = PipelineCompilationQueue.forDevice(device);
    const module = device.createShaderModule({ label: "SCGI/cache", code: scgiCacheWgsl(plan) });
    const compile = (module: GPUShaderModule, entryPoint: string, layout: GPUPipelineLayout) =>
      queue.run(() =>
        device.createComputePipelineAsync({
          label: `SCGI/cache/${entryPoint}`,
          layout,
          compute: { module, entryPoint }
        })
      );
    const pipelines = Object.fromEntries(
      await Promise.all(
        ENTRIES.map(async (entry) => [
          entry,
          await compile(
            module,
            entry,
            entry === "begin" || entry === "quotas" ? argsPipelineLayout : pipelineLayout
          )
        ])
      )
    ) as Record<(typeof ENTRIES)[number], GPUComputePipeline>;
    const scans = new Map<string, Scan>();
    const ranges = plan.scratch.ranges;
    for (const [name, capacity] of scgiCacheScanDomains(
      plan.profile.patches,
      plan.profile.requests + plan.profile.bounceRequests
    )) {
      const counts: number[] = [capacity];
      while (counts[counts.length - 1]! > W) {
        counts.push(Math.ceil(counts[counts.length - 1]! / W));
      }
      const up: GPUComputePipeline[] = [];
      const down: GPUComputePipeline[] = [];
      const control =
        name === "cacheFree"
          ? 3
          : name === "cacheLive"
            ? 2
            : name === "cacheWinner"
              ? 4
              : name === "cacheVisibleWinner"
                ? 12
                : 16 + Number(name.at(-1));
      for (let level = 0; level < counts.length; level++) {
        const last = level === counts.length - 1;
        const code = scgiCacheScanWgsl(
          ranges[`${name}Flags${level}`]!.offset / 4,
          ranges[`${name}Prefix${level}`]!.offset / 4,
          counts[level]!,
          last ? null : ranges[`${name}Flags${level + 1}`]!.offset / 4,
          last ? null : ranges[`${name}Prefix${level + 1}`]!.offset / 4,
          last ? ranges.cacheControl!.offset / 4 + control : null
        );
        const module = device.createShaderModule({ label: `SCGI/${name}/${level}`, code });
        up.push(await compile(module, "scan", scanPipelineLayout));
        if (!last) {
          down.push(await compile(module, "add", scanPipelineLayout));
        }
      }
      scans.set(name, { up, down, counts });
    }
    return new ScgiCache(device, plan, layout, scanLayout, argsLayout, pipelines, scans);
  }

  encode(transaction: ScgiFrameTransaction, settings: ScgiCacheSettings): void {
    if (
      transaction.state !== "encoded" ||
      transaction.command.device !== this.device ||
      this.encoded.has(transaction) ||
      transaction.workset.plan !== this.plan
    ) {
      throw new Error("SCGI cache requires its initialized, unique physical transaction");
    }
    const { command, publication } = transaction;
    if (
      settings.originEpoch !== this.lastOriginEpoch &&
      settings.frame <= this.lastFrame &&
      publication.activeWorld !== null
    ) {
      throw new RangeError("SCGI cache serial reset requires a fresh world scene epoch");
    }
    if (
      publication.activeWorld !== null &&
      settings.frame <= this.lastFrame &&
      settings.originEpoch === this.lastOriginEpoch
    ) {
      throw new RangeError("SCGI cache frame serial must increase inside an origin epoch");
    }
    const input = this.packSettings(settings, publication.activeWorld !== null);
    const world = publication.candidateWorld.buffer;
    const scratch = publication.privateScratch.buffer;
    const previous = publication.activeWorld?.buffer ?? publication.candidateWorldField.segments[0]!.buffer;
    const ranges = this.plan.scratch.ranges;
    const regions = [
      { destination: scratch, destinationOffset: ranges.cacheSettings!.offset, bytes: input.settings }
    ];
    if (input.dirty.byteLength > 0) {
      regions.push({
        destination: scratch,
        destinationOffset: ranges.cacheDirtyRegions!.offset,
        bytes: input.dirty
      });
    }
    command.uploadRegions(regions);
    if (settings.gpuDirty !== undefined) {
      if (
        settings.dirtyRegions?.length ||
        settings.gpuDirty.size < 1040 ||
        !(settings.gpuDirty.usage & GPUBufferUsage.COPY_SRC)
      ) {
        throw new RangeError("SCGI GPU dirty requires a complete exclusive region publication");
      }
      command.copyBufferToBuffer(settings.gpuDirty, 0, scratch, ranges.cacheSettings!.offset + 9 * 4, 8);
      command.copyBufferToBuffer(settings.gpuDirty, 8, scratch, ranges.cacheSettings!.offset + 14 * 4, 4);
      command.copyBufferToBuffer(settings.gpuDirty, 16, scratch, ranges.cacheDirtyRegions!.offset, 1024);
    }
    let byPrevious = this.groups.get(world);
    if (byPrevious === undefined) {
      byPrevious = new WeakMap();
      this.groups.set(world, byPrevious);
    }
    let byScratch = byPrevious.get(previous);
    if (byScratch === undefined) {
      byScratch = new WeakMap();
      byPrevious.set(previous, byScratch);
    }
    let group = byScratch.get(scratch);
    if (group === undefined) {
      group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: world } },
          { binding: 1, resource: { buffer: scratch } },
          { binding: 2, resource: { buffer: previous } }
        ]
      });
      byScratch.set(scratch, group);
    }
    let scanGroup = this.scanGroups.get(scratch);
    if (scanGroup === undefined) {
      scanGroup = this.device.createBindGroup({
        layout: this.scanLayout,
        entries: [{ binding: 0, resource: { buffer: scratch } }]
      });
      this.scanGroups.set(scratch, scanGroup);
    }
    let byPreviousArgs = this.argsGroups.get(world);
    if (byPreviousArgs === undefined) {
      byPreviousArgs = new WeakMap();
      this.argsGroups.set(world, byPreviousArgs);
    }
    let byScratchArgs = byPreviousArgs.get(previous);
    if (byScratchArgs === undefined) {
      byScratchArgs = new WeakMap();
      byPreviousArgs.set(previous, byScratchArgs);
    }
    let argsGroup = byScratchArgs.get(scratch);
    if (argsGroup === undefined) {
      argsGroup = this.device.createBindGroup({
        layout: this.argsLayout,
        entries: [
          { binding: 0, resource: { buffer: world } },
          { binding: 1, resource: { buffer: scratch } },
          { binding: 2, resource: { buffer: previous } },
          { binding: 3, resource: { buffer: publication.queryBatch.buffer } }
        ]
      });
      byScratchArgs.set(scratch, argsGroup);
    }
    const dispatch = (entry: (typeof ENTRIES)[number], count: number, indirect?: number): void => {
      const pass = command.beginComputePass({ label: `SCGI/cache/${entry}` });
      pass.setPipeline(this.pipelines[entry]);
      pass.setBindGroup(0, entry === "begin" || entry === "quotas" ? argsGroup! : group!);
      if (indirect === undefined) {
        pass.dispatchWorkgroups(Math.ceil(count / (count === 1 ? 1 : W)));
      } else {
        pass.dispatchWorkgroupsIndirect(
          publication.queryBatch.buffer,
          this.plan.batch.ranges.cacheIndirect!.offset + indirect
        );
      }
      pass.end();
    };
    const scan = (name: string): void => {
      const record = this.scans.get(name)!;
      for (let level = 0; level < record.up.length; level++) {
        const pass = command.beginComputePass({ label: `SCGI/${name}/scan/${level}` });
        pass.setPipeline(record.up[level]!);
        pass.setBindGroup(0, scanGroup!);
        pass.dispatchWorkgroups(Math.ceil(record.counts[level]! / W));
        pass.end();
      }
      for (let level = record.down.length - 1; level >= 0; level--) {
        const pass = command.beginComputePass({ label: `SCGI/${name}/add/${level}` });
        pass.setPipeline(record.down[level]!);
        pass.setBindGroup(0, scanGroup!);
        pass.dispatchWorkgroups(Math.ceil(record.counts[level]! / W));
        pass.end();
      }
    };
    const free = (): void => {
      dispatch("classify_free", this.plan.profile.patches);
      scan("cacheFree");
      dispatch("scatter_free", this.plan.profile.patches);
    };
    const live = (): void => {
      dispatch("classify_live", this.plan.profile.patches);
      scan("cacheLive");
      dispatch("scatter_live", this.plan.profile.patches);
    };
    this.encoded.add(transaction);
    const frame = settings.frame;
    const originEpoch = settings.originEpoch;
    command.observeSubmission({
      submitted: () => {
        this.lastFrame = frame;
        this.lastOriginEpoch = originEpoch;
      },
      aborted: () => {},
      failed: () => {}
    });
    dispatch("clear_claims", this.plan.cells);
    dispatch("begin", 1);
    dispatch("claim_requests", 0, 16);
    dispatch("maintain", this.plan.profile.patches);
    dispatch("resolve_requests", this.plan.profile.requests + this.plan.profile.bounceRequests);
    free();
    scan("cacheWinner");
    scan("cacheVisibleWinner");
    dispatch("allocate", this.plan.profile.requests + this.plan.profile.bounceRequests);
    live();
    if (settings.moveBudget > 0) {
      free();
      dispatch("plan_moves", this.plan.profile.patches);
      dispatch("snapshot_moves", Math.min(settings.moveBudget, this.plan.profile.patches));
      dispatch("apply_moves", Math.min(settings.moveBudget, this.plan.profile.patches));
      live();
    }
    dispatch("finalize_requests", this.plan.profile.requests + this.plan.profile.bounceRequests);
    dispatch("classify_priority", this.plan.profile.patches);
    for (let category = 0; category < 4; category++) {
      scan(`cachePriority${category}`);
    }
    dispatch("scatter_priority", this.plan.profile.patches);
    dispatch("quotas", 1);
    dispatch("select_updates", 0, 32);
    dispatch("finish", 1);
    publication.cacheComplete = true;
  }

  private packSettings(input: ScgiCacheSettings, previous: boolean) {
    scgiInteger(input.frame, "cache frame", 1, 0xfffffffd);
    scgiInteger(input.originEpoch, "cache origin epoch");
    scgiInteger(input.evictionAge, "eviction age");
    scgiInteger(input.updateAge, "update age");
    scgiInteger(input.moveBudget, "move budget", 0, this.plan.profile.patches);
    if (
      !Number.isFinite(Math.fround(input.voxelSize)) ||
      Math.fround(input.voxelSize) <= 0 ||
      !Number.isFinite(input.normalCosine) ||
      input.normalCosine < -1 ||
      input.normalCosine > 1 ||
      !Number.isFinite(Math.fround(input.planeDistanceScale)) ||
      Math.fround(input.planeDistanceScale) <= 0 ||
      !Number.isFinite(Math.fround(input.varianceThreshold)) ||
      input.varianceThreshold < 0 ||
      input.camera.some((value) => !Number.isFinite(Math.fround(value)))
    ) {
      throw new RangeError("Invalid SCGI cache geometry or update settings");
    }
    const words = new Uint32Array(64);
    const floats = new Float32Array(words.buffer);
    const signed = new Int32Array(words.buffer);
    words.set([input.frame, input.originEpoch, Number(input.bounceEnabled), input.evictionAge]);
    floats.set([input.voxelSize, input.normalCosine, input.planeDistanceScale], 4);
    words[7] = input.moveBudget;
    const regions = input.dirtyRegions ?? [];
    words[9] = Math.min(regions.length, SCGI_CACHE_DIRTY_CAPACITY);
    words[10] = Number(regions.length > SCGI_CACHE_DIRTY_CAPACITY);
    words[11] = Number(previous);
    words[12] = input.updateAge;
    floats[13] = input.varianceThreshold;
    for (let cascade = 0; cascade < this.plan.profile.cascades; cascade++) {
      const size = Math.fround(input.voxelSize * 2 ** cascade);
      if (!Number.isFinite(size)) {
        throw new RangeError("SCGI cascade scale overflow");
      }
      for (let axis = 0; axis < 3; axis++) {
        const cell =
          Math.floor(Math.fround(input.camera[axis]!) / size) - Math.floor(this.plan.profile.resolution / 2);
        // Integer origins beyond exact f32 cells require caller origin rebase.
        if (!Number.isSafeInteger(cell) || Math.abs(cell) + this.plan.profile.resolution >= 2 ** 23) {
          throw new RangeError("SCGI origin requires world rebase before integer precision is lost");
        }
        signed[16 + cascade * 4 + axis] = cell;
      }
    }
    const dirty = new Float32Array(words[9]! * 8);
    for (let region = 0; region < regions.length; region++) {
      const value = regions[region]!;
      for (let axis = 0; axis < 3; axis++) {
        if (
          !Number.isFinite(Math.fround(value.min[axis]!)) ||
          !Number.isFinite(Math.fround(value.max[axis]!)) ||
          value.min[axis]! > value.max[axis]!
        ) {
          throw new RangeError("Invalid SCGI dirty bounds");
        }
      }
      if (region < words[9]!) {
        dirty.set(value.min, region * 8);
        dirty.set(value.max, region * 8 + 4);
      }
    }
    return { settings: new Uint8Array(words.buffer), dirty: new Uint8Array(dirty.buffer) };
  }
}
