/** Product-owned GPUBuffer capacity, including unpublished and retiring revisions. */
export const GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT = 512 * 1024 * 1024;
/**
 * Scene-level Product-per-Shard metadata is a fixed GPU heap, not decoded
 * geometry payload. Keep it separately bounded, but large enough for the
 * formal 100M hierarchy tables and all per-shard residency descriptors.
 */
export const GEOMETRY_PRODUCT_METADATA_OVERHEAD_LIMIT = 256 * 1024 * 1024;

interface Ledger {
  allocatedBytes: number;
  metadataBytes: number;
  peakBytes: number;
  metadataPeakBytes: number;
  allocations: number;
  metadataAllocations: number;
  capacityLimitBytes: number;
}
const ledgers = new WeakMap<GPUDevice, Ledger>();

export function reserveGeometryProductGpuBytes(
  device: GPUDevice,
  bytes: number,
  capacityLimitBytes = GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT,
): () => void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new RangeError("Geometry Product GPU allocation size is invalid");
  if (!Number.isSafeInteger(capacityLimitBytes) || capacityLimitBytes <= 0) {
    throw new RangeError("Geometry Product GPU capacity limit is invalid");
  }
  let ledger = ledgers.get(device);
  if (!ledger) {
    ledger = {
      allocatedBytes: 0,
      metadataBytes: 0,
      peakBytes: 0,
      metadataPeakBytes: 0,
      allocations: 0,
      metadataAllocations: 0,
      capacityLimitBytes: GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT,
    };
    ledgers.set(device, ledger);
  }
  if (ledger.allocatedBytes + bytes > capacityLimitBytes) {
    throw new RangeError(
      `Geometry Product GPUBuffer capacity budget exceeded: ${ledger.allocatedBytes + bytes} > ${capacityLimitBytes}`,
    );
  }
  ledger.capacityLimitBytes = Math.max(ledger.capacityLimitBytes, capacityLimitBytes);
  ledger.allocatedBytes += bytes;
  ledger.allocations++;
  ledger.peakBytes = Math.max(ledger.peakBytes, ledger.allocatedBytes);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ledger.allocatedBytes -= bytes;
    ledger.allocations--;
    if (ledger.allocatedBytes === 0) ledger.capacityLimitBytes = GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT;
  };
}

export function reserveGeometryProductMetadataBytes(device: GPUDevice, bytes: number): () => void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new RangeError("Geometry Product metadata allocation size is invalid");
  let ledger = ledgers.get(device);
  if (!ledger) {
    ledger = {
      allocatedBytes: 0,
      metadataBytes: 0,
      peakBytes: 0,
      metadataPeakBytes: 0,
      allocations: 0,
      metadataAllocations: 0,
      capacityLimitBytes: GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT,
    };
    ledgers.set(device, ledger);
  }
  if (ledger.metadataBytes + bytes > GEOMETRY_PRODUCT_METADATA_OVERHEAD_LIMIT)
    throw new RangeError("Geometry Product metadata overhead budget exceeded");
  ledger.metadataBytes += bytes;
  ledger.metadataAllocations++;
  ledger.metadataPeakBytes = Math.max(ledger.metadataPeakBytes, ledger.metadataBytes);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ledger!.metadataBytes -= bytes;
    ledger!.metadataAllocations--;
  };
}

export function geometryProductGpuBudgetEvidence(device: GPUDevice): Readonly<{
  allocatedBytes: number;
  metadataBytes: number;
  totalBytes: number;
  peakBytes: number;
  metadataPeakBytes: number;
  allocations: number;
  metadataAllocations: number;
  limitBytes: number;
  metadataLimitBytes: number;
}> {
  const ledger = ledgers.get(device);
  return Object.freeze({
    allocatedBytes: ledger?.allocatedBytes ?? 0,
    metadataBytes: ledger?.metadataBytes ?? 0,
    totalBytes: (ledger?.allocatedBytes ?? 0) + (ledger?.metadataBytes ?? 0),
    peakBytes: ledger?.peakBytes ?? 0,
    metadataPeakBytes: ledger?.metadataPeakBytes ?? 0,
    allocations: ledger?.allocations ?? 0,
    metadataAllocations: ledger?.metadataAllocations ?? 0,
    limitBytes: ledger?.capacityLimitBytes ?? GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT,
    metadataLimitBytes: GEOMETRY_PRODUCT_METADATA_OVERHEAD_LIMIT,
  });
}
