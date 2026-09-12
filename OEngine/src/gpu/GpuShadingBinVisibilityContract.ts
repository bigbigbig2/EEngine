import {
  GPU_SHADING_BIN_COUNT,
  GPU_SHADING_BIN_INVALID_ID
} from "./GpuShadingBinAbi.js";
import { GPU_VISIBILITY_KEY_EMPTY } from "./GpuVisibilityKeyAbi.js";

export const GPU_SHADING_BIN_VISIBILITY_FORMAT = "r8uint" as const;
export const GPU_SHADING_BIN_VISIBILITY_SAMPLE_COUNT = 1 as const;
export const GPU_SHADING_BIN_VISIBILITY_CLEAR = GPU_SHADING_BIN_INVALID_ID;
export const GPU_SHADING_BIN_VISIBILITY_USAGE = Object.freeze([
  "render-attachment",
  "texture-binding"
] as const);
export const GPU_SHADING_BIN_VISIBILITY_TARGETS = Object.freeze([
  Object.freeze({ location: 0, semantic: "visibility-key", format: "r32uint" as const }),
  Object.freeze({ location: 1, semantic: "shading-bin-id", format: "r8uint" as const })
]);

export interface GpuShadingBinVisibilityAttachmentContract {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly format: typeof GPU_SHADING_BIN_VISIBILITY_FORMAT;
  readonly sampleCount: typeof GPU_SHADING_BIN_VISIBILITY_SAMPLE_COUNT;
  readonly usage: typeof GPU_SHADING_BIN_VISIBILITY_USAGE;
  readonly clearValue: Readonly<{ r: number; g: 0; b: 0; a: 0 }>;
}

export interface GpuShadingBinRasterFragment {
  readonly x: number;
  readonly y: number;
  readonly reverseDepth: number;
  readonly visibilityKey: number;
  readonly shadingBinId: number;
  readonly discarded: boolean;
}

export interface GpuShadingBinRasterOwnershipResult {
  readonly width: number;
  readonly height: number;
  readonly visibilityKeys: Readonly<Uint32Array>;
  readonly shadingBinIds: Readonly<Uint8Array>;
  readonly reverseDepth: Readonly<Float32Array>;
}

export function gpuShadingBinVisibilityAttachmentContract(
  width: number,
  height: number
): Readonly<GpuShadingBinVisibilityAttachmentContract> {
  assertExtent(width, "width");
  assertExtent(height, "height");
  return Object.freeze({
    label: "ADR-0013 Visibility ShadingBinId r8uint",
    width,
    height,
    format: GPU_SHADING_BIN_VISIBILITY_FORMAT,
    sampleCount: GPU_SHADING_BIN_VISIBILITY_SAMPLE_COUNT,
    usage: GPU_SHADING_BIN_VISIBILITY_USAGE,
    clearValue: Object.freeze({ r: GPU_SHADING_BIN_VISIBILITY_CLEAR, g: 0, b: 0, a: 0 })
  });
}

export function gpuShadingBinVisibilityNativeDescriptor(
  contract: GpuShadingBinVisibilityAttachmentContract,
  usage: Readonly<{ RENDER_ATTACHMENT: number; TEXTURE_BINDING: number }>
): GPUTextureDescriptor {
  return {
    label: contract.label,
    size: { width: contract.width, height: contract.height, depthOrArrayLayers: 1 },
    format: contract.format,
    sampleCount: contract.sampleCount,
    mipLevelCount: 1,
    dimension: "2d",
    usage: usage.RENDER_ATTACHMENT | usage.TEXTURE_BINDING
  };
}

export function gpuShadingBinVisibilityRenderPassAttachments(
  visibilityKey: GPUTextureView,
  shadingBinId: GPUTextureView
): readonly GPURenderPassColorAttachment[] {
  return Object.freeze([
    {
      view: visibilityKey,
      clearValue: { r: GPU_VISIBILITY_KEY_EMPTY, g: 0, b: 0, a: 0 },
      loadOp: "clear",
      storeOp: "store"
    },
    {
      view: shadingBinId,
      clearValue: { r: GPU_SHADING_BIN_INVALID_ID, g: 0, b: 0, a: 0 },
      loadOp: "clear",
      storeOp: "store"
    }
  ]);
}

/**
 * L1 oracle for the dual-MRT ownership rule. Input order is raster order and
 * reverse-Z uses strict `greater`, matching the Visibility pipeline.
 */
export function resolveGpuShadingBinRasterOwnership(
  width: number,
  height: number,
  fragments: readonly GpuShadingBinRasterFragment[]
): Readonly<GpuShadingBinRasterOwnershipResult> {
  assertExtent(width, "width");
  assertExtent(height, "height");
  const pixelCount = checkedMultiply(width, height, "pixel count");
  const visibilityKeys = new Uint32Array(pixelCount);
  visibilityKeys.fill(GPU_VISIBILITY_KEY_EMPTY);
  const shadingBinIds = new Uint8Array(pixelCount);
  shadingBinIds.fill(GPU_SHADING_BIN_INVALID_ID);
  const reverseDepth = new Float32Array(pixelCount);

  for (const fragment of fragments) {
    assertCoordinate(fragment.x, width, "x");
    assertCoordinate(fragment.y, height, "y");
    if (!Number.isFinite(fragment.reverseDepth) ||
        fragment.reverseDepth < 0 || fragment.reverseDepth > 1) {
      throw new RangeError("Visibility fragment reverse depth must be finite and in [0, 1]");
    }
    assertU32(fragment.visibilityKey, "Visibility fragment key");
    if (!Number.isInteger(fragment.shadingBinId) || fragment.shadingBinId < 0 ||
        fragment.shadingBinId >= GPU_SHADING_BIN_COUNT) {
      throw new RangeError("Visibility fragment shading bin must be in [0, 63]");
    }
    if (typeof fragment.discarded !== "boolean") {
      throw new TypeError("Visibility fragment discarded must be boolean");
    }
    if (fragment.discarded) continue;
    const pixel = fragment.y * width + fragment.x;
    if (fragment.reverseDepth <= reverseDepth[pixel]!) continue;
    reverseDepth[pixel] = fragment.reverseDepth;
    visibilityKeys[pixel] = fragment.visibilityKey;
    shadingBinIds[pixel] = fragment.shadingBinId;
  }

  return Object.freeze({ width, height, visibilityKeys, shadingBinIds, reverseDepth });
}

function assertExtent(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new RangeError(`Shading bin visibility ${label} must be a positive u32`);
  }
}

function assertCoordinate(value: number, extent: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= extent) {
    throw new RangeError(`Visibility fragment ${label} is outside the attachment`);
  }
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a u32`);
  }
}

function checkedMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value > 0xffffffff) {
    throw new RangeError(`Shading bin visibility ${label} exceeds u32`);
  }
  return value;
}
