import {
  checkedImageInteger,
  validateImageTextureDirectory,
  type ImageTextureDirectory,
  type ImageTexturePlane
} from "./ImageTextureProduct.js";

export const IMAGE_PAGE_INTERIOR = 128;
export const IMAGE_PAGE_GUTTER = 8;
export const IMAGE_PAGE_SIZE = IMAGE_PAGE_INTERIOR + 2 * IMAGE_PAGE_GUTTER;
export const IMAGE_PAGE_MAX_OWNERS = 16;
const pageSources = new WeakMap<ImagePagePlan, ImageTextureDirectory>();
const tailLevels = new WeakSet<ImageTailLevel>();
// Preserve the established protected-tail packing, including block-aligned gutters.
const tailOrigins = [[0, 0], [80, 0], [0, 80], [32, 80], [56, 80], [76, 80], [96, 80]] as const;

export interface ImageTailLevel {
  readonly page: ImagePagePlan;
  readonly origin: readonly [number, number];
  readonly width: number;
  readonly height: number;
}

export interface ImageTailPlan {
  readonly first: number;
  readonly levels: readonly ImageTailLevel[];
}

export interface ImagePagePlan {
  readonly plane: number;
  readonly mip: number;
  readonly x: number;
  readonly y: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly owners: readonly number[];
  readonly encodedBytes: number;
  readonly decodedBytes: number;
}

interface MipOwners {
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly items: Int32Array;
}

/** Source-domain lookup, never a second encoded gutter image. Index storage is bounded
 * independently of item metadata. Each page touches at most four 128-cells per axis,
 * including NPOT repeat/mirror seams; actual owner IDs are deduplicated before IO. */
export class ImageTexturePages {
  readonly #domains = new Map<string, MipOwners>();
  readonly indexBytes: number;

