/** Phase 2 full-rate visible-sample work; independent of the former ShadingBin layout. */
export const SHADING_WORK_ABI_VERSION = 1;
export const SHADING_WORK_HEADER_BYTES = 20;
export const SHADING_WORK_RECORD_BYTES = 8;
export const SHADING_WORK_THREADS = 64;
export const SHADING_WORK_WGSL = /* wgsl */ `
struct ShadingWorkHeader {
  attempted: atomic<u32>,
  written: atomic<u32>,
  overflow: atomic<u32>,
  capacity: u32,
  dispatch_x: u32,
};
struct ShadingWorkRecord { pixel: u32, visibility_key: u32, };
struct ShadingWorkQueue {
  header: ShadingWorkHeader,
  records: array<ShadingWorkRecord>,
};
struct ShadingWorkHeaderRead {
  attempted: u32,
  written: u32,
  overflow: u32,
  capacity: u32,
  dispatch_x: u32,
};
struct ShadingWorkQueueRead {
  header: ShadingWorkHeaderRead,
  records: array<ShadingWorkRecord>,
};
`;

export function shadingWorkCapacity(width: number, height: number, limits: {
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  maxComputeWorkgroupsPerDimension: number;
}): Readonly<{ capacity: number; queueBytes: number }> {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("ShadingWork extent must be positive integers");
  }
  const capacity = width * height;
  const queueBytes = SHADING_WORK_HEADER_BYTES + capacity * SHADING_WORK_RECORD_BYTES;
  const bound = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  if (!Number.isSafeInteger(queueBytes) || queueBytes > bound) {
    throw new RangeError("ShadingWork full coverage exceeds negotiated storage-buffer limit");
  }
  const groupsX = Math.ceil(width / 8);
  const groupsY = Math.ceil(height / 8);
  const consumerGroupsY = Math.ceil(Math.ceil(capacity / SHADING_WORK_THREADS) /
    limits.maxComputeWorkgroupsPerDimension);
  if (groupsX > limits.maxComputeWorkgroupsPerDimension ||
      groupsY > limits.maxComputeWorkgroupsPerDimension ||
      consumerGroupsY > limits.maxComputeWorkgroupsPerDimension) {
    throw new RangeError("ShadingWork dispatch exceeds negotiated workgroup limit");
  }
  return Object.freeze({ capacity, queueBytes });
}
