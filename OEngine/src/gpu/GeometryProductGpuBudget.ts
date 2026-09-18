/** Product-owned GPUBuffer capacity, including unpublished and retiring revisions. */
export const GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT = 512 * 1024 * 1024;
export const GEOMETRY_PRODUCT_METADATA_OVERHEAD_LIMIT = 16 * 1024 * 1024;

interface Ledger {
  allocatedBytes: number;
  metadataBytes: number;
  peakBytes: number;
  metadataPeakBytes: number;
  allocations: number;
  metadataAllocations: number;
}
const ledgers = new WeakMap<GPUDevice, Ledger>();

export function reserveGeometryProductGpuBytes(device: GPUDevice, bytes: number): () => void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError("Geometry Product GPU allocation size is invalid");
  let ledger = ledgers.get(device);
  if (!ledger) { ledger = { allocatedBytes: 0, metadataBytes: 0, peakBytes: 0, metadataPeakBytes: 0, allocations: 0, metadataAllocations: 0 }; ledgers.set(device, ledger); }
  if (ledger.allocatedBytes + bytes > GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT) {
    throw new RangeError(`Geometry Product GPUBuffer capacity budget exceeded: ${ledger.allocatedBytes + bytes} > ${GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT}`);
  }
  ledger.allocatedBytes += bytes;
  ledger.allocations++;
  ledger.peakBytes = Math.max(ledger.peakBytes, ledger.allocatedBytes);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ledger.allocatedBytes -= bytes;
    ledger.allocations--;
  };
}

export function reserveGeometryProductMetadataBytes(device: GPUDevice, bytes: number): () => void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError("Geometry Product metadata allocation size is invalid");
  let ledger = ledgers.get(device);
  if (!ledger) { ledger = { allocatedBytes: 0, metadataBytes: 0, peakBytes: 0, metadataPeakBytes: 0, allocations: 0, metadataAllocations: 0 }; ledgers.set(device, ledger); }
  if (ledger.metadataBytes + bytes > GEOMETRY_PRODUCT_METADATA_OVERHEAD_LIMIT) throw new RangeError("Geometry Product metadata overhead budget exceeded");
  ledger.metadataBytes += bytes;
  ledger.metadataAllocations++;
  ledger.metadataPeakBytes = Math.max(ledger.metadataPeakBytes, ledger.metadataBytes);
  let released = false;
  return () => { if (released) return; released = true; ledger!.metadataBytes -= bytes; ledger!.metadataAllocations--; };
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
    limitBytes: GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT,
    metadataLimitBytes: GEOMETRY_PRODUCT_METADATA_OVERHEAD_LIMIT
  });
}
