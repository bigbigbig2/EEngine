/** E1 internal product. Not exported or accepted by production texture loaders until E2. */
export type ImageTextureSemantic =
  "color-rgb" | "color-rgba" | "normal-xy" | "data-rgb" | "moment-xyz" | "scalar-r" | "exact-r";

export const IMAGE_TEXTURE_LIMITS = Object.freeze({
  directoryBytes: 8 * 1024 * 1024,
  items: 65536,
  imageBytes: 4 * 1024 * 1024,
  imageDimension: 2048,
  logicalDimension: 65536
});

export interface ImageTextureItem {
  readonly id: number;
  readonly plane: number;
  readonly mip: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind: "image" | "exact";
  readonly codec: "avif" | "raw";
  readonly bytes: number;
  readonly decodedBytes: number;
  readonly sha256: string;
  readonly uri: string;
  /** Decimal u64, or null for one bounded external object. */
  readonly offset: string | null;
  readonly objectBytes: string;
}

export interface ImageTexturePlane {
  readonly semantic: ImageTextureSemantic;
  readonly mode: "resident" | "virtual";
  readonly mips: "runtime" | "provided";
  readonly target: "bc7-rgb" | "bc7-rgba" | "bc5-rg" | "bc4-r" | "r8";
  readonly addressU: "clamp-to-edge" | "repeat" | "mirror-repeat";
  readonly addressV: "clamp-to-edge" | "repeat" | "mirror-repeat";
  readonly alphaScales: readonly number[];
  /** Exact source constants in UNORM8; null means the decoded channel is consumed. */
  readonly constants: readonly (number | null)[];
}

export interface ImageTextureDirectory {
  readonly schemaVersion: 4;
  readonly sourceRevision: string;
  readonly recipe: string;
  readonly width: number;
  readonly height: number;
  readonly mipCount: number;
  readonly quality: "high" | "extreme";
  readonly planes: readonly ImageTexturePlane[];
  readonly items: readonly ImageTextureItem[];
}

export function imageMipCount(width: number, height: number): number {
  return 1 + Math.floor(Math.log2(Math.max(width, height)));
}

export function imageTarget(semantic: ImageTextureSemantic): ImageTexturePlane["target"] {
  switch (semantic) {
    case "color-rgb":
    case "data-rgb":
    case "moment-xyz":
      return "bc7-rgb";
    case "color-rgba":
      return "bc7-rgba";
    case "normal-xy":
      return "bc5-rg";
    case "scalar-r":
      return "bc4-r";
    case "exact-r":
      return "r8";
    default:
      throw new Error("Unknown image texture semantic");
  }
}

export function imageCicp(semantic: ImageTextureSemantic): readonly [number, number, number] {
  if (semantic === "color-rgb" || semantic === "color-rgba") {
    return [1, 13, 6];
  }
  return semantic === "scalar-r" ? [1, 8, 6] : [1, 8, 0];
}

export function checkedImageInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError("Image texture integer exceeds its domain");
  }
  return value;
}

export function checkedImageHash(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Image texture SHA256 is malformed");
  }
}

export function checkedImageU64(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error("Image texture offset is not canonical u64");
  }
  const result = BigInt(value);
  if (result > 0xffffffffffffffffn) {
    throw new RangeError("Image texture u64 overflow");
  }
  return result;
}

