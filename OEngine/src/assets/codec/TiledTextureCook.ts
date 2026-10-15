import {
  TILED_TEXTURE_RECIPE,
  TILED_TEXTURE_PAYLOAD_LIMIT,
  TILED_TEXTURE_TAIL_ORIGINS,
  TILED_TEXTURE_PAGE_LIMIT,
  openTiledTextureDirectory,
  type TiledTextureAddress,
  type TiledTextureDirectory,
  type TiledTextureMetadata,
  type TiledTextureMip,
  type TiledTexturePayload,
  type TiledTexturePlane
} from "../TiledTextureProduct.js";
import {
  assertValidatedTextureProduct,
  textureProductHash,
  type TextureProduct,
  type TextureProductPlane
} from "../TextureProduct.js";
import { encodePcTextureMip, type PcTextureCookMip, type PcTextureCodecs } from "./PcTextureCook.js";

export interface TiledTextureCookOptions {
  readonly packUri: string;
  readonly addresses: readonly TiledTextureAddress[];
  /** Derived from the actual coverage graph by the caller; coverage is always protected. */
  readonly residentRoles?: readonly TextureProductPlane["role"][];
  /** Appends one immutable payload to the pack and persists its hash-addressed bounded shard. */
  readonly writePayload: (
    bytes: Uint8Array,
    hash: string
  ) => Promise<{ readonly offset: number; readonly shard: string }>;
}

interface PlaneBuild {
  readonly role: TextureProductPlane["role"];
  readonly mode: "virtual" | "resident";
  readonly address: TiledTextureAddress;
  readonly mips: TiledTextureMip[];
  tailFirst: number;
  tail: Uint8Array | null;
}

/** Cold cooker extension, observing PcTextureCook's exact RGBA/encoded mip pair.
 * Retains only directories and at most one compressed tail slot per address profile.
 * It never regenerates normal/sRGB mips or decodes BC in the runtime. */
export class TiledTextureCook {
  readonly #planes: PlaneBuild[] = [];
  readonly #payloads: TiledTexturePayload[] = [];
  readonly #observed = new Map<string, { hash: string; width: number; height: number }[]>();
  #bytes = 0;
  #finished = false;

  constructor(
    readonly codecs: PcTextureCodecs,
    readonly options: TiledTextureCookOptions,
    readonly channel: number = 0
  ) {
    if (
      !options.addresses.length ||
      new Set(options.addresses).size !== options.addresses.length ||
      options.addresses.some((a) => !["clamp", "repeat", "mirror"].includes(a)) ||
      !Number.isInteger(channel) ||
      channel < 0 ||
      channel > 3
    ) {
      throw new Error("Tiled cook requires distinct supported address profiles");
    }
  }

