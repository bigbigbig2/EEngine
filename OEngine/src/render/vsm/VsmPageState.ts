/** Fixed GPU layouts shared by the page-table and receiver-demand stages. */
export const VSM_PAGE_ENTRY_WORDS = 8;
export const VSM_META_ENTRY_WORDS = 8;
export const VSM_PAGE_WORK_WORDS = 8;
export const VSM_DEMAND_HEADER_WORDS = 4;
export const VSM_DEMAND_RECORD_WORDS = 8;

export const VSM_PAGE_FLAGS = Object.freeze({
  allocated: 1 << 0,
  dirty: 1 << 1,
  inFlight: 1 << 2,
  generationValid: 1 << 3
} as const);

export interface VsmPageEntry {
  readonly slotX: number;
  readonly slotY: number;
  readonly mip: number;
  readonly flags: number;
  readonly generation: number;
  readonly fallbackMip: number;
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
}

export interface VsmDemandHeader {
  readonly attempted: number;
  readonly written: number;
  readonly overflow: number;
  readonly generation: number;
}

export interface VsmDemandRecord {
  readonly virtualPage: number;
  readonly mip: number;
  readonly priority: number;
  readonly flags: number;
  readonly receiverMinX: number;
  readonly receiverMinY: number;
  readonly receiverMaxX: number;
  readonly receiverMaxY: number;
}

export function vsmPageTableEntryIndex(
  level: number, pageX: number, pageY: number, pagesPerAxis: number
): number {
  if (!Number.isInteger(level) || level < 0 ||
      !Number.isInteger(pageX) || pageX < 0 || pageX >= pagesPerAxis ||
      !Number.isInteger(pageY) || pageY < 0 || pageY >= pagesPerAxis ||
      !Number.isInteger(pagesPerAxis) || pagesPerAxis <= 0) {
    throw new RangeError("VSM page coordinate is outside the fixed virtual page domain");
  }
  return (level * pagesPerAxis + pageY) * pagesPerAxis + pageX;
}

export function vsmPageTableEntryByteOffset(
  level: number, pageX: number, pageY: number, pagesPerAxis: number
): number {
  return vsmPageTableEntryIndex(level, pageX, pageY, pagesPerAxis) * VSM_PAGE_ENTRY_WORDS * 4;
}

export function vsmMetaEntryByteOffset(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0) throw new RangeError("VSM slot must be non-negative");
  return slot * VSM_META_ENTRY_WORDS * 4;
}

export function vsmPageGenerationMatches(entry: Pick<VsmPageEntry, "flags" | "generation">,
  generation: number): boolean {
  return (entry.flags & VSM_PAGE_FLAGS.allocated) !== 0 &&
    (entry.flags & VSM_PAGE_FLAGS.generationValid) !== 0 && entry.generation === generation;
}
