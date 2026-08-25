/**
 * GPUTextureManager：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { ShadeTextureFlags } from "../texture/ShadeTextureFlags.js";
import { GPUTextureContext } from "./GPUTextureContext.js";
import { id, nativeTextureDescriptor } from "./GPUTextureDescriptors.js";
import {
  requireShadeImage,
  shadeTextureDescriptor,
  uploadShadeImage
} from "./GPUTextureUpload.js";
import { MipmapGenerator } from "./MipmapGenerator.js";
import type { GraphicsContext } from "./GraphicsContext.js";

export class GPUTextureManager {
  private readonly byShadeTexture = new Map<ShadeTexture, GPUTextureContext>();
  private readonly shared = new Map<string, GPUTextureContext>();
  readonly mipmaps: MipmapGenerator;

  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    this.mipmaps = new MipmapGenerator(graphics);
  }

  obtain(texture: ShadeTexture): GPUTextureContext {
    let context = this.byShadeTexture.get(texture);
    if (context === undefined) {
      context = this.contextFromShadeTexture(texture);
      this.byShadeTexture.set(texture, context);
    }
    return context;
  }

  contextFromShadeTexture(texture: ShadeTexture): GPUTextureContext {
    const image = requireShadeImage(texture);
    const descriptor = shadeTextureDescriptor(texture);
    const key = sharedTextureKey(image.id, descriptor);
    const existing = this.shared.get(key);
    if (existing !== undefined) return existing;

    const context = this.contextFromDescriptor(descriptor);
    uploadShadeImage(image, context.gpu_texture, this.device.queue);
    if ((texture.flags & ShadeTextureFlags.GenerateMipMaps) !== 0) {
      this.mipmaps.schedule(
        context.gpu_texture,
        descriptor,
        texture.mipmapGenerationFilter
      );
    }
    this.shared.set(key, context);
    return context;
  }

  contextFromDescriptor(descriptor: GPUTextureDescriptor | id): GPUTextureContext {
    return new GPUTextureContext(this.device, nativeTextureDescriptor(descriptor));
  }

  update(): void {
    this.mipmaps.update(1);
  }

  get pending_mipmap_count(): number {
    return this.mipmaps.pending_count;
  }

  get gpu_memory_usage(): number {
    let usage = 0;
    for (const context of this.shared.values()) {
      usage += context.gpu_memory_usage;
    }
    return usage;
  }
}

function sharedTextureKey(
  sourceId: number,
  descriptor: GPUTextureDescriptor
): string {
  const size = Array.from(descriptor.size as Iterable<number>);
  return JSON.stringify({
    sourceId,
    label: descriptor.label ?? "",
    size,
    format: descriptor.format,
    usage: descriptor.usage,
    mipLevelCount: descriptor.mipLevelCount ?? 1,
    sampleCount: descriptor.sampleCount ?? 1,
    dimension: descriptor.dimension ?? "2d",
    viewFormats: descriptor.viewFormats ?? []
  });
}
