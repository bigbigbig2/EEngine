/**
 * RenderTargetViews：渲染目标资源视图解析辅助。
 *
 * 这些 helper 原先内嵌于 MaterialExpandPass，因其是 producer-agnostic 的
 * 视图解析工具，被 ~30 个 pass 复用。现将它们迁到独立模块，使删除
 * MaterialExpandPass 时不丢失通用能力。
 */

import { createNativeTextureView } from "../gpu/GPUTextureDescriptors.js";

export function resolveTextureView(
  resource: unknown,
  descriptor?: GPUTextureViewDescriptor
): GPUTextureView {
  if (!resource || typeof resource !== "object") {
    throw new Error("RenderTargetViews: missing texture resource");
  }
  const value = resource as {
    createView?: (descriptor?: GPUTextureViewDescriptor) => GPUTextureView;
    isGPUTextureContext?: boolean;
  };
  if (typeof value.createView !== "function") return resource as GPUTextureView;
  return value.isGPUTextureContext
    ? value.createView(descriptor)
    : createNativeTextureView(resource as GPUTexture, descriptor);
}

const DEPTH_ATTACHMENT_VIEW_DESCRIPTOR: GPUTextureViewDescriptor = {
  dimension: "2d",
  baseMipLevel: 0,
  mipLevelCount: 1,
  baseArrayLayer: 0,
  arrayLayerCount: 1
};

export function resolveDepthAttachmentView(resource: unknown): GPUTextureView {
  return resolveTextureView(resource, DEPTH_ATTACHMENT_VIEW_DESCRIPTOR);
}
