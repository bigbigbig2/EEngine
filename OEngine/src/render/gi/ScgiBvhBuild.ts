import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { scgiBvhBuildWgsl, scgiBvhRadixWgsl, scgiBvhScanWgsl, scgiBvhTreeletWgsl } from "../../shaders/scgi_bvh_build.js";
import { scgiInteger } from "./ScgiCapacity.js";
import { SCGI_BVH_MAX_DEPTH, SCGI_BVH_WORKGROUP_SIZE as W, type ScgiBvhPlan } from "./ScgiBvhLayout.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";

const ENTRIES = ["initialize", "reduce_bounds", "morton", "topology", "depth_initialize",
  "depth_jump", "classify_depth", "level_offsets", "scatter_levels", "refit", "balanced_topology",
  "reset_levels", "rebuild_links", "escape_links", "finalize", "update_leaves"] as const;

/** Physical build kernels borrow immutable primitive facts and candidate arenas.
 * This owner creates no frame submits, scene database, vertex/index copies or
 * CPU work decisions from GPU results. The scene publication owns AS lifetime. */
export class ScgiBvhBuild {
  private readonly buildGroups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  private readonly radixGroups = new WeakMap<GPUBuffer, GPUBindGroup>();
  private readonly scanGroups = new WeakMap<GPUBuffer, GPUBindGroup>();
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
    private readonly accounting?: ResourceAccounting,
  ) {
    for (const buffer of [settings, indirect]) {
      if (accounting !== undefined) {
        this.resourceHandles.push(accounting.created({ kind: "buffer", owner: "SCGI/BVH",
          category: "transient", bytes: buffer.size, label: buffer.label }, buffer));
      }
    }
  }

  static async create(device: GPUDevice, plan: ScgiBvhPlan, subgroup = false,
    accounting?: ResourceAccounting): Promise<ScgiBvhBuild> {
    if (subgroup && !device.features.has("subgroups")) {
      throw new RangeError("Subgroup BVH build requires the negotiated device feature");
    }
    if (device.limits.maxComputeInvocationsPerWorkgroup < W || device.limits.maxComputeWorkgroupSizeX < W ||
        device.limits.maxStorageBuffersPerShaderStage < 2 ||
        Math.ceil(plan.nodes / W) > device.limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError("BVH shard exceeds negotiated compute limits");
    }
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({
      binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" },
    });
    const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
      binding, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
    });
    const buildLayout = device.createBindGroupLayout({
      label: "SCGI/BVH/build", entries: [storage(0), storage(1), uniform(2)],
    });
    const radixLayout = device.createBindGroupLayout({
      label: "SCGI/BVH/radix", entries: [storage(0), uniform(1)],
    });
    const scanLayout = device.createBindGroupLayout({ label: "SCGI/BVH/scan", entries: [storage(0)] });
    const buildPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [buildLayout] });
    const radixPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [radixLayout] });
    const scanPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [scanLayout] });
    const queue = PipelineCompilationQueue.forDevice(device);
    const buildModule = device.createShaderModule({ label: "SCGI/BVH/build", code: scgiBvhBuildWgsl(plan) });
    const radixModule = device.createShaderModule({ label: "SCGI/BVH/radix", code: scgiBvhRadixWgsl(plan, subgroup) });
    const treeletModule = device.createShaderModule({ label: "SCGI/BVH/treelet", code: scgiBvhTreeletWgsl(plan) });
    const compile = (module: GPUShaderModule, entryPoint: string, layout: GPUPipelineLayout) =>
      queue.run(() => device.createComputePipelineAsync({
        label: `SCGI/BVH/${entryPoint}`, layout, compute: { module, entryPoint },
      }));
    const buildPipelines = Object.fromEntries(await Promise.all(ENTRIES.map(async (entry) =>
      [entry, await compile(buildModule, entry, buildPipelineLayout)]))) as Record<(typeof ENTRIES)[number], GPUComputePipeline>;
    const radixPipelines = await Promise.all([
      compile(radixModule, "histogram", radixPipelineLayout),
      compile(radixModule, "scatter", radixPipelineLayout),
    ]) as [GPUComputePipeline, GPUComputePipeline];
    const treeletPipeline = await compile(treeletModule, "restructure", buildPipelineLayout);
    const scans: Array<readonly [GPUComputePipeline, GPUComputePipeline]> = [];
    for (let level = 0; level < plan.scanCounts.length; level++) {
      const module = device.createShaderModule({
        label: `SCGI/BVH/scan/${level}`, code: scgiBvhScanWgsl(plan, level),
      });
      scans.push(await Promise.all([
        compile(module, "scan_up", scanPipelineLayout),
        compile(module, "scan_down", scanPipelineLayout),
      ]) as [GPUComputePipeline, GPUComputePipeline]);
    }
    // One encoded build uses fewer than 512 fixed parameter slots. Writes are command
    // copies, so same-queue reuse never host-overwrites an in-flight build.
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    const settings = device.createBuffer({
      label: "SCGI/BVH/build parameters", size: alignment * 512,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
      return new ScgiBvhBuild(device, plan, subgroup, buildLayout, radixLayout, scanLayout,
        settings, indirect, buildPipelines, radixPipelines, scans, treeletPipeline, accounting);
    } catch (error) {
      settings.destroy();
      indirect?.destroy();
      throw error;
    }
  }

  /** Records the Morton/radix/topology/level-refit build. Primitive facts must
   * already be completely written by a dependency in this same command. */
  encode(command: ShadeGPUCommandContext, hierarchy: GPUBuffer, scratch: GPUBuffer, count: number): void {
    this.encodeBuild(command, hierarchy, scratch, count, false);
  }

  /** Shared geometry has changed positions without changing primitive identity
   * or count. The caller copies a committed topology into a separate candidate
   * before encoding; no active hierarchy is modified while readers retain it. */
  encodeRefit(command: ShadeGPUCommandContext, hierarchy: GPUBuffer, scratch: GPUBuffer, count: number): void {
    this.encodeBuild(command, hierarchy, scratch, count, true);
  }

  private encodeBuild(command: ShadeGPUCommandContext, hierarchy: GPUBuffer, scratch: GPUBuffer,
    count: number, refitOnly: boolean): void {
    scgiInteger(count, "BVH primitive count", 0, this.plan.primitiveCapacity);
    if (this.destroyed || command.device !== this.device || command.closed || hierarchy.size < this.plan.hierarchy.bytes ||
        scratch.size < this.plan.scratch.bytes || hierarchy === scratch ||
        (scratch.usage & GPUBufferUsage.COPY_SRC) === 0) {
      throw new Error("BVH build requires its live device and complete separate candidate arenas");
    }
    let byScratch = this.buildGroups.get(hierarchy);
    if (byScratch === undefined) {
      byScratch = new WeakMap();
      this.buildGroups.set(hierarchy, byScratch);
    }
    let buildGroup = byScratch.get(scratch);
    if (buildGroup === undefined) {
      buildGroup = this.device.createBindGroup({ layout: this.buildLayout, entries: [
        { binding: 0, resource: { buffer: hierarchy, size: this.plan.hierarchy.bytes } },
        { binding: 1, resource: { buffer: scratch, size: this.plan.scratch.bytes } },
        { binding: 2, resource: { buffer: this.settings, size: 16 } },
      ] });
      byScratch.set(scratch, buildGroup);
    }
    let radixGroup = this.radixGroups.get(scratch);
    if (radixGroup === undefined) {
      radixGroup = this.device.createBindGroup({ layout: this.radixLayout, entries: [
        { binding: 0, resource: { buffer: scratch, size: this.plan.scratch.bytes } },
        { binding: 1, resource: { buffer: this.settings, size: 16 } },
      ] });
      this.radixGroups.set(scratch, radixGroup);
    }
    let scanGroup = this.scanGroups.get(scratch);
    if (scanGroup === undefined) {
      scanGroup = this.device.createBindGroup({ layout: this.scanLayout, entries: [
        { binding: 0, resource: { buffer: scratch, size: this.plan.scratch.bytes } },
      ] });
      this.scanGroups.set(scratch, scanGroup);
    }
    const alignment = this.device.limits.minUniformBufferOffsetAlignment;
    const parameters = new Uint8Array(512 * alignment);
    const words = new DataView(parameters.buffer);
    let slot = 0;
    type Dispatch = { pipeline: GPUComputePipeline; group: GPUBindGroup; count: number;
      offset?: number; indirectOffset?: number };
    const records: Array<Dispatch | { copyArguments: true }> = [];
    const step = (pipeline: GPUComputePipeline, group: GPUBindGroup, groups: number,
      phase = 0, source = 0, mode = 0) => {
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
    if (refitOnly) {
      // Clear control/header without erasing existing topology parent links.
      command.gpu_encoder.clearBuffer(scratch, this.plan.scratch.ranges.control!.offset,
        this.plan.scratch.ranges.control!.bytes);
      build("reduce_bounds", this.plan.blocks);
      build("reduce_bounds", 1, 0, 0, 1);
      build("update_leaves", primitiveGroups);
    } else {
      build("initialize", Math.max(1, Math.ceil(Math.max(nodes, SCGI_BVH_MAX_DEPTH + 1) / W)));
      build("reduce_bounds", this.plan.blocks);
      build("reduce_bounds", 1, 0, 0, 1);
      build("morton", primitiveGroups);
      for (let digit = 0; digit < 8; digit++) {
        step(this.radixPipelines[0], radixGroup, this.plan.blocks, digit * 4, digit & 1);
        for (let level = 0; level < this.plan.scanCounts.length; level++) {
          records.push({ pipeline: this.scanPipelines[level]![0], group: scanGroup,
            count: Math.ceil(this.plan.scanCounts[level]! / W) });
        }
        for (let level = this.plan.scanCounts.length - 2; level >= 0; level--) {
          records.push({ pipeline: this.scanPipelines[level]![1], group: scanGroup,
            count: Math.ceil(this.plan.scanCounts[level]! / W) });
        }
        step(this.radixPipelines[1], radixGroup, this.plan.blocks, digit * 4, digit & 1);
      }
      build("topology", primitiveGroups);
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
    for (let depth = SCGI_BVH_MAX_DEPTH; depth >= 0; depth--) {
      step(this.treeletPipeline, buildGroup, 0, depth).indirectOffset =
        (SCGI_BVH_MAX_DEPTH + 1 + depth) * 16;
    }
    build("rebuild_links", nodeGroups);
    levels();
    build("balanced_topology", nodeGroups);
    levels();
    refit();
    build("escape_links", nodeGroups);
    build("finalize", 1);
    if (slot > 512) {
      throw new Error("BVH physical parameter schedule exceeds capacity");
    }
    command.uploadRegions([{ destination: this.settings, destinationOffset: 0,
      bytes: parameters.subarray(0, slot * alignment) }]);
    for (const record of records) {
      if ("copyArguments" in record) {
        command.copyBufferToBuffer(scratch, this.plan.scratch.ranges.indirect!.offset,
          this.indirect, 0, this.indirect.size);
        continue;
      }
      const pass = command.gpu_encoder.beginComputePass({ label: record.pipeline.label });
      pass.setPipeline(record.pipeline);
      pass.setBindGroup(0, record.group, record.offset === undefined ? [] : [record.offset]);
      if (record.indirectOffset === undefined) {
        pass.dispatchWorkgroups(record.count);
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
    for (const handle of this.resourceHandles) {
      this.accounting!.destroyed(handle);
    }
  }
}
