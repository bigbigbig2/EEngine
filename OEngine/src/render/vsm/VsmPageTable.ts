import type { VsmCapabilities } from "./VsmCapabilities.js";
import {
  VSM_PAGE_ENTRY_WORDS,
  VSM_META_ENTRY_WORDS,
  vsmPageTableEntryByteOffset,
  vsmMetaEntryByteOffset,
} from "./VsmPageState.js";
import type { VsmResources } from "./VsmResources.js";

/** Read-only page-table ABI owner. It never performs CPU residency decisions. */
export class VsmPageTable {
  readonly virtualEntryCount: number;
  readonly slotCount: number;

  constructor(
    readonly resources: VsmResources,
    readonly capabilities: VsmCapabilities = resources.capabilities,
  ) {
    if (resources.profile === "shadow-disabled") throw new Error("Disabled VSM has no page table");
    this.virtualEntryCount = capabilities.virtualEntryCount;
    this.slotCount = capabilities.residentSlots;
    if (
      capabilities.pageTableBytes < this.virtualEntryCount * VSM_PAGE_ENTRY_WORDS * 4 ||
      capabilities.metaTableBytes < this.slotCount * VSM_META_ENTRY_WORDS * 4
    ) {
      throw new Error("VSM persistent buffers do not satisfy the page-table ABI");
    }
  }

  entryByteOffset(level: number, mip: number, pageX: number, pageY: number): number {
    return vsmPageTableEntryByteOffset(level, mip, pageX, pageY, this.capabilities.virtualPagesPerAxis);
  }

  metaByteOffset(slot: number): number {
    if (slot >= this.slotCount) throw new RangeError("VSM slot exceeds resident capacity");
    return vsmMetaEntryByteOffset(slot);
  }

  get pageTableBuffer(): GPUBuffer {
    const buffer = this.resources.pageTable;
    if (!buffer) throw new Error("VSM page table buffer is unavailable");
    return buffer;
  }

  get metaTableBuffer(): GPUBuffer {
    const buffer = this.resources.metaTable;
    if (!buffer) throw new Error("VSM meta table buffer is unavailable");
    return buffer;
  }

  /** Clears the persistent ABI at device-epoch creation; no page decision is made on CPU. */
  clearForDeviceEpoch(encoder: GPUCommandEncoder): void {
    encoder.clearBuffer(this.pageTableBuffer);
    encoder.clearBuffer(this.metaTableBuffer);
    for (const buffer of [
      this.resources.dirtyMask,
      this.resources.generation,
      this.resources.overflowCounters,
      this.resources.allocation,
      this.resources.casterRecords,
      this.resources.rasterIndirect,
      this.resources.pageLocks,
      this.resources.slotLocks,
    ]) {
      if (buffer) encoder.clearBuffer(buffer);
    }
    if (this.resources.demand) encoder.clearBuffer(this.resources.demand, 0, 16);
  }

  /** Invalidates generation-visible state while retaining physical storage capacity. */
  invalidateGeneration(encoder: GPUCommandEncoder): void {
    for (const buffer of [
      this.resources.dirtyMask,
      this.resources.generation,
      this.resources.overflowCounters,
    ]) {
      if (buffer) encoder.clearBuffer(buffer);
    }
  }
}
