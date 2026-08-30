import {
  counterByteOffset,
  type GpuCounterFieldName
} from "./GpuFrameCounters.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { FrameGraph } from "../framegraph/FrameGraph.js";
import type { ResourceId } from "../framegraph/ResourceHandle.js";
import type { CachedComputePipelineDescriptor } from "../gpu/GPUDescriptorCaches.js";

export const GPU_LIST_COUNTER_WORKGROUP_SIZE = 1;
const DISABLED_COUNTER_INDEX = 0xffffffff;
const MESHLET_LIST_HEADER_BYTES = 16;
const MESHLET_LIST_ELEMENT_BYTES = 8;
const PARAM_WORDS = 14;

export const GPU_LIST_COUNTER_WGSL = /* wgsl */ `
struct CounterParams {
  primary_index: u32,
  secondary_index: u32,
  triangle_index: u32,
  overflow_index: u32,
  overflow_bit: u32,
  capacity: u32,
  triangles_per_element: u32,
  input_index: u32,
  rejected_index: u32,
  input_count: u32,
  source_count_word: u32,
  source_overflow_word: u32,
  _padding0: u32,
  _padding1: u32,
};

@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write>
  frame_counters: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: CounterParams;

@compute @workgroup_size(${GPU_LIST_COUNTER_WORKGROUP_SIZE})
fn main() {
  let raw_count = source[params.source_count_word];
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
  if (params.input_index != ${DISABLED_COUNTER_INDEX}u) {
    atomicAdd(&frame_counters[params.input_index], params.input_count);
  }
  if (params.rejected_index != ${DISABLED_COUNTER_INDEX}u) {
    let accepted_count = min(raw_count, params.input_count);
    atomicAdd(
      &frame_counters[params.rejected_index],
      params.input_count - accepted_count
    );
  }
  let explicit_overflow = params.source_overflow_word != ${DISABLED_COUNTER_INDEX}u &&
    source[params.source_overflow_word] != 0u;
  if ((raw_count > params.capacity || explicit_overflow) && params.overflow_bit != 0u) {
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
  primary?: GpuCounterFieldName;
  secondary?: GpuCounterFieldName;
  triangleField?: GpuCounterFieldName;
  trianglesPerElement?: number;
  inputField?: GpuCounterFieldName;
  rejectedField?: GpuCounterFieldName;
  inputCount?: number;
  overflowBit: number;
  headerBytes?: number;
  elementBytes?: number;
  countByteOffset?: number;
  overflowByteOffset?: number;
}

/** Adds an ordered sampling pass for a FrameGraph-owned count-prefixed list. */
export function addGpuListCounterPass(
  graph: FrameGraph,
  source: ResourceId,
  counters: ResourceId,
  options: GpuListCounterOptions
): ResourceId {
  const builder = graph.add(
    `R0 GPU list counters/${options.primary ?? "overflow-only"}`,
    options,
    (data, resources, context) => {
      GRAPH_ACCUMULATOR.encode(
        requireShadeCommandContext(context.encoder),
        requireGpuBuffer(resources.get(source), "source list"),
        requireGpuBuffer(resources.get(counters), "counter ABI"),
        data
      );
    }
  );
  builder.read(source);
  const nextCounters = builder.write(counters);
  builder.make_side_effect();
  return nextCounters;
}

/** Sampling-only reducer for count-prefixed GPU work queues. */
export class GpuListCounterAccumulator {
  encode(
    command: ShadeGPUCommandContext,
    source: GPUBuffer,
    counters: GPUBuffer,
    options: GpuListCounterOptions
  ): void {
    validateInputCounterOptions(options);
    const headerBytes = options.headerBytes ?? MESHLET_LIST_HEADER_BYTES;
    const elementBytes = options.elementBytes ?? MESHLET_LIST_ELEMENT_BYTES;
    const capacity = gpuListElementCapacity(
      source.size,
      headerBytes,
      elementBytes
    );
    const params = new Uint32Array(PARAM_WORDS);
    params[0] = optionalCounterIndex(options.primary);
    params[1] = optionalCounterIndex(options.secondary);
    params[2] = optionalCounterIndex(options.triangleField);
    params[3] = counterIndex("queueOverflowMask");
    params[4] = options.overflowBit >>> 0;
    params[5] = capacity >>> 0;
    params[6] = options.trianglesPerElement ?? 0;
    params[7] = optionalCounterIndex(options.inputField);
    params[8] = optionalCounterIndex(options.rejectedField);
    params[9] = options.inputCount ?? 0;
    params[10] = (options.countByteOffset ?? 0) / Uint32Array.BYTES_PER_ELEMENT;
    params[11] = options.overflowByteOffset === undefined
      ? DISABLED_COUNTER_INDEX
      : options.overflowByteOffset / Uint32Array.BYTES_PER_ELEMENT;
    const paramsBuffer = command.allocateTransientBufferAndLoad(
      params.buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructComputePass({
      label: `R0 GPU list counters/${options.primary ?? "overflow-only"}`,
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

const GRAPH_ACCUMULATOR = new GpuListCounterAccumulator();

export function gpuListElementCapacity(
  bufferSize: number,
  headerBytes = MESHLET_LIST_HEADER_BYTES,
  elementBytes = MESHLET_LIST_ELEMENT_BYTES
): number {
  if (!Number.isInteger(headerBytes) || headerBytes < 0 || headerBytes % 4 !== 0) {
    throw new RangeError("headerBytes must be a non-negative u32-aligned integer");
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

function validateInputCounterOptions(options: GpuListCounterOptions): void {
  validateHeaderFieldOffset(options.countByteOffset, "countByteOffset");
  validateHeaderFieldOffset(options.overflowByteOffset, "overflowByteOffset");
  const tracksInput = options.inputField !== undefined ||
    options.rejectedField !== undefined;
  if (!tracksInput && options.inputCount === undefined) return;
  if (
    !Number.isInteger(options.inputCount) ||
    options.inputCount === undefined ||
    options.inputCount < 0 ||
    options.inputCount > 0xffffffff
  ) {
    throw new RangeError(
      "inputCount must be a non-negative u32 when input/rejected fields are used"
    );
  }
}

function validateHeaderFieldOffset(
  value: number | undefined,
  label: string
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value % 4 !== 0) {
    throw new RangeError(`${label} must be a non-negative u32-aligned integer`);
  }
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "allocateTransientBufferAndLoad" in value &&
    "constructComputePass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("GPU list counter pass requires ShadeGPUCommandContext");
}

function requireGpuBuffer(value: unknown, label: string): GPUBuffer {
  if (
    value &&
    typeof value === "object" &&
    "size" in value &&
    "usage" in value
  ) {
    return value as GPUBuffer;
  }
  throw new Error(`GPU list counter pass expected ${label} GPUBuffer`);
}
