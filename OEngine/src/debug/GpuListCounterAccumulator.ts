import {
  counterByteOffset,
  type GpuCounterFieldName
} from "./GpuFrameCounters.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "../gpu/GPUDescriptorCaches.js";

export const GPU_LIST_COUNTER_WORKGROUP_SIZE = 1;
const DISABLED_COUNTER_INDEX = 0xffffffff;
const MESHLET_LIST_HEADER_BYTES = 16;
const MESHLET_LIST_ELEMENT_BYTES = 8;
const PARAM_WORDS = 8;

export const GPU_LIST_COUNTER_WGSL = /* wgsl */ `
struct CounterParams {
  primary_index: u32,
  secondary_index: u32,
  triangle_index: u32,
  overflow_index: u32,
  overflow_bit: u32,
  capacity: u32,
  triangles_per_element: u32,
  _padding: u32,
};

@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write>
  frame_counters: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: CounterParams;

@compute @workgroup_size(${GPU_LIST_COUNTER_WORKGROUP_SIZE})
fn main() {
  let raw_count = source[0];
  let safe_count = min(raw_count, params.capacity);
  if (params.primary_index != ${DISABLED_COUNTER_INDEX}u) {
    atomicAdd(&frame_counters[params.primary_index], safe_count);
  }
  if (params.secondary_index != ${DISABLED_COUNTER_INDEX}u) {
    atomicAdd(&frame_counters[params.secondary_index], safe_count);
  }
  if (params.triangle_index != ${DISABLED_COUNTER_INDEX}u) {
    atomicAdd(
      &frame_counters[params.triangle_index],
      safe_count * params.triangles_per_element
    );
  }
  if (raw_count > params.capacity && params.overflow_bit != 0u) {
    atomicOr(
      &frame_counters[params.overflow_index],
      params.overflow_bit
    );
  }
}
`;

const GPU_LIST_COUNTER_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "R0 GPU list counters/group0",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" }
    }
  ]
};

const GPU_LIST_COUNTER_PIPELINE: CachedComputePipelineDescriptor = {
  label: "R0 GPU list counter accumulator",
  layout: {
    label: "R0 GPU list counter accumulator/layout",
    bindGroupLayouts: [GPU_LIST_COUNTER_LAYOUT]
  },
  compute: {
    module: {
      label: "R0 GPU list counter accumulator",
      code: GPU_LIST_COUNTER_WGSL
    },
    entryPoint: "main"
  }
};

export interface GpuListCounterOptions {
  primary: GpuCounterFieldName;
  secondary?: GpuCounterFieldName;
  triangleField?: GpuCounterFieldName;
  trianglesPerElement?: number;
  overflowBit: number;
  headerBytes?: number;
  elementBytes?: number;
}

/** Sampling-only reducer for count-prefixed GPU work queues. */
export class GpuListCounterAccumulator {
  encode(
    command: ShadeGPUCommandContext,
    source: GPUBuffer,
    counters: GPUBuffer,
    options: GpuListCounterOptions
  ): void {
    const headerBytes = options.headerBytes ?? MESHLET_LIST_HEADER_BYTES;
    const elementBytes = options.elementBytes ?? MESHLET_LIST_ELEMENT_BYTES;
    const capacity = gpuListElementCapacity(
      source.size,
      headerBytes,
      elementBytes
    );
    const params = new Uint32Array(PARAM_WORDS);
    params[0] = counterIndex(options.primary);
    params[1] = optionalCounterIndex(options.secondary);
    params[2] = optionalCounterIndex(options.triangleField);
    params[3] = counterIndex("queueOverflowMask");
    params[4] = options.overflowBit >>> 0;
    params[5] = capacity >>> 0;
    params[6] = options.trianglesPerElement ?? 0;
    const paramsBuffer = command.allocateTransientBufferAndLoad(
      params.buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructComputePass({
      label: `R0 GPU list counters/${options.primary}`,
      pipeline: GPU_LIST_COUNTER_PIPELINE,
      bindings: [[
        { buffer: source },
        { buffer: counters },
        { buffer: paramsBuffer }
      ]]
    });
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
  }
}

export function gpuListElementCapacity(
  bufferSize: number,
  headerBytes = MESHLET_LIST_HEADER_BYTES,
  elementBytes = MESHLET_LIST_ELEMENT_BYTES
): number {
  if (!Number.isInteger(headerBytes) || headerBytes < 0 || headerBytes % 16 !== 0) {
    throw new RangeError("headerBytes must be a non-negative 16-byte multiple");
  }
  if (!Number.isInteger(elementBytes) || elementBytes <= 0 || elementBytes % 4 !== 0) {
    throw new RangeError("elementBytes must be a positive u32-aligned integer");
  }
  if (!Number.isInteger(bufferSize) || bufferSize < headerBytes) {
    throw new RangeError("bufferSize must contain the complete list header");
  }
  return Math.floor((bufferSize - headerBytes) / elementBytes);
}

function counterIndex(field: GpuCounterFieldName): number {
  return counterByteOffset(field) / Uint32Array.BYTES_PER_ELEMENT;
}

function optionalCounterIndex(field: GpuCounterFieldName | undefined): number {
  return field === undefined ? DISABLED_COUNTER_INDEX : counterIndex(field);
}
