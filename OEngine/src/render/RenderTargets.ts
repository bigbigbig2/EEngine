/**
 * 渲染目标集合：集中创建并管理深度、可见性、材质、光照和历史帧纹理。
 */

import { GPUTextureContext } from "../gpu/GPUTextureContext.js";
import { gd, id } from "../gpu/GPUTextureDescriptors.js";
import type { GPUTextureManager } from "../gpu/GPUTextureManager.js";
import { GPU_SURFACE_FORMATS } from "../gpu/GpuSurfaceAbi.js";

export const VIS_MESH_ID_FORMAT: GPUTextureFormat = "r32uint";
export const VIS_TRI_ID_FORMAT: GPUTextureFormat = "r32uint";
export const VIS_DEPTH_FORMAT: GPUTextureFormat = GPU_SURFACE_FORMATS.depth;

export const GBUF_PBR_FORMAT: GPUTextureFormat = GPU_SURFACE_FORMATS.pbr;
export const GBUF_NORMAL_FORMAT: GPUTextureFormat = GPU_SURFACE_FORMATS.normal;
export const GBUF_ALBEDO_FORMAT: GPUTextureFormat = GPU_SURFACE_FORMATS.albedoAo;
export const GBUF_EMISSIVE_FORMAT: GPUTextureFormat = GPU_SURFACE_FORMATS.emissive;
export const MATERIAL_DEPTH_FORMAT: GPUTextureFormat = GPU_SURFACE_FORMATS.depth;

export const HDR_COLOR_FORMAT: GPUTextureFormat = GPU_SURFACE_FORMATS.hdrColor;

export type RenderTargetImportBundle = {
  meshId: GPUTextureContext;
  triangleId: GPUTextureContext;
  depth: GPUTextureContext;
  width: number;
  height: number;
};

export class RenderTargets {
  meshId!: GPUTextureContext;
  triangleId!: GPUTextureContext;
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
        mipLevelCount: 5,
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

  initializeVisibility(
    textures: GPUTextureManager,
    width: number,
    height: number
  ): void {
    const colorDescriptor = (format: GPUTextureFormat): id => id.from({
      label: "",
      size: [width, height, 1],
      format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING
    });
    this.triangleId = textures.contextFromDescriptor(
      colorDescriptor(VIS_TRI_ID_FORMAT)
    );
    this.meshId = textures.contextFromDescriptor(
      colorDescriptor(VIS_MESH_ID_FORMAT)
    );
    this.width = width;
    this.height = height;
  }

  resize(width: number, height: number): void {
    this.depthBuffers[0].resize(width, height);
    this.depthBuffers[1].resize(width, height);
    this.triangleId.resize(width, height);
    this.meshId.resize(width, height);
    this.width = width;
    this.height = height;
  }

  get meshIdViewOrThrow(): GPUTextureView {
    return this.meshId.obtainView();
  }

  get triangleIdViewOrThrow(): GPUTextureView {
    return this.triangleId.obtainView();
  }

  get depthViewOrThrow(): GPUTextureView {
    return this.depthCurrent.obtainView(depthAttachmentViewDescriptor());
  }

  asImportBundle(): RenderTargetImportBundle {
    return {
      meshId: this.meshId,
      triangleId: this.triangleId,
      depth: this.depthCurrent,
      width: this.width,
      height: this.height
    };
  }

  destroy(): void {
    this.meshId.destroy();
    this.triangleId.destroy();
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
