export const VT_TILE_SIZE = 144;
export const VT_ATLAS_TILES = 16;
export const VT_ATLAS_SIZE = VT_TILE_SIZE * VT_ATLAS_TILES;
export const VT_PAGE_CAPACITY = 1_048_576;
export const VT_TABLE_WIDTH = 1024;
export const VT_FEEDBACK_CAPACITY = 65_536;
export const VT_FEEDBACK_HEADER_WORDS = 16;
export const VT_MIP_WORDS = 7;
/** Schema4 logical dimensions reach 65536: log2(65536) + 1. */
export const VT_MAX_MIP_LEVELS = 17;
export const VT_FEEDBACK_MAILBOX_WORDS = 256;
export const VT_MISSING = 0xffffffff;
export const VT_WANTED = 0x40000000;
export const VT_USED = 0x80000000;
export const VT_PAGE_MASK = 0x3fffffff;

export interface VirtualTextureSettings {
  readonly colorBytes: number;
  readonly linearBytes: number;
  readonly scalarBytes: number;
  readonly metadataBytes: number;
  readonly uploadBytes: number;
  readonly copies: number;
}
export function virtualTextureSettings(input: Partial<VirtualTextureSettings> = {}): VirtualTextureSettings {
  const result = {
    colorBytes: 128 * 1024 ** 2,
    linearBytes: 96 * 1024 ** 2,
    scalarBytes: 32 * 1024 ** 2,
    metadataBytes: 32 * 1024 ** 2,
    uploadBytes: 4 * 1024 ** 2,
    copies: 128,
    ...input
  };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`VT ${key} must be a positive integer`);
    }
  }
  if (
    result.colorBytes + result.linearBytes + result.scalarBytes > 256 * 1024 ** 2 ||
    result.metadataBytes > 32 * 1024 ** 2 ||
    result.uploadBytes > 4 * 1024 ** 2 ||
    result.copies > 128
  ) {
    throw new RangeError("VT settings exceed the admitted v1 working set");
  }
  return Object.freeze(result);
}
export function virtualTextureFeedbackLayout(pages: number, capacity = VT_FEEDBACK_CAPACITY) {
  if (
    !Number.isSafeInteger(pages) ||
    pages < 1 ||
    pages > VT_PAGE_CAPACITY ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > VT_FEEDBACK_CAPACITY
  ) {
    throw new RangeError("VT feedback domain exceeds its lossless u30 transport");
  }
  const words = Math.ceil(pages / 32);
  const wanted = VT_FEEDBACK_HEADER_WORDS;
  const used = wanted + words;
  const union = used + words;
  const queue = union + words;
  return Object.freeze({ words, wanted, used, union, queue, capacity, bytes: (queue + capacity) * 4 });
}

export interface VirtualTextureMipRoute {
  readonly width: number;
  readonly height: number;
  readonly gridWidth: number;
  readonly base: number;
  readonly origin: readonly [number, number];
}
export interface VirtualTextureRoute {
  readonly table: GPUTexture;
  readonly tableView: GPUTextureView;
  readonly atlas: GPUTexture;
  readonly atlasView: GPUTextureView;
  readonly tailFirst: number;
  readonly mips: readonly VirtualTextureMipRoute[];
}
