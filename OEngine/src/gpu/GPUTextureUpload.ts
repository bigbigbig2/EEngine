/**
 * GPUTextureUpload：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { ShadeDataType } from "../texture/ShadeDataType.js";
import type { ShadeImage } from "../texture/ShadeImage.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { ShadeTextureFlags } from "../texture/ShadeTextureFlags.js";
import { textureMipLevelCount } from "./GPUTextureContext.js";
import { id } from "./GPUTextureDescriptors.js";
import {
  recordGpuQueueUpload,
  writeGpuTexture
} from "./GpuQueueEvidence.js";

export type ShadeGpuImage = Pick<
  ShadeImage,
  | "id"
  | "width"
  | "height"
  | "depth"
  | "channel_count"
  | "data_type"
  | "normalized"
  | "color_space"
  | "source"
>;

export function shadeTextureDescriptor(
  texture: ShadeTexture
): id {
  const image = requireShadeImage(texture);
  let usage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.COPY_SRC;
  let mipLevelCount = 1;
  if ((texture.flags & ShadeTextureFlags.GenerateMipMaps) !== 0) {
    usage |= GPUTextureUsage.RENDER_ATTACHMENT;
    mipLevelCount = textureMipLevelCount(image.width, image.height);
  }
  let dimension: GPUTextureDimension = "1d";
  if (texture.dimensions === 2) dimension = "2d";
  else if (texture.dimensions === 3) dimension = "3d";
  return id.from({
    label: texture.label,
    size: [image.width, image.height, image.depth],
    format: shadeImageTextureFormat(image),
    usage,
    mipLevelCount,
    dimension
  });
}

export function shadeImageTextureFormat(image: ShadeGpuImage): GPUTextureFormat {
  if (isImageBitmapSource(image.source)) {
    if (image.data_type === ShadeDataType.Float16) return "rgba16float";
    return image.color_space === 1 ? "rgba8unorm-srgb" : "rgba8unorm";
  }
  if (
    !isSampler2DSource(image.source) &&
    !(image.source instanceof ArrayBuffer)
  ) {
    throw new Error("Unsupported image data");
  }
  const supportedChannels = [1, 2, 4];
  let channels = image.channel_count;
  if (!supportedChannels.includes(channels)) {
    for (let index = 0; index < supportedChannels.length; index++) {
      const candidate = supportedChannels[index]!;
      if (channels < candidate) {
        channels = candidate;
        break;
      }
    }
  }
  const prefix = "rgba".slice(0, channels);
  const bits = dataTypeBytes(image.data_type) * 8;
  let suffix: string;
  if (image.color_space === 2) {
    if (image.data_type === ShadeDataType.Uint8) suffix = "unorm";
    else if (image.data_type === ShadeDataType.Float32) suffix = "float";
    else throw new Error(`Unsupported data type '${image.data_type}'`);
  } else if (image.color_space === 0) {
    if (
      image.data_type === ShadeDataType.Uint8 ||
      image.data_type === ShadeDataType.Uint16 ||
      image.data_type === ShadeDataType.Uint32
    ) {
      suffix = image.normalized ? "unorm" : "uint";
    } else if (
      image.data_type === ShadeDataType.Float32 ||
      image.data_type === ShadeDataType.Float16
    ) {
      suffix = "float";
    } else {
      throw new Error(`Unsupported data type '${image.data_type}'`);
    }
  } else if (image.color_space === 1) {
    if (image.data_type !== ShadeDataType.Uint8) {
      throw new Error(`Unsupported data type '${image.data_type}'`);
    }
    suffix = "unorm-srgb";
  } else {
    throw new Error(`Unsupported color space '${image.color_space}'`);
  }
  return `${prefix}${bits}${suffix}` as GPUTextureFormat;
}

export function uploadShadeImage(
  image: ShadeGpuImage,
  texture: GPUTexture,
  queue: GPUQueue
): void {
  const source = image.source;
  if (source === null || source === undefined) {
    throw new Error("source is undefined or null");
  }
  const size: GPUExtent3DStrict = [
    texture.width,
    texture.height,
    texture.depthOrArrayLayers
  ];
  const premultipliedAlpha = image.color_space !== 0;
  if (isSampler2DSource(source)) {
    const data = source.data;
    if (!ArrayBuffer.isView(data)) {
      throw new Error("Sampler2D source data must be a TypedArray");
    }
    if (!(data.buffer instanceof ArrayBuffer)) {
      throw new Error("Sampler2D SharedArrayBuffer data is unsupported");
    }
    uploadRawShadeImage(
      image,
      data.buffer,
      queue,
      texture,
      premultipliedAlpha
    );
  } else if (source instanceof ArrayBuffer) {
    uploadRawShadeImage(
      image,
      source,
      queue,
      texture,
      premultipliedAlpha
    );
  } else if (isImageBitmapSource(source)) {
    recordGpuQueueUpload(
      queue,
      "GPUTextureUpload/external-image",
      image.width * image.height * image.depth * image.channel_count *
        dataTypeBytes(image.data_type)
    );
    queue.copyExternalImageToTexture(
      { source },
      { texture, premultipliedAlpha },
      size
    );
  } else {
    throw new Error("Unsupported image data");
  }
}

export function requireShadeImage(texture: ShadeTexture): ShadeGpuImage {
  const image = texture.image as ShadeGpuImage | undefined;
  if (image === undefined) {
    throw new Error("ShadeTexture image is undefined");
  }
  return image;
}

function uploadRawShadeImage(
  image: ShadeGpuImage,
  source: ArrayBuffer,
  queue: GPUQueue,
  texture: GPUTexture,
  premultipliedAlpha: boolean
): void {
  const bytesPerComponent = dataTypeBytes(image.data_type);
  let bytesPerRow = image.channel_count * bytesPerComponent * image.width;
  let upload = source;
  if (image.channel_count === 3) {
    if (textureFormatChannelCount(texture.format) !== 4) {
      throw new Error(
        `Unsupported texture format '${texture.format}', expected 4 channels`
      );
    }
    const pixelCount = image.width * image.height * image.depth;
    upload = new ArrayBuffer(4 * bytesPerComponent * pixelCount);
    const input = new Uint8Array(source);
    const output = new Uint8Array(upload);
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      output.set(
        input.subarray(
          pixel * bytesPerComponent * 3,
          (pixel + 1) * bytesPerComponent * 3
        ),
        pixel * bytesPerComponent * 4
      );
    }
    bytesPerRow = bytesPerComponent * image.width * 4;
  }
  const layout: GPUImageDataLayout = {
    offset: 0,
    bytesPerRow
  };
  if (image.depth > 1) layout.rowsPerImage = image.height;
  writeGpuTexture(
    queue,
    "GPUTextureUpload/raw",
    { texture, premultipliedAlpha } as GPUImageCopyTexture & {
      premultipliedAlpha?: boolean;
    },
    upload,
    layout,
    [image.width, image.height, image.depth]
  );
}

function dataTypeBytes(dataType: string): number {
  switch (dataType) {
    case ShadeDataType.Uint8:
    case ShadeDataType.Int8:
      return 1;
    case ShadeDataType.Uint16:
    case ShadeDataType.Int16:
    case ShadeDataType.Float16:
      return 2;
    case ShadeDataType.Uint32:
    case ShadeDataType.Int32:
    case ShadeDataType.Float32:
      return 4;
    case ShadeDataType.Uint64:
    case ShadeDataType.Int64:
    case ShadeDataType.Float64:
      return 8;
    default:
      throw new Error(`Unsupported data type '${dataType}'`);
  }
}

function textureFormatChannelCount(format: GPUTextureFormat): number {
  if (format.startsWith("rgba") || format.startsWith("bgra")) return 4;
  if (format.startsWith("rg")) return 2;
  return 1;
}

function isSampler2DSource(
  source: unknown
): source is { isSampler2D: true; data: ArrayBufferView } {
  return (
    typeof source === "object" &&
    source !== null &&
    "isSampler2D" in source &&
    (source as { isSampler2D?: boolean }).isSampler2D === true &&
    "data" in source
  );
}

function isImageBitmapSource(source: unknown): source is ImageBitmap {
  return typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap;
}
