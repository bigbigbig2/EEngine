export type AccountedResourceKind = "buffer" | "texture" | "sampler" | "bindGroup" | "pipeline";
export type AccountedResourceCategory =
  | "resident"
  | "transient"
  | "history"
  | "atlas"
  | "upload"
  | "readback"
  | "profiler";

export interface ResourceAccountedInput {
  readonly kind: AccountedResourceKind;
  readonly category?: AccountedResourceCategory;
  readonly owner: string;
  readonly bytes: number;
  readonly label?: string;
}

export interface ResourceHandle extends Omit<ResourceAccountedInput, "category"> {
  readonly id: number;
  readonly category: AccountedResourceCategory;
}

export interface ResourceCategorySnapshot {
  readonly bytes: number;
  readonly peakBytes: number;
  readonly count: number;
}

export interface ResourceAccountingSnapshot {
  readonly totalBytes: number;
  readonly peakBytes: number;
  readonly createdCount: number;
  readonly destroyedCount: number;
  readonly counts: Readonly<Record<AccountedResourceKind, number>>;
  readonly categories: Readonly<Partial<Record<AccountedResourceCategory, ResourceCategorySnapshot>>>;
  readonly owners: Readonly<Record<string, Readonly<Partial<Record<AccountedResourceKind, number>>>>>
}

export class ResourceAccounting {
  private nextId = 1;
  private currentBytes = 0;
  private peakBytes = 0;
  private createdCount = 0;
  private destroyedCount = 0;
  private readonly resources = new Map<number, ResourceHandle>();
  private readonly categoryStats = new Map<AccountedResourceCategory, { bytes: number; peakBytes: number; count: number }>();

  created(input: ResourceAccountedInput): ResourceHandle {
    validateInput(input);
    const handle = Object.freeze({ ...input, category: input.category ?? "resident", id: this.nextId++ });
    this.resources.set(handle.id, handle);
    this.currentBytes += handle.bytes;
    this.peakBytes = Math.max(this.peakBytes, this.currentBytes);
    this.createdCount++;
    const category = this.categoryStats.get(handle.category) ?? { bytes: 0, peakBytes: 0, count: 0 };
    category.bytes += handle.bytes;
    category.count++;
    category.peakBytes = Math.max(category.peakBytes, category.bytes);
    this.categoryStats.set(handle.category, category);
    return handle;
  }

  destroyed(handle: ResourceHandle): void {
    const current = this.resources.get(handle.id);
    if (current === undefined || current !== handle) {
      throw new Error(`Resource ${handle.id} is already released, unknown, or belongs to another ledger`);
    }
    this.resources.delete(handle.id);
    this.currentBytes -= current.bytes;
    this.destroyedCount++;
    const category = this.categoryStats.get(current.category)!;
    category.bytes -= current.bytes;
    category.count--;
  }

  snapshot(): ResourceAccountingSnapshot {
    const counts: Record<AccountedResourceKind, number> = {
      buffer: 0, texture: 0, sampler: 0, bindGroup: 0, pipeline: 0
    };
    const ownerBytes: Record<string, Record<AccountedResourceKind, number>> = {};
    for (const resource of this.resources.values()) {
      counts[resource.kind]++;
      const owner = ownerBytes[resource.owner] ??= {
        buffer: 0, texture: 0, sampler: 0, bindGroup: 0, pipeline: 0
      };
      owner[resource.kind] += resource.bytes;
    }
    return Object.freeze({
      totalBytes: this.currentBytes,
      peakBytes: this.peakBytes,
      createdCount: this.createdCount,
      destroyedCount: this.destroyedCount,
      counts: Object.freeze({ ...counts }),
      categories: Object.freeze(Object.fromEntries(
        [...this.categoryStats.entries()].map(([category, values]) => [
          category,
          Object.freeze({ ...values })
        ])
      )),
      owners: Object.freeze(Object.fromEntries(
        Object.entries(ownerBytes).map(([owner, values]) => [
          owner,
          Object.freeze(Object.fromEntries(
            Object.entries(values).filter(([, bytes]) => bytes > 0)
          ))
        ])
      ))
    });
  }
}

interface TextureBlockInfo {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly compressed?: boolean;
}

const FORMAT_BYTES: Readonly<Record<string, number>> = {
  r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1,
  rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2,
  rgba8unorm: 4, "rgba8unorm-srgb": 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4,
  bgra8unorm: 4, "bgra8unorm-srgb": 4,
  r16float: 2, rg16float: 4, rgba16float: 8,
  r16uint: 2, r16sint: 2, rg16uint: 4, rg16sint: 4, rgba16uint: 8, rgba16sint: 8,
  r32float: 4, r32uint: 4, r32sint: 4,
  rg32float: 8, rg32uint: 8, rg32sint: 8,
  rgba32float: 16, rgba32uint: 16, rgba32sint: 16,
  rgb10a2unorm: 4, rg11b10ufloat: 4, rgb9e5ufloat: 4,
  depth16unorm: 2, depth24plus: 4, "depth24plus-stencil8": 4, depth32float: 4,
  "depth32float-stencil8": 8
};

