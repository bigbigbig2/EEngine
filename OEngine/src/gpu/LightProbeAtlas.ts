/** Persistent sampling atlas for the render world's light-probe volume. */
import {
  estimateTextureBytes,
  type ResourceAccounting,
  type ResourceHandle
} from "../debug/profiling/ResourceAccounting.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  createNativeTexture,
  createNativeTextureView
} from "./GPUTextureDescriptors.js";

export const LIGHT_PROBE_ATLAS_PROBE_RESOLUTION = 64;
export const LIGHT_PROBE_ATLAS_PADDED_RESOLUTION = 66;
export const LIGHT_PROBE_ATLAS_RADIANCE_FORMAT = "r32uint" as const;
export const LIGHT_PROBE_ATLAS_DEPTH_FORMAT = "rg16float" as const;

export class LightProbeAtlasTexture {
  private textureValue: GPUTexture | null = null;
  private resourceHandle: ResourceHandle | null = null;

  constructor(
    private readonly device: GPUDevice,
    readonly label: string,
    readonly format: GPUTextureFormat,
    readonly usage: GPUTextureUsageFlags,
    private widthValue: number,
    private heightValue: number,
    private readonly accounting?: {
      readonly accounting?: ResourceAccounting;
      readonly category: "atlas";
      readonly owner: string;
    }
  ) {}

  get width(): number { return this.widthValue; }
  get height(): number { return this.heightValue; }

  get texture(): GPUTexture {
    this.textureValue ??= this.allocate();
    return this.textureValue;
  }

  createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    return createNativeTextureView(this.texture, descriptor);
  }

  resize(width: number, height: number): void {
    if (width === this.widthValue && height === this.heightValue) return;
    this.widthValue = width;
    this.heightValue = height;
    if (this.textureValue !== null) {
      this.releaseTexture();
      this.textureValue = this.allocate();
    }
  }

  get gpu_memory_usage(): number {
    return estimateTextureBytes({
      format: this.format,
      width: this.widthValue,
      height: this.heightValue
    });
  }

  destroy(): void { this.releaseTexture(); }

  private allocate(): GPUTexture {
    const texture = createNativeTexture(this.device, {
      label: this.label,
      size: [this.widthValue, this.heightValue, 1],
      dimension: "2d",
      format: this.format,
      mipLevelCount: 1,
      sampleCount: 1,
      usage: this.usage
    });
    this.resourceHandle = this.accounting?.accounting?.created({
      kind: "texture",
      category: this.accounting.category,
      owner: this.accounting.owner,
      bytes: this.gpu_memory_usage,
      label: this.label
    }) ?? null;
    return texture;
  }

  private releaseTexture(): void {
    this.textureValue?.destroy();
    this.textureValue = null;
    if (this.resourceHandle !== null) {
      this.accounting?.accounting?.destroyed(this.resourceHandle);
      this.resourceHandle = null;
    }
  }
}

/**
 * Sampling-only atlas owner. The removed object-runtime update path has no
 * fallback in the unified renderer.
 */
export class LightProbeAtlas {
  readonly probe_resolution = LIGHT_PROBE_ATLAS_PROBE_RESOLUTION;
  readonly texture_radiance: LightProbeAtlasTexture;
  readonly texture_depth: LightProbeAtlasTexture;
  private readonly maximumDimension: number;

  constructor(graphics: GraphicsContext) {
    const device = graphics.device;
    this.maximumDimension = device.limits.maxTextureDimension2D;
    const initialHeight = this.padded_probe_resolution;
    const accounting = {
      accounting: graphics.resource_accounting,
      category: "atlas" as const,
      owner: "LightProbeAtlas"
    };
    this.texture_radiance = new LightProbeAtlasTexture(
      device,
      "Light Probe Atlas / radiance",
      LIGHT_PROBE_ATLAS_RADIANCE_FORMAT,
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.STORAGE_BINDING,
      this.maximumDimension,
      initialHeight,
      accounting
    );
    this.texture_depth = new LightProbeAtlasTexture(
      device,
      "Light Probe Atlas / depth",
      LIGHT_PROBE_ATLAS_DEPTH_FORMAT,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      this.maximumDimension,
      initialHeight,
      accounting
    );
  }

  get padded_probe_resolution(): number { return LIGHT_PROBE_ATLAS_PADDED_RESOLUTION; }

  get resolution(): readonly [number, number] {
    const padded = this.padded_probe_resolution;
    return [
      Math.floor(this.texture_radiance.width / padded),
      Math.floor(this.texture_radiance.height / padded)
    ];
  }

  ensure_capacity(probeCount: number): void {
    const width = this.texture_radiance.width;
    const padded = this.padded_probe_resolution;
    const probesPerRow = Math.floor(width / padded);
    const currentCapacity = probesPerRow *
      Math.floor(this.texture_radiance.height / padded);
    if (currentCapacity >= probeCount) return;
    const height = Math.min(
      Math.ceil(probeCount / probesPerRow) * padded,
      this.maximumDimension
    );
    this.texture_radiance.resize(width, height);
    this.texture_depth.resize(width, height);
  }

  get gpu_memory_usage(): number {
    return this.texture_radiance.gpu_memory_usage + this.texture_depth.gpu_memory_usage;
  }

  destroy(): void {
    this.texture_depth.destroy();
    this.texture_radiance.destroy();
  }
}
