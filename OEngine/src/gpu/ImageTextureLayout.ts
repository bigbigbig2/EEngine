import {
  checkedImageInteger,
  type ImageTextureDirectory
} from "../assets/ImageTextureProduct.js";
import { imageGpuFormat } from "./ImageTextureTranscoder.js";

export interface ImageTextureMipLayout {
  readonly mip: number;
  readonly width: number;
  readonly height: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly blockColumns: number;
  readonly blockRows: number;
  readonly bytes: number;
}

export interface ImageTextureResidentLayout {
  readonly plane: number;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly mipCount: number;
  readonly levels: readonly ImageTextureMipLayout[];
  readonly bytesPerLayer: number;
  /** True only when hardware normalized coordinates agree at every logical mip.
   * Otherwise consumers must use the per-level logical-domain sampling contract. */
  readonly hardwareDomain: boolean;
}

/** GPU allocation facts, not a network product or a legacy metadata projection.
 * Block padding never changes canonical source dimensions. Allocation and encoded
 * full-block copies are checked independently for every physical mip. */
export function imageTextureResidentLayout(
  directory: ImageTextureDirectory,
  planeIndex: number,
  limits: Pick<GPUSupportedLimits, "maxTextureDimension2D">,
  unaligned: boolean
): ImageTextureResidentLayout {
  checkedImageInteger(planeIndex, 0, directory.planes.length - 1);
  const plane = directory.planes[planeIndex]!;
  if (plane.mode !== "resident") {
    throw new Error("Resident texture layout requires a resident image plane");
  }
  const format = imageGpuFormat(plane.semantic);
  const block = plane.target === "r8" ? 1 : 4;
  const bytesPerBlock = plane.target === "r8" ? 1 : plane.target === "bc4-r" ? 8 : 16;
  const width = unaligned ? directory.width : Math.ceil(directory.width / block) * block;
  const height = unaligned ? directory.height : Math.ceil(directory.height / block) * block;
  if (Math.max(width, height) > limits.maxTextureDimension2D) {
    throw new RangeError("Image resident physical extent exceeds negotiated device dimensions");
  }
  const levels: ImageTextureMipLayout[] = [];
  let bytesPerLayer = 0;
  let hardwareDomain = true;
  for (let mip = 0; mip < directory.mipCount; mip++) {
    const logicalWidth = Math.max(1, Math.floor(directory.width / 2 ** mip));
    const logicalHeight = Math.max(1, Math.floor(directory.height / 2 ** mip));
    const physicalWidth = Math.max(1, Math.floor(width / 2 ** mip));
    const physicalHeight = Math.max(1, Math.floor(height / 2 ** mip));
    const blockColumns = Math.ceil(physicalWidth / block);
    const blockRows = Math.ceil(physicalHeight / block);
    if (Math.ceil(logicalWidth / block) > blockColumns || Math.ceil(logicalHeight / block) > blockRows) {
      throw new Error("Image padded mip cannot hold its complete logical source blocks");
    }
    const bytes = blockColumns * blockRows * bytesPerBlock;
    bytesPerLayer += bytes;
    hardwareDomain &&= physicalWidth === logicalWidth && physicalHeight === logicalHeight;
    levels.push(Object.freeze({
      mip, width: logicalWidth, height: logicalHeight, physicalWidth, physicalHeight,
      blockColumns, blockRows, bytes
    }));
  }
  return Object.freeze({
    plane: planeIndex, format, width, height, mipCount: directory.mipCount,
    levels: Object.freeze(levels), bytesPerLayer, hardwareDomain
  });
}
