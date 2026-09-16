import {
  assertGeometryProductDescriptorV1,
  type GeometryProductDescriptorV1,
  type GeometryProductRevisionSourceV1
} from "../assets/geometry-product/GeometryProductV1.js";
import { VirtualGeometryResidency } from "./VirtualGeometryResidency.js";

export type GeometryProductRevisionStateV1 = "offered" | "validating" | "reserving" | "filling-activation-cut" | "ready-to-activate" | "active" | "retiring" | "retired" | "failed" | "cancelled";

export interface GeometryProductAdmissionEvidenceV1 {
  readonly offered: number;
  readonly admitted: number;
  readonly active: number;
  readonly failed: number;
  readonly cancelled: number;
}

export class GeometryProductAdmission {
  #nextGeneration = 1;
  #nextProductTableSlot = 0;
  #offered = 0;
  #admitted = 0;
  #active = 0;
  #failed = 0;
  #cancelled = 0;
  constructor(readonly device: GPUDevice) {}

  offer(source: GeometryProductRevisionSourceV1): GeometryProductAdmissionTransaction {
    if (this.#nextProductTableSlot >= 0xffffffff) throw new Error("Geometry Product table slot space exhausted");
    const generation = this.#allocateGeneration();
    const productTableSlot = this.#nextProductTableSlot++;
    this.#offered++;
    return new GeometryProductAdmissionTransaction(this, source, generation, productTableSlot);
  }
  evidence(): GeometryProductAdmissionEvidenceV1 { return Object.freeze({ offered: this.#offered, admitted: this.#admitted, active: this.#active, failed: this.#failed, cancelled: this.#cancelled }); }
  #allocateGeneration(): number { if (this.#nextGeneration > 0xfffffffe) throw new Error("Geometry Product generation space exhausted; reuse requires a completed retirement proof"); const generation = this.#nextGeneration; this.#nextGeneration = generation + 1; return generation; }
  _admitted(): void { this.#admitted++; }
  _active(): void { this.#active++; }
  _retired(): void { this.#active = Math.max(0, this.#active - 1); }
  _failed(): void { this.#failed++; }
  _cancelled(): void { this.#cancelled++; }
}

export class GeometryProductAdmissionTransaction {
  readonly descriptor: GeometryProductDescriptorV1;
  readonly generation: number;
  readonly productTableSlot: number;
  #state: GeometryProductRevisionStateV1 = "offered";
  #residency: VirtualGeometryResidency | undefined;
  readonly #abort = new AbortController();
  #released = false;
  constructor(readonly admission: GeometryProductAdmission, readonly source: GeometryProductRevisionSourceV1, generation: number, productTableSlot: number) { this.descriptor = source.descriptor; this.generation = generation; this.productTableSlot = productTableSlot; }
  get state(): GeometryProductRevisionStateV1 { return this.#state; }
  get residency(): VirtualGeometryResidency { if (!this.#residency || this.#state !== "active") throw new Error("Geometry Product transaction is not active"); return this.#residency; }
  async activate(): Promise<VirtualGeometryResidency> {
    if (this.#state !== "offered") throw new Error(`Geometry Product transaction cannot activate from ${this.#state}`);
    let sourceTransferred = false;
    try {
      this.#state = "validating"; assertGeometryProductDescriptorV1(this.descriptor);
      this.#state = "reserving"; this.#state = "filling-activation-cut";
      sourceTransferred = true;
      this.#residency = await VirtualGeometryResidency.create(this.admission.device, this.source, this.generation, this.productTableSlot, this.#abort.signal);
      if (this.#abort.signal.aborted) throw this.#abort.signal.reason ?? new Error("Geometry Product admission was cancelled");
      this.#state = "ready-to-activate"; this.admission._admitted();
      this.#residency.activatePublication();
      this.#state = "active"; this.admission._active();
      return this.#residency;
    } catch (error) {
      if (this.#residency) { this.#residency.destroy(); this.#residency = undefined; sourceTransferred = true; }
      if (sourceTransferred) this.#released = true; else this.releaseSource();
      if (!this.#abort.signal.aborted) { this.#state = "failed"; this.admission._failed(); }
      throw error;
    }
  }
  beginRetire(): void { if (this.#state !== "active") throw new Error(`Geometry Product transaction cannot retire from ${this.#state}`); this.#state = "retiring"; }
  retire(): void { if (this.#state !== "retiring") throw new Error(`Geometry Product transaction cannot finish retire from ${this.#state}`); this.#residency?.destroy(); this.#residency = undefined; this.#state = "retired"; this.admission._retired(); this.releaseSource(); }
  cancel(): void {
    if (this.#state === "active" || this.#state === "retiring" || this.#state === "retired") throw new Error("active Geometry Product transaction must retire before cancellation");
    if (this.#state === "cancelled" || this.#state === "failed") return;
    const inFlight = this.#state !== "offered";
    this.#state = "cancelled"; this.admission._cancelled();
    this.#abort.abort(new Error("Geometry Product admission was cancelled"));
    if (!inFlight) this.releaseSource();
  }
  private releaseSource(): void { if (this.#released) return; this.#released = true; this.source.release(); }
}
