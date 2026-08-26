import {
  counterByteOffset,
  type GpuCounterFieldName
} from "./GpuFrameCounters.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "../gpu/GPUDescriptorCaches.js";

const PARAM_WORDS = 4;

export const GPU_COUNTER_ATOMIC_ADD_WGSL = /* wgsl */ `
struct CounterAddParams {
  index: u32,
  value: u32,
  _padding0: u32,
  _padding1: u32,
};

@group(0) @binding(0) var<storage, read_write>
  frame_counters: array<atomic<u32>>;
@group(0) @binding(1) var<uniform> params: CounterAddParams;

@compute @workgroup_size(1)
fn main() {
  atomicAdd(&frame_counters[params.index], params.value);
}
`;

const GROUP_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "R0 GPU counter atomic add/group0",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" }
    }
  ]
};

const PIPELINE: CachedComputePipelineDescriptor = {
  label: "R0 GPU counter atomic add",
  layout: {
    label: "R0 GPU counter atomic add/layout",
    bindGroupLayouts: [GROUP_LAYOUT]
  },
  compute: {
    module: {
      label: "R0 GPU counter atomic add",
      code: GPU_COUNTER_ATOMIC_ADD_WGSL
    },
    entryPoint: "main"
  }
};

/** Sampling-only constant adder for exact CPU-known GPU work counts. */
export class GpuCounterAtomicAdder {
  encode(
    command: ShadeGPUCommandContext,
    counters: GPUBuffer,
    field: GpuCounterFieldName,
    value: number
  ): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError("GPU counter add value must be a non-negative u32");
    }
    const params = new Uint32Array(PARAM_WORDS);
    params[0] = counterByteOffset(field) / Uint32Array.BYTES_PER_ELEMENT;
    params[1] = value;
    const paramsBuffer = command.allocateTransientBufferAndLoad(
      params.buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructComputePass({
      label: `R0 GPU counter atomic add/${field}`,
      pipeline: PIPELINE,
      bindings: [[{ buffer: counters }, { buffer: paramsBuffer }]]
    });
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
  }
}
