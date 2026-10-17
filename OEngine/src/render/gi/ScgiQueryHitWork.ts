import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../../gpu/GpuInstanceAbi.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { ScgiQueryRayCount } from "./ScgiQueryRayCount.js";
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
    private readonly rayWork?: ScgiQueryRayCount,
  ) {}

  static async create(
    device: GPUDevice,
    source: GPUBuffer,
    materials: GPUBuffer,
    batch: GPUBuffer,
    rayCount: number,
    resultByteOffset: number,
    binCount: number,
    rayWork?: ScgiQueryRayCount,
  ): Promise<ScgiQueryHitWork> {
    scgiInteger(rayCount, "query hit rays", 0);
    scgiInteger(binCount, "query hit native bins");
    scgiInteger(resultByteOffset, "query hit result byte offset", 0);
    if (
      resultByteOffset % 4 !== 0 ||
      resultByteOffset < rayCount * 48 ||
      resultByteOffset + rayCount * 32 > batch.size ||
      device.limits.maxComputeInvocationsPerWorkgroup < 128 ||
      device.limits.maxComputeWorkgroupSizeX < 128 ||
      device.limits.maxComputeWorkgroupStorageSize < 2048 ||
      Math.ceil(Math.max(rayCount, binCount) / 128) > device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("Query hit classification requires complete admitted ray/result domains");
    }
    const counts = [binCount];
    while (counts[counts.length - 1]! > 128) {
      counts.push(Math.ceil(counts[counts.length - 1]! / 128));
    }
    const plan = planScgiArena(device.limits, [
      ["bins", binCount, 32],
      ["rays", rayCount, 4],
      ...counts.flatMap((count, level) => [
        [`counts${level}`, count, 4] as const,
        [`prefix${level}`, count, 4] as const,
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
  ${
    level + 1 < counts.length
      ? `if (lane == 127u) {
    atomicStore(&work[${word(`counts${level + 1}`)}u + group.x], scan[lane]);
  }`
      : ""
  }
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
    const module = device.createShaderModule({
      label: "SCGI/native hit compaction",
      code: /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
@group(0) @binding(0) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(1) var<storage, read> materials: array<vec4u>;
@group(0) @binding(2) var<storage, read> batch: array<u32>;
@group(0) @binding(3) var<storage, read_write> work: array<atomic<u32>>;
${rayWork === undefined ? "" : "@group(0) @binding(4) var<storage, read> ray_count: array<u32>;"}
var<workgroup> scan: array<u32, 128>;
var<workgroup> keys: array<u32, 128>;
var<workgroup> rays: array<u32, 128>;
var<workgroup> reservations: array<u32, 128>;
// Local bitonic sort groups arbitrary native bins in O(log^2 WG) work,
// with one global reservation per occupied bin per workgroup.
fn sorted_hits(lane: u32, ray: u32) {
  var bin = 0xffffffffu;
  if (ray < ${rayWork === undefined ? `${rayCount}u` : "ray_count[0]"}) { bin = hit_bin(ray); }
  keys[lane] = bin;
  rays[lane] = ray;
  workgroupBarrier();
  for (var size = 2u; size <= 128u; size <<= 1u) {
    for (var width = size >> 1u; width > 0u; width >>= 1u) {
      let other = lane ^ width;
      if (other > lane) {
        let ascending = (lane & size) == 0u;
        if ((keys[lane] > keys[other]) == ascending && keys[lane] != keys[other]) {
          let key = keys[lane]; keys[lane] = keys[other]; keys[other] = key;
          let value = rays[lane]; rays[lane] = rays[other]; rays[other] = value;
        }
      }
      workgroupBarrier();
    }
  }
}
fn hit_bin(ray: u32) -> u32 {
  let result = ${resultByteOffset / 4}u + ray * 8u;
  if (batch[result + 3u] != 0u) { return 0xffffffffu; }
  let instance = batch[result + 4u];
  if (instance >= arrayLength(&source)) { return 0xffffffffu; }
  let material = source[instance].material_handle;
  if (material >= arrayLength(&materials)) { return 0xffffffffu; }
  let route = materials[material];
  if (route.w == 0u || route.y >= ${binCount}u) { return 0xffffffffu; }
  return route.y;

}
@compute @workgroup_size(128)
fn classify(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  sorted_hits(lane, group.x * 128u + lane);
  let bin = keys[lane];
  if (bin == 0xffffffffu) { return; }
  if (lane > 0u && keys[lane - 1u] == bin) { return; }
  var end = lane + 1u;
  loop {
    if (end >= 128u) { break; }
    if (keys[end] != bin) { break; }
    end++;
  }
  atomicAdd(&work[bin * 8u], end - lane);
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
fn scatter(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  sorted_hits(lane, group.x * 128u + lane);
  let bin = keys[lane];
  var head = lane;
  loop {
    if (head == 0u) { break; }
    if (keys[head - 1u] != bin) { break; }
    head--;
  }
  if (lane == head && bin != 0xffffffffu) {
    var end = lane + 1u;
    loop {
      if (end >= 128u) { break; }
      if (keys[end] != bin) { break; }
      end++;
    }
    reservations[lane] = atomicLoad(&work[bin * 8u + 1u]) + atomicAdd(&work[bin * 8u + 2u], end - lane);
  }
  workgroupBarrier();
  if (bin != 0xffffffffu) {
    atomicStore(&work[${list}u + reservations[head] + lane - head], rays[lane]);
  }
}
`,
    });
    const layout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3, ...(rayWork === undefined ? [] : [4])].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 3 ? "storage" : "read-only-storage" },
      })),
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipelines = await Promise.all(
      entries.map((entryPoint) =>
        PipelineCompilationQueue.forDevice(device).run(() =>
          device.createComputePipelineAsync({
            label: `SCGI/native hit ${entryPoint}`,
            layout: pipelineLayout,
            compute: { module, entryPoint },
          }),
        ),
      ),
    );
    const buffers: GPUBuffer[] = [];
    try {
      const buffer = device.createBuffer({
        label: "SCGI/packed native hit work",
        size: plan.bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      buffers.push(buffer);
      const indirect = device.createBuffer({
        label: "SCGI/native hit indirect",
        size: binCount * 32,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      });
      buffers.push(indirect);
      const group = device.createBindGroup({
        layout,
        entries: [source, materials, batch, buffer, ...(rayWork === undefined ? [] : [rayWork.buffer])].map(
          (resource, binding) => ({ binding, resource: { buffer: resource } }),
        ),
      });
      return new ScgiQueryHitWork(
        device,
        buffer,
        indirect,
        binCount,
        rayCount,
        list,
        pipelines,
        group,
        scanGroups,
        rayWork,
      );
    } catch (error) {
      for (const buffer of buffers) {
        buffer.destroy();
      }
      throw error;
    }
  }

  get dispatchCount(): number {
    return this.pipelines.length;
  }

  encode(command: ShadeGPUCommandContext): void {
    if (this.destroyed || command.closed || command.device !== this.device) {
      throw new Error("Native hit compaction requires its live admitted batch");
    }
    command.clearBuffer(this.buffer, 0, this.binCount * 32);
    const groups = [
      Math.ceil(this.rayCount / 128),
      Math.ceil(this.binCount / 128),
      ...this.scanGroups,
      Math.ceil(this.binCount / 128),
      Math.ceil(this.rayCount / 128),
    ];
    for (let index = 0; index < this.pipelines.length; index++) {
      const pass = command.gpu_encoder.beginComputePass({ label: this.pipelines[index]!.label });
      pass.setPipeline(this.pipelines[index]!);
      pass.setBindGroup(0, this.group);
      if (this.rayWork !== undefined && (index === 0 || index === this.pipelines.length - 1)) {
        pass.dispatchWorkgroupsIndirect(this.rayWork.indirect, 32);
      } else {
        pass.dispatchWorkgroups(groups[index]!);
      }
      pass.end();
    }
    command.copyBufferToBuffer(this.buffer, 0, this.indirect, 0, this.binCount * 32);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.buffer.destroy();
    this.indirect.destroy();
  }
}
