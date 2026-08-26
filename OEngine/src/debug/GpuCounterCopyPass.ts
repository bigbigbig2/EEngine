import { counterByteOffset, type GpuCounterFieldName } from "./GpuFrameCounters.js";
import type { FrameGraph } from "../framegraph/FrameGraph.js";
import type { ResourceId } from "../framegraph/ResourceHandle.js";

const COUNTER_FIELD_BYTES = Uint32Array.BYTES_PER_ELEMENT;

/** Copies one GPU-produced u32 into the sampled frame-counter ABI in graph order. */
export function addGpuCounterCopyPass(
  graph: FrameGraph,
  field: GpuCounterFieldName,
  source: ResourceId,
  counters: ResourceId,
  sourceOffset = 0
): ResourceId {
  assertAlignedOffset(sourceOffset);
  const destinationOffset = counterByteOffset(field);
  const builder = graph.add(
    `R0 GPU counter copy/${field}`,
    { sourceOffset, destinationOffset },
    (data, resources, context) => {
      const encoder = context.gpu_encoder;
      if (encoder === undefined) {
        throw new Error("GPU counter copy pass has no GPU command encoder");
      }
      encoder.copyBufferToBuffer(
        requireBuffer(resources.get(source), "source"),
        data.sourceOffset,
        requireBuffer(resources.get(counters), "counter ABI"),
        data.destinationOffset,
        COUNTER_FIELD_BYTES
      );
    }
  );
  builder.read(source);
  const nextCounters = builder.write(counters);
  builder.make_side_effect();
  return nextCounters;
}

function assertAlignedOffset(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value % COUNTER_FIELD_BYTES !== 0
  ) {
    throw new RangeError("sourceOffset must be a non-negative u32-aligned integer");
  }
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (
    value &&
    typeof value === "object" &&
    "size" in value &&
    "usage" in value
  ) {
    return value as GPUBuffer;
  }
  throw new Error(`GPU counter copy pass expected ${label} GPUBuffer`);
}
