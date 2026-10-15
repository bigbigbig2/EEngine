import { textureProductHash, type TextureProductMetadata } from "./TextureProduct.js";
import { encodedTextureMipByteLength } from "./codec/TextureFormatLayout.js";

export const TILED_TEXTURE_RECIPE = Object.freeze({
  version: 1,
  interior: 128,
  border: 8,
  physical: 144,
  tailMax: 64
} as const);
export const TILED_TEXTURE_DIRECTORY_LIMIT = 16 * 1024 * 1024;
export const TILED_TEXTURE_PAYLOAD_LIMIT = 1024 * 1024;
export const TILED_TEXTURE_PAGE_LIMIT = 1_048_576;
export type TiledTextureAddress = "clamp" | "repeat" | "mirror";
export const TILED_TEXTURE_TAIL_ORIGINS = [
  [0, 0],
  [80, 0],
  [0, 80],
  [32, 80],
  [56, 80],
  [76, 80],
  [96, 80]
] as const;

export interface TiledTexturePayload {
  readonly id: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly hash: string;
  /** Bounded standalone shard, resolved relative to the directory URL. */
  readonly shard: string;
}
export interface TiledTextureMip {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly payloads: readonly number[];
  /** Present only in a virtual packed tail; outer gutter origin. */
  readonly tailOrigin?: readonly [number, number];
}
export interface TiledTexturePlane {
  readonly sourcePlane: number;
  readonly mode: "virtual" | "resident";
  readonly address: TiledTextureAddress;
  readonly tailFirst: number;
  readonly mips: readonly TiledTextureMip[];
}
export interface TiledTextureMetadata {
  readonly schemaVersion: 1;
  readonly recipe: typeof TILED_TEXTURE_RECIPE;
  readonly sourceIdentity: string;
  readonly source: TextureProductMetadata;
  readonly pack: { readonly uri: string; readonly byteLength: number };
  readonly payloads: readonly TiledTexturePayload[];
  readonly planes: readonly TiledTexturePlane[];
}
/** Immutable metadata only. Fine bytes belong to bounded provider leases, never this object. */
export interface TiledTextureDirectory {
  readonly identity: string;
  readonly metadata: TiledTextureMetadata;
  readonly directoryBytes: number;
}

const validatedDirectories = new WeakSet<object>();
export function assertTiledTextureDirectory(value: TiledTextureDirectory): void {
  if (!validatedDirectories.has(value)) {
    throw new Error("Tiled directory must originate from authenticated validation");
  }
}

/** Hash exact directory bytes before parsing; each payload is authenticated separately on read. */
export async function openTiledTextureDirectory(
  bytes: Uint8Array,
  expectedHash: string
): Promise<TiledTextureDirectory> {
  if (bytes.byteLength === 0 || bytes.byteLength > TILED_TEXTURE_DIRECTORY_LIMIT) {
    throw new RangeError("Tiled directory exceeds bounded input");
  }
  checkHash(expectedHash);
  if ((await textureProductHash(bytes)) !== expectedHash) {
    throw new Error("Tiled directory hash mismatch");
  }
  return validateTiledTextureMetadata(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    expectedHash,
    bytes.byteLength
  );
}