  async appendMip(mip: PcTextureCookMip): Promise<void> {
    if (this.#finished) {
      throw new Error("Tiled cook is already finalized");
    }
    const observed = this.#observed.get(mip.plane.role) ?? [];
    if (observed.length !== mip.level || !mip.plane.mips[mip.level]) {
      throw new Error("Tiled cook source mip observation is incomplete or duplicated");
    }
    observed.push({ hash: mip.plane.mips[mip.level]!.hash, width: mip.width, height: mip.height });
    this.#observed.set(mip.plane.role, observed);
    if (mip.level === 0) {
      const resident =
        mip.plane.role === "coverage" ||
        this.options.residentRoles?.includes(mip.plane.role) ||
        Math.max(mip.width, mip.height) <= 128;
      for (const address of resident ? ["clamp" as const] : this.options.addresses) {
        this.#planes.push({
          role: mip.plane.role,
          mode: resident ? "resident" : "virtual",
          address,
          mips: [],
          tailFirst: -1,
          tail: null
        });
      }
    }
    for (const plane of this.#planes) {
      if (plane.role !== mip.plane.role) {
        continue;
      }
      if (plane.mips.length !== mip.level) {
        throw new Error("Tiled cook must observe each source mip exactly once in order");
      }
      if (plane.mode === "resident") {
        const payloads: number[] = [];
        for (let start = 0; start < mip.payload.length; start += TILED_TEXTURE_PAYLOAD_LIMIT) {
          payloads.push(await this.#write(mip.payload.subarray(start, start + TILED_TEXTURE_PAYLOAD_LIMIT)));
        }
        plane.mips.push({
          level: mip.level,
          width: mip.width,
          height: mip.height,
          gridWidth: 1,
          gridHeight: 1,
          payloads
        });
        continue;
      }
      const inTail = Math.max(mip.width, mip.height) <= TILED_TEXTURE_RECIPE.tailMax;
      if (inTail) {
        if (plane.tailFirst === -1) {
          plane.tailFirst = mip.level;
          plane.tail = new Uint8Array(36 * 36 * (mip.plane.format === "bc4-r-unorm" ? 8 : 16));
        }
        const origin = TILED_TEXTURE_TAIL_ORIGINS[mip.level - plane.tailFirst];
        if (!origin) {
          throw new Error("Tiled tail layout overflow");
        }
        const w = Math.ceil((mip.width + 16) / 4) * 4;
        const h = Math.ceil((mip.height + 16) / 4) * 4;
        const bytes = this.#region(mip, plane.address, -8, -8, w, h);
        const block = mip.plane.format === "bc4-r-unorm" ? 8 : 16;
        for (let y = 0; y < h / 4; y++) {
          const target = ((origin[1] / 4 + y) * 36 + origin[0] / 4) * block;
          plane.tail!.set(bytes.subarray(((y * w) / 4) * block, (((y + 1) * w) / 4) * block), target);
        }
        plane.mips.push({
          level: mip.level,
          width: mip.width,
          height: mip.height,
          gridWidth: 1,
          gridHeight: 1,
          payloads: [],
          tailOrigin: origin
        });
      } else {
        const gridWidth = Math.ceil(mip.width / 128);
        const gridHeight = Math.ceil(mip.height / 128);
        const payloads: number[] = [];
        for (let y = 0; y < gridHeight; y++) {
          for (let x = 0; x < gridWidth; x++) {
            const bytes = this.#region(mip, plane.address, x * 128 - 8, y * 128 - 8, 144, 144);
            payloads.push(await this.#write(bytes));
          }
        }
        plane.mips.push({
          level: mip.level,
          width: mip.width,
          height: mip.height,
          gridWidth,
          gridHeight,
          payloads
        });
      }
    }
  }

  async finish(product: TextureProduct): Promise<{
    readonly bytes: Uint8Array;
    readonly directory: TiledTextureDirectory;
  }> {
    if (this.#finished) {
      throw new Error("Tiled cook is already finalized");
    }
    assertValidatedTextureProduct(product);
    this.#finished = true;
    if (
      product.metadata.channel !== this.channel ||
      product.metadata.recipe.binaryHash !== this.codecs.basisHash ||
      this.#observed.size !== product.metadata.planes.length
    ) {
      throw new Error("Tiled cook source channel/encoder/planes mismatch");
    }
    for (const source of product.metadata.planes) {
      const observed = this.#observed.get(source.role);
      if (
        observed?.length !== source.mips.length ||
        source.mips.some(
          (mip, l) =>
            observed[l]!.hash !== mip.hash ||
            observed[l]!.width !== mip.width ||
            observed[l]!.height !== mip.height
        )
      ) {
        throw new Error("Tiled cook must finalize with its exact observed source Product");
      }
    }
    const planes: TiledTexturePlane[] = [];
    for (const plane of this.#planes) {
      if (plane.mode === "virtual") {
        if (!plane.tail) {
          throw new Error("Tiled cook did not receive the complete tail");
        }
        const id = await this.#write(plane.tail);
        plane.tail = null;
        for (let l = plane.tailFirst; l < plane.mips.length; l++) {
          plane.mips[l] = { ...plane.mips[l]!, payloads: [id] };
        }
      }
      planes.push({
        sourcePlane: product.metadata.planes.findIndex((p) => p.role === plane.role),
        mode: plane.mode,
        address: plane.address,
        tailFirst: plane.tailFirst,
        mips: plane.mips
      });
    }
    const metadata: TiledTextureMetadata = {
      schemaVersion: 1,
      recipe: TILED_TEXTURE_RECIPE,
      sourceIdentity: product.identity,
      source: product.metadata,
      pack: { uri: this.options.packUri, byteLength: this.#bytes },
      payloads: this.#payloads,
      planes
    };
    const bytes = new TextEncoder().encode(JSON.stringify(metadata));
    const directory = await openTiledTextureDirectory(bytes, await textureProductHash(bytes));
    return { bytes, directory };
  }

  #region(
    mip: PcTextureCookMip,
    address: TiledTextureAddress,
    ox: number,
    oy: number,
    width: number,
    height: number
  ): Uint8Array {
    const block = mip.plane.format === "bc4-r-unorm" ? 8 : 16;
    const entirelyInside = ox >= 0 && oy >= 0 && ox + width <= mip.width && oy + height <= mip.height;
    let result: Uint8Array;
    if (entirelyInside) {
      result = new Uint8Array((((width / 4) * height) / 4) * block);
    } else {
      const rgba = tiledTextureGutter(mip.rgba, mip.width, mip.height, ox, oy, width, height, address);
      result = encodePcTextureMip(
        this.codecs.basis,
        rgba,
        width,
        height,
        block === 8 ? 4 : 7,
        mip.plane.format.endsWith("srgb"),
        this.channel
      );
    }
    // Exact source blocks are retained wherever all 16 source texels are valid.
    // Boundary/partial blocks come from the existing pinned cold encoder above.
    const sourceRow = Math.ceil(mip.width / 4) * block;
    for (let y = 0; y < height; y += 4) {
      const sy = oy + y;
      if (sy < 0 || sy + 4 > mip.height) {
        continue;
      }
      for (let x = 0; x < width; x += 4) {
        const sx = ox + x;
        if (sx >= 0 && sx + 4 <= mip.width) {
          const source = (sy / 4) * sourceRow + (sx / 4) * block;
          const target = ((y / 4) * (width / 4) + x / 4) * block;
          result.set(mip.payload.subarray(source, source + block), target);
        }
      }
    }
    return result;
  }

  async #write(bytes: Uint8Array): Promise<number> {
    if (this.#payloads.length >= TILED_TEXTURE_PAGE_LIMIT) {
      throw new RangeError("Tiled cook payload directory capacity exceeded");
    }
    const hash = await textureProductHash(bytes);
    const location = await this.options.writePayload(bytes, hash);
    if (location.offset !== this.#bytes) {
      throw new Error("Tiled sink must append the exact payload extent");
    }
    const id = this.#payloads.length;
    this.#payloads.push({
      id,
      offset: location.offset,
      byteLength: bytes.byteLength,
      hash,
      shard: location.shard
    });
    this.#bytes += bytes.byteLength;
    return id;
  }
}

/** Local block-address glue, not a new mip filter or BC codec. */
export function tiledTextureGutter(
  source: Uint8Array,
  sw: number,
  sh: number,
  ox: number,
  oy: number,
  width: number,
  height: number,
  address: TiledTextureAddress
): Uint8Array {
  if (source.byteLength !== sw * sh * 4 || !["clamp", "repeat", "mirror"].includes(address)) {
    throw new Error("Tiled gutter input invalid");
  }
  const result = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = addressTexel(oy + y, sh, address);
    for (let x = 0; x < width; x++) {
      const sx = addressTexel(ox + x, sw, address);
      const from = (sy * sw + sx) * 4;
      result.set(source.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return result;
}

function addressTexel(value: number, size: number, mode: TiledTextureAddress): number {
  if (mode === "clamp") {
    return Math.max(0, Math.min(size - 1, value));
  }
  const period = mode === "mirror" ? size * 2 : size;
  const wrapped = ((value % period) + period) % period;
  return mode === "mirror" && wrapped >= size ? period - 1 - wrapped : wrapped;
}
