import {
  assertGeometryProductDescriptorV1,
  type GeometryProductDescriptorV1,
  type GeometryProductProviderV1,
  type GeometryProductRevisionSourceV1
} from "../assets/geometry-product/GeometryProductV1.js";
import { VirtualGeometryResidency } from "./VirtualGeometryResidency.js";
import type { GeometryPageSchedulerV1 } from "./GeometryPageScheduler.js";

export type GeometryProductRevisionStateV1 = "offered" | "validating" | "reserving" | "filling-activation-cut" | "ready-to-activate" | "active" | "retiring" | "retired" | "failed" | "cancelled";

export interface GeometryProductAdmissionEvidenceV1 {
  readonly offered: number;
  readonly admitted: number;
  readonly active: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface GeometryProductAdmissionControllerEvidenceV1 {
  readonly state: "idle" | "consuming" | "complete" | "cancelled" | "failed";
  readonly offered: number;
  readonly activated: number;
  readonly rejected: number;
  readonly replacements: number;
  readonly retiring: number;
  readonly activeGeneration: number;
  readonly lastRejection?: string;
  readonly failure?: string;
}

export class GeometryProductAdmission {
  #nextGeneration = 1;
  #nextProductTableSlot = 0;
  #offered = 0;
  #admitted = 0;
  #active = 0;
  #failed = 0;
  #cancelled = 0;
  constructor(public device: GPUDevice) {}

  replaceDevice(device: GPUDevice): void { this.device = device; }

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

/**
 * Consumes producer revisions at the single admission boundary. The
 * controller never inspects provider internals and never owns GPU resources;
 * it only commits a revision after VirtualGeometryResidency has filled its
 * complete activation cut.
 */
export class GeometryProductAdmissionController {
  readonly #admission: GeometryProductAdmission;
  readonly #abort = new AbortController();
  #state: GeometryProductAdmissionControllerEvidenceV1["state"] = "idle";
  #offered = 0;
  #activated = 0;
  #rejected = 0;
  #replacements = 0;
  #active: GeometryProductAdmissionTransaction | undefined;
  readonly #retiring: GeometryProductAdmissionTransaction[] = [];
  #failure: string | undefined;
  #lastRejection: string | undefined;
  readonly #schedulers = new Set<GeometryPageSchedulerV1>();
  readonly #activatedListeners = new Set<(transaction: GeometryProductAdmissionTransaction) => void>();

