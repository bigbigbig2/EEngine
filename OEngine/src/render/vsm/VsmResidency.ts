import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { VsmCapabilities } from "./VsmCapabilities.js";
import type { VsmResources } from "./VsmResources.js";

/** GPU-owned residency publication for one VSM frame. No CPU page decisions live here. */
export interface VsmAllocationFrame {
  readonly allocation: ResourceId;
  readonly demand: ResourceId;
  readonly pageTable: ResourceId;
  readonly metaTable: ResourceId;
  readonly contentVersion: ResourceId;
  readonly generation: number;
  readonly capacity: number;
}

export function virtualEntryCount(capabilities: VsmCapabilities): number {
  return capabilities.virtualEntryCount;
}

export function allocationRecordCapacity(capabilities: VsmCapabilities): number {
  return capabilities.residentSlots;
}

export function requireResidencyBuffers(resources: VsmResources): {
  pageTable: GPUBuffer;
  metaTable: GPUBuffer;
  allocation: GPUBuffer;
  overflowCounters: GPUBuffer;
} {
  const pageTable = resources.pageTable;
  const metaTable = resources.metaTable;
  const allocation = resources.allocation;
  const overflowCounters = resources.overflowCounters;
  if (!pageTable || !metaTable || !allocation || !overflowCounters) {
    throw new Error("VSM residency buffers are unavailable for the negotiated profile");
  }
  return { pageTable, metaTable, allocation, overflowCounters };
}
