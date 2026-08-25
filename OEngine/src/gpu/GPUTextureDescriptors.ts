/**
 * GPUTextureDescriptors：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

export type NativeTextureExtent = readonly [number, number, number] &
  Readonly<GPUExtent3DDict>;

class sd {
  #label = "";

  get label(): string {
    return this.#label;
  }

  set label(value: string) {
    this.#label = value;
  }

  protected copyLabel(source: GPUObjectDescriptorBase): void {
    this.label = source.label ?? "";
  }
}

export class id extends sd implements GPUTextureDescriptor {
  #size: NativeTextureExtent = nativeTextureExtent([1, 1, 1]);

  mipLevelCount = 1;
  sampleCount = 1;
  dimension: GPUTextureDimension = "2d";
  format: GPUTextureFormat = "rgba8unorm";
  usage: GPUTextureUsageFlags = GPUTextureUsage.TEXTURE_BINDING;
  viewFormats: GPUTextureFormat[] = [];

  constructor(descriptor?: GPUTextureDescriptor) {
    super();
    if (descriptor !== undefined) this.fromJSON(descriptor);
  }

  set size(value: GPUExtent3D) {
    this.#size = nativeTextureExtent(value);
  }

  get size(): NativeTextureExtent {
    return this.#size;
  }

  get bits_per_sample(): number {
    return formatBitsPerSample(this.format);
  }

  get memory_footprint(): number {
    const size = this.#size;
    let texels = size[0] * size[1] * size[2];
    for (let mip = 0; mip < this.mipLevelCount; mip++) {
      texels =
        Math.max(size[0] >> mip, 1) *
        Math.max(size[1] >> mip, 1) *
        Math.max(size[2] >> mip, 1);
    }
    return texels * this.bits_per_sample * this.sampleCount;
  }

  get isTextureDescriptor(): true {
    return true;
  }

  copy(source: id): this {
    this.copyLabel(source);
    this.size = source.size;
    this.mipLevelCount = source.mipLevelCount;
    this.sampleCount = source.sampleCount;
    this.dimension = source.dimension;
    this.format = source.format;
    this.usage = source.usage;
    this.viewFormats = source.viewFormats.slice();
    return this;
  }

  fromTexture(texture: GPUTexture): this {
    this.format = texture.format;
    this.usage = texture.usage;
    this.sampleCount = texture.sampleCount;
    this.mipLevelCount = texture.mipLevelCount;
    this.dimension = texture.dimension;
    this.label = texture.label;
    this.size = [texture.width, texture.height, texture.depthOrArrayLayers];
    return this;
  }

  fromJSON(descriptor: GPUTextureDescriptor): this {
    this.copyLabel(descriptor);
    this.size = descriptor.size;
    this.mipLevelCount = descriptor.mipLevelCount ?? 1;
    this.sampleCount = descriptor.sampleCount ?? 1;
    this.dimension = descriptor.dimension ?? "2d";
    this.format = descriptor.format;
    this.usage = descriptor.usage;
    this.viewFormats = Array.from(descriptor.viewFormats ?? []);
    return this;
  }

  static from(descriptor: GPUTextureDescriptor): id {
    return new id(descriptor);
  }
}

export class gd extends sd implements GPUTextureViewDescriptor {
  format: GPUTextureFormat | undefined;
  dimension: GPUTextureViewDimension | undefined;
  aspect: GPUTextureAspect = "all";
  baseMipLevel = 0;
  mipLevelCount: number | undefined;
  baseArrayLayer = 0;
  arrayLayerCount: number | undefined;

  constructor(descriptor?: GPUTextureViewDescriptor) {
    super();
    if (descriptor !== undefined) this.fromJSON(descriptor);
  }

  get isTextureViewDescriptor(): true {
    return true;
  }

  fromJSON(descriptor: GPUTextureViewDescriptor): this {
    this.copyLabel(descriptor);
    this.format = descriptor.format;
    this.dimension = descriptor.dimension;
    this.aspect = descriptor.aspect ?? "all";
    this.baseMipLevel = descriptor.baseMipLevel ?? 0;
    this.mipLevelCount = descriptor.mipLevelCount;
    this.baseArrayLayer = descriptor.baseArrayLayer ?? 0;
    this.arrayLayerCount = descriptor.arrayLayerCount;
    return this;
  }

  static from(descriptor: GPUTextureViewDescriptor): gd {
    return new gd(descriptor);
  }
}

const defaultTextureViewDescriptor = gd.from({ label: "" });
Object.freeze(defaultTextureViewDescriptor);
export const DEFAULT_TEXTURE_VIEW_DESCRIPTOR: gd = defaultTextureViewDescriptor;

export function nativeTextureDescriptor(
  descriptor: GPUTextureDescriptor | id
): id {
  return descriptor instanceof id ? descriptor : id.from(descriptor);
}

export function nativeTextureViewDescriptor(
  descriptor?: GPUTextureViewDescriptor | gd
): gd {
  if (descriptor === undefined) return DEFAULT_TEXTURE_VIEW_DESCRIPTOR;
  return descriptor instanceof gd ? descriptor : gd.from(descriptor);
}

export function createNativeTexture(
  device: GPUDevice,
  descriptor: GPUTextureDescriptor | id
): GPUTexture {
  return device.createTexture(nativeTextureDescriptor(descriptor));
}

export function createNativeTextureView(
  texture: GPUTexture,
  descriptor?: GPUTextureViewDescriptor | gd
): GPUTextureView {
  return texture.createView(nativeTextureViewDescriptor(descriptor));
}

function nativeTextureExtent(extent: GPUExtent3D): NativeTextureExtent {
  let width: number;
  let height: number;
  let depthOrArrayLayers: number;
  if (Symbol.iterator in Object(extent)) {
    const values = Array.from(extent as Iterable<number>);
    width = values[0] ?? 1;
    height = values[1] ?? 1;
    depthOrArrayLayers = values[2] ?? 1;
  } else {
    const dictionary = extent as GPUExtent3DDict;
    width = dictionary.width;
    height = dictionary.height ?? 1;
    depthOrArrayLayers = dictionary.depthOrArrayLayers ?? 1;
  }
  const result = [width, height, depthOrArrayLayers] as number[] &
    GPUExtent3DDict;
  result.width = width;
  result.height = height;
  result.depthOrArrayLayers = depthOrArrayLayers;
  return Object.freeze(result) as unknown as NativeTextureExtent;
}

function formatBitsPerSample(format: GPUTextureFormat): number {
  switch (format) {
    case "r8unorm":
    case "r8snorm":
    case "r8uint":
    case "r8sint":
      return 8;
    case "r16uint":
    case "r16sint":
    case "r16float":
    case "rg8unorm":
    case "rg8snorm":
    case "rg8uint":
    case "rg8sint":
      return 16;
    case "r32uint":
    case "r32sint":
    case "r32float":
    case "rg16uint":
    case "rg16sint":
    case "rg16float":
    case "rgba8unorm":
    case "rgba8unorm-srgb":
    case "rgba8snorm":
    case "rgba8uint":
    case "rgba8sint":
    case "bgra8unorm":
    case "bgra8unorm-srgb":
    case "rgb9e5ufloat":
    case "rgb10a2unorm":
    case "rg11b10ufloat":
    case "depth24plus":
    case "depth32float":
      return 32;
    case "rg32uint":
    case "rg32sint":
    case "rg32float":
    case "rgba16uint":
    case "rgba16sint":
    case "rgba16float":
      return 64;
    case "rgba32uint":
    case "rgba32sint":
    case "rgba32float":
      return 128;
    default:
      return 0;
  }
}
