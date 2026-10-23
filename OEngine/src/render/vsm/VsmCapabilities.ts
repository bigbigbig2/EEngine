/**
 * Device-local VSM profile negotiation.  The negotiated profile is immutable
 * for a device epoch; per-frame demand and residency never participate in it.
 */
import {
  VSM_PAGE_ENTRY_WORDS,
  VSM_DEMAND_RECORD_WORDS,
  vsmEntriesPerClipLevel,
  vsmScanBytes,
} from "./VsmPageState.js";
import { VSM_PAIR_HEADER_BYTES, VSM_PAIR_STRIDE } from "../../gpu/GpuVsmPairAbi.js";
import { VSM_MAX_CLIP_LEVELS, VSM_PROJECTION_CONSTANT_BYTES } from "../../gpu/GpuVsmProjectionAbi.js";

export type VsmProfile = "vsm-directional-high" | "vsm-directional-bounded" | "shadow-disabled";

export interface VsmCapabilities {
  readonly profile: VsmProfile;
  readonly reason: string;
  readonly clipLevels: number;
  readonly virtualPagesPerAxis: number;
  readonly virtualEntryCount: number;
  readonly pageSize: number;
  readonly border: number;
  readonly atlasDimension: number;
  readonly atlasPagesPerAxis: number;
  readonly residentSlots: number;
  readonly demandCapacity: number;
  readonly casterRecordCapacity: number;
  readonly pageTableBytes: number;
  readonly metaTableBytes: number;
  readonly demandBytes: number;
  readonly requestedPagesBytes: number;
  readonly receiverPriorityBytes: number;
  readonly demandScanBytes: number;
  readonly slotCandidatesBytes: number;
  readonly coarseReservedSlots: number;
  readonly allocationBytes: number;
  readonly casterRecordBytes: number;
  readonly limits: Readonly<{
    maxTextureDimension2D: number;
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
    maxUniformBufferBindingSize: number;
    maxStorageBuffersPerShaderStage: number;
    maxComputeWorkgroupsPerDimension: number;
    maxComputeWorkgroupSizeX: number;
    maxComputeInvocationsPerWorkgroup: number;
    maxComputeWorkgroupStorageSize: number;
  }>;
}

export const VSM_PAGE_SIZE = 64;
export const VSM_BORDER = 4;
export const VSM_VIRTUAL_PAGES_PER_AXIS = 64;
export interface VsmResourceBudget {
  /** Maximum atlas allocation, in MiB. 256 explicitly opts into the 8192 atlas. */
  readonly atlasMiB?: 16 | 64 | 256;
  /** Nine converted clips match the old nominal far extent; default ten also
   * covers its forward-offset/snapping fringe. Larger ranges are explicit. */
  readonly clipLevels?: number;
}
const LARGE_ATLAS = 8192;
const HIGH_ATLAS = 4096;
const BOUNDED_ATLAS = 2048;
export const VSM_MAX_RESIDENT_SLOTS = Math.floor(LARGE_ATLAS / (VSM_PAGE_SIZE + VSM_BORDER * 2)) ** 2;

function limitsOf(device: GPUDevice): VsmCapabilities["limits"] {
  return Object.freeze({
    maxTextureDimension2D: Number(device.limits.maxTextureDimension2D),
    maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
    maxBufferSize: Number(device.limits.maxBufferSize),
    maxUniformBufferBindingSize: Number(device.limits.maxUniformBufferBindingSize),
    maxStorageBuffersPerShaderStage: Number(device.limits.maxStorageBuffersPerShaderStage),
    maxComputeWorkgroupsPerDimension: Number(device.limits.maxComputeWorkgroupsPerDimension),
    maxComputeWorkgroupSizeX: Number(device.limits.maxComputeWorkgroupSizeX),
    maxComputeInvocationsPerWorkgroup: Number(device.limits.maxComputeInvocationsPerWorkgroup),
    maxComputeWorkgroupStorageSize: Number(device.limits.maxComputeWorkgroupStorageSize),
  });
}

