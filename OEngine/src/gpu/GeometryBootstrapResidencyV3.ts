import {
  OEGPACK_V3_GEOMETRY_BANK_BYTES,
  OEGPACK_V3_PAGE_BYTES,
  OEGPACK_V3_SLOTS_PER_BANK
} from "../assets/GeometryAbiV3.js";
import type { OegPackV3 } from "../assets/OegPackV3.js";

export interface GeometryPhysicalAddressV3 {
  readonly bankIndex: number;
  readonly byteOffset: number;
}

export interface GeometryBootstrapEvidenceV3 {
  readonly bankCount: number;
  readonly slotCapacity: number;
  readonly residentPages: number;
  readonly residentGroups: number;
  readonly uploadedBytes: number;
}

/** A8-only root-page proof owner. Demand scheduling and eviction belong to ADR-0016-B. */
export class GeometryBootstrapResidencyV3 {
  readonly #banks: GPUBuffer[] = [];
  readonly #pageAddresses = new Map<number, GeometryPhysicalAddressV3>();
  readonly #groupAddresses = new Map<number, GeometryPhysicalAddressV3>();
  #destroyed = false;
  #uploadedBytes = 0;

  private constructor(readonly device: GPUDevice, readonly pack: OegPackV3) {}

  static async create(device: GPUDevice, pack: OegPackV3): Promise<GeometryBootstrapResidencyV3> {
    if (device.limits.maxBufferSize < OEGPACK_V3_GEOMETRY_BANK_BYTES || device.limits.maxStorageBufferBindingSize < OEGPACK_V3_GEOMETRY_BANK_BYTES) {
      throw new RangeError("OEGPACK V3 bootstrap requires a 128 MiB storage-buffer bank");
    }
    const owner = new GeometryBootstrapResidencyV3(device, pack);
    try { await owner.load(); return owner; } catch (error) { owner.destroy(); throw error; }
  }

  private async load(): Promise<void> {
    const uniquePages = [...new Set(this.pack.bootstrapPageIds)].sort((a, b) => a - b);
    const bankCount = Math.ceil(uniquePages.length / OEGPACK_V3_SLOTS_PER_BANK);
    for (let bank = 0; bank < bankCount; bank++) {
      this.#banks.push(this.device.createBuffer({
        label: `OEngine OEGPACK V3 bootstrap geometry bank ${bank}`,
        size: OEGPACK_V3_GEOMETRY_BANK_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      }));
    }
    for (let slot = 0; slot < uniquePages.length; slot++) {
      const pageId = uniquePages[slot]!;
      const bankIndex = Math.floor(slot / OEGPACK_V3_SLOTS_PER_BANK);
      const byteOffset = (slot % OEGPACK_V3_SLOTS_PER_BANK) * OEGPACK_V3_PAGE_BYTES;
      const decoded = await this.pack.readPage(pageId);
      const upload = new Uint8Array(decoded.byteLength);
      upload.set(decoded);
      this.device.queue.writeBuffer(this.#banks[bankIndex]!, byteOffset, upload);
      this.#pageAddresses.set(pageId, Object.freeze({ bankIndex, byteOffset }));
      this.#uploadedBytes += decoded.byteLength;
    }
    for (let groupId = 0; groupId < this.pack.groups.length; groupId++) {
      const group = this.pack.groups[groupId]!;
      const page = this.#pageAddresses.get(group.pageId);
      if (page) this.#groupAddresses.set(groupId, Object.freeze({ bankIndex: page.bankIndex, byteOffset: page.byteOffset + group.offsetInDecodedPage }));
    }
    for (const asset of this.pack.assets) {
      if (!Array.from({ length: asset.bootstrapPageCount }, (_, i) => this.pack.bootstrapPageIds[asset.bootstrapPageBegin + i]!).every(page => this.#pageAddresses.has(page))) {
        throw new Error("asset bootstrap cut was not fully resident");
      }
    }
  }

  bank(index: number): GPUBuffer {
    if (this.#destroyed || !Number.isInteger(index) || index < 0 || index >= this.#banks.length) throw new RangeError("geometry bank index is invalid");
    return this.#banks[index]!;
  }

  groupAddress(groupId: number): GeometryPhysicalAddressV3 | undefined {
    if (this.#destroyed) throw new Error("GeometryBootstrapResidencyV3 is destroyed");
    return this.#groupAddresses.get(groupId);
  }

  evidence(): GeometryBootstrapEvidenceV3 {
    return Object.freeze({ bankCount: this.#banks.length, slotCapacity: this.#banks.length * OEGPACK_V3_SLOTS_PER_BANK, residentPages: this.#pageAddresses.size, residentGroups: this.#groupAddresses.size, uploadedBytes: this.#uploadedBytes });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const bank of this.#banks) bank.destroy();
    this.#banks.length = 0; this.#pageAddresses.clear(); this.#groupAddresses.clear();
  }
}
