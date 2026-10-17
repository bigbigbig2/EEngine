import { geometryQueryPipelines } from "../../gpu/GeometryQueryPipelines.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  scgiBvhBuildWgsl,
  scgiBvhRadixWgsl,
  scgiBvhScanWgsl,
  scgiBvhTreeletWgsl,
} from "../../shaders/scgi_bvh_build.js";
import { scgiInteger } from "./ScgiCapacity.js";
import { SCGI_BVH_MAX_DEPTH, SCGI_BVH_WORKGROUP_SIZE as W, type ScgiBvhPlan } from "./ScgiBvhLayout.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";

const ENTRIES = [
  "initialize",
  "reduce_bounds",
  "morton",
  "topology",
  "depth_initialize",
  "depth_jump",
  "classify_depth",
  "level_offsets",
  "scatter_levels",
  "refit",
  "balanced_topology",
  "reset_levels",
  "rebuild_links",
  "escape_links",
  "finalize",
  "update_leaves",
  "publish_references",
  "update_policy",
  "update_decide",
  "quality_reduce",
  "quality_decide",
] as const;

/** Physical build kernels borrow immutable primitive facts and candidate arenas.
 * This owner creates no frame submits, scene database, vertex/index copies or
 * CPU work decisions from GPU results. The scene publication owns AS lifetime. */
export class ScgiBvhBuild {
  private readonly buildGroups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  private readonly radixGroups = new WeakMap<GPUBuffer, GPUBindGroup>();
  private readonly scanGroups = new WeakMap<GPUBuffer, GPUBindGroup>();
  private readonly countGroups = new WeakMap<GPUBuffer, GPUBindGroup>();
  private destroyed = false;
  private readonly resourceHandles: ResourceHandle[] = [];

  private constructor(
    readonly device: GPUDevice,
    readonly plan: ScgiBvhPlan,
    readonly subgroup: boolean,
    private readonly buildLayout: GPUBindGroupLayout,
    private readonly radixLayout: GPUBindGroupLayout,
    private readonly scanLayout: GPUBindGroupLayout,
    private readonly settings: GPUBuffer,
    private readonly indirect: GPUBuffer,
    private readonly buildPipelines: Readonly<Record<(typeof ENTRIES)[number], GPUComputePipeline>>,
    private readonly radixPipelines: readonly [GPUComputePipeline, GPUComputePipeline],
    private readonly scanPipelines: readonly (readonly [GPUComputePipeline, GPUComputePipeline])[],
    private readonly treeletPipeline: GPUComputePipeline,
    private readonly resolvedSettings: GPUBuffer,
    private readonly countPipeline: GPUComputePipeline,
    private readonly accounting?: ResourceAccounting,
  ) {
    for (const buffer of [settings, indirect, resolvedSettings]) {
      if (accounting !== undefined) {
        this.resourceHandles.push(
          accounting.created(
            {
              kind: "buffer",
              owner: "SCGI/BVH",
              category: "transient",
              bytes: buffer.size,
              label: buffer.label,
            },
            buffer,
          ),
        );
      }
    }
  }

  get byteLength(): number {
    return this.settings.size + this.resolvedSettings.size + this.indirect.size;
  }

  static allocationBytes(device: GPUDevice, plan: ScgiBvhPlan): number {
    return device.limits.minUniformBufferOffsetAlignment * 1024 + plan.scratch.ranges.indirect!.bytes;
  }

