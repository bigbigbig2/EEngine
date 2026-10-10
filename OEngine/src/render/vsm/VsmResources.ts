import type { VsmCapabilities } from "./VsmCapabilities.js";

export type VsmBufferKey =
  | "pageTable"
  | "metaTable"
  | "demand"
  | "allocation"
  | "casterRecords"
  | "generation"
  | "overflowCounters"
  | "rasterIndirect"
  | "pageConstants"
  | "requestedPages"
  | "missingPages"
  | "demandScan"
  | "demandIndirect"
  | "slotCandidates"
  | "contentVersion"
  | "depthRange";
let nextContentNamespace = 1;

/** GPU-resident diagnostic locations. Consumers must not map them to steer work. */
export interface VsmDiagnostics {
  readonly generation: GPUBuffer;
  readonly pageDemand: Readonly<{ buffer: GPUBuffer; byteOffset: number }>;
  readonly allocationFailure: Readonly<{ buffer: GPUBuffer; byteOffset: number }>;
  readonly dirtyPages: Readonly<{
    buffer: GPUBuffer;
    byteOffset: number;
    byteLength: number;
    countByteOffset: number;
    stride: number;
  }>;
  readonly casterRecords: Readonly<{ buffer: GPUBuffer; byteOffset: number }>;
  readonly atlasPixels: number;
  readonly samplingFallback: null;
  readonly overflowMask: null;
}

/** Persistent device-local VSM storage. FrameGraph owns only per-frame scratch. */
export class VsmResources {
  readonly namespace: number;
  readonly profile: VsmCapabilities["profile"];
  readonly atlasDepth: GPUTexture | null;
  readonly atlasDepthView: GPUTextureView | null;
  private readonly buffers = new Map<VsmBufferKey, GPUBuffer>();
  private destroyed = false;

