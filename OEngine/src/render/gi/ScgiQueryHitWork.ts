import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../../gpu/GpuInstanceAbi.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { planScgiArena, scgiInteger } from "./ScgiCapacity.js";

/** Eight words per native bin: count, packed offset, scatter cursor, reserved,
 * followed by xyz indirect arguments and reserved. One ray index per accepted
 * ray across all bins; memory never multiplies ray capacity by material count. */
export class ScgiQueryHitWork {
  private destroyed = false;

  private constructor(
    private readonly device: GPUDevice,
    readonly buffer: GPUBuffer,
    readonly indirect: GPUBuffer,
    readonly binCount: number,
    readonly rayCount: number,
    readonly listWordOffset: number,
    private readonly pipelines: readonly GPUComputePipeline[],
    private readonly group: GPUBindGroup,
    private readonly scanGroups: readonly number[],
  ) {}

  static async create(device: GPUDevice, source: GPUBuffer, materials: GPUBuffer,
    batch: GPUBuffer, rayCount: number, resultByteOffset: number, binCount: number,
    pendingOnly = false): Promise<ScgiQueryHitWork> {
    scgiInteger(rayCount, "query hit rays", 0);
    scgiInteger(binCount, "query hit native bins");
    if (pendingOnly && binCount !== 1) {
      throw new RangeError("Pending query work is one compact complete tail domain");
    }
    scgiInteger(resultByteOffset, "query hit result byte offset", 0);
    if (resultByteOffset % 4 !== 0 || resultByteOffset < rayCount * 48 ||
        resultByteOffset + rayCount * 32 > batch.size ||
        device.limits.maxComputeInvocationsPerWorkgroup < 128 ||
        device.limits.maxComputeWorkgroupSizeX < 128 ||
        device.limits.maxComputeWorkgroupStorageSize < 512 ||
        Math.ceil(Math.max(rayCount, binCount) / 128) > device.limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError("Query hit classification requires complete admitted ray/result domains");
    }
    const counts = [binCount];
    while (counts[counts.length - 1]! > 128) {
      counts.push(Math.ceil(counts[counts.length - 1]! / 128));
    }
    const plan = planScgiArena(device.limits, [
      ["bins", binCount, 32], ["rays", rayCount, 4],
      ...counts.flatMap((count, level) => [
        [`counts${level}`, count, 4] as const, [`prefix${level}`, count, 4] as const,
      ]),
    ]);
    const word = (name: string) => plan.ranges[name]!.offset / 4;
    const list = word("rays");
    const scans: string[] = [];
    const scanGroups: number[] = [];
    const entries = ["classify", "gather_counts"];
    for (let level = 0; level < counts.length; level++) {
      const count = counts[level]!;
      const input = word(`counts${level}`);
      const output = word(`prefix${level}`);
      scans.push(/* wgsl */ `
@compute @workgroup_size(128)
fn scan_up_${level}(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  let index = group.x * 128u + lane;
  var value = 0u;
  if (index < ${count}u) { value = atomicLoad(&work[${input}u + index]); }
  scan[lane] = value;
  workgroupBarrier();
  for (var width = 1u; width < 128u; width <<= 1u) {
    var add = 0u;
    if (lane >= width) { add = scan[lane - width]; }
    workgroupBarrier();
    scan[lane] += add;
    workgroupBarrier();
  }
  if (index < ${count}u) { atomicStore(&work[${output}u + index], scan[lane] - value); }
  ${level + 1 < counts.length ? `if (lane == 127u) {
    atomicStore(&work[${word(`counts${level + 1}`)}u + group.x], scan[lane]);
  }` : ""}
}`);
      entries.push(`scan_up_${level}`);
      scanGroups.push(Math.ceil(count / 128));
    }
    for (let level = counts.length - 2; level >= 0; level--) {
      scans.push(/* wgsl */ `
@compute @workgroup_size(128)
fn scan_down_${level}(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < ${counts[level]}u) {
    atomicAdd(&work[${word(`prefix${level}`)}u + id.x],
      atomicLoad(&work[${word(`prefix${level + 1}`)}u + id.x / 128u]));
  }
}`);
      entries.push(`scan_down_${level}`);
      scanGroups.push(Math.ceil(counts[level]! / 128));
    }
    entries.push("publish_bins", "scatter");
    const module = device.createShaderModule({ label: "SCGI/native hit compaction", code: /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
@group(0) @binding(0) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(1) var<storage, read> materials: array<vec4u>;
@group(0) @binding(2) var<storage, read> batch: array<u32>;
@group(0) @binding(3) var<storage, read_write> work: array<atomic<u32>>;
var<workgroup> scan: array<u32, 128>;
fn hit_bin(ray: u32) -> u32 {
  let result = ${resultByteOffset / 4}u + ray * 8u;
  ${pendingOnly ? "return select(0xffffffffu, 0u, batch[result + 3u] == 4u);" : `
  if (batch[result + 3u] != 0u) { return 0xffffffffu; }
  let instance = batch[result + 4u];
  if (instance >= arrayLength(&source)) { return 0xffffffffu; }
  let material = source[instance].material_handle;
  if (material >= arrayLength(&materials)) { return 0xffffffffu; }
  let route = materials[material];
  if (route.w == 0u || route.y >= ${binCount}u) { return 0xffffffffu; }
  return route.y;
  `}
}
@compute @workgroup_size(128)
fn classify(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${rayCount}u) { return; }
  let bin = hit_bin(id.x);
  if (bin != 0xffffffffu) { atomicAdd(&work[bin * 8u], 1u); }
}
@compute @workgroup_size(128)
fn gather_counts(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < ${binCount}u) {
    atomicStore(&work[${word("counts0")}u + id.x], atomicLoad(&work[id.x * 8u]));
  }
}
${scans.join("\n")}
@compute @workgroup_size(128)
fn publish_bins(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${binCount}u) { return; }
  let at = id.x * 8u;
  let count = atomicLoad(&work[at]);
  atomicStore(&work[at + 1u], atomicLoad(&work[${word("prefix0")}u + id.x]));
  atomicStore(&work[at + 4u], (count + 63u) / 64u);
  atomicStore(&work[at + 5u], 1u);
  atomicStore(&work[at + 6u], 1u);
}
@compute @workgroup_size(128)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${rayCount}u) { return; }
  let bin = hit_bin(id.x);
  if (bin == 0xffffffffu) { return; }
  let at = bin * 8u;
  let index = atomicLoad(&work[at + 1u]) + atomicAdd(&work[at + 2u], 1u);
  atomicStore(&work[${list}u + index], id.x);
}
` });
    const layout = device.createBindGroupLayout({ entries: [0, 1, 2, 3].map((binding) => ({
      binding, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: binding === 3 ? "storage" : "read-only-storage" },
    })) });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipelines = await Promise.all(entries.map((entryPoint) =>
      PipelineCompilationQueue.forDevice(device).run(() => device.createComputePipelineAsync({
        label: `SCGI/native hit ${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint },
      }))));
    const buffers: GPUBuffer[] = [];
    try {
      const buffer = device.createBuffer({ label: "SCGI/packed native hit work", size: plan.bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      buffers.push(buffer);
      const indirect = device.createBuffer({ label: "SCGI/native hit indirect", size: binCount * 32,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
      buffers.push(indirect);
      const group = device.createBindGroup({ layout, entries: [source, materials, batch, buffer]
        .map((resource, binding) => ({ binding, resource: { buffer: resource } })) });
      return new ScgiQueryHitWork(device, buffer, indirect, binCount, rayCount, list,
        pipelines, group, scanGroups);
    } catch (error) {
      for (const buffer of buffers) { buffer.destroy(); }
      throw error;
    }
  }

  encode(command: ShadeGPUCommandContext): void {
    if (this.destroyed || command.closed || command.device !== this.device) {
      throw new Error("Native hit compaction requires its live admitted batch");
    }
    command.clearBuffer(this.buffer);
    const groups = [Math.ceil(this.rayCount / 128), Math.ceil(this.binCount / 128),
      ...this.scanGroups, Math.ceil(this.binCount / 128), Math.ceil(this.rayCount / 128)];
    for (let index = 0; index < this.pipelines.length; index++) {
      const pass = command.gpu_encoder.beginComputePass({ label: this.pipelines[index]!.label });
      pass.setPipeline(this.pipelines[index]!);
      pass.setBindGroup(0, this.group);
      pass.dispatchWorkgroups(groups[index]!);
      pass.end();
    }
    command.copyBufferToBuffer(this.buffer, 0, this.indirect, 0, this.binCount * 32);
  }

  destroy(): void {
    if (this.destroyed) { return; }
    this.destroyed = true;
    this.buffer.destroy();
    this.indirect.destroy();
  }
}
