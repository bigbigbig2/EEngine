/**
 * Evidence-only model for the optional M7 tile backend.
 *
 * This module intentionally has no GPU resources or render/compute pass.  It
 * turns a deterministic per-pixel material-class fixture into the bounded
 * tile-mask work that a future producer/consumer would have to perform.  The
 * model is useful for comparing a validated prototype against ClassDepth while
 * the M7 gate remains closed.
 */

export const TILE_BACKEND_MODEL_VERSION = 1;
export const TILE_BACKEND_CLASS_COUNT = 7;
export const TILE_BACKEND_TILE_SIZES = Object.freeze([16, 32, 64] as const);
export type TileBackendTileSize = (typeof TILE_BACKEND_TILE_SIZES)[number];

export interface TileBackendCostModelInput {
  readonly width: number;
  readonly height: number;
  readonly tileSize: TileBackendTileSize;
  /** Row-major class ids; -1 denotes an empty/invalid VisibilityKey pixel. */
  readonly classIds: ArrayLike<number>;
  /** Fixed tile-record capacity; records beyond it contribute to overflow. */
  readonly tileCapacity: number;
}

export interface TileBackendMaskRecord {
  readonly tileIndex: number;
  readonly classMask: number;
}

export interface TileBackendCostModelResult {
  readonly modelVersion: 1;
  readonly width: number;
  readonly height: number;
  readonly tileSize: TileBackendTileSize;
  readonly tileCapacity: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tileCount: number;
  readonly nonEmptyTileCount: number;
  readonly writtenTileCount: number;
  readonly overflow: number;
  /** Overflow is counted in tile records, not pixels; this ratio is useful for gate reports. */
  readonly overflowRate: number;
  readonly classTileCounts: readonly number[];
  readonly records: readonly TileBackendMaskRecord[];
  /** Deterministic operation counts for calibrated prototype comparison. */
  readonly work: Readonly<{
    visibilityClassReads: number;
    tileMaskOrOperations: number;
    classTileDispatches: number;
  }>;
}

/** Build a bounded tile-class mask model without creating runtime GPU state. */
export function modelTileBackendCost(
  input: TileBackendCostModelInput
): TileBackendCostModelResult {
  validateInput(input);
  const tileWidth = Math.ceil(input.width / input.tileSize);
  const tileHeight = Math.ceil(input.height / input.tileSize);
  const tileCount = tileWidth * tileHeight;
  const masks = new Uint8Array(tileCount);
  let visibilityClassReads = 0;
  let tileMaskOrOperations = 0;

  for (let y = 0; y < input.height; y++) {
    for (let x = 0; x < input.width; x++) {
      const classId = input.classIds[y * input.width + x]!;
      visibilityClassReads++;
      if (classId < 0) continue;
      const tileX = Math.floor(x / input.tileSize);
      const tileY = Math.floor(y / input.tileSize);
      const tileIndex = tileY * tileWidth + tileX;
      masks[tileIndex] = masks[tileIndex]! | (1 << classId);
      tileMaskOrOperations++;
    }
  }

  const records: TileBackendMaskRecord[] = [];
  const classTileCounts = new Array<number>(TILE_BACKEND_CLASS_COUNT).fill(0);
  let nonEmptyTileCount = 0;
  let overflow = 0;
  for (let tileIndex = 0; tileIndex < masks.length; tileIndex++) {
    const classMask = masks[tileIndex]!;
    if (classMask === 0) continue;
    nonEmptyTileCount++;
    if (records.length >= input.tileCapacity) {
      overflow++;
      continue;
    }
    records.push(Object.freeze({ tileIndex, classMask }));
    for (let classId = 0; classId < TILE_BACKEND_CLASS_COUNT; classId++) {
      if ((classMask & (1 << classId)) !== 0) classTileCounts[classId]!++;
    }
  }

  const classTileDispatches = classTileCounts.reduce((sum, count) => sum + count, 0);
  return Object.freeze({
    modelVersion: TILE_BACKEND_MODEL_VERSION,
    width: input.width,
    height: input.height,
    tileSize: input.tileSize,
    tileCapacity: input.tileCapacity,
    tileWidth,
    tileHeight,
    tileCount,
    nonEmptyTileCount,
    writtenTileCount: records.length,
    overflow,
    overflowRate: nonEmptyTileCount > 0 ? overflow / nonEmptyTileCount : 0,
    classTileCounts: Object.freeze(classTileCounts),
    records: Object.freeze(records),
    work: Object.freeze({
      visibilityClassReads,
      tileMaskOrOperations,
      classTileDispatches
    })
  });
}

function validateInput(input: TileBackendCostModelInput): void {
  if (!Number.isInteger(input.width) || input.width <= 0 ||
      !Number.isInteger(input.height) || input.height <= 0) {
    throw new RangeError("Tile model dimensions must be positive integers");
  }
  if (!TILE_BACKEND_TILE_SIZES.includes(input.tileSize)) {
    throw new RangeError("Tile model tileSize must be 16, 32, or 64");
  }
  if (input.classIds.length !== input.width * input.height) {
    throw new RangeError("Tile model classIds must cover every input pixel");
  }
  if (!Number.isInteger(input.tileCapacity) || input.tileCapacity < 0) {
    throw new RangeError("Tile model tileCapacity must be a non-negative integer");
  }
  for (let index = 0; index < input.classIds.length; index++) {
    const value = input.classIds[index]!;
    if (!Number.isInteger(value) || value < -1 || value >= TILE_BACKEND_CLASS_COUNT) {
      throw new RangeError(`Tile model class id at ${index} must be -1 or in [0, ${TILE_BACKEND_CLASS_COUNT - 1}]`);
    }
  }
}
