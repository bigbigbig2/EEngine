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
  readonly depthBuffers: [GPUTextureContext | null, GPUTextureContext | null] = [
    null,
    null
  ];

  width = 0;
  height = 0;

  private frameIndex = 0;
  private depthHistoryEnabled = false;

  setFrameIndex(frame: number): void {
    this.frameIndex = frame >>> 0;
  }

  get depth(): GPUTextureContext {
    return this.depthCurrent;
  }

  get depthCurrent(): GPUTextureContext {
    const index = this.depthHistoryEnabled ? this.frameIndex % 2 : 0;
    return this.requireDepthBuffer(index, "current");
  }

  get depthPrevious(): GPUTextureContext {
    if (!this.depthHistoryEnabled) return this.depthCurrent;
    return this.requireDepthBuffer((this.frameIndex - 1 + 2) % 2, "previous");
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
    this.width = width;
    this.height = height;
    this.depthBuffers[0] = this.createDepthBuffer(textures);
    this.depthBuffers[1] = null;
    this.depthHistoryEnabled = false;
  }

  /**
   * Reconciles the second depth32float target with the real previous-depth
   * consumer set. Slot placement follows the submitted-frame index parity, so
   * an aborted frame retries the same current/previous mapping.
   */
  setDepthHistoryEnabled(
    textures: GPUTextureManager,
    enabled: boolean
  ): GPUTextureContext | null {
    if (enabled === this.depthHistoryEnabled) return null;
    const currentIndex = this.frameIndex % 2;
    const previousIndex = (this.frameIndex - 1 + 2) % 2;
    if (enabled) {
      const lastSubmittedDepth = this.requireDepthBuffer(0, "single");
      this.depthBuffers[previousIndex] = lastSubmittedDepth;
      this.depthBuffers[currentIndex] = this.createDepthBuffer(textures);
      this.depthHistoryEnabled = true;
      return null;
    }

    const nextCurrent = this.requireDepthBuffer(currentIndex, "current");
    const retiredPrevious = this.requireDepthBuffer(previousIndex, "previous");
    this.depthBuffers[0] = nextCurrent;
    this.depthBuffers[1] = null;
    this.depthHistoryEnabled = false;
    return retiredPrevious;
  }

  resize(width: number, height: number): void {
    this.depthBuffers[0]?.resize(width, height);
    this.depthBuffers[1]?.resize(width, height);
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

  get depthTextureCount(): 1 | 2 {
    return this.depthHistoryEnabled ? 2 : 1;
  }

  get previousDepthBytes(): number {
    if (!this.depthHistoryEnabled) return 0;
    return this.depthPrevious.gpu_memory_usage;
  }

  destroy(): void {
    this.depthBuffers[0]?.destroy();
    this.depthBuffers[1]?.destroy();
    this.depthBuffers[0] = null;
    this.depthBuffers[1] = null;
    this.depthHistoryEnabled = false;
    this.width = 0;
    this.height = 0;
  }

  private createDepthBuffer(textures: GPUTextureManager): GPUTextureContext {
    return textures.contextFromDescriptor(id.from({
      label: "",
      size: [this.width, this.height, 1],
      format: VIS_DEPTH_FORMAT,
      // Hierarchical depth lives in the dedicated rg16float HZB owner. The
      // double-buffered depth32float targets expose and preserve mip 0 only.
      mipLevelCount: 1,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC
    }));
  }

  private requireDepthBuffer(index: number, role: string): GPUTextureContext {
    const depth = this.depthBuffers[index];
    if (depth === null || depth === undefined) {
      throw new Error(`RenderTargets: missing ${role} depth buffer`);
    }
    return depth;
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
