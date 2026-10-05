export const SURFACE_COVERAGE_HEADER_WORDS = 4;
export const SURFACE_COVERAGE_TILE_WORDS = 8;
export const SURFACE_ACTIVE_TILE_COUNT_WORD = 127;
export const SURFACE_MIXED_MAP_CURSOR_WORD = 126;
export const SURFACE_WORK_MODE = Object.freeze({ implicitFine: 2, uniform: 3, mixed: 4 });

export function surfaceCoverageLayout(
  tiles: number,
): Readonly<{ tileOffset: number; activeOffset: number; bytes: number }> {
  if (!Number.isSafeInteger(tiles) || tiles < 1 || tiles > 0x1fffffff) {
    throw new RangeError("Invalid Surface coverage capacity");
  }
  const activeOffset = SURFACE_COVERAGE_HEADER_WORDS + tiles * SURFACE_COVERAGE_TILE_WORDS;
  return Object.freeze({
    tileOffset: SURFACE_COVERAGE_HEADER_WORDS,
    activeOffset,
    bytes: (activeOffset + tiles) * 4,
  });
}

export const SURFACE_COVERAGE_WGSL = /* wgsl */ `
struct SurfaceCoverageTile {
  absolute_tile: u32,
  coverage_lo: u32,
  coverage_hi: u32,
  enabled: u32,
  uniform_entry: u32,
  mode: u32,
  generation: u32,
  profile: u32,
}
`;