function makeCapabilities(
  device: GPUDevice,
  profile: VsmProfile,
  reason: string,
  clipLevels: number,
  atlasDimension: number,
  casterRecordCapacity: number,
): VsmCapabilities {
  const atlasPagesPerAxis = Math.floor(atlasDimension / (VSM_PAGE_SIZE + VSM_BORDER * 2));
  const residentSlots = atlasPagesPerAxis * atlasPagesPerAxis;
  const virtualEntryCount = clipLevels * vsmEntriesPerClipLevel(VSM_VIRTUAL_PAGES_PER_AXIS);
  const pageTableBytes = virtualEntryCount * VSM_PAGE_ENTRY_WORDS * 4;
  const metaTableBytes = Math.max(256, residentSlots * 32);
  const demandCapacity = virtualEntryCount;
  const demandBytes = Math.max(256, demandCapacity * VSM_DEMAND_RECORD_WORDS * 4 + 16);
  const requestedPagesBytes = Math.max(256, Math.ceil(virtualEntryCount / 32) * 4);
  const receiverPriorityBytes = virtualEntryCount * 4;
  const demandScanBytes = Math.max(256, vsmScanBytes(virtualEntryCount));
  const slotCandidatesBytes = Math.max(256, residentSlots * 8 + 16);
  const coarseReservedSlots = clipLevels * (VSM_VIRTUAL_PAGES_PER_AXIS / 32 + 1) ** 2;
  const allocationBytes = Math.max(256, residentSlots * 32 + 16);
  const casterRecordBytes = Math.max(256, casterRecordCapacity * VSM_PAIR_STRIDE + VSM_PAIR_HEADER_BYTES);
  return Object.freeze({
    profile,
    reason,
    clipLevels,
    virtualPagesPerAxis: VSM_VIRTUAL_PAGES_PER_AXIS,
    virtualEntryCount,
    pageSize: VSM_PAGE_SIZE,
    border: VSM_BORDER,
    atlasDimension,
    atlasPagesPerAxis,
    residentSlots,
    demandCapacity,
    casterRecordCapacity,
    pageTableBytes,
    metaTableBytes,
    demandBytes,
    requestedPagesBytes,
    receiverPriorityBytes,
    demandScanBytes,
    slotCandidatesBytes,
    coarseReservedSlots,
    allocationBytes,
    casterRecordBytes,
    limits: limitsOf(device),
  });
}

function fitsBuffer(bytes: number, limits: VsmCapabilities["limits"]): boolean {
  return bytes <= limits.maxStorageBufferBindingSize && bytes <= limits.maxBufferSize;
}

function profileFits(
  device: GPUDevice,
  atlasDimension: number,
  clipLevels: number,
  casterRecordCapacity: number,
): boolean {
  const limits = limitsOf(device);
  if (
    !Object.values(limits).every((value) => Number.isFinite(value) && value > 0) ||
    limits.maxTextureDimension2D < atlasDimension ||
    limits.maxUniformBufferBindingSize < VSM_PROJECTION_CONSTANT_BYTES ||
    // E5 needs seven compute storage buffers; both Atlas vertex backends
    // need eight. The material record is fragment-only in the ordinary path.
    limits.maxStorageBuffersPerShaderStage < 8 ||
    limits.maxComputeWorkgroupsPerDimension < 1 ||
    limits.maxComputeWorkgroupSizeX < 64 ||
    limits.maxComputeInvocationsPerWorkgroup < 64 ||
    limits.maxComputeWorkgroupStorageSize < 1024
  )
    return false;
  const candidate = makeCapabilities(
    device,
    "vsm-directional-bounded",
    "preflight",
    clipLevels,
    atlasDimension,
    casterRecordCapacity,
  );
  if (
    candidate.residentSlots <= candidate.coarseReservedSlots ||
    Math.ceil(candidate.virtualEntryCount / 64) > limits.maxComputeWorkgroupsPerDimension
  ) {
    return false;
  }
  return [
    candidate.pageTableBytes,
    candidate.metaTableBytes,
    candidate.demandBytes,
    candidate.allocationBytes,
    candidate.casterRecordBytes,
    candidate.requestedPagesBytes,
    candidate.receiverPriorityBytes,
    candidate.demandScanBytes,
    candidate.slotCandidatesBytes,
  ].every((bytes) => fitsBuffer(bytes, limits));
}

/** Negotiate once after device creation and before any VSM resource allocation. */
export function negotiateVsmCapabilities(device: GPUDevice, budget: VsmResourceBudget = {}): VsmCapabilities {
  const atlasMiB = budget.atlasMiB ?? 64;
  const clipLevels = budget.clipLevels ?? 10;
  if (!Number.isInteger(clipLevels) || clipLevels < 10 || clipLevels > VSM_MAX_CLIP_LEVELS) {
    throw new RangeError("VSM resource clip levels must be an integer in [10, 16]");
  }
  if (![16, 64, 256].includes(atlasMiB)) {
    throw new RangeError("Invalid VSM atlas budget");
  }
  if (atlasMiB === 256 && profileFits(device, LARGE_ATLAS, clipLevels, 262144)) {
    return makeCapabilities(
      device,
      "vsm-directional-high",
      "explicit 256 MiB atlas budget",
      clipLevels,
      LARGE_ATLAS,
      262144,
    );
  }
  if (atlasMiB >= 64 && profileFits(device, HIGH_ATLAS, clipLevels, 262144)) {
    return makeCapabilities(
      device,
      "vsm-directional-high",
      "device limits satisfy directional high profile",
      clipLevels,
      HIGH_ATLAS,
      262144,
    );
  }
  if (profileFits(device, BOUNDED_ATLAS, clipLevels, 16384)) {
    return makeCapabilities(
      device,
      "vsm-directional-bounded",
      atlasMiB === 16 ? "explicit 16 MiB atlas budget" : "high profile limits unavailable; bounded directional profile selected",
      clipLevels,
      BOUNDED_ATLAS,
      16384,
    );
  }
  return makeCapabilities(
    device,
    "shadow-disabled",
    "device cannot satisfy the minimum fixed VSM resource profile",
    0,
    0,
    0,
  );
}
