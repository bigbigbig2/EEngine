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
  | "pageConstants";

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
    const dirtyWords = Math.ceil((capabilities.clipLevels * capabilities.virtualPagesPerAxis ** 2) / 32);
    this.createBuffer("dirtyMask", Math.max(256, dirtyWords * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("generation", 256, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("overflowCounters", 256, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.createBuffer("rasterIndirect", 5 * 4 * 64, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.createBuffer("pageConstants", 256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
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

  getBuffer(key: VsmBufferKey): GPUBuffer | null {
    return this.buffers.get(key) ?? null;
  }

  private createBuffer(key: VsmBufferKey, requestedSize: number, usage: GPUBufferUsageFlags): void {
    const size = Math.max(4, Math.ceil(requestedSize / 4) * 4);
    if (!Number.isSafeInteger(size) || size > this.capabilities.limits.maxStorageBufferBindingSize ||
        size > this.capabilities.limits.maxBufferSize) {
      throw new Error(`VSM ${key} buffer exceeds negotiated device limits`);
    }
    this.buffers.set(key, this.device.createBuffer({
      label: `VSM/${this.capabilities.profile}/${key}`,
      size,
      usage
    }));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.atlasDepth?.destroy();
    for (const buffer of this.buffers.values()) buffer.destroy();
    this.buffers.clear();
  }
}
