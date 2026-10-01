import { type AppearanceCacheBudget, DEFAULT_APPEARANCE_CACHE_BUDGET } from "./GpuAppearanceCacheAbi.js";
import type { AppearanceCachePlan } from "../shaders/appearance_cache.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";

export interface PreparedAppearanceCache {
  /** Simple sources and constants have no dynamic cache allocation. */
  readonly programs: readonly (GPUBuffer | null)[];
  readonly maxAge: number;
  readonly allocatedBytes: number;
}
interface State { readonly handles: readonly ResourceHandle[]; }

/** Sole physical owner of exact dependency pages. Compiled request/election/
 * publication/evaluation/consumption stages use these cells in the caller's
 * frame encoder. Uncached fields do not pay for a dormant material atlas. */
export class GpuAppearanceCache {
  private readonly states = new Map<PreparedAppearanceCache, State>();
  private destroyed = false;
  constructor(private readonly device: GPUDevice, private readonly accounting?: ResourceAccounting,
    private readonly budget: AppearanceCacheBudget = DEFAULT_APPEARANCE_CACHE_BUDGET) {
    if (!Object.values(budget).every(value => Number.isSafeInteger(value) && value > 0) ||
      (budget.pages & (budget.pages - 1)) !== 0) throw new RangeError("Invalid Appearance cache budget");
    void device.lost.then(() => this.destroy());
  }
  get allocatedBytes(): number { let total = 0; for (const state of this.states.keys()) total += state.allocatedBytes; return total; }
  prepare(plans: readonly AppearanceCachePlan[]): PreparedAppearanceCache {
    if (this.destroyed) throw new Error("Appearance cache owner is destroyed");
    const sizes = plans.map(plan => plan.fields.some(field => field.cells > 0) ? plan.words * 4 : 0);
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
    if (bytes + this.allocatedBytes > this.budget.maxBytes || sizes.some(size => size > this.device.limits.maxStorageBufferBindingSize ||
      size > this.device.limits.maxBufferSize) || plans.some(plan => plan.fields.some(field => field.cells > this.budget.pages * 64))) {
      throw new RangeError("Appearance cache exceeds negotiated physical budget");
    }
    const programs: (GPUBuffer | null)[] = [], handles: ResourceHandle[] = [];
    try {
      for (const size of sizes) {
        if (size === 0) { programs.push(null); continue; }
        const label = "Appearance dependency field pages";
        const buffer = this.device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        programs.push(buffer);
        const handle = this.accounting?.created({ kind: "buffer", category: "work-cache", owner: "Appearance/cache", bytes: size, label });
        if (handle) handles.push(handle);
      }
      const prepared = Object.freeze({ programs: Object.freeze(programs), maxAge: this.budget.maxAge, allocatedBytes: bytes });
      this.states.set(prepared, { handles }); return prepared;
    } catch (error) {
      for (const buffer of programs) buffer?.destroy();
      for (const handle of handles) this.accounting?.destroyed(handle);
      throw error;
    }
  }
  release(cache: PreparedAppearanceCache): void {
    const state = this.states.get(cache);
    if (!state) { if (this.destroyed) return; throw new Error("Appearance cache allocation is stale"); }
    this.states.delete(cache);
    for (const buffer of cache.programs) buffer?.destroy();
    for (const handle of state.handles) this.accounting?.destroyed(handle);
  }
  destroy(): void { if (this.destroyed) return; for (const cache of this.states.keys()) this.release(cache); this.destroyed = true; }
}
