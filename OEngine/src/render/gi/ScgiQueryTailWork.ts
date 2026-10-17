import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import type { ScgiQueryHitWork } from "./ScgiQueryHitWork.js";

/** One reusable queue for every bin/shard tail in a batch. Each quantum
 * compacts only unfinished rays; no rays survive into another submission.
 * Append capacity is proven by one invocation per unique admitted input ray. */
export class ScgiQueryTailWork {
  readonly listWordOffset = 8;
  readonly binCount = 1;
  private constructor(
    readonly rayCount: number,
    readonly buffer: GPUBuffer,
    readonly indirect: GPUBuffer,
    private readonly pipelines: readonly GPUComputePipeline[],
    private readonly group: GPUBindGroup
  ) {}

  static async create(
    device: GPUDevice,
    rayCount: number,
    batch: GPUBuffer,
    resultByteOffset: number,
    continuation: GPUBuffer,
    pending?: ScgiQueryHitWork,
    rayCountBuffer?: { buffer: GPUBuffer; offset: number }
  ): Promise<ScgiQueryTailWork> {
    const bytes = 32 + rayCount * 4;
    if (bytes > Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError("Complete query tail queue exceeds binding capacity");
    }
    const module = device.createShaderModule({
      label: "SCGI/tail compact work",
      code: /* wgsl */ `
@group(0) @binding(0) var<storage, read> continuation: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> batch: array<u32>;
${pending ? "@group(0) @binding(3) var<storage, read> pending: array<u32>;" : ""}
${rayCountBuffer ? "@group(0) @binding(4) var<storage, read> input_count: array<u32>;" : ""}
fn input_ray(index: u32) -> u32 {
  ${
    pending
      ? `if (index >= pending[0]) { return 0xffffffffu; }
  return pending[${pending.listWordOffset}u + pending[1] + index];`
      : `
  ${rayCountBuffer ? `if (index >= input_count[${rayCountBuffer.offset / 4}u]) { return 0xffffffffu; }` : ""}
  return index;`
  }
}
@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${rayCount}u) { return; }
  let ray = input_ray(id.x);
  if (ray >= ${rayCount}u || continuation[ray * 16u] == 2u) { return; }
  let at = atomicAdd(&output[0], 1u);
  atomicStore(&output[8u + at], ray);
}
@compute @workgroup_size(1)
fn publish() {
  atomicStore(&output[4], (atomicLoad(&output[0]) + 63u) / 64u);
  atomicStore(&output[5], 1u);
  atomicStore(&output[6], 1u);
}
@compute @workgroup_size(64)
fn finish(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${rayCount}u) { return; }
  let ray = input_ray(id.x);
  if (ray < ${rayCount}u && continuation[ray * 16u] != 2u) {
    batch[${resultByteOffset / 4}u + ray * 8u + 3u] = 5u;
  }
}`
    });
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ...(pending
        ? [{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" as const } }]
        : []),
      ...(rayCountBuffer
        ? [{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" as const } }]
        : [])
    ];
    const layout = device.createBindGroupLayout({ entries });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipelines = await Promise.all(
      ["compact", "publish", "finish"].map((entryPoint) =>
        PipelineCompilationQueue.forDevice(device).run(() =>
          device.createComputePipelineAsync({
            label: `SCGI/tail ${entryPoint}`,
            layout: pipelineLayout,
            compute: { module, entryPoint }
          })
        )
      )
    );
    const buffer = device.createBuffer({
      label: "SCGI/compact tail work",
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });
    let indirect: GPUBuffer | undefined;
    try {
      indirect = device.createBuffer({
        label: "SCGI/compact tail dispatch",
        size: 32,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
      });
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: continuation } },
          { binding: 1, resource: { buffer } },
          { binding: 2, resource: { buffer: batch } },
          ...(pending ? [{ binding: 3, resource: { buffer: pending.buffer } }] : []),
          ...(rayCountBuffer ? [{ binding: 4, resource: { buffer: rayCountBuffer.buffer } }] : [])
        ]
      });
      return new ScgiQueryTailWork(rayCount, buffer, indirect, pipelines, group);
    } catch (error) {
      buffer.destroy();
      indirect?.destroy();
      throw error;
    }
  }

  compact(command: ShadeGPUCommandContext): void {
    command.clearBuffer(this.buffer, 0, 32);
    for (let index = 0; index < 2; index++) {
      const pass = command.gpu_encoder.beginComputePass({ label: this.pipelines[index]!.label });
      pass.setPipeline(this.pipelines[index]!);
      pass.setBindGroup(0, this.group);
      pass.dispatchWorkgroups(index === 0 ? Math.ceil(this.rayCount / 64) : 1);
      pass.end();
    }
    command.copyBufferToBuffer(this.buffer, 0, this.indirect, 0, 32);
  }

  finish(command: ShadeGPUCommandContext): void {
    const pass = command.gpu_encoder.beginComputePass({ label: "SCGI/tail complete or fault" });
    pass.setPipeline(this.pipelines[2]!);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(this.rayCount / 64));
    pass.end();
  }

  destroy(): void {
    this.buffer.destroy();
    this.indirect.destroy();
  }
}
