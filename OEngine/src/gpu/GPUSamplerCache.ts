/**
 * GPUSamplerCache：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

class Hd implements GPUSamplerDescriptor {
  addressModeU: GPUAddressMode = "clamp-to-edge";
  addressModeV: GPUAddressMode = "clamp-to-edge";
  addressModeW: GPUAddressMode = "clamp-to-edge";
  magFilter: GPUFilterMode = "nearest";
  minFilter: GPUFilterMode = "nearest";
  mipmapFilter: GPUMipmapFilterMode = "nearest";
  lodMinClamp = 0;
  lodMaxClamp = 32;
  maxAnisotropy = 1;
  compare: GPUCompareFunction | undefined;
  readonly #label: string;

  private constructor(descriptor: GPUSamplerDescriptor) {
    this.#label = descriptor.label ?? "";
    this.addressModeU = descriptor.addressModeU ?? "clamp-to-edge";
    this.addressModeV = descriptor.addressModeV ?? "clamp-to-edge";
    this.addressModeW = descriptor.addressModeW ?? "clamp-to-edge";
    this.magFilter = descriptor.magFilter ?? "nearest";
    this.minFilter = descriptor.minFilter ?? "nearest";
    this.mipmapFilter = descriptor.mipmapFilter ?? "nearest";
    this.lodMinClamp = descriptor.lodMinClamp ?? 0;
    this.lodMaxClamp = descriptor.lodMaxClamp ?? 32;
    this.maxAnisotropy = descriptor.maxAnisotropy ?? 1;
    this.compare = descriptor.compare;
  }

  get label(): string {
    return this.#label;
  }

  static from(descriptor: GPUSamplerDescriptor): Hd {
    return new Hd(descriptor);
  }
}

Object.defineProperty(Hd.prototype, "isSamplerDescriptor", {
  value: true,
  writable: true,
  enumerable: true,
  configurable: true
});

export const LINEAR_CLAMP_SAMPLER_DESCRIPTOR: GPUSamplerDescriptor =
  Object.freeze(Hd.from({ magFilter: "linear" }));

export const SHADOW_COMPARISON_SAMPLER_DESCRIPTOR: GPUSamplerDescriptor =
  Object.freeze(
    Hd.from({
      compare: "greater",
      minFilter: "linear",
      magFilter: "linear"
    })
  );

export const DEFAULT_MATERIAL_SAMPLER_DESCRIPTOR: GPUSamplerDescriptor =
  Object.freeze(Hd.from({}));

export class GPUSamplerCache {
  private readonly cache = new Map<string, GPUSampler>();

  constructor(private readonly device: GPUDevice) {}

  obtain(descriptor: GPUSamplerDescriptor): GPUSampler {
    const key = samplerKey(descriptor);
    let sampler = this.cache.get(key);
    if (sampler === undefined) {
      sampler = this.device.createSampler(descriptor);
      this.cache.set(key, sampler);
    }
    return sampler;
  }
}

function samplerKey(descriptor: GPUSamplerDescriptor): string {
  return JSON.stringify({
    label: descriptor.label ?? "",
    addressModeU: descriptor.addressModeU ?? "clamp-to-edge",
    addressModeV: descriptor.addressModeV ?? "clamp-to-edge",
    addressModeW: descriptor.addressModeW ?? "clamp-to-edge",
    magFilter: descriptor.magFilter ?? "nearest",
    minFilter: descriptor.minFilter ?? "nearest",
    mipmapFilter: descriptor.mipmapFilter ?? "nearest",
    lodMinClamp: descriptor.lodMinClamp ?? 0,
    lodMaxClamp: descriptor.lodMaxClamp ?? 32,
    compare: descriptor.compare ?? "",
    maxAnisotropy: descriptor.maxAnisotropy ?? 1
  });
}
