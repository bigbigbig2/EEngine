import type { AppearanceAssetPackage, AppearanceAssetField } from "../assets/AppearanceAssetPackage.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { stageAppearanceAssetUpload, type AppearanceAssetDestination } from "./AppearanceAssetUpload.js";
import type { AppearanceProgramRegistry } from "./AppearanceProgramRegistry.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";

export interface AppearanceStaticBudget {
  readonly maxAssets: number;
  readonly maxResidentBytes: number;
  readonly maxUploadBytes: number;
  readonly maxStagingBytes: number;
}
export interface AppearanceStaticLease {
  readonly assetId: string;
  destination(field: string): AppearanceAssetDestination;
  /** Publication releases after its last GPU consumer has completed; idempotent. */
  release(): void;
}
interface Entry {
  readonly id: string;
  readonly bytes: number;
  readonly textures: GPUTexture[];
  readonly accounting: ResourceHandle[];
  readonly destinations: Map<string, AppearanceAssetDestination>;
  command: ShadeGPUCommandContext | null;
  refs: number;
  state: "staging" | "resident" | "retiring" | "destroyed";
}

/** Stable physical key for a field in an immutable asset. Does not allocate GPU resources. */
export function appearanceStaticTextureKey(asset: AppearanceAssetPackage, field: AppearanceAssetField): string | null {
  if (field.format === null) return null;
  const mip = field.mips[0]!;
  return JSON.stringify([asset.runtime.manifest.assetId, field.format, mip.width, mip.height, field.mips.length]);
}

/**
 * Sole long-lived owner for static cooked Appearance textures. Same immutable
 * asset shares physical data across materials/scenes; fields of equal format /
 * extent/mip count share exact-sized array layers. No duplicated source banks,
 * streaming/cache algorithm, private submit, or per-frame allocation here.
 * All resources (including retiring allocations) count against fixed budgets.
 */
export class AppearanceStaticResidency {
  private readonly current = new Map<string, Entry>();
  private readonly physical = new Set<Entry>();
  private readonly transactions = new WeakMap<ShadeGPUCommandContext, { upload: number; staging: number }>();
  private allocatedBytes = 0;
  private stopped = false;
  private unwatch: (() => void) | null = null;
  private readonly budget: AppearanceStaticBudget;

  constructor(private readonly device: GPUDevice, registry: AppearanceProgramRegistry,
    budget: AppearanceStaticBudget = { maxAssets: 4096, maxResidentBytes: 256 * 1024 * 1024,
      maxUploadBytes: 64 * 1024 * 1024, maxStagingBytes: 64 * 1024 * 1024 }, private readonly accounting?: ResourceAccounting) {
    for (const [name, value] of Object.entries(budget)) if (!Number.isSafeInteger(value) || value < (name === "maxAssets" ? 1 : 0)) {
      throw new RangeError(`Invalid static Appearance ${name}`);
    }
    this.budget = Object.freeze({ ...budget });
    this.unwatch = registry.onStopped(() => this.destroy());
  }

  acquire(asset: AppearanceAssetPackage, command: ShadeGPUCommandContext): AppearanceStaticLease {
    if (this.stopped || command.closed || command.device !== this.device) throw new Error("Static Appearance requires a live same-device publication transaction");
    const id = asset.runtime.manifest.assetId;
    let entry = this.current.get(id);
    if (entry !== undefined && entry.state === "staging" && entry.command !== command) {
      throw new Error("Static Appearance asset has an uncommitted transaction");
    }
    if (entry === undefined) entry = this.stage(asset, command);
    entry.refs++;
    const owned = entry; let released = false;
    return Object.freeze({ assetId: id, destination: (field: string) => {
      if (released || owned.state === "destroyed" || owned.state === "retiring") throw new Error("Static Appearance lease is not consumable");
      const target = owned.destinations.get(field);
      if (target === undefined) throw new RangeError(`Static Appearance texture field '${field}' is missing`);
      return target;
    }, release: () => {
      if (released) return; released = true; owned.refs--;
      if (owned.refs !== 0 || owned.state === "destroyed") return;
      this.current.delete(owned.id);
      if (owned.state === "staging") { this.dispose(owned); return; }
      owned.state = "retiring";
      void this.device.queue.onSubmittedWorkDone().then(() => this.dispose(owned), () => this.dispose(owned));
    } });
  }