const COMPRESSED_FORMAT_BLOCKS: Readonly<Record<string, TextureBlockInfo>> = {
  "bc1-rgba-unorm": block(4, 4, 8), "bc1-rgba-unorm-srgb": block(4, 4, 8),
  "bc2-rgba-unorm": block(4, 4, 16), "bc2-rgba-unorm-srgb": block(4, 4, 16),
  "bc3-rgba-unorm": block(4, 4, 16), "bc3-rgba-unorm-srgb": block(4, 4, 16),
  "bc4-r-unorm": block(4, 4, 8), "bc4-r-snorm": block(4, 4, 8),
  "bc5-rg-unorm": block(4, 4, 16), "bc5-rg-snorm": block(4, 4, 16),
  "bc6h-rgb-ufloat": block(4, 4, 16), "bc6h-rgb-float": block(4, 4, 16),
  "bc7-rgba-unorm": block(4, 4, 16), "bc7-rgba-unorm-srgb": block(4, 4, 16),
  "etc2-rgb8unorm": block(4, 4, 8), "etc2-rgb8unorm-srgb": block(4, 4, 8),
  "etc2-rgb8a1unorm": block(4, 4, 8), "etc2-rgb8a1unorm-srgb": block(4, 4, 8),
  "etc2-rgba8unorm": block(4, 4, 16), "etc2-rgba8unorm-srgb": block(4, 4, 16),
  "eac-r11unorm": block(4, 4, 8), "eac-r11snorm": block(4, 4, 8),
  "eac-rg11unorm": block(4, 4, 16), "eac-rg11snorm": block(4, 4, 16)
};

export function estimateBufferBytes(input: { readonly size: number }): number {
  if (!Number.isFinite(input.size)) throw new RangeError("buffer size must be finite");
  if (!Number.isInteger(input.size) || input.size < 0) {
    throw new RangeError("buffer size must be a non-negative integer");
  }
  return input.size;
}

export function estimateTextureBytes(input: {
  format: string;
  width: number;
  height: number;
  depthOrArrayLayers?: number;
  mipLevelCount?: number;
  sampleCount?: number;
  dimension?: "1d" | "2d" | "3d";
}): number {
  const format = textureBlockInfo(input.format);
  if (format === undefined) throw new RangeError(`unsupported texture format '${input.format}'`);
  assertPositiveInteger(input.width, "width");
  assertPositiveInteger(input.height, "height");
  const layers = input.depthOrArrayLayers ?? 1;
  const mipCount = input.mipLevelCount ?? 1;
  const sampleCount = input.sampleCount ?? 1;
  assertPositiveInteger(layers, "depthOrArrayLayers");
  assertPositiveInteger(mipCount, "mipLevelCount");
  if (sampleCount !== 1 && sampleCount !== 4) throw new RangeError("sampleCount must be 1 or 4");
  if (format.compressed && sampleCount !== 1) throw new RangeError("compressed textures cannot be multisampled");
  if (sampleCount !== 1 && mipCount !== 1) throw new RangeError("multisampled textures must have one mip level");
  let total = 0;
  for (let mip = 0; mip < mipCount; mip++) {
    const width = Math.max(1, input.width >> mip);
    const height = Math.max(1, input.height >> mip);
    const depth = input.dimension === "3d" ? Math.max(1, layers >> mip) : layers;
    total += Math.ceil(width / format.width) * Math.ceil(height / format.height) * depth * format.bytes * sampleCount;
  }
  return total;
}

function block(width: number, height: number, bytes: number): TextureBlockInfo {
  return Object.freeze({ width, height, bytes, compressed: true });
}

function textureBlockInfo(format: string): TextureBlockInfo | undefined {
  const bytes = FORMAT_BYTES[format];
  if (bytes !== undefined) return { width: 1, height: 1, bytes };
  const compressed = COMPRESSED_FORMAT_BLOCKS[format];
  if (compressed !== undefined) return compressed;
  const astc = /^astc-(4x4|5x4|5x5|6x5|6x6|8x5|8x6|8x8|10x5|10x6|10x8|10x10|12x10|12x12)-unorm(?:-srgb)?$/.exec(format);
  if (astc === null) return undefined;
  const [width, height] = astc[1]!.split("x").map(Number);
  return block(width!, height!, 16);
}

function validateInput(input: ResourceAccountedInput): void {
  if (!input.owner) throw new TypeError("Resource owner is required");
  if (input.category !== undefined && !["resident", "transient", "history", "atlas", "upload", "readback", "profiler"].includes(input.category)) {
    throw new TypeError(`Unknown resource category '${String(input.category)}'`);
  }
  if (!Number.isFinite(input.bytes) || input.bytes < 0) throw new RangeError("Resource bytes must be finite and non-negative");
  if (!Number.isInteger(input.bytes)) throw new RangeError("Resource bytes must be an integer");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}
