/** Internal binding range. Explicit sizes prevent a typed arena view from
 * accidentally binding the writable neighbours in the same GPUBuffer. */
export interface GpuStorageRange {
  readonly buffer: GPUBuffer;
  readonly offset: number;
  readonly size: number;
}
export type GpuStorageInput = GPUBuffer | GpuStorageRange;

export function gpuStorageRange(
  input: GpuStorageInput,
  limits: GPUSupportedLimits,
  minBytes: number,
  label: string,
): GpuStorageRange {
  const range = "buffer" in input ? input : { buffer: input, offset: 0, size: input.size };
  if (
    ![range.offset, range.size].every(Number.isSafeInteger) ||
    range.offset < 0 ||
    range.offset % limits.minStorageBufferOffsetAlignment !== 0 ||
    range.size < minBytes ||
    range.size % 4 !== 0 ||
    range.size > limits.maxStorageBufferBindingSize ||
    range.offset > range.buffer.size - range.size ||
    (range.buffer.usage & GPUBufferUsage.STORAGE) === 0
  ) {
    throw new RangeError(`${label} requires an aligned, bounded storage binding range`);
  }
  return Object.freeze({ ...range });
}

/** Read/read overlap is legal; a writer must have a disjoint range from every
 * other binding in its dispatch. Validation happens at preparation, not lanes. */
export function requireDisjointStorageRanges(
  reads: readonly GpuStorageRange[],
  writes: readonly GpuStorageRange[],
): void {
  const aliases = (a: GpuStorageRange, b: GpuStorageRange) =>
    a.buffer === b.buffer && a.offset < b.offset + b.size && b.offset < a.offset + a.size;
  for (let i = 0; i < writes.length; i++) {
    if (
      reads.some((read) => aliases(read, writes[i]!)) ||
      writes.slice(i + 1).some((write) => aliases(write, writes[i]!))
    ) {
      throw new RangeError("Writable frame geometry storage binding ranges overlap");
    }
  }
}