  constructor(
    readonly directory: ImageTextureDirectory,
    maxIndexBytes = 8 * 1024 * 1024
  ) {
    validateImageTextureDirectory(directory);
    this.directory = structuredClone(directory);
    for (const plane of this.directory.planes) {
      Object.freeze(plane.constants);
      Object.freeze(plane.alphaScales);
      Object.freeze(plane);
    }
    for (const item of this.directory.items) {
      Object.freeze(item);
    }
    Object.freeze(this.directory.items);
    Object.freeze(this.directory.planes);
    Object.freeze(this.directory);
    directory = this.directory;
    checkedImageInteger(maxIndexBytes, 4, 32 * 1024 * 1024);
    let bytes = 0;
    for (let plane = 0; plane < directory.planes.length; plane++) {
      if (directory.planes[plane]!.mode !== "virtual") {
        continue;
      }
      for (let mip = 0; mip < directory.mipCount; mip++) {
        const width = Math.max(1, Math.floor(directory.width / 2 ** mip));
        const height = Math.max(1, Math.floor(directory.height / 2 ** mip));
        const columns = Math.ceil(width / IMAGE_PAGE_INTERIOR);
        const rows = Math.ceil(height / IMAGE_PAGE_INTERIOR);
        bytes += columns * rows * 4;
        if (bytes > maxIndexBytes) {
          throw new RangeError("Image page spatial index exceeds its metadata capacity");
        }
        this.#domains.set(`${plane}/${mip}`, {
          width,
          height,
          columns,
          items: new Int32Array(columns * rows).fill(-1)
        });
      }
    }
    for (const item of directory.items) {
      const domain = this.#domains.get(`${item.plane}/${item.mip}`);
      if (!domain) {
        continue;
      }
      for (
        let y = item.y / IMAGE_PAGE_INTERIOR;
        y < Math.ceil((item.y + item.height) / IMAGE_PAGE_INTERIOR);
        y++
      ) {
        for (
          let x = item.x / IMAGE_PAGE_INTERIOR;
          x < Math.ceil((item.x + item.width) / IMAGE_PAGE_INTERIOR);
          x++
        ) {
          domain.items[y * domain.columns + x] = item.id;
        }
      }
    }
    this.indexBytes = bytes;
  }

  page(plane: number, mip: number, x: number, y: number): ImagePagePlan {
    const domain = this.#domains.get(`${plane}/${mip}`);
    if (!domain) {
      throw new RangeError("Page requires a provided virtual image plane/mip");
    }
    checkedImageInteger(x, 0, domain.columns - 1);
    checkedImageInteger(y, 0, Math.ceil(domain.height / IMAGE_PAGE_INTERIOR) - 1);
    const profile = this.directory.planes[plane]!;
    const horizontal = axisCells(x * IMAGE_PAGE_INTERIOR - IMAGE_PAGE_GUTTER, domain.width, profile.addressU);
    const vertical = axisCells(y * IMAGE_PAGE_INTERIOR - IMAGE_PAGE_GUTTER, domain.height, profile.addressV);
    const owners = new Set<number>();
    for (const row of vertical) {
      for (const column of horizontal) {
        const id = domain.items[row * domain.columns + column]!;
        if (!this.directory.items[id]) {
          throw new Error("Page source-domain index contains an unowned texel");
        }
        owners.add(id);
      }
    }
    if (owners.size > IMAGE_PAGE_MAX_OWNERS) {
      throw new RangeError("Image page exceeds the complete finite dependency domain");
    }
    const ids = [...owners].sort((a, b) => a - b);
    const page = Object.freeze({
      plane,
      mip,
      x,
      y,
      logicalWidth: domain.width,
      logicalHeight: domain.height,
      owners: Object.freeze(ids),
      encodedBytes: ids.reduce((sum, id) => sum + this.directory.items[id]!.bytes, 0),
      decodedBytes: ids.reduce((sum, id) => sum + this.directory.items[id]!.decodedBytes, 0)
    });
    pageSources.set(page, this.directory);
    return page;
  }

  /** One protected physical slot per virtual plane. All levels retain their own
   * canonical source and gutter; no independent lossy tail image is introduced. */
  tail(plane: number): ImageTailPlan {
    checkedImageInteger(plane, 0, this.directory.planes.length - 1);
    if (this.directory.planes[plane]!.mode !== "virtual") {
      throw new Error("Protected tail requires a virtual image plane");
    }
    let first = 0;
    while (Math.max(this.directory.width, this.directory.height) / 2 ** first >= 65) {
      first++;
    }
    const levels: ImageTailLevel[] = [];
    for (let mip = first; mip < this.directory.mipCount; mip++) {
      const page = this.page(plane, mip, 0, 0);
      const origin = tailOrigins[mip - first];
      if (!origin) {
        throw new RangeError("Protected image tail exceeds its finite slot packing");
      }
      const level = Object.freeze({ page, origin,
        width: Math.ceil((page.logicalWidth + 16) / 4) * 4,
        height: Math.ceil((page.logicalHeight + 16) / 4) * 4
      });
      tailLevels.add(level);
      levels.push(level);
    }
    return Object.freeze({ first, levels: Object.freeze(levels) });
  }
}

export function assertImageTailLevel(level: ImageTailLevel): void {
  if (!tailLevels.has(level)) {
    throw new Error("Image tail level was not issued by a validated source");
  }
}

export function imagePageSource(page: ImagePagePlan): ImageTextureDirectory {
  const source = pageSources.get(page);
  if (!source) {
    throw new Error("Image page plan was not issued by a validated spatial index");
  }
  return source;
}

function addressed(value: number, size: number, mode: ImageTexturePlane["addressU"]): number {
  if (mode === "clamp-to-edge") {
    return Math.max(0, Math.min(size - 1, value));
  }
  const period = mode === "repeat" ? size : size * 2;
  const wrapped = ((value % period) + period) % period;
  return wrapped < size ? wrapped : period - 1 - wrapped;
}

function axisCells(start: number, size: number, mode: ImageTexturePlane["addressU"]): number[] {
  const cells = new Set<number>();
  // Fixed 144-texel axis walk handles tiny tails without an unbounded patch list.
  for (let offset = 0; offset < IMAGE_PAGE_SIZE; offset++) {
    cells.add(Math.floor(addressed(start + offset, size, mode) / IMAGE_PAGE_INTERIOR));
  }
  return [...cells];
}