  static async create(
    device: GPUDevice,
    plan: ScgiBvhPlan,
    subgroup = false,
    accounting?: ResourceAccounting,
  ): Promise<ScgiBvhBuild> {
    if (subgroup && !device.features.has("subgroups")) {
      throw new RangeError("Subgroup BVH build requires the negotiated device feature");
    }
    if (
      device.limits.maxComputeInvocationsPerWorkgroup < W ||
      device.limits.maxComputeWorkgroupSizeX < W ||
      device.limits.maxStorageBuffersPerShaderStage < 2 ||
      Math.ceil(plan.nodes / W) > device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("BVH shard exceeds negotiated compute limits");
    }
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" },
    });
    const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
    });
    const cache = geometryQueryPipelines(device);
    const buildDescriptor = { label: "SCGI/BVH/build", entries: [storage(0), storage(1), uniform(2)] };
    const radixDescriptor = { label: "SCGI/BVH/radix", entries: [storage(0), uniform(1)] };
    const scanDescriptor = { label: "SCGI/BVH/scan", entries: [storage(0)] };
    const buildLayout = cache.layouts.obtainBindGroupLayout(buildDescriptor);
    const radixLayout = cache.layouts.obtainBindGroupLayout(radixDescriptor);
    const scanLayout = cache.layouts.obtainBindGroupLayout(scanDescriptor);
    const buildModule = { label: "SCGI/BVH/build", code: scgiBvhBuildWgsl(plan) };
    const radixModule = { label: "SCGI/BVH/radix", code: scgiBvhRadixWgsl(plan, subgroup) };
    const treeletModule = { label: "SCGI/BVH/treelet", code: scgiBvhTreeletWgsl(plan) };
    const compile = (
      module: GPUShaderModuleDescriptor,
      entryPoint: string,
      descriptor: GPUBindGroupLayoutDescriptor,
    ) =>
      cache.prepare({
        label: `SCGI/BVH/${entryPoint}`,
        layout: { bindGroupLayouts: [descriptor] },
        compute: { module, entryPoint },
      });
    const buildPipelines = Object.fromEntries(
      await Promise.all(
        ENTRIES.map(async (entry) => [entry, await compile(buildModule, entry, buildDescriptor)]),
      ),
    ) as Record<(typeof ENTRIES)[number], GPUComputePipeline>;
    const radixPipelines = (await Promise.all([
      compile(radixModule, "histogram", radixDescriptor),
      compile(radixModule, "scatter", radixDescriptor),
    ])) as [GPUComputePipeline, GPUComputePipeline];
    const treeletPipeline = await compile(treeletModule, "restructure", buildDescriptor);
    const scans: Array<readonly [GPUComputePipeline, GPUComputePipeline]> = [];
    for (let level = 0; level < plan.scanCounts.length; level++) {
      const module = { label: `SCGI/BVH/scan/${level}`, code: scgiBvhScanWgsl(plan, level) };
      scans.push(
        (await Promise.all([
          compile(module, "scan_up", scanDescriptor),
          compile(module, "scan_down", scanDescriptor),
        ])) as [GPUComputePipeline, GPUComputePipeline],
      );
    }
    // One encoded build uses fewer than 512 fixed parameter slots. Writes are command
    // copies, so same-queue reuse never host-overwrites an in-flight build.
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    const countModule = {
      code: /* wgsl */ `
@group(0) @binding(0) var<storage, read> scratch: array<u32>;
@group(0) @binding(1) var<storage, read_write> parameters: array<u32>;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < 512u) {
    let at = id.x * ${alignment / 4}u;
    parameters[at] = scratch[${plan.scratch.ranges.input!.offset / 4}u];
    let action = scratch[${plan.scratch.ranges.input!.offset / 4 + 1}u];
    let route = parameters[at + 7u];
    if (action == 0u || (route == 3u && action != 3u) || (route == 1u && action == 3u)) {
      parameters[at + 4u] = 0u;
    }
  }
}`,
    };
    const countPipeline = await compile(countModule, "main", {
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        storage(1),
      ],
    });
    const settings = device.createBuffer({
      label: "SCGI/BVH/build parameters",
      size: alignment * 512,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const resolvedSettings = device.createBuffer({
      label: "SCGI/BVH/GPU count parameters",
      size: alignment * 512,
      usage:
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT,
    });
    // The build scratch is storage-bound by the consumers. Copy GPU-produced
    // arguments into a separate buffer to avoid storage/indirect usage overlap.
    let indirect: GPUBuffer | undefined;
    try {
      indirect = device.createBuffer({
        label: "SCGI/BVH/level dispatch arguments",
        size: plan.scratch.ranges.indirect!.bytes,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      });
      return new ScgiBvhBuild(
        device,
        plan,
        subgroup,
        buildLayout,
        radixLayout,
        scanLayout,
        settings,
        indirect,
        buildPipelines,
        radixPipelines,
        scans,
        treeletPipeline,
        resolvedSettings,
        countPipeline,
        accounting,
      );
    } catch (error) {
      settings.destroy();
      resolvedSettings.destroy();
      indirect?.destroy();
      throw error;
    }
  }

  /** Records the Morton/radix/topology/level-refit build. Primitive facts must
   * already be completely written by a dependency in this same command. */
  encode(
    command: ShadeGPUCommandContext,
    hierarchy: GPUBuffer,
    scratch: GPUBuffer,
    count: number,
    gpuCount = false,
  ): void {
    this.encodeBuild(command, hierarchy, scratch, count, false, gpuCount);
  }

  /** Shared geometry has changed positions without changing primitive identity
   * or count. The caller copies a committed topology into a separate candidate
   * before encoding; no active hierarchy is modified while readers retain it. */
  encodeRefit(
    command: ShadeGPUCommandContext,
    hierarchy: GPUBuffer,
    scratch: GPUBuffer,
    count: number,
  ): void {
    this.encodeBuild(command, hierarchy, scratch, count, true);
  }

  /** Candidate must already contain a copy of the previous hierarchy. GPU
   * classification chooses unchanged/refit or rebuild, then quality controls
   * treelet work and a persistent next-update rebuild request. */
  encodeUpdate(
    command: ShadeGPUCommandContext,
    hierarchy: GPUBuffer,
    scratch: GPUBuffer,
    capacity: number,
  ): void {
    this.encodeBuild(command, hierarchy, scratch, capacity, false, true, true);
  }

  private encodeBuild(
    command: ShadeGPUCommandContext,
    hierarchy: GPUBuffer,
    scratch: GPUBuffer,
    count: number,
    refitOnly: boolean,
    gpuCount = false,
    update = false,
  ): void {
    scgiInteger(count, "BVH primitive count", 0, this.plan.primitiveCapacity);
    if (
      this.destroyed ||
      command.device !== this.device ||
      command.closed ||
      hierarchy.size < this.plan.hierarchy.bytes ||
      scratch.size < this.plan.scratch.bytes ||
      hierarchy === scratch ||
      (scratch.usage & GPUBufferUsage.COPY_SRC) === 0
    ) {
      throw new Error("BVH build requires its live device and complete separate candidate arenas");
    }
    let byScratch = this.buildGroups.get(hierarchy);
    if (byScratch === undefined) {
      byScratch = new WeakMap();
      this.buildGroups.set(hierarchy, byScratch);
    }
    let buildGroup = byScratch.get(scratch);
    if (buildGroup === undefined) {
      buildGroup = this.device.createBindGroup({
        layout: this.buildLayout,
        entries: [
          { binding: 0, resource: { buffer: hierarchy, size: this.plan.hierarchy.bytes } },
          { binding: 1, resource: { buffer: scratch, size: this.plan.scratch.bytes } },
          { binding: 2, resource: { buffer: this.settings, size: 16 } },
        ],
      });
      byScratch.set(scratch, buildGroup);
    }
    let radixGroup = this.radixGroups.get(scratch);
    if (radixGroup === undefined) {
      radixGroup = this.device.createBindGroup({
        layout: this.radixLayout,
        entries: [
          { binding: 0, resource: { buffer: scratch, size: this.plan.scratch.bytes } },
          { binding: 1, resource: { buffer: this.settings, size: 16 } },
        ],
      });
      this.radixGroups.set(scratch, radixGroup);
    }
    let scanGroup = this.scanGroups.get(scratch);
    if (scanGroup === undefined) {
      scanGroup = this.device.createBindGroup({
        layout: this.scanLayout,
        entries: [{ binding: 0, resource: { buffer: scratch, size: this.plan.scratch.bytes } }],
      });
      this.scanGroups.set(scratch, scanGroup);
    }
    const alignment = this.device.limits.minUniformBufferOffsetAlignment;
    const parameters = new Uint8Array(512 * alignment);
    const words = new DataView(parameters.buffer);
    let slot = 0;
    type Dispatch = {
      pipeline: GPUComputePipeline;
      group: GPUBindGroup;
      count: number;
      offset?: number;
      indirectOffset?: number;
      route?: number;
      schedule?: number;
    };
    const records: Array<Dispatch | { copyArguments: true }> = [];
    const step = (
      pipeline: GPUComputePipeline,
      group: GPUBindGroup,
      groups: number,
      phase = 0,
      source = 0,
      mode = 0,
    ) => {
      const offset = slot++ * alignment;
      for (const [lane, value] of [count, phase, source, mode].entries()) {
        words.setUint32(offset + lane * 4, value, true);
      }
      const record: Dispatch = { pipeline, group, count: groups, offset };
      records.push(record);
      return record;
    };
    const build = (entry: (typeof ENTRIES)[number], groups: number, phase = 0, source = 0, mode = 0) =>
      step(this.buildPipelines[entry], buildGroup!, groups, phase, source, mode);
    const nodes = count === 0 ? 0 : count * 2 - 1;
    const nodeGroups = Math.max(1, Math.ceil(nodes / W));
    const primitiveGroups = Math.max(1, Math.ceil(count / W));
    // input is a separate producer domain; initialize/control resets cannot
    // erase compact count or update decisions from the preceding dispatch.
    if (update) {
      command.clearBuffer(scratch, this.plan.scratch.ranges.input!.offset + 4, 12);
      command.clearBuffer(
        scratch,
        this.plan.scratch.ranges.indirect!.offset,
        this.plan.scratch.ranges.indirect!.bytes,
      );
      for (const [entry, groups] of [
        ["update_policy", primitiveGroups],
        ["update_decide", 1],
      ] as const) {
        const pass = command.gpu_encoder.beginComputePass({ label: `SCGI/BVH/${entry}` });
        pass.setPipeline(this.buildPipelines[entry]);
        pass.setBindGroup(0, buildGroup, [0]);
        pass.dispatchWorkgroups(groups);
        pass.end();
      }
    } else {
      const input = new Uint32Array([count, refitOnly ? 2 : 3, 0, 0]);
      command.uploadRegions([
        {
          destination: scratch,
          destinationOffset: this.plan.scratch.ranges.input!.offset + (gpuCount ? 4 : 0),
          bytes: new Uint8Array(input.buffer, gpuCount ? 4 : 0),
        },
      ]);
    }
    if (refitOnly) {
      // Clear control/header without erasing existing topology parent links.
      command.gpu_encoder.clearBuffer(
        scratch,
        this.plan.scratch.ranges.control!.offset,
        this.plan.scratch.ranges.control!.bytes,
      );
      build("reduce_bounds", this.plan.blocks);
      build("reduce_bounds", 1, 0, 0, 1);
      build("update_leaves", primitiveGroups);
    } else {
      build("initialize", Math.max(1, Math.ceil(Math.max(nodes, SCGI_BVH_MAX_DEPTH + 1) / W)));
      build("reduce_bounds", this.plan.blocks);
      build("reduce_bounds", 1, 0, 0, 1);
      build("morton", primitiveGroups).route = 3;
      for (let digit = 0; digit < 8; digit++) {
        step(this.radixPipelines[0], radixGroup, this.plan.blocks, digit * 4, digit & 1).route = 3;
        for (let level = 0; level < this.plan.scanCounts.length; level++) {
          records.push({
            pipeline: this.scanPipelines[level]![0],
            group: scanGroup,
            count: Math.ceil(this.plan.scanCounts[level]! / W),
            route: 3,
          });
        }
        for (let level = this.plan.scanCounts.length - 2; level >= 0; level--) {
          records.push({
            pipeline: this.scanPipelines[level]![1],
            group: scanGroup,
            count: Math.ceil(this.plan.scanCounts[level]! / W),
            route: 3,
          });
        }
        step(this.radixPipelines[1], radixGroup, this.plan.blocks, digit * 4, digit & 1).route = 3;
      }
      build("topology", primitiveGroups).route = 3;
      if (update) {
        build("update_leaves", primitiveGroups).route = 1;
      }
    }
    const levels = () => {
      build("reset_levels", 1);
      build("depth_initialize", nodeGroups);
      let source = 0;
      for (let round = 0; round < Math.ceil(Math.log2(Math.max(2, this.plan.nodes))); round++) {
        build("depth_jump", nodeGroups, 0, source);
        source ^= 1;
      }
      build("classify_depth", nodeGroups, 0, source);
    };
    levels();
    build("balanced_topology", nodeGroups);
    levels();
    const refit = () => {
      build("level_offsets", 1, 0, 0, this.device.limits.maxComputeWorkgroupsPerDimension);
      build("scatter_levels", nodeGroups);
      records.push({ copyArguments: true });
      for (let depth = SCGI_BVH_MAX_DEPTH; depth >= 0; depth--) {
        build("refit", 0, depth).indirectOffset = depth * 16;
      }
    };
    refit();
    build("quality_reduce", nodeGroups);
    build("quality_decide", 1, 0);
    for (let depth = SCGI_BVH_MAX_DEPTH; depth >= 0; depth--) {
      step(this.treeletPipeline, buildGroup, 0, depth).indirectOffset = (SCGI_BVH_MAX_DEPTH + 1 + depth) * 16;
    }
    build("rebuild_links", nodeGroups);
    levels();
    build("balanced_topology", nodeGroups);
    levels();
    refit();
    build("quality_reduce", nodeGroups);
    build("quality_decide", 1, 1);
    build("escape_links", nodeGroups);
    build("publish_references", primitiveGroups);
    build("finalize", 1);
    for (const record of records) {
      if ("copyArguments" in record) {
        continue;
      }
      const offset = record.offset ?? slot++ * alignment;
      record.schedule = offset + 16;
      words.setUint32(offset + 16, record.count, true);
      words.setUint32(offset + 20, 1, true);
      words.setUint32(offset + 24, 1, true);
      words.setUint32(offset + 28, record.route ?? 0, true);
    }
    if (slot > 512) {
      throw new Error("BVH physical parameter schedule exceeds capacity");
    }
    command.uploadRegions([
      {
        destination: gpuCount ? this.resolvedSettings : this.settings,
        destinationOffset: 0,
        bytes: parameters.subarray(0, slot * alignment),
      },
    ]);
    if (gpuCount) {
      let group = this.countGroups.get(scratch);
      if (group === undefined) {
        group = this.device.createBindGroup({
          layout: this.countPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: scratch } },
            { binding: 1, resource: { buffer: this.resolvedSettings } },
          ],
        });
        this.countGroups.set(scratch, group);
      }
      const pass = command.gpu_encoder.beginComputePass({ label: "SCGI/BVH/resolve compact count" });
      pass.setPipeline(this.countPipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(4);
      pass.end();
      command.copyBufferToBuffer(this.resolvedSettings, 0, this.settings, 0, slot * alignment);
    }
    for (const record of records) {
      if ("copyArguments" in record) {
        command.copyBufferToBuffer(
          scratch,
          this.plan.scratch.ranges.indirect!.offset,
          this.indirect,
          0,
          this.indirect.size,
        );
        continue;
      }
      const pass = command.gpu_encoder.beginComputePass({ label: record.pipeline.label });
      pass.setPipeline(record.pipeline);
      pass.setBindGroup(0, record.group, record.offset === undefined ? [] : [record.offset]);
      if (record.indirectOffset === undefined) {
        if (gpuCount) {
          pass.dispatchWorkgroupsIndirect(this.resolvedSettings, record.schedule!);
        } else {
          pass.dispatchWorkgroups(record.count);
        }
      } else {
        pass.dispatchWorkgroupsIndirect(this.indirect, record.indirectOffset);
      }
      pass.end();
    }
  }

  /** Caller waits its final consumer fence, or a confirmed device teardown. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.settings.destroy();
    this.indirect.destroy();
    this.resolvedSettings.destroy();
    for (const handle of this.resourceHandles) {
      this.accounting!.destroyed(handle);
    }
  }
}
