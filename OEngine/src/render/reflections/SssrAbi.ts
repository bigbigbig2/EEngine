import { encodeFloat16 } from "../../core/Float16.js";

export const SSSR_RECEIVER_BYTES = 32;
export const SSSR_UNIFORM_BYTES = 528;
export const SSSR_RAY_BYTES = 8;
export const SSSR_NOISE_BYTES = 819200;
export const SSSR_SOURCE_REVISION = "c6efa6bf7f2027b3ec94f28578bb5965eabb9e55";

export interface SssrMemorySettings {
  readonly maxBytes?: number;
  readonly ownerMaxBytes?: number;
}

export function resolveSssrMemorySettings(input: SssrMemorySettings = {}): Required<SssrMemorySettings> {
  const maxBytes = input.maxBytes ?? 384 * 1024 * 1024;
  const ownerMaxBytes = input.ownerMaxBytes ?? 768 * 1024 * 1024;
  if (
    ![maxBytes, ownerMaxBytes].every((value) => Number.isSafeInteger(value) && value > 0) ||
    ownerMaxBytes < maxBytes
  ) {
    throw new RangeError("SSSR memory ceilings must be positive safe integers, owner >= active");
  }
  return Object.freeze({ maxBytes, ownerMaxBytes });
}

export interface SssrCapacity {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly tiles: number;
  readonly mipCount: number;
  readonly depthBytes: number;
  readonly receiverBytes: number;
  readonly rayBytes: number;
  /** Includes borrowed receiver allocation and one shared noise allocation. */
  readonly activeBytes: number;
  readonly ownedBytes: number;
}

export function planSssrCapacity(
  width: number,
  height: number,
  limits: Pick<
    GPUSupportedLimits,
    | "maxTextureDimension2D"
    | "maxTextureArrayLayers"
    | "maxBufferSize"
    | "maxStorageBufferBindingSize"
    | "maxUniformBufferBindingSize"
    | "maxComputeWorkgroupsPerDimension"
    | "maxStorageTexturesPerShaderStage"
    | "maxStorageBuffersPerShaderStage"
    | "maxSampledTexturesPerShaderStage"
    | "maxComputeWorkgroupStorageSize"
    | "maxComputeInvocationsPerWorkgroup"
    | "maxComputeWorkgroupSizeX"
    | "maxComputeWorkgroupSizeY"
  >,
  memory: SssrMemorySettings = {},
  debug = false
): SssrCapacity {
  if (
    ![width, height].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= limits.maxTextureDimension2D
    )
  ) {
    throw new RangeError("SSSR viewport exceeds texture capacity");
  }
  const pixels = width * height;
  const tilesX = Math.ceil(width / 8);
  const tilesY = Math.ceil(height / 8);
  const tiles = tilesX * tilesY;
  const rayBytes = pixels * SSSR_RAY_BYTES;
  const receiverBytes = pixels * SSSR_RECEIVER_BYTES;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels > 0xffffffff ||
    receiverBytes > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)
  ) {
    throw new RangeError("SSSR full receiver/ray identity exceeds storage binding capacity");
  }
  const groupLimit = limits.maxComputeWorkgroupsPerDimension;
  if (tilesX > groupLimit || tilesY > groupLimit || Math.ceil(pixels / 64) > groupLimit * groupLimit) {
    throw new RangeError("SSSR dispatch exceeds two-dimensional capacity");
  }
  if (
    limits.maxStorageTexturesPerShaderStage < 4 ||
    limits.maxStorageBuffersPerShaderStage < 6 ||
    limits.maxSampledTexturesPerShaderStage < 11 ||
    limits.maxComputeWorkgroupStorageSize < 10240 ||
    limits.maxComputeInvocationsPerWorkgroup < 64 ||
    limits.maxComputeWorkgroupSizeX < 64 ||
    limits.maxComputeWorkgroupSizeY < 8 ||
    limits.maxUniformBufferBindingSize < SSSR_UNIFORM_BYTES ||
    limits.maxTextureDimension2D < 128 ||
    limits.maxTextureArrayLayers < 2
  ) {
    throw new RangeError(
      "SSSR complete profile requires four storage textures, six buffers and 10 KiB shared memory"
    );
  }
  const mipCount = Math.min(7, Math.floor(Math.log2(Math.max(width, height))) + 1);
  let depthBytes = 0;
  for (let mip = 0; mip < mipCount; mip++) {
    depthBytes += 4 * Math.max(1, width >> mip) * Math.max(1, height >> mip);
  }
  // Normal/depth history20P + radiance32P + statistics16P + shared18P
  // + ray8P + composite8P; receiver32P is borrowed but included in admission.
  const ownedBytes = 102 * pixels + depthBytes + 36 * tiles + SSSR_NOISE_BYTES + 4096;
  const activeBytes = ownedBytes + receiverBytes + (debug ? 4 * pixels : 0);
  if (activeBytes > resolveSssrMemorySettings(memory).maxBytes) {
    throw new RangeError("SSSR active working set exceeds its memory ceiling");
  }
  return Object.freeze({
    width,
    height,
    pixels,
    tilesX,
    tilesY,
    tiles,
    mipCount,
    depthBytes,
    receiverBytes,
    rayBytes,
    activeBytes,
    ownedBytes
  });
}

/** The physical record is four vec4 half blocks. Alpha is canonical across
 * classify/trace/denoise; flags fit exactly in half and never carry an ID. */
export function packSssrReceiver(values: readonly number[], target: Uint32Array, wordOffset = 0): void {
  if (
    values.length !== 16 ||
    !Number.isSafeInteger(wordOffset) ||
    wordOffset < 0 ||
    wordOffset + 8 > target.length
  ) {
    throw new RangeError("SSSR receiver requires sixteen half values and eight words");
  }
  if (!Number.isInteger(values[15]) || values[15]! < 0 || values[15]! > 7) {
    throw new RangeError("SSSR receiver flags must be the exact three-bit mask");
  }
  for (let pair = 0; pair < 8; pair++) {
    const low = encodeFloat16(values[pair * 2]!);
    const high = encodeFloat16(values[pair * 2 + 1]!);
    if ((low & 0x7c00) === 0x7c00 || (high & 0x7c00) === 0x7c00) {
      throw new RangeError("SSSR receiver contains non-finite half values");
    }
  }
  for (let pair = 0; pair < 8; pair++) {
    target[wordOffset + pair] =
      encodeFloat16(values[pair * 2]!) | (encodeFloat16(values[pair * 2 + 1]!) << 16);
  }
}

export const SSSR_RECEIVER_WGSL = /* wgsl */ `
struct SssrReceiver {
  base: vec4f,
  coat: vec4f,
  response: vec4f,
  baseline: vec4f,
}
fn sssr_unpack4(a: u32, b: u32) -> vec4f {
  return vec4f(unpack2x16float(a), unpack2x16float(b));
}
fn sssr_receiver(index: u32) -> SssrReceiver {
  let offset = index * 8u;
  return SssrReceiver(
    sssr_unpack4(receivers[offset], receivers[offset + 1u]),
    sssr_unpack4(receivers[offset + 2u], receivers[offset + 3u]),
    sssr_unpack4(receivers[offset + 4u], receivers[offset + 5u]),
    sssr_unpack4(receivers[offset + 6u], receivers[offset + 7u]));
}
`;
