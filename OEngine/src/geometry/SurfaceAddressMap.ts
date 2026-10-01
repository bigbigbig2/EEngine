import { surfaceAddressKey, type SurfaceAddressCpu } from "../gpu/GpuSurfaceAddressAbi.js";

export interface SurfaceLodAddress {
  readonly sourceDomain: number;
  readonly lod: number;
  readonly primitive: number;
  readonly seam: number;
}

/** Cooked source-domain mapping. LODs may reorder meshlets, but the authored
 * domain/primitive/seam tuple remains the cross-frame identity. */
export class SurfaceAddressMap {
  private readonly byLod = new Map<number, readonly SurfaceLodAddress[]>();
  publish(lod: number, entries: readonly SurfaceLodAddress[]): void {
    if (!Number.isInteger(lod) || lod < 0 || entries.some(entry =>
      !Number.isInteger(entry.sourceDomain) || entry.sourceDomain < 0 ||
      !Number.isInteger(entry.primitive) || entry.primitive < 0 ||
      !Number.isInteger(entry.seam) || entry.seam < 0)) {
      throw new RangeError("Surface LOD address mapping is invalid");
    }
    this.byLod.set(lod, Object.freeze(entries.map(entry => Object.freeze({ ...entry }))));
  }
  resolve(lod: number, primitive: number): SurfaceLodAddress {
    const entries = this.byLod.get(lod);
    const value = entries?.[primitive];
    if (!value) throw new RangeError("Surface primitive is outside its stable LOD domain");
    return value;
  }
  key(material: number, generation: number, lod: number, primitive: number): string {
    const value = this.resolve(lod, primitive);
    return surfaceAddressKey({ domain: value.sourceDomain, primitive: value.primitive, material,
      generation, seam: value.seam, lod });
  }
}