  constructor(device: GPUDevice) { this.#admission = new GeometryProductAdmission(device); }

  get active(): GeometryProductAdmissionTransaction | undefined { return this.#active; }
  get admission(): GeometryProductAdmission { return this.#admission; }

  /**
   * Observes every activation, including replacements, so a renderer owner can
   * publish the new revision before the previous one is retired. Listener
   * failures never fail admission.
   */
  onActivated(listener: (transaction: GeometryProductAdmissionTransaction) => void): () => void {
    this.#activatedListeners.add(listener);
    return () => this.#activatedListeners.delete(listener);
  }

  /** Registers the active Product for demand scheduling without transferring source ownership. */
  registerActiveProduct(scheduler: GeometryPageSchedulerV1): void {
    const active = this.#active;
    if (!active || active.state !== "active") throw new Error("Geometry Product admission has no active revision to register");
    scheduler.registerProduct(active.productTableSlot, active.generation, active.source, { sourceOwnership: "external" });
    this.#schedulers.add(scheduler);
  }

  consume(provider: GeometryProductProviderV1, signal?: AbortSignal): Promise<void> {
    if (this.#state !== "idle") throw new Error(`Geometry Product admission controller cannot consume from '${this.#state}'`);
    this.#state = "consuming";
    return this.#consume(provider, signal);
  }

  cancel(reason = new Error("Geometry Product admission was cancelled")): void {
    if (this.#state === "complete" || this.#state === "cancelled" || this.#state === "failed") return;
    this.#abort.abort(reason);
    this.#state = "cancelled";
  }

  /** Retires the current active revision; callers must do this at a safe GPU boundary. */
  retireActive(): void {
    const active = this.#active;
    if (!active) return;
    active.beginRetire();
    this.#retiring.push(active);
    this.#active = undefined;
  }

  /** Completes replacement retirement after the renderer's submission safety boundary. */
  retireReplaced(): void {
    for (const transaction of this.#retiring.splice(0)) {
      for (const scheduler of this.#schedulers) {
        scheduler.unregisterProduct(transaction.generation);
      }
      if (transaction.state === "active") transaction.beginRetire();
      transaction.retire();
    }
  }

  /** Rebuilds the active Product on a new device from its retained CPU source. */
  async recoverDevice(device: GPUDevice): Promise<void> {
    for (const transaction of this.#retiring.splice(0)) {
      if (transaction.state === "active") transaction.beginRetire();
      if (transaction.state === "retiring") transaction.retire();
    }
    const active = this.#active;
    if (!active || active.state !== "active") throw new Error("Geometry Product recovery requires an active revision");
    this.#admission.replaceDevice(device);
    try {
      await active.recover(device);
    } catch (error) {
      this.#admission._retired();
      this.#active = undefined;
      throw error;
    }
  }

  evidence(): GeometryProductAdmissionControllerEvidenceV1 {
    return Object.freeze({
      state: this.#state,
      offered: this.#offered,
      activated: this.#activated,
      rejected: this.#rejected,
      replacements: this.#replacements,
      retiring: this.#retiring.length,
      activeGeneration: this.#active?.generation ?? 0,
      ...(this.#lastRejection === undefined ? {} : { lastRejection: this.#lastRejection }),
      ...(this.#failure === undefined ? {} : { failure: this.#failure })
    });
  }

  async #consume(provider: GeometryProductProviderV1, signal?: AbortSignal): Promise<void> {
    const abort = new AbortController();
    const forwardAbort = (): void => abort.abort(signal?.reason ?? new Error("Geometry Product admission was cancelled"));
    signal?.addEventListener("abort", forwardAbort, { once: true });
    this.#abort.signal.addEventListener("abort", () => abort.abort(this.#abort.signal.reason), { once: true });
    try {
      for await (const source of provider.revisions(abort.signal)) {
        if (abort.signal.aborted) throw abort.signal.reason ?? new Error("Geometry Product admission was cancelled");
        this.#offered++;
        const transaction = this.#admission.offer(source);
        const cancelTransaction = (): void => transaction.cancel();
        abort.signal.addEventListener("abort", cancelTransaction, { once: true });
        try {
          if (!this.#active && transaction.descriptor.replaces) throw new Error("Geometry Product replacement requires an active revision");
          await transaction.activate();
          if (this.#active) {
            this.#assertReplacement(this.#active, transaction);
            const old = this.#active;
            this.#active = transaction;
            this.#replacements++;
            this.#retiring.push(old);
          } else {
            this.#active = transaction;
          }
          this.#activated++;
          for (const listener of this.#activatedListeners) {
            try { listener(transaction); } catch { /* a publish failure must not fail admission */ }
          }
        } catch (error) {
          this.#rejected++;
          this.#lastRejection = error instanceof Error ? error.message : String(error);
          // Activation owns rollback/release. A replacement failure therefore
          // leaves the previous active revision untouched and consumption can
          // continue to a later valid revision.
          if (transaction.state === "active") {
            transaction.beginRetire();
            transaction.retire();
          } else if (transaction.state === "offered") {
            transaction.cancel();
          }
        } finally {
          abort.signal.removeEventListener("abort", cancelTransaction);
        }
      }
      if (this.#state === "consuming") this.#state = "complete";
    } catch (error) {
      this.#failure = error instanceof Error ? error.message : String(error);
      this.#state = abort.signal.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  #assertReplacement(active: GeometryProductAdmissionTransaction, next: GeometryProductAdmissionTransaction): void {
    const replaces = next.descriptor.replaces;
    if (!replaces || !sameRevisionKey(replaces, active.descriptor)) throw new Error("Geometry Product replacement does not target the active revision");
  }
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
      // VirtualGeometryResidency.create owns source release on every path once
      // descriptor validation has passed, including asynchronous fill failure.
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
  retire(): void {
    if (this.#state !== "retiring") throw new Error(`Geometry Product transaction cannot finish retire from ${this.#state}`);
    // VirtualGeometryResidency owns the source after activation and releases it
    // exactly once when its GPU resources are destroyed.
    this.#residency?.destroy();
    this.#residency = undefined;
    this.#released = true;
    this.#state = "retired";
    this.admission._retired();
  }
  async recover(device: GPUDevice): Promise<VirtualGeometryResidency> {
    if (this.#state !== "active" || !this.#residency) throw new Error("Geometry Product transaction cannot recover unless active");
    this.#residency.abandonForDeviceLoss();
    try {
      this.#residency = await VirtualGeometryResidency.create(device, this.source, this.generation, this.productTableSlot, this.#abort.signal);
      this.#residency.activatePublication();
      return this.#residency;
    } catch (error) {
      this.#residency = undefined;
      this.#released = true;
      this.#state = "failed";
      this.admission._failed();
      throw error;
    }
  }
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

function sameRevisionKey(key: { readonly productId: Uint8Array; readonly revision: number }, descriptor: GeometryProductDescriptorV1): boolean {
  if (key.revision !== descriptor.revision) return false;
  if (key.productId.byteLength !== descriptor.productId.byteLength) return false;
  for (let index = 0; index < key.productId.byteLength; index++) if (key.productId[index] !== descriptor.productId[index]) return false;
  return true;
}
