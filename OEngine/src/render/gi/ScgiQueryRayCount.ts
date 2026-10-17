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
    private readonly initialize: GPUComputePipeline,
  ) {}

  static async create(
    device: GPUDevice,
    capacity: number,
    batch: GPUBuffer,
    resultOffset: number,
    input: { buffer: GPUBuffer; byteOffset: number } | undefined,
    coverage: GPUBuffer,
    hitOutput?: { buffer: GPUBuffer; stride: number },
  ): Promise<ScgiQueryRayCount> {
    if (
      input !== undefined &&
      (!Number.isSafeInteger(input.byteOffset) ||
        input.byteOffset < 0 ||
        input.byteOffset % 4 !== 0 ||
        input.byteOffset + 4 > input.buffer.size ||
        !(input.buffer.usage & GPUBufferUsage.STORAGE))
    ) {
      throw new RangeError("GPU ray count requires a complete aligned storage word");
    }
    if (
      input !== undefined &&
      input.buffer === batch &&
      input.byteOffset >= resultOffset &&
      input.byteOffset < resultOffset + capacity * 32
    ) {
      throw new RangeError("GPU ray count cannot overlap the result write domain");
    }
    const separateCount = input !== undefined && input.buffer !== batch;
    const module = device.createShaderModule({
      label: "SCGI/GPU ray count",
      code: /* wgsl */ `
${separateCount ? "@group(0) @binding(0) var<storage, read> input_count: array<u32>;" : ""}
${hitOutput === undefined ? "" : "@group(0) @binding(4) var<storage, read_write> hits: array<vec4f>;"}
@group(0) @binding(3) var<storage, read> coverage: array<u32>;
@group(0) @binding(1) var<storage, read_write> batch: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(1)
fn main() {
  let count = ${input === undefined ? `${capacity}u` : `${separateCount ? "input_count" : "batch"}[${input.byteOffset / 4}u]`};
  let overflow = count > ${capacity}u;
  output[0] = select(count, 0u, overflow);
  output[1] = u32(overflow);
  output[2] = select(count, ${capacity}u, overflow);
  output[4] = (output[2] + 63u) / 64u;
  output[5] = 1u;
  output[6] = 1u;
  output[8] = (output[0] + 127u) / 128u;
  output[9] = 1u;
  output[10] = 1u;
}
@compute @workgroup_size(64)
fn initialize(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= output[2]) { return; }
  ${hitOutput === undefined ? "" : `hits[id.x * ${hitOutput.stride / 16}u + 2u] = vec4f(0.0);`}
  let result = ${resultOffset / 4}u + id.x * 8u;
  batch[result] = batch[id.x * 12u + 7u];
  batch[result + 1u] = 0u;
  batch[result + 2u] = 0u;
  let ray = id.x * 12u;
  let origin = bitcast<vec3f>(vec3u(batch[ray], batch[ray + 1u], batch[ray + 2u]));
  let direction = bitcast<vec3f>(vec3u(batch[ray + 4u], batch[ray + 5u], batch[ray + 6u]));
  let t_min = bitcast<f32>(batch[ray + 3u]);
  let t_max = bitcast<f32>(batch[ray + 7u]);
  let finite_origin = all((bitcast<vec3u>(origin) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
  let finite_direction = all((bitcast<vec3u>(direction) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
  let finite_min = (bitcast<u32>(t_min) & 0x7f800000u) != 0x7f800000u;
  let valid_max = (bitcast<u32>(t_max) & 0x7f800000u) != 0x7f800000u || bitcast<u32>(t_max) == 0x7f800000u;
  var status = 1u;
  if (coverage[0] != 0u) { status = 2u; }
  if (coverage[7] != 0u) {
    let low = bitcast<vec3f>(vec3u(coverage[4], coverage[5], coverage[6]));
    let high = bitcast<vec3f>(vec3u(coverage[8], coverage[9], coverage[10]));
    let start = origin + direction * t_min;
    let end = origin + direction * t_max;
    if (any((bitcast<vec3u>(start) & vec3u(0x7f800000u)) == vec3u(0x7f800000u)) ||
        any((bitcast<vec3u>(end) & vec3u(0x7f800000u)) == vec3u(0x7f800000u)) ||
        any(start < low) || any(start > high) || any(end < low) || any(end > high)) { status = 2u; }
  }
  if (output[1] != 0u || !finite_origin || !finite_direction || !finite_min || !valid_max ||
      all(direction == vec3f(0.0)) || !(t_min <= t_max)) { status = 5u; }
  batch[result + 3u] = status;
  batch[result + 4u] = 0xffffffffu;
  batch[result + 5u] = 0xffffffffu;
  batch[result + 6u] = 0u;
  batch[result + 7u] = 0u;
}`,
    });
    const layout = device.createBindGroupLayout({
      entries: [
        ...(separateCount
          ? [
              {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "read-only-storage" as const },
              },
            ]
          : []),
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        ...(hitOutput === undefined
          ? []
          : [{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } }]),
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = await PipelineCompilationQueue.forDevice(device).run(() =>
      device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: "main" } }),
    );
    const initialize = await PipelineCompilationQueue.forDevice(device).run(() =>
      device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: { module, entryPoint: "initialize" },
      }),
    );
    const buffer = device.createBuffer({
      label: "SCGI/validated GPU ray count",
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    let indirect: GPUBuffer | undefined;
    try {
      indirect = device.createBuffer({
        label: "SCGI/GPU ray dispatch",
        size: 48,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT,
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...(separateCount ? [{ binding: 0, resource: { buffer: input!.buffer } }] : []),
          { binding: 1, resource: { buffer: batch } },
          { binding: 2, resource: { buffer } },
          { binding: 3, resource: { buffer: coverage } },
          ...(hitOutput === undefined ? [] : [{ binding: 4, resource: { buffer: hitOutput.buffer } }]),
        ],
      });
      return new ScgiQueryRayCount(buffer, indirect, pipeline, group, initialize);
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
    pass.dispatchWorkgroups(1);
    pass.end();
    command.copyBufferToBuffer(this.buffer, 0, this.indirect, 0, 48);
    const initialize = command.beginComputePass({ label: "SCGI/initialize active query results" });
    initialize.setPipeline(this.initialize);
    initialize.setBindGroup(0, this.group);
    initialize.dispatchWorkgroupsIndirect(this.indirect, 16);
    initialize.end();
  }

  destroy(): void {
    this.buffer.destroy();
    this.indirect.destroy();
  }
}