/** Internal receipt import rechecks layout, but never rehashes transferred payloads. */
export function validateTiledTextureMetadata(
  input: TiledTextureMetadata,
  identity: string,
  directoryBytes: number
): TiledTextureDirectory {
  checkHash(identity);
  integer(directoryBytes, 1, TILED_TEXTURE_DIRECTORY_LIMIT, "directory bytes");
  // Own the small metadata closure; no caller can mutate validated routes after admission.
  const m = structuredClone(input);
  keys(m, ["schemaVersion", "recipe", "sourceIdentity", "source", "pack", "payloads", "planes"]);
  keys(m.recipe, Object.keys(TILED_TEXTURE_RECIPE));
  if (
    m.schemaVersion !== 1 ||
    (Object.keys(TILED_TEXTURE_RECIPE) as (keyof typeof TILED_TEXTURE_RECIPE)[]).some(
      (key) => m.recipe[key] !== TILED_TEXTURE_RECIPE[key]
    )
  ) {
    throw new Error("Tiled directory schema/recipe mismatch; recook required");
  }
  checkHash(m.sourceIdentity);
  const s = m.source;
  keys(s, [
    "schemaVersion",
    "sourceWidth",
    "sourceHeight",
    "storageWidth",
    "storageHeight",
    "sourceBytes",
    "sourceHash",
    "sourceUri",
    "semantic",
    "channel",
    "exactAlpha",
    "uvScaleBias",
    "recipe",
    "planes"
  ]);
  if (
    s.schemaVersion !== 3 ||
    ![
      "base-color-srgb",
      "normal-linear",
      "orm-linear",
      "occlusion-linear",
      "alpha-mask",
      "emissive-srgb"
    ].includes(s.semantic)
  ) {
    throw new Error("Tiled source semantic/schema invalid");
  }
  for (const size of [s.sourceWidth, s.sourceHeight, s.storageWidth, s.storageHeight]) {
    integer(size, 1, 16384, "source dimension");
  }
  if (
    s.storageWidth !== Math.ceil(s.sourceWidth / 4) * 4 ||
    s.storageHeight !== Math.ceil(s.sourceHeight / 4) * 4
  ) {
    throw new Error("Tiled source storage domain mismatch");
  }
  integer(s.sourceBytes, 1, 128 * 1024 * 1024, "source bytes");
  integer(s.channel, 0, 3, "channel");
  checkHash(s.sourceHash);
  keys(s.recipe, ["encoder", "revision", "binaryHash", "filter", "quality"]);
  checkHash(s.recipe.binaryHash);
  if (
    typeof s.sourceUri !== "string" ||
    typeof s.exactAlpha !== "boolean" ||
    typeof s.recipe.encoder !== "string" ||
    !s.recipe.encoder ||
    typeof s.recipe.revision !== "string" ||
    !s.recipe.revision ||
    JSON.stringify(s.uvScaleBias) !== "[1,1,0,0]" ||
    !["linear", "linear-normal", "provided"].includes(s.recipe.filter) ||
    !["bc7e-scalar-6-bc4-hq", "external-final"].includes(s.recipe.quality) ||
    (s.semantic === "occlusion-linear" && s.exactAlpha)
  ) {
    throw new Error("Tiled source recipe/UV invalid");
  }
  keys(m.pack, ["uri", "byteLength"]);
  relativeUri(m.pack.uri);
  integer(m.pack.byteLength, 1, Number.MAX_SAFE_INTEGER, "pack bytes");
  if (!Array.isArray(m.payloads) || m.payloads.length === 0 || m.payloads.length > TILED_TEXTURE_PAGE_LIMIT) {
    throw new RangeError("Tiled payload directory capacity exceeded");
  }
  let end = 0;
  for (let i = 0; i < m.payloads.length; i++) {
    const p = m.payloads[i]!;
    keys(p, ["id", "offset", "byteLength", "hash", "shard"]);
    if (p.id !== i || p.offset !== end) {
      throw new Error("Tiled payload IDs/ranges overlap or contain holes");
    }
    integer(p.byteLength, 1, TILED_TEXTURE_PAYLOAD_LIMIT, "payload bytes");
    checkHash(p.hash);
    relativeUri(p.shard);
    end += p.byteLength;
    if (!Number.isSafeInteger(end) || end > m.pack.byteLength) {
      throw new RangeError("Tiled payload exceeds pack extent");
    }
  }
  if (end !== m.pack.byteLength) {
    throw new Error("Tiled pack extent mismatch");
  }
  if (
    !Array.isArray(s.planes) ||
    s.planes.length < 1 ||
    s.planes.length > 2 ||
    !Array.isArray(m.planes) ||
    m.planes.length < 1 ||
    m.planes.length > 6
  ) {
    throw new RangeError("Tiled plane directory invalid");
  }
  const expectedRoles =
    s.semantic === "alpha-mask"
      ? ["coverage"]
      : s.exactAlpha
        ? ["color", "coverage"]
        : [s.semantic === "occlusion-linear" ? "scalar" : "color"];
  if (
    s.exactAlpha !== (s.semantic === "alpha-mask" || expectedRoles.includes("coverage")) ||
    s.planes.map((p) => p.role).join() !== expectedRoles.join()
  ) {
    throw new Error("Tiled source plane roles invalid");
  }
  const levels = Math.floor(Math.log2(Math.max(s.storageWidth, s.storageHeight))) + 1;
  for (const plane of s.planes) {
    keys(plane, ["role", "format", "mips"]);
    const format =
      plane.role === "coverage"
        ? "r8unorm"
        : plane.role === "scalar"
          ? "bc4-r-unorm"
          : s.semantic === "base-color-srgb" || s.semantic === "emissive-srgb"
            ? "bc7-rgba-unorm-srgb"
            : "bc7-rgba-unorm";
    if (plane.format !== format || plane.mips.length !== levels) {
      throw new Error("Tiled source format/mip chain invalid");
    }
    for (let l = 0; l < levels; l++) {
      const mip = plane.mips[l]!;
      keys(mip, [
        "level",
        "width",
        "height",
        "physicalWidth",
        "physicalHeight",
        "byteLength",
        "chunkId",
        "hash"
      ]);
      const w = Math.max(1, Math.floor(s.storageWidth / 2 ** l));
      const h = Math.max(1, Math.floor(s.storageHeight / 2 ** l));
      const block = format === "r8unorm" ? 1 : 4;
      if (
        mip.level !== l ||
        mip.width !== w ||
        mip.height !== h ||
        mip.physicalWidth !== Math.ceil(w / block) * block ||
        mip.physicalHeight !== Math.ceil(h / block) * block ||
        mip.byteLength !== encodedTextureMipByteLength(format, w, h) ||
        mip.chunkId !== `${plane.role}-mip-${l}`
      ) {
        throw new Error("Tiled source mip dimensions/extent invalid");
      }
      checkHash(mip.hash);
    }
  }
  const planeKeys = new Set<string>();
  const sourcePlanes = new Set<number>();
  const referenced = new Set<number>();
  for (const plane of m.planes) {
    keys(plane, ["sourcePlane", "mode", "address", "tailFirst", "mips"]);
    integer(plane.sourcePlane, 0, s.planes.length - 1, "source plane");
    const source = s.planes[plane.sourcePlane]!;
    const key = `${plane.sourcePlane}/${plane.address}`;
    if (
      planeKeys.has(key) ||
      !["clamp", "repeat", "mirror"].includes(plane.address) ||
      !["virtual", "resident"].includes(plane.mode) ||
      plane.mips.length !== levels
    ) {
      throw new Error("Tiled plane profile/mip closure invalid");
    }
    planeKeys.add(key);
    sourcePlanes.add(plane.sourcePlane);
    const tailFirst = source.mips.findIndex(
      (mip: { width: number; height: number }) => Math.max(mip.width, mip.height) <= 64
    );
    if (
      plane.tailFirst !== (plane.mode === "virtual" ? tailFirst : -1) ||
      (plane.mode === "virtual" &&
        (source.role === "coverage" || Math.max(s.storageWidth, s.storageHeight) <= 128)) ||
      (plane.mode === "resident" && plane.address !== "clamp") ||
      m.planes.some((p) => p !== plane && p.sourcePlane === plane.sourcePlane && p.mode !== plane.mode)
    ) {
      throw new Error("Tiled protected resident/tail contract invalid");
    }
    let tailPayload = -1;
    for (let level = 0; level < levels; level++) {
      const mip = plane.mips[level]!;
      keys(
        mip,
        ["level", "width", "height", "gridWidth", "gridHeight", "payloads"],
        mip.tailOrigin === undefined ? [] : ["tailOrigin"]
      );
      const original = source.mips[level]!;
      if (
        mip.level !== level ||
        mip.width !== original.width ||
        mip.height !== original.height ||
        !Array.isArray(mip.payloads)
      ) {
        throw new Error("Tiled mip domain mismatch");
      }
      const tail = plane.mode === "virtual" && level >= tailFirst;
      const gw = plane.mode === "resident" || tail ? 1 : Math.ceil(mip.width / 128);
      const gh = plane.mode === "resident" || tail ? 1 : Math.ceil(mip.height / 128);
      const expectedCount =
        plane.mode === "resident" ? Math.ceil(original.byteLength / TILED_TEXTURE_PAYLOAD_LIMIT) : gw * gh;
      if (mip.gridWidth !== gw || mip.gridHeight !== gh || mip.payloads.length !== expectedCount) {
        throw new Error("Tiled mip grid/payload closure mismatch");
      }
      let residentBytes = 0;
      for (const id of mip.payloads) {
        integer(id, 0, m.payloads.length - 1, "payload ID");
        referenced.add(id);
        residentBytes += m.payloads[id]!.byteLength;
        if (
          plane.mode === "virtual" &&
          m.payloads[id]!.byteLength !== encodedTextureMipByteLength(source.format, 144, 144)
        ) {
          throw new Error("Tiled physical tile extent invalid");
        }
      }
      if (plane.mode === "resident" && residentBytes !== original.byteLength) {
        throw new Error("Tiled resident mip byte extent invalid");
      }
      if (tail) {
        const origin = TILED_TEXTURE_TAIL_ORIGINS[level - tailFirst];
        if (!origin || JSON.stringify(origin) !== JSON.stringify(mip.tailOrigin)) {
          throw new Error("Tiled tail rectangle invalid");
        }
        if (tailPayload === -1) {
          tailPayload = mip.payloads[0]!;
        } else if (tailPayload !== mip.payloads[0]) {
          throw new Error("Tiled tail must be one protected slot");
        }
      } else if (mip.tailOrigin !== undefined) {
        throw new Error("Unexpected tiled tail rectangle");
      }
    }
  }
  if (sourcePlanes.size !== s.planes.length || referenced.size !== m.payloads.length) {
    throw new Error("Tiled directory contains orphan planes/payloads");
  }
  freeze(m);
  const directory = Object.freeze({ identity, metadata: m, directoryBytes });
  validatedDirectories.add(directory);
  return directory;
}

export function tiledTextureBootstrapPayloads(directory: TiledTextureDirectory): readonly number[] {
  assertTiledTextureDirectory(directory);
  const ids = new Set<number>();
  for (const plane of directory.metadata.planes) {
    const mips = plane.mode === "resident" ? plane.mips : plane.mips.slice(plane.tailFirst);
    for (const mip of mips) {
      for (const id of mip.payloads) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Tiled ${label} outside admitted domain`);
  }
}
function checkHash(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Tiled hash invalid");
  }
}
function relativeUri(value: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    !/^[a-zA-Z0-9_./-]+$/u.test(value) ||
    value.startsWith("/") ||
    value.split("/").includes("..")
  ) {
    throw new Error("Tiled payload URI must be a relative immutable asset path");
  }
}
function keys(value: object, required: readonly string[], optional: readonly string[] = []): void {
  if (
    !value ||
    typeof value !== "object" ||
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error("Tiled directory unknown/missing fields");
  }
}
function freeze(value: object): void {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      freeze(child);
    }
  }
  Object.freeze(value);
}
