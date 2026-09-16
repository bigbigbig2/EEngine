import type { OegPackV3 } from "../assets/OegPackV3.js";
import { descriptorFromOegPack, OegPackProductRevisionSource } from "../assets/geometry-product/OegPackProductProvider.js";
import { GeometryProductAdmission } from "./GeometryProductAdmission.js";
import { VirtualGeometryResidency } from "./VirtualGeometryResidency.js";

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

/** Compatibility test adapter; Product admission and heap ownership live in VirtualGeometryResidency. */
export class GeometryBootstrapResidencyV3 {
  readonly #residency: VirtualGeometryResidency;

  private constructor(readonly device: GPUDevice, readonly pack: OegPackV3, residency: VirtualGeometryResidency) { this.#residency = residency; }

  static async create(device: GPUDevice, pack: OegPackV3): Promise<GeometryBootstrapResidencyV3> {
    const source = new OegPackProductRevisionSource(pack, descriptorFromOegPack(pack));
    try { const transaction = new GeometryProductAdmission(device).offer(source); const residency = await transaction.activate(); return new GeometryBootstrapResidencyV3(device, pack, residency); } catch (error) { source.release(); throw error; }
  }

  bank(index: number): GPUBuffer {
    return this.#residency.bank(index);
  }

  groupAddress(groupId: number): GeometryPhysicalAddressV3 | undefined {
    const address = this.#residency.groupAddress(groupId); if (!address) return undefined; return { bankIndex: address.bankIndex, byteOffset: address.byteOffset };
  }

  evidence(): GeometryBootstrapEvidenceV3 {
    const evidence = this.#residency.evidence(); return Object.freeze({ bankCount: evidence.bankCount, slotCapacity: evidence.slotCapacity, residentPages: evidence.residentPages, residentGroups: evidence.residentPages ? this.pack.groups.filter(group => this.#residency.pageLocation(group.pageId)).length : 0, uploadedBytes: evidence.uploadedBytes });
  }

  destroy(): void {
    this.#residency.destroy();
  }
}
