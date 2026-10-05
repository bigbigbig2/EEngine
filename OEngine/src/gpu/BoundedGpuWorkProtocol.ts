/** CPU-side control plane for existing GPU work streams; never a shared buffer ABI. */
export interface BoundedGpuWorkStreamInput {
  readonly name: string;
  readonly producer: string;
  readonly gpuConsumer: string;
  readonly elementAbi: string;
  readonly capacity: number;
  readonly elementBytes: number;
  readonly prefixBytes: number;
  readonly counters: readonly ("attempted" | "written" | "overflow" | "consumed" | "peak" | "invalid")[];
  readonly overflow: "suppress-indirect-output";
  readonly execution: "draw-indirect" | "dispatch-indirect";
  readonly maxBufferBytes: number;
  readonly maxStorageBindingBytes: number;
}

export interface BoundedGpuWorkStreamPlan
  extends Omit<BoundedGpuWorkStreamInput, "maxBufferBytes" | "maxStorageBindingBytes"> {
  readonly bufferBytes: number;
}

/** Preflight the physical allocation while retaining the stream's own counters and layout. */
export function planBoundedGpuWorkStream(
  input: BoundedGpuWorkStreamInput,
): Readonly<BoundedGpuWorkStreamPlan> {
  for (const [name, value] of [
    ["name", input.name],
    ["producer", input.producer],
    ["gpuConsumer", input.gpuConsumer],
    ["elementAbi", input.elementAbi],
  ] as const) {
    if (value.trim().length === 0) throw new RangeError(`GPU work ${name} is required`);
  }
  for (const [name, value] of [
    ["capacity", input.capacity],
    ["elementBytes", input.elementBytes],
    ["prefixBytes", input.prefixBytes],
    ["maxBufferBytes", input.maxBufferBytes],
    ["maxStorageBindingBytes", input.maxStorageBindingBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${input.name} ${name} must be a non-negative safe integer`);
    }
  }
  if (input.elementBytes === 0 || input.maxBufferBytes === 0 || input.maxStorageBindingBytes === 0) {
    throw new RangeError(`${input.name} requires nonzero element size and negotiated limits`);
  }
  if (input.capacity > 0xffffffff) {
    throw new RangeError(`${input.name} capacity exceeds the u32 counter range`);
  }
  if (
    input.overflow !== "suppress-indirect-output" ||
    (input.execution !== "draw-indirect" && input.execution !== "dispatch-indirect")
  ) {
    throw new RangeError(`${input.name} has unsupported GPU work execution semantics`);
  }
  for (const required of ["attempted", "written", "overflow"] as const) {
    if (!input.counters.includes(required)) {
      throw new RangeError(`${input.name} is missing the ${required} counter`);
    }
  }
  if (new Set(input.counters).size !== input.counters.length) {
    throw new RangeError(`${input.name} has duplicate counter semantics`);
  }
  const bufferBytes = input.prefixBytes + input.capacity * input.elementBytes;
  if (!Number.isSafeInteger(bufferBytes)) {
    throw new RangeError(`${input.name} work buffer byte length is unsafe`);
  }
  if (bufferBytes > input.maxBufferBytes) {
    throw new RangeError(`${input.name} work buffer exceeds maxBufferSize`);
  }
  if (bufferBytes > input.maxStorageBindingBytes) {
    throw new RangeError(`${input.name} work buffer exceeds maxStorageBufferBindingSize`);
  }
  return Object.freeze({
    name: input.name,
    producer: input.producer,
    gpuConsumer: input.gpuConsumer,
    elementAbi: input.elementAbi,
    capacity: input.capacity,
    elementBytes: input.elementBytes,
    prefixBytes: input.prefixBytes,
    counters: Object.freeze([...input.counters]),
    overflow: input.overflow,
    execution: input.execution,
    bufferBytes,
  });
}
