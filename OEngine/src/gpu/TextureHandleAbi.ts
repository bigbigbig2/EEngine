export const TEXTURE_HANDLE_ABI_VERSION = 1;
export const TEXTURE_HANDLE_INVALID = 0xffffffff;
export const TEXTURE_HANDLE_VERSION_SHIFT = 28;
export const TEXTURE_HANDLE_GENERATION_SHIFT = 16;
export const TEXTURE_HANDLE_SLOT_MASK = 0x0000ffff;
export const TEXTURE_HANDLE_GENERATION_MASK = 0x0fff0000;
export const TEXTURE_HANDLE_MAX_SLOT = TEXTURE_HANDLE_SLOT_MASK;
export const TEXTURE_HANDLE_MAX_GENERATION = 0x0fff;

export interface TextureHandle {
  readonly version: number;
  readonly slot: number;
  readonly generation: number;
}

export function encodeTextureHandle(slot: number, generation: number): number {
  if (!Number.isInteger(slot) || slot <= 0 || slot > TEXTURE_HANDLE_MAX_SLOT) {
    throw new RangeError(`Texture handle slot ${slot} is outside the usable range`);
  }
  if (!Number.isInteger(generation) || generation <= 0 || generation > TEXTURE_HANDLE_MAX_GENERATION) {
    throw new RangeError(`Texture handle generation ${generation} is outside the usable range`);
  }
  return (
    (TEXTURE_HANDLE_ABI_VERSION << TEXTURE_HANDLE_VERSION_SHIFT) |
    (generation << TEXTURE_HANDLE_GENERATION_SHIFT) |
    slot
  ) >>> 0;
}

export function decodeTextureHandle(value: number): TextureHandle | null {
  const handle = value >>> 0;
  if (handle === TEXTURE_HANDLE_INVALID) return null;
  const version = handle >>> TEXTURE_HANDLE_VERSION_SHIFT;
  const generation = (handle & TEXTURE_HANDLE_GENERATION_MASK) >>> TEXTURE_HANDLE_GENERATION_SHIFT;
  const slot = handle & TEXTURE_HANDLE_SLOT_MASK;
  if (version !== TEXTURE_HANDLE_ABI_VERSION || generation === 0 || slot === 0) return null;
  return Object.freeze({ version, slot, generation });
}

export function nextTextureHandleGeneration(generation: number): number {
  const next = (generation + 1) & TEXTURE_HANDLE_MAX_GENERATION;
  return next === 0 ? 1 : next;
}
