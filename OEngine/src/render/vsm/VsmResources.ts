import type { VsmCapabilities } from "./VsmCapabilities.js";

export type VsmBufferKey =
  | "pageTable"
  | "metaTable"
  | "demand"
  | "allocation"
  | "casterRecords"
  | "dirtyMask"
  | "generation"
  | "overflowCounters"
  | "rasterIndirect"
  | "pageConstants"
  | "pageLocks"
  | "slotLocks"
  | "contentVersion";
let nextContentNamespace = 1;

/** GPU-resident diagnostic locations. Consumers must not map them to steer work. */
export interface VsmDiagnostics {
  readonly generation: GPUBuffer;
  readonly pageDemand: Readonly<{ buffer: GPUBuffer; byteOffset: number }>;
  readonly allocationFailure: Readonly<{ buffer: GPUBuffer; byteOffset: number }>;
  readonly dirtyPages: Readonly<{ buffer: GPUBuffer; byteOffset: number; byteLength: number }>;
  readonly casterRecords: Readonly<{ buffer: GPUBuffer; byteOffset: number }>;
  readonly atlasPixels: number;
  readonly samplingFallback: Readonly<{ buffer: GPUBuffer; byteOffset: number }>;
  readonly overflowMask: Readonly<{ buffer: GPUBuffer; byteOffset: number }>;
}

/** Persistent device-local VSM storage. FrameGraph owns only per-frame scratch. */
export class VsmResources {
  readonly profile: VsmCapabilities["profile"];
  readonly atlasDepth: GPUTexture | null;
  readonly atlasDepthView: GPUTextureView | null;
  private readonly buffers = new Map<VsmBufferKey, GPUBuffer>();
  private destroyed = false;

  private constructor(
    private readonly device: GPUDevice,
    readonly capabilities: VsmCapabilities
  ) {
    this.profile = capabilities.profile;
    if (capabilities.profile === "shadow-disabled") {
      this.atlasDepth = null;
      this.atlasDepthView = null;
      return;
    }
    if (nextContentNamespace >= 0xfffffffe) { throw new RangeError("VSM content namespace exhausted"); }
    const contentNamespace=nextContentNamespace++;
    this.atlasDepth = device.createTexture({
      label: `VSM/${capabilities.profile}/depth-atlas`,
      size: { width: capabilities.atlasDimension, height: capabilities.atlasDimension, depthOrArrayLayers: 1 },
      dimension: "2d",
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.atlasDepthView = this.atlasDepth.createView({ dimension: "2d", aspect: "all" });
    this.createBuffer("pageTable", capabilities.pageTableBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("metaTable", capabilities.metaTableBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("demand", capabilities.demandBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("allocation", capabilities.allocationBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("casterRecords", capabilities.casterRecordBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const dirtyWords = Math.ceil(capabilities.virtualEntryCount / 32);
    this.createBuffer("dirtyMask", Math.max(256, dirtyWords * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("generation", 256, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("overflowCounters", 256, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("rasterIndirect", 5 * 4 * 64, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.createBuffer("pageConstants", 256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.createBuffer("pageLocks", Math.max(256, capabilities.virtualEntryCount * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("slotLocks", Math.max(256, capabilities.residentSlots * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("contentVersion", 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, [0,0,0,contentNamespace]);
  }

  static create(device: GPUDevice, capabilities: VsmCapabilities): VsmResources {
    return new VsmResources(device, capabilities);
  }

  get pageTable(): GPUBuffer | null { return this.getBuffer("pageTable"); }
  get metaTable(): GPUBuffer | null { return this.getBuffer("metaTable"); }
  get demand(): GPUBuffer | null { return this.getBuffer("demand"); }
  get allocation(): GPUBuffer | null { return this.getBuffer("allocation"); }
  get casterRecords(): GPUBuffer | null { return this.getBuffer("casterRecords"); }
  get dirtyMask(): GPUBuffer | null { return this.getBuffer("dirtyMask"); }
  get generation(): GPUBuffer | null { return this.getBuffer("generation"); }
  get overflowCounters(): GPUBuffer | null { return this.getBuffer("overflowCounters"); }
  get rasterIndirect(): GPUBuffer | null { return this.getBuffer("rasterIndirect"); }
  get pageConstants(): GPUBuffer | null { return this.getBuffer("pageConstants"); }
  get pageLocks(): GPUBuffer | null { return this.getBuffer("pageLocks"); }
  get slotLocks(): GPUBuffer | null { return this.getBuffer("slotLocks"); }
  /** version, frame dirty marker, last generation, immutable owner namespace. */
  get contentVersion(): GPUBuffer | null { return this.getBuffer("contentVersion"); }

  diagnostics(): VsmDiagnostics | null {
    if (this.profile === "shadow-disabled") return null;
    const generation = this.generation;
    const pageDemand = this.demand;
    const allocationFailure = this.overflowCounters;
    const dirtyPages = this.dirtyMask;
    const casterRecords = this.casterRecords;
    const samplingFallback = this.overflowCounters;
    const overflowMask = this.overflowCounters;
    if (!generation || !pageDemand || !allocationFailure || !dirtyPages || !casterRecords ||
        !this.atlasDepth || !samplingFallback || !overflowMask) return null;
    return Object.freeze({
      generation,
      pageDemand: Object.freeze({ buffer: pageDemand, byteOffset: 0 }),
      // E5 allocation telemetry occupies words 0..3; E6 caster/raster
      // telemetry occupies words 4..7. Sampling fallback and overflow mask
      // are reserved in the same GPU telemetry block for the consumer.
      allocationFailure: Object.freeze({ buffer: allocationFailure, byteOffset: 0 }),
      dirtyPages: Object.freeze({ buffer: dirtyPages, byteOffset: 0, byteLength: dirtyPages.size }),
      casterRecords: Object.freeze({ buffer: casterRecords, byteOffset: 0 }),
      atlasPixels: this.atlasDepth.width * this.atlasDepth.height,
      samplingFallback: Object.freeze({ buffer: samplingFallback, byteOffset: 24 }),
      overflowMask: Object.freeze({ buffer: overflowMask, byteOffset: 28 })
    });
  }

  getBuffer(key: VsmBufferKey): GPUBuffer | null {
    return this.buffers.get(key) ?? null;
  }

  private createBuffer(key: VsmBufferKey, requestedSize: number, usage: GPUBufferUsageFlags, initial?:readonly number[]): void {
    const size = Math.max(4, Math.ceil(requestedSize / 4) * 4);
    if (!Number.isSafeInteger(size) || size > this.capabilities.limits.maxStorageBufferBindingSize ||
        size > this.capabilities.limits.maxBufferSize) {
      throw new Error(`VSM ${key} buffer exceeds negotiated device limits`);
    }
    this.buffers.set(key, this.device.createBuffer({
      label: `VSM/${this.capabilities.profile}/${key}`,
      size,
      usage,
      mappedAtCreation: true
    }));
    const buffer = this.buffers.get(key)!;
    new Uint8Array(buffer.getMappedRange()).fill(0);
    if(initial!==undefined) { new Uint32Array(buffer.getMappedRange()).set(initial); }
    buffer.unmap();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.atlasDepth?.destroy();
    for (const buffer of this.buffers.values()) buffer.destroy();
    this.buffers.clear();
  }
}
