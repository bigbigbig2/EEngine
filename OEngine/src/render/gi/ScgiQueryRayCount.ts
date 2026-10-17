import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";

/** Dense RayWork prefix produced on GPU. Count overflow invalidates the entire
 * admitted batch instead of clamping and publishing a partial cohort. This
 * owner never maps the count or changes the frame submission boundary. */
export class ScgiQueryRayCount {
  private constructor(
    readonly buffer: GPUBuffer,
    readonly indirect: GPUBuffer,
    private readonly pipeline: GPUComputePipeline,
    private readonly group: GPUBindGroup,
    private readonly capacity: number
  ) {}

  static async create(
    device: GPUDevice,
    capacity: number,
    batch: GPUBuffer,
    resultOffset: number,
    input: { buffer: GPUBuffer; byteOffset: number }
  ): Promise<ScgiQueryRayCount> {
    if (
      !Number.isSafeInteger(input.byteOffset) ||
      input.byteOffset < 0 ||
      input.byteOffset % 4 !== 0 ||
      input.byteOffset + 4 > input.buffer.size ||
      !(input.buffer.usage & GPUBufferUsage.STORAGE)
    ) {
      throw new RangeError("GPU ray count requires a complete aligned storage word");
    }
    if (
      input.buffer === batch &&
      input.byteOffset >= resultOffset &&
      input.byteOffset < resultOffset + capacity * 32
    ) {
      throw new RangeError("GPU ray count cannot overlap the result write domain");
    }
    const separateCount = input.buffer !== batch;
    const module = device.createShaderModule({
      label: "SCGI/GPU ray count",
      code: /* wgsl */ `
${separateCount ? "@group(0) @binding(0) var<storage, read> input_count: array<u32>;" : ""}
@group(0) @binding(1) var<storage, read_write> batch: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let count = ${separateCount ? "input_count" : "batch"}[${input.byteOffset / 4}u];
  let overflow = count > ${capacity}u;
  if (id.x == 0u) {
    output[0] = select(count, 0u, overflow);
    output[1] = u32(overflow);
    output[4] = select((count + 63u) / 64u, 0u, overflow);
    output[5] = 1u;
    output[6] = 1u;
  }
  if (id.x >= ${capacity}u) { return; }
  let result = ${resultOffset / 4}u + id.x * 8u;
  batch[result] = batch[id.x * 12u + 7u];
  batch[result + 1u] = 0u;
  batch[result + 2u] = 0u;
  batch[result + 3u] = select(2u, 5u, overflow);
  batch[result + 4u] = 0xffffffffu;
  batch[result + 5u] = 0xffffffffu;
  batch[result + 6u] = 0u;
  batch[result + 7u] = 0u;
}`
    });
    const pipeline = await PipelineCompilationQueue.forDevice(device).run(() =>
      device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } })
    );
    const buffer = device.createBuffer({
      label: "SCGI/validated GPU ray count",
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    let indirect: GPUBuffer | undefined;
    try {
      indirect = device.createBuffer({
        label: "SCGI/GPU ray dispatch",
        size: 32,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...(separateCount ? [{ binding: 0, resource: { buffer: input.buffer } }] : []),
          { binding: 1, resource: { buffer: batch } },
          { binding: 2, resource: { buffer } }
        ]
      });
      return new ScgiQueryRayCount(buffer, indirect, pipeline, group, capacity);
    } catch (error) {
      buffer.destroy();
      indirect?.destroy();
      throw error;
    }
  }

  encode(command: ShadeGPUCommandContext): void {
    const pass = command.gpu_encoder.beginComputePass({ label: "SCGI/validate GPU ray count" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(this.capacity / 64));
    pass.end();
    command.copyBufferToBuffer(this.buffer, 0, this.indirect, 0, 32);
  }

  destroy(): void {
    this.buffer.destroy();
    this.indirect.destroy();
  }
}
