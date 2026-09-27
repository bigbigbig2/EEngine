/**
 * Device-local VSM profile negotiation.  The negotiated profile is immutable
 * for a device epoch; per-frame demand and residency never participate in it.
 */
export type VsmProfile =
  | "vsm-directional-high"
  | "vsm-directional-bounded"
  | "shadow-disabled";

export interface VsmCapabilities {
  readonly profile: VsmProfile;
  readonly reason: string;
  readonly clipLevels: number;
  readonly virtualPagesPerAxis: number;
  readonly pageSize: number;
  readonly border: number;
  readonly atlasDimension: number;
  readonly atlasPagesPerAxis: number;
  readonly residentSlots: number;
  readonly demandCapacity: number;
  readonly casterRecordCapacity: number;
  readonly pcfTapCount: number;
  readonly pageTableBytes: number;
  readonly metaTableBytes: number;
  readonly demandBytes: number;
  readonly allocationBytes: number;
  readonly casterRecordBytes: number;
  readonly limits: Readonly<{
    maxTextureDimension2D: number;
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
    maxStorageBuffersPerShaderStage: number;
    maxComputeWorkgroupsPerDimension: number;
  }>;
}

const PAGE_SIZE = 128;
const BORDER = 4;
const VIRTUAL_PAGES_PER_AXIS = 128;
const HIGH_ATLAS = 4096;
const BOUNDED_ATLAS = 2048;

function bytesForPages(clipLevels: number, bytesPerEntry: number): number {
  return clipLevels * VIRTUAL_PAGES_PER_AXIS * VIRTUAL_PAGES_PER_AXIS * bytesPerEntry;
}

function limitsOf(device: GPUDevice): VsmCapabilities["limits"] {
  return Object.freeze({
    maxTextureDimension2D: Number(device.limits.maxTextureDimension2D),
    maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
    maxBufferSize: Number(device.limits.maxBufferSize),
    maxStorageBuffersPerShaderStage: Number(device.limits.maxStorageBuffersPerShaderStage),
    maxComputeWorkgroupsPerDimension: Number(device.limits.maxComputeWorkgroupsPerDimension)
  });
}

function makeCapabilities(
  device: GPUDevice,
  profile: VsmProfile,
  reason: string,
  clipLevels: number,
  atlasDimension: number,
  demandCapacity: number,
  casterRecordCapacity: number
): VsmCapabilities {
  const atlasPagesPerAxis = Math.floor(atlasDimension / (PAGE_SIZE + BORDER * 2));
  const residentSlots = atlasPagesPerAxis * atlasPagesPerAxis;
  const pageTableBytes = bytesForPages(clipLevels, 16);
  const metaTableBytes = Math.max(256, residentSlots * 32);
  const demandBytes = Math.max(256, demandCapacity * 32 + 16);
  const allocationBytes = Math.max(256, residentSlots * 32 + 16);
  const casterRecordBytes = Math.max(256, casterRecordCapacity * 32 + 16);
  return Object.freeze({
    profile,
    reason,
    clipLevels,
    virtualPagesPerAxis: VIRTUAL_PAGES_PER_AXIS,
    pageSize: PAGE_SIZE,
    border: BORDER,
    atlasDimension,
    atlasPagesPerAxis,
    residentSlots,
    demandCapacity,
    casterRecordCapacity,
    pcfTapCount: profile === "vsm-directional-high" ? 4 : profile === "vsm-directional-bounded" ? 2 : 1,
    pageTableBytes,
    metaTableBytes,
    demandBytes,
    allocationBytes,
    casterRecordBytes,
    limits: limitsOf(device)
  });
}

function fitsBuffer(bytes: number, limits: VsmCapabilities["limits"]): boolean {
  return bytes <= limits.maxStorageBufferBindingSize && bytes <= limits.maxBufferSize;
}

function profileFits(
  device: GPUDevice,
  atlasDimension: number,
  clipLevels: number,
  demandCapacity: number,
  casterRecordCapacity: number
): boolean {
  const limits = limitsOf(device);
  if (limits.maxTextureDimension2D < atlasDimension ||
      // E5 binds demand, page/meta tables, allocation work, two lock arrays
      // and GPU telemetry in one compute stage.
      limits.maxStorageBuffersPerShaderStage < 7 ||
      limits.maxComputeWorkgroupsPerDimension < 1) return false;
  const candidate = makeCapabilities(device, "vsm-directional-bounded", "preflight", clipLevels,
    atlasDimension, demandCapacity, casterRecordCapacity);
  const pageLocksBytes = Math.max(256, clipLevels * VIRTUAL_PAGES_PER_AXIS * VIRTUAL_PAGES_PER_AXIS * 4);
  const slotLocksBytes = Math.max(256, candidate.residentSlots * 4);
  return [candidate.pageTableBytes, candidate.metaTableBytes, candidate.demandBytes,
    candidate.allocationBytes, candidate.casterRecordBytes, pageLocksBytes, slotLocksBytes]
    .every(bytes => fitsBuffer(bytes, limits));
}

/** Negotiate once after device creation and before any VSM resource allocation. */
export function negotiateVsmCapabilities(device: GPUDevice): VsmCapabilities {
  if (profileFits(device, HIGH_ATLAS, 6, 8192, 65536)) {
    return makeCapabilities(device, "vsm-directional-high",
      "device limits satisfy directional high profile", 6, HIGH_ATLAS, 8192, 65536);
  }
  if (profileFits(device, BOUNDED_ATLAS, 4, 2048, 16384)) {
    return makeCapabilities(device, "vsm-directional-bounded",
      "high profile limits unavailable; bounded directional profile selected", 4,
      BOUNDED_ATLAS, 2048, 16384);
  }
  return makeCapabilities(device, "shadow-disabled",
    "device cannot satisfy the minimum fixed VSM resource profile", 0, 0, 0, 0);
}
