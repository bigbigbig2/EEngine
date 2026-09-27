/** Fixed B4/B5 exception lanes. Set zero Standard/Unlit is shaded by Dense. */
export const SURFACE_EXCEPTION_LANES = 7;
export const SURFACE_WORK_HEADER_BYTES = 16;
export const SURFACE_WORK_LANE_BYTES = 16;
export const SURFACE_WORK_RECORD_BYTES = 8;
export const SURFACE_WORK_INDIRECT_BYTES = SURFACE_EXCEPTION_LANES * 2 * 16;
export const SURFACE_WORK_THREADS = 64;

/** Lane zero is resident-set-zero Coated; sets one to three each own Standard/Unlit and Coated. */
export function surfaceExceptionLane(setId: number, coated: boolean): number {
  if (!Number.isInteger(setId) || setId < 0 || setId > 3) throw new RangeError("Surface set id is invalid");
  if (setId === 0) {
    if (!coated) throw new RangeError("Resident hot Standard/Unlit belongs to Dense");
    return 0;
  }
  return 1 + (setId - 1) * 2 + Number(coated);
}

export function surfaceLaneCapacity(width: number, height: number, limits: Pick<GPUSupportedLimits,
  "maxBufferSize" | "maxStorageBufferBindingSize" | "maxComputeWorkgroupsPerDimension">):
  Readonly<{ capacity: number; queueBytes: number }> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("Surface dimensions must be positive integers");
  }
  const pixels = width * height;
  const header = SURFACE_WORK_HEADER_BYTES + SURFACE_EXCEPTION_LANES * SURFACE_WORK_LANE_BYTES;
  const limit = Math.min(Number(limits.maxBufferSize), Number(limits.maxStorageBufferBindingSize));
  const maximum = Math.floor((limit - header) / (SURFACE_EXCEPTION_LANES * SURFACE_WORK_RECORD_BYTES));
  const capacity = Math.min(Math.ceil(pixels / SURFACE_EXCEPTION_LANES), maximum);
  if (!Number.isSafeInteger(pixels) || capacity < 1 ||
      Math.ceil(width / 8) > Number(limits.maxComputeWorkgroupsPerDimension) ||
      Math.ceil(height / 8) > Number(limits.maxComputeWorkgroupsPerDimension)) {
    throw new RangeError("Surface Dense or exception dispatch exceeds device limits");
  }
  return Object.freeze({ capacity,
    queueBytes: header + SURFACE_EXCEPTION_LANES * capacity * SURFACE_WORK_RECORD_BYTES });
}

export const SURFACE_EXECUTION_WGSL = /* wgsl */ `
struct SurfaceWorkHeader { capacity: u32, max_dispatch_x: u32, width: u32, height: u32, };
struct SurfaceWorkLane {
  attempted: atomic<u32>, overflow: atomic<u32>, dispatch_x: u32, reserved: u32,
};
struct SurfaceWorkRecord { pixel: u32, visibility_key: u32, };
struct SurfaceWorkQueue {
  header: SurfaceWorkHeader,
  lanes: array<SurfaceWorkLane, ${SURFACE_EXCEPTION_LANES}>,
  records: array<SurfaceWorkRecord>,
};
struct SurfaceIndirectArgs { args: array<vec4u, ${SURFACE_EXCEPTION_LANES * 2}>, };
`;