  private constructor(
    private readonly device: GPUDevice,
    readonly capabilities: VsmCapabilities,
  ) {
    if (nextContentNamespace >= 0xfffffffe) {
      throw new RangeError("VSM content namespace exhausted");
    }
    this.namespace = nextContentNamespace++;
    this.profile = capabilities.profile;
    if (capabilities.profile === "shadow-disabled") {
      this.atlasDepth = null;
      this.atlasDepthView = null;
      return;
    }
    const contentNamespace = this.namespace;
    this.atlasDepth = device.createTexture({
      label: `VSM/${capabilities.profile}/depth-atlas`,
      size: {
        width: capabilities.atlasDimension,
        height: capabilities.atlasDimension,
        depthOrArrayLayers: 1,
      },
      dimension: "2d",
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.atlasDepthView = this.atlasDepth.createView({ dimension: "2d", aspect: "all" });
    this.createBuffer(
      "pageTable",
      capabilities.pageTableBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.createBuffer(
      "metaTable",
      capabilities.metaTableBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.createBuffer(
      "demand",
      capabilities.demandBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.createBuffer(
      "allocation",
      capabilities.allocationBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.createBuffer(
      "casterRecords",
      capabilities.casterRecordBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.createBuffer("generation", 256, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer(
      "overflowCounters",
      256,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.createBuffer(
      "rasterIndirect",
      5 * 4 * 64,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    );
    this.createBuffer(
      "depthRange",
      16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    );
    this.createBuffer("pageConstants", 256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    for (const key of ["requestedPages", "missingPages"] as const) {
      this.createBuffer(
        key,
        capabilities.requestedPagesBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      );
    }
    this.createBuffer(
      "demandScan",
      capabilities.demandScanBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.createBuffer(
      "demandIndirect",
      16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    );
    this.createBuffer(
      "slotCandidates",
      capabilities.slotCandidatesBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.createBuffer("contentVersion", 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, [
      0,
      0,
      0,
      contentNamespace,
    ]);
  }

  static create(device: GPUDevice, capabilities: VsmCapabilities): VsmResources {
    return new VsmResources(device, capabilities);
  }

  get depthRange(): GPUBuffer | null {
    return this.getBuffer("depthRange");
  }

  get pageTable(): GPUBuffer | null {
    return this.getBuffer("pageTable");
  }
  get metaTable(): GPUBuffer | null {
    return this.getBuffer("metaTable");
  }
  get demand(): GPUBuffer | null {
    return this.getBuffer("demand");
  }
  get allocation(): GPUBuffer | null {
    return this.getBuffer("allocation");
  }
  get casterRecords(): GPUBuffer | null {
    return this.getBuffer("casterRecords");
  }
  get generation(): GPUBuffer | null {
    return this.getBuffer("generation");
  }
  get overflowCounters(): GPUBuffer | null {
    return this.getBuffer("overflowCounters");
  }
  get rasterIndirect(): GPUBuffer | null {
    return this.getBuffer("rasterIndirect");
  }
  get pageConstants(): GPUBuffer | null {
    return this.getBuffer("pageConstants");
  }
  get requestedPages(): GPUBuffer | null {
    return this.getBuffer("requestedPages");
  }
  get missingPages(): GPUBuffer | null {
    return this.getBuffer("missingPages");
  }
  get demandScan(): GPUBuffer | null {
    return this.getBuffer("demandScan");
  }
  get demandIndirect(): GPUBuffer | null {
    return this.getBuffer("demandIndirect");
  }
  get slotCandidates(): GPUBuffer | null {
    return this.getBuffer("slotCandidates");
  }
  /** version, frame dirty marker, last generation, immutable owner namespace. */
  get contentVersion(): GPUBuffer | null {
    return this.getBuffer("contentVersion");
  }

  diagnostics(): VsmDiagnostics | null {
    if (this.profile === "shadow-disabled") return null;
    const generation = this.generation;
    const pageDemand = this.demand;
    const allocationFailure = this.overflowCounters;
    const dirtyPages = this.allocation;
    const casterRecords = this.casterRecords;
    if (!generation || !pageDemand || !allocationFailure || !dirtyPages || !casterRecords || !this.atlasDepth)
      return null;
    return Object.freeze({
      generation,
      pageDemand: Object.freeze({ buffer: pageDemand, byteOffset: 0 }),
      // Allocation words: fine/coarse misses, evictions, touches, coarse failures.
      // Caster/raster occupy words 4..5. Query counters are not produced.
      allocationFailure: Object.freeze({ buffer: allocationFailure, byteOffset: 0 }),
      dirtyPages: Object.freeze({
        buffer: dirtyPages,
        byteOffset: 16,
        byteLength: dirtyPages.size - 16,
        countByteOffset: 4,
        stride: 32,
      }),
      casterRecords: Object.freeze({ buffer: casterRecords, byteOffset: 0 }),
      atlasPixels: this.atlasDepth.width * this.atlasDepth.height,
      samplingFallback: null,
      overflowMask: null,
    });
  }

  getBuffer(key: VsmBufferKey): GPUBuffer | null {
    return this.buffers.get(key) ?? null;
  }

  private createBuffer(
    key: VsmBufferKey,
    requestedSize: number,
    usage: GPUBufferUsageFlags,
    initial?: readonly number[],
  ): void {
    const size = Math.max(4, Math.ceil(requestedSize / 4) * 4);
    if (
      !Number.isSafeInteger(size) ||
      size > this.capabilities.limits.maxStorageBufferBindingSize ||
      size > this.capabilities.limits.maxBufferSize
    ) {
      throw new Error(`VSM ${key} buffer exceeds negotiated device limits`);
    }
    this.buffers.set(
      key,
      this.device.createBuffer({
        label: `VSM/${this.capabilities.profile}/${key}`,
        size,
        usage,
        mappedAtCreation: true,
      }),
    );
    const buffer = this.buffers.get(key)!;
    const mapped = buffer.getMappedRange();
    new Uint8Array(mapped).fill(0);
    if (initial !== undefined) {
      new Uint32Array(mapped).set(initial);
    }
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
