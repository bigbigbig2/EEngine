/**
 * GPUTextureContext：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import {
  createNativeTexture,
  createNativeTextureView,
  DEFAULT_TEXTURE_VIEW_DESCRIPTOR,
  gd,
  id,
  nativeTextureDescriptor,
  nativeTextureViewDescriptor,
  type NativeTextureExtent
} from "./GPUTextureDescriptors.js";
import { submitGpuCommands } from "./GpuQueueEvidence.js";

let nextTextureContextId = 0;

export class GPUTextureContext {
  readonly id = nextTextureContextId++;
  readonly isGPUTextureContext = true;

  private textureValue: GPUTexture | null = null;
  private state: 0 | 1 | 2 = 0;
  private versionValue = 0;
  private readonly views = new Map<string, GPUTextureView>();

  constructor(
    private readonly device: GPUDevice,
    descriptor?: GPUTextureDescriptor
  ) {
    this.descriptor = descriptor === undefined
      ? new id()
      : nativeTextureDescriptor(descriptor);
  }

  descriptor: id;

  get size(): NativeTextureExtent {
    return this.descriptor.size;
  }

  get width(): number {
    return this.size[0];
  }

  get height(): number {
    return this.size[1];
  }

  get depth(): number {
    return this.size[2];
  }

  get depthOrArrayLayers(): number {
    return this.size[2];
  }

  get format(): GPUTextureFormat {
    return this.descriptor.format;
  }

  get usage(): GPUTextureUsageFlags {
    return this.descriptor.usage;
  }

  get dimension(): GPUTextureDimension {
    return this.descriptor.dimension ?? "2d";
  }

  get mipLevelCount(): number {
    return this.descriptor.mipLevelCount ?? 1;
  }

  get sampleCount(): number {
    return this.descriptor.sampleCount ?? 1;
  }

  get label(): string {
    return this.descriptor.label ?? "";
  }

  get version(): number {
    return this.versionValue;
  }

  set version(value: number) {
    if (value < this.versionValue) {
      throw new Error(
        `Texture version cannot decrease. Current: ${this.versionValue}, new: ${value}`
      );
    }
    this.versionValue = value;
  }

  incrementVersion(): void {
    this.versionValue++;
  }

  get gpu_texture(): GPUTexture {
    if (this.state === 0) this.allocate();
    if (this.textureValue === null) {
      throw new Error("GPUTextureContext: texture is unavailable");
    }
    return this.textureValue;
  }

  get gpu_memory_usage(): number {
    return this.descriptor.memory_footprint;
  }

  obtainView(
    descriptor: GPUTextureViewDescriptor | gd = DEFAULT_TEXTURE_VIEW_DESCRIPTOR
  ): GPUTextureView {
    const nativeDescriptor = nativeTextureViewDescriptor(descriptor);
    const key = viewDescriptorKey(nativeDescriptor);
    let view = this.views.get(key);
    if (view === undefined) {
      view = createNativeTextureView(this.gpu_texture, nativeDescriptor);
      this.views.set(key, view);
    }
    return view;
  }

  createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    return this.obtainView(descriptor);
  }

  allocate(preserveData = false): void {
    let preserve = preserveData && this.state === 1;
    const previous = this.textureValue;
    if (preserve && previous !== null) {
      if ((previous.usage & GPUTextureUsage.COPY_SRC) === 0) {
        throw new Error(
          "preserve_data flag is on, but usage does not include COPY_SRC. Can't copy"
        );
      }
      if ((this.descriptor.usage & GPUTextureUsage.COPY_DST) === 0) {
        throw new Error(
          "preserve_data flag is on, but usage does not include COPY_DST. Can't copy"
        );
      }
    } else {
      preserve = false;
      this.destroy();
    }

    const next = createNativeTexture(this.device, this.descriptor);
    if (preserve && previous !== null) {
      const encoder = this.device.createCommandEncoder({ label: "" });
      encoder.copyTextureToTexture(
        { texture: previous, origin: [0, 0, 0], mipLevel: 0 },
        { texture: next, origin: [0, 0, 0], mipLevel: 0 },
        [
          Math.min(previous.width, next.width),
          Math.min(previous.height, next.height),
          Math.min(previous.depthOrArrayLayers, next.depthOrArrayLayers)
        ]
      );
      submitGpuCommands(this.device, "GPUTextureContext/resize-copy", [
        encoder.finish()
      ]);
      previous.destroy();
    }
    this.textureValue = next;
    this.state = 1;
    this.views.clear();
  }

  isAllocated(): boolean {
    return this.state === 1;
  }

  get isDestroyed(): boolean {
    return this.state === 2;
  }

  destroy(): void {
    this.textureValue?.destroy();
    this.textureValue = null;
    this.views.clear();
    this.state = 2;
  }

  resize(width: number, height = 1, depth = 1, preserveData = false): void {
    const [oldWidth, oldHeight, oldDepth] = this.size;
    if (oldWidth === width && oldHeight === height && oldDepth === depth) return;
    this.descriptor.size = [width, height, depth];
    if (
      this.state === 1 &&
      (this.textureValue?.width !== width ||
        this.textureValue.height !== height ||
        this.textureValue.depthOrArrayLayers !== depth)
    ) {
      this.allocate(preserveData);
    }
  }
}

export function textureMipLevelCount(width: number, height: number): number {
  const maximum = Math.max(width, height);
  return maximum === 0 ? 0 : Math.floor(Math.log2(maximum)) + 1;
}

function viewDescriptorKey(descriptor: GPUTextureViewDescriptor): string {
  return JSON.stringify({
    label: descriptor.label ?? "",
    format: descriptor.format ?? "",
    dimension: descriptor.dimension ?? "",
    aspect: descriptor.aspect ?? "all",
    baseMipLevel: descriptor.baseMipLevel ?? 0,
    mipLevelCount: descriptor.mipLevelCount ?? -1,
    baseArrayLayer: descriptor.baseArrayLayer ?? 0,
    arrayLayerCount: descriptor.arrayLayerCount ?? -1
  });
}