export function validateImageTextureDirectory(directory: ImageTextureDirectory): void {
  if (directory.schemaVersion !== 4 || !["high", "extreme"].includes(directory.quality)) {
    throw new Error("Unsupported image texture product");
  }
  checkedImageHash(directory.sourceRevision);
  checkedImageHash(directory.recipe);
  checkedImageInteger(directory.width, 1, IMAGE_TEXTURE_LIMITS.logicalDimension);
  checkedImageInteger(directory.height, 1, IMAGE_TEXTURE_LIMITS.logicalDimension);
  if (directory.mipCount !== imageMipCount(directory.width, directory.height)) {
    throw new Error("Image texture must declare its full logical mip domain");
  }
  checkedImageInteger(directory.planes.length, 1, 16);
  checkedImageInteger(directory.items.length, 1, IMAGE_TEXTURE_LIMITS.items);
  let metadataUpperBound = 512 + directory.planes.length * 512;
  const domains = new Map<string, ImageTextureItem[]>();
  const ranges = new Map<string, ImageTextureItem[]>();
  for (const plane of directory.planes) {
    if (
      plane.target !== imageTarget(plane.semantic) ||
      !["resident", "virtual"].includes(plane.mode) ||
      !["runtime", "provided"].includes(plane.mips)
    ) {
      throw new Error("Image plane semantic/profile mismatch");
    }
    if (
      (plane.mode === "virtual" || plane.semantic === "moment-xyz" || plane.semantic === "exact-r") &&
      plane.mips !== "provided"
    ) {
      throw new Error("Special/virtual semantics require canonical provided mips");
    }
    for (const address of [plane.addressU, plane.addressV]) {
      if (!["clamp-to-edge", "repeat", "mirror-repeat"].includes(address)) {
        throw new Error("Unsupported image address mode");
      }
    }
    if (
      plane.constants.length !== 4 ||
      plane.alphaScales.length > directory.mipCount - 1 ||
      plane.alphaScales.some((value) => !Number.isFinite(value) || value < 0 || value > 16)
    ) {
      throw new Error("Invalid image channel/mip recipe");
    }
    for (const constant of plane.constants) {
      if (constant !== null) {
        checkedImageInteger(constant, 0, 255);
      }
    }
    if (plane.semantic === "normal-xy" && (plane.constants[2] !== 0 || plane.constants[3] !== 255)) {
      throw new Error("XY normal requires explicit restored B=0 and opaque alpha");
    }
    if (plane.mode === "virtual" && plane.alphaScales.length !== 0) {
      throw new Error("Virtual provided mips cannot request runtime alpha scaling");
    }
  }
  for (let index = 0; index < directory.items.length; index++) {
    const item = directory.items[index]!;
    if (item.id !== index) {
      throw new Error("Image item IDs must form the complete indexed domain");
    }
    checkedImageInteger(item.plane, 0, directory.planes.length - 1);
    checkedImageInteger(item.mip, 0, directory.mipCount - 1);
    checkedImageInteger(item.width, 1, IMAGE_TEXTURE_LIMITS.imageDimension);
    checkedImageInteger(item.height, 1, IMAGE_TEXTURE_LIMITS.imageDimension);
    const width = Math.max(1, Math.floor(directory.width / 2 ** item.mip));
    const height = Math.max(1, Math.floor(directory.height / 2 ** item.mip));
    checkedImageInteger(item.x, 0, width - item.width);
    checkedImageInteger(item.y, 0, height - item.height);
    checkedImageInteger(item.bytes, 1, IMAGE_TEXTURE_LIMITS.imageBytes);
    checkedImageHash(item.sha256);
    const plane = directory.planes[item.plane]!;
    if (
      item.x % 128 ||
      item.y % 128 ||
      (item.x + item.width !== width && item.width % 128) ||
      (item.y + item.height !== height && item.height % 128)
    ) {
      throw new Error("Image owners must respect the finite 128-texel spatial grid");
    }
    const exact = plane.semantic === "exact-r";
    if (
      item.kind !== (exact ? "exact" : "image") ||
      item.codec !== (exact ? "raw" : "avif") ||
      item.decodedBytes !== item.width * item.height * (exact ? 1 : 4)
    ) {
      throw new Error("Image item encoded/decoded domain mismatch");
    }
    if (
      typeof item.uri !== "string" ||
      item.uri.length < 1 ||
      item.uri.length > 2048 ||
      /[\u0000-\u001f]/.test(item.uri)
    ) {
      throw new Error("Invalid image source URI");
    }
    metadataUpperBound += 512 + item.uri.length * 6;
    if (metadataUpperBound > IMAGE_TEXTURE_LIMITS.directoryBytes) {
      throw new RangeError("Image directory metadata exceeds bounded object/string accounting");
    }
    const objectBytes = checkedImageU64(item.objectBytes);
    if (item.offset === null) {
      if (objectBytes !== BigInt(item.bytes)) {
        throw new Error("External image object length mismatch");
      }
    } else {
      const offset = checkedImageU64(item.offset);
      if (offset + BigInt(item.bytes) > objectBytes) {
        throw new Error("Image range is outside its immutable object");
      }
      const sameSource = ranges.get(item.uri) ?? [];
      sameSource.push(item);
      ranges.set(item.uri, sameSource);
    }
    if (exact && item.bytes !== item.decodedBytes) {
      throw new Error("Raw exact image byte count mismatch");
    }
    if (
      plane.mips === "runtime" &&
      (item.mip !== 0 || item.x !== 0 || item.y !== 0 || item.width !== width || item.height !== height)
    ) {
      throw new Error("Runtime mip input must be one complete base image");
    }
    const key = `${item.plane}/${item.mip}`;
    const domain = domains.get(key) ?? [];
    domain.push(item);
    domains.set(key, domain);
  }
  for (const items of ranges.values()) {
    items.sort((a, b) => (checkedImageU64(a.offset!) < checkedImageU64(b.offset!) ? -1 : 1));
    for (let index = 1; index < items.length; index++) {
      const previous = items[index - 1]!;
      const item = items[index]!;
      if (
        previous.objectBytes !== item.objectBytes ||
        checkedImageU64(previous.offset!) + BigInt(previous.bytes) > checkedImageU64(item.offset!)
      ) {
        throw new Error("Image encoded ranges overlap or disagree on source length");
      }
    }
  }
  // Sweep rows: exact area plus disjoint row intervals proves full rectangular coverage.
  for (let planeIndex = 0; planeIndex < directory.planes.length; planeIndex++) {
    const plane = directory.planes[planeIndex]!;
    for (let mip = 0; mip < (plane.mips === "runtime" ? 1 : directory.mipCount); mip++) {
      const width = Math.max(1, Math.floor(directory.width / 2 ** mip));
      const height = Math.max(1, Math.floor(directory.height / 2 ** mip));
      const items = domains.get(`${planeIndex}/${mip}`) ?? [];
      const events = items.flatMap((item) => [item.y, item.y + item.height]).sort((a, b) => a - b);
      const active = new Set<ImageTextureItem>();
      const starts = [...items].sort((a, b) => a.y - b.y);
      let cursor = 0;
      let previousY = 0;
      for (const y of new Set(events)) {
        if (y > previousY) {
          const row = [...active].sort((a, b) => a.x - b.x);
          let end = 0;
          for (const item of row) {
            if (item.x !== end) {
              throw new Error("Image owner domain has a hole or overlap");
            }
            end += item.width;
          }
          if (end !== width) {
            throw new Error("Image owner domain does not cover the row");
          }
        }
        for (const item of active) {
          if (item.y + item.height === y) {
            active.delete(item);
          }
        }
        while (cursor < starts.length && starts[cursor]!.y === y) {
          active.add(starts[cursor++]!);
        }
        previousY = y;
      }
      if (previousY !== height || events[0] !== 0) {
        throw new Error("Image owner domain has missing rows");
      }
    }
  }
}

export function readImageTextureDirectory(bytes: Uint8Array): ImageTextureDirectory {
  checkedImageInteger(bytes.byteLength, 1, IMAGE_TEXTURE_LIMITS.directoryBytes);
  const directory = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  ) as ImageTextureDirectory;
  validateImageTextureDirectory(directory);
  return directory;
}

export function writeImageTextureDirectory(directory: ImageTextureDirectory): Uint8Array {
  validateImageTextureDirectory(directory);
  const bytes = new TextEncoder().encode(JSON.stringify(directory));
  checkedImageInteger(bytes.byteLength, 1, IMAGE_TEXTURE_LIMITS.directoryBytes);
  return bytes;
}

export async function imageTextureHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
