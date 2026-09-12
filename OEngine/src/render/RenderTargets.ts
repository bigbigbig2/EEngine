/**
 * 渲染目标集合：集中创建并管理深度、可见性、材质、光照和历史帧纹理。
 */

import { GPUTextureContext } from "../gpu/GPUTextureContext.js";
import { gd, id } from "../gpu/GPUTextureDescriptors.js";
import type { GPUTextureManager } from "../gpu/GPUTextureManager.js";
import { GPU_HDR_FORMAT } from "../gpu/GpuHdrAbi.js";
export const VIS_DEPTH_FORMAT: GPUTextureFormat = "depth32float";

export const HDR_COLOR_FORMAT: GPUTextureFormat = GPU_HDR_FORMAT;

export type RenderTargetImportBundle = {
  depth: GPUTextureContext;
  width: number;
  height: number;
};

export class RenderTargets {
  readonly depthBuffers = new Array(2) as [
    GPUTextureContext,
    GPUTextureContext
  ];

  width = 0;
  height = 0;

  private frameIndex = 0;

  setFrameIndex(frame: number): void {
    this.frameIndex = frame >>> 0;
  }

  get depth(): GPUTextureContext {
    return this.depthCurrent;
  }

  get depthCurrent(): GPUTextureContext {
    return this.depthBuffers[this.frameIndex % 2]!;
  }

  get depthPrevious(): GPUTextureContext {
    return this.depthBuffers[(this.frameIndex - 1 + 2) % 2]!;
  }

  get depthCurrentView(): GPUTextureView {
    return this.depthCurrent.obtainView(depthAttachmentViewDescriptor());
  }

  get depthPreviousView(): GPUTextureView {
    return this.depthPrevious.obtainView(depthAttachmentViewDescriptor());
  }

  initializeDepth(
    textures: GPUTextureManager,
    width: number,
    height: number
  ): void {
    const depthDescriptor = (): id => id.from({
        label: "",
        size: [width, height, 1],
        format: VIS_DEPTH_FORMAT,
        // Hierarchical depth lives in the dedicated rg16float HZB owner. The
        // double-buffered depth32float targets expose and preserve mip 0 only.
        mipLevelCount: 1,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC
      });
    this.depthBuffers[0] = textures.contextFromDescriptor(depthDescriptor());
    this.depthBuffers[1] = textures.contextFromDescriptor(depthDescriptor());
    this.width = width;
    this.height = height;
  }

  resize(width: number, height: number): void {
    this.depthBuffers[0].resize(width, height);
    this.depthBuffers[1].resize(width, height);
    this.width = width;
    this.height = height;
  }

  get depthViewOrThrow(): GPUTextureView {
    return this.depthCurrent.obtainView(depthAttachmentViewDescriptor());
  }

  asImportBundle(): RenderTargetImportBundle {
    return {
      depth: this.depthCurrent,
      width: this.width,
      height: this.height
    };
  }

  destroy(): void {
    this.depthBuffers[0].destroy();
    this.depthBuffers[1].destroy();
    this.width = 0;
    this.height = 0;
  }
}

function depthAttachmentViewDescriptor(): gd {
  return gd.from({
    dimension: "2d",
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1
  });
}
