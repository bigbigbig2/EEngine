/** Fixed GPU layouts shared by the page-table and receiver-demand stages. */
export const VSM_PAGE_ENTRY_WORDS = 12;
export const VSM_META_ENTRY_WORDS = 8;
export const VSM_PAGE_WORK_WORDS = 8;
export const VSM_DEMAND_HEADER_WORDS = 4;
export const VSM_DEMAND_RECORD_WORDS = 4;
export const VSM_SCAN_LANES = 64;
/** Each clip level owns disjoint mip planes, including the coarsest fallback plane. */
export const VSM_MIP_LEVELS = 6;

export const VSM_PAGE_FLAGS = Object.freeze({
  allocated: 1 << 0,
  dirty: 1 << 1,
  inFlight: 1 << 2,
  generationValid: 1 << 3,
} as const);

export interface VsmPageEntry {
  readonly slotX: number;
  readonly slotY: number;
  readonly mip: number;
  readonly flags: number;
  readonly generation: number;
  readonly fallbackMip: number;
  readonly projectionEpoch: number;
  readonly worldX: number;
  readonly worldY: number;
  readonly namespace: number;
  readonly contentVersion: number;
}

export interface VsmMetaEntry {
  readonly virtualPage: number;
  readonly mip: number;
  readonly lastVisited: number;
  readonly flags: number;
  readonly generation: number;
  readonly owner: number;
}

export interface VsmPageWork {
  readonly virtualPage: number;
  readonly slot: number;
  readonly priority: number;
  readonly generation: number;
  readonly flags: number;
  readonly fallbackMip: number;
  readonly worldX: number;
  readonly worldY: number;
}

export interface VsmDemandHeader {
  readonly fineCount: number;
  readonly written: number;
  readonly overflow: number;
  readonly generation: number;
}

export interface VsmDemandRecord {
  readonly virtualPage: number;
  readonly slot: number;
  readonly worldX: number;
  readonly worldY: number;
}

export function vsmEntriesPerClipLevel(pagesPerAxis: number): number {
  if (!Number.isInteger(pagesPerAxis) || pagesPerAxis < 1) {
    throw new RangeError("VSM pages per axis must be positive");
  }
  let count = 0;
  for (let mip = 0; mip < VSM_MIP_LEVELS; mip++) {
    const axis = vsmMipStorageAxis(pagesPerAxis, mip);
    count += axis * axis;
  }
  return count;
}

export function vsmPageTableEntryIndex(
  level: number,
  mip: number,
  pageX: number,
  pageY: number,
  pagesPerAxis: number,
): number {
  const perLevel = vsmEntriesPerClipLevel(pagesPerAxis);
  const axis = vsmMipStorageAxis(pagesPerAxis, mip);
  if (
    !Number.isInteger(level) ||
    level < 0 ||
    !Number.isInteger(mip) ||
    mip < 0 ||
    mip >= VSM_MIP_LEVELS ||
    !Number.isInteger(pageX) ||
    pageX < 0 ||
    pageX >= axis ||
    !Number.isInteger(pageY) ||
    pageY < 0 ||
    pageY >= axis
  ) {
    throw new RangeError("VSM page coordinate is outside the fixed virtual page domain");
  }
  let offset = level * perLevel;
  for (let previous = 0; previous < mip; previous++) {
    const planeAxis = vsmMipStorageAxis(pagesPerAxis, previous);
    offset += planeAxis * planeAxis;
  }
  return offset + pageY * axis + pageX;
}

export function vsmPageTableEntryByteOffset(
  level: number,
  mip: number,
  pageX: number,
  pageY: number,
  pagesPerAxis: number,
): number {
  return vsmPageTableEntryIndex(level, mip, pageX, pageY, pagesPerAxis) * VSM_PAGE_ENTRY_WORDS * 4;
}

export function vsmMetaEntryByteOffset(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0) throw new RangeError("VSM slot must be non-negative");
  return slot * VSM_META_ENTRY_WORDS * 4;
}

export function vsmPageGenerationMatches(
  entry: Pick<VsmPageEntry, "flags" | "generation">,
  generation: number,
): boolean {
  return (
    (entry.flags & VSM_PAGE_FLAGS.allocated) !== 0 &&
    (entry.flags & VSM_PAGE_FLAGS.generationValid) !== 0 &&
    entry.generation === generation
  );
}

/** World coordinates retain their full signed identity; modulo only selects storage. */
export function vsmWorldPageEntryIndex(
  level: number,
  mip: number,
  worldX: number,
  worldY: number,
  pages: number,
): number {
  const axis = vsmMipStorageAxis(pages, mip);
  for (const value of [worldX, worldY]) {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
      throw new RangeError("VSM world page coordinate must be i32");
    }
  }
  const mod = (value: number) => ((value % axis) + axis) % axis;
  return vsmPageTableEntryIndex(level, mip, mod(worldX), mod(worldY), pages);
}

/** Coarse has a larger address ring, while its world texel scale is unchanged.
 * A rolling fine window intersects up to 5x5 coarse pages, which cannot have
 * unique addresses in the old 4x4 ring. */
export function vsmMipStorageAxis(pages: number, mip: number): number {
  const axis = Math.max(1, Math.floor(pages / 2 ** mip));
  return mip === VSM_MIP_LEVELS - 1 ? axis * 2 : axis;
}

export function vsmScanBytes(entries: number): number {
  const words = Math.ceil(entries / 32);
  const groups = Math.ceil(words / VSM_SCAN_LANES);
  return (words + groups * 2 + 1) * 8;
}