  evidence(): Readonly<{ allocatedBytes: number; residentBytes: number; stagingBytes: number; retiringBytes: number; assets: number }> {
    let residentBytes = 0, stagingBytes = 0, retiringBytes = 0;
    for (const entry of this.physical) {
      if (entry.state === "resident") residentBytes += entry.bytes;
      else if (entry.state === "staging") stagingBytes += entry.bytes;
      else if (entry.state === "retiring") retiringBytes += entry.bytes;
    }
    return Object.freeze({ allocatedBytes: this.allocatedBytes, residentBytes, stagingBytes, retiringBytes, assets: this.physical.size });
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true; this.unwatch?.(); this.unwatch = null;
    for (const entry of this.physical) this.dispose(entry);
    this.current.clear();
  }

  private stage(asset: AppearanceAssetPackage, command: ShadeGPUCommandContext): Entry {
    const groups = new Map<string, AppearanceAssetField[]>();
    let padded = 0;
    for (const field of asset.fields) {
      const key = appearanceStaticTextureKey(asset, field);
      if (key === null) continue;
      const group = groups.get(key) ?? []; group.push(field); groups.set(key, group);
      const base = field.mips[0]!;
      if (base.width > this.device.limits.maxTextureDimension2D || base.height > this.device.limits.maxTextureDimension2D ||
          group.length > this.device.limits.maxTextureArrayLayers) throw new RangeError("Static Appearance extent/layers exceed negotiated device limits");
      const channels = field.width === 3 ? 4 : field.width;
      for (const mip of field.mips) {
        const row = mip.width * channels * 2, pitch = Math.ceil(row / 256) * 256;
        const bytes = Math.ceil((pitch * (mip.height - 1) + row) / 4) * 4;
        if (bytes > this.device.limits.maxBufferSize) throw new RangeError("Static Appearance upload exceeds negotiated buffer limit");
        padded += bytes;
      }
    }
    const transaction = this.transactions.get(command) ?? { upload: 0, staging: 0 };
    if (!Number.isSafeInteger(padded) || this.physical.size >= this.budget.maxAssets ||
        this.allocatedBytes + asset.residentBytes > this.budget.maxResidentBytes ||
        transaction.upload + padded > this.budget.maxUploadBytes || transaction.staging + padded > this.budget.maxStagingBytes) {
      throw new RangeError("Static Appearance physical or transaction budget exhausted before allocation");
    }
    const entry: Entry = { id: asset.runtime.manifest.assetId, bytes: asset.residentBytes, textures: [], accounting: [],
      destinations: new Map(), command, refs: 0, state: "staging" };
    this.current.set(entry.id, entry); this.physical.add(entry); this.allocatedBytes += entry.bytes;
    transaction.upload += padded; transaction.staging += padded; this.transactions.set(command, transaction);
    // Install rollback before the first command copy can throw and abort the transaction.
    command.onAborted.addOne(() => this.dispose(entry));
    command.onBeforeFinish.addOne(() => { if (entry.state === "destroyed") throw new Error("Static Appearance publication was cancelled before submit"); });
    command.onFinished.addOne(() => { if (entry.state === "staging") { entry.state = "resident"; entry.command = null; } });
    try {
      for (const group of groups.values()) {
        const field = group[0]!, base = field.mips[0]!;
        const label = `AppearanceStatic/${entry.id}/${field.format}/${base.width}x${base.height}`;
        const texture = this.device.createTexture({ label, dimension: "2d", format: field.format!,
          size: [base.width, base.height, group.length], mipLevelCount: field.mips.length,
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
        entry.textures.push(texture);
        if (this.accounting !== undefined) entry.accounting.push(this.accounting.created({ kind: "texture", category: "resident",
          owner: "AppearanceStaticResidency", label, bytes: group.reduce((sum, item) => sum + item.mips.reduce((n, mip) => n + mip.payload.byteLength, 0), 0) }));
        group.forEach((item, layer) => entry.destinations.set(item.name, Object.freeze({ texture, layer })));
      }
      stageAppearanceAssetUpload(this.device, asset, entry.destinations, command, { maxUploadBytes: padded,
        maxStagingBytes: padded, maxResidentBytes: asset.residentBytes });
      return entry;
    } catch (error) {
      this.dispose(entry);
      transaction.upload -= padded; transaction.staging -= padded;
      // Any partial upload uses the caller's one atomic transaction.
      if (!command.closed) command.abort(error);
      throw error;
    }
  }

  private dispose(entry: Entry): void {
    if (entry.state === "destroyed") return;
    entry.state = "destroyed"; entry.command = null;
    if (this.current.get(entry.id) === entry) this.current.delete(entry.id);
    this.physical.delete(entry); this.allocatedBytes -= entry.bytes;
    for (const texture of entry.textures) texture.destroy();
    for (const handle of entry.accounting) this.accounting?.destroyed(handle);
  }
}
