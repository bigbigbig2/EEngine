/**
 * `scene.oescene` contract V3 (schema `oengine-scene-v3`).
 *
 * The Native Offline Cooker writes this JSON alongside the `.oegpack`
 * containers; the Runtime reads it to build a `VirtualGeometrySceneSource`
 * before Geometry Product admission. It carries only pack/asset level indices -
 * Page directories stay in the binary pack metadata - and it never carries GPU
 * state, addresses or descriptor offsets.
 *
 * The parser is strict: unknown keys, malformed hashes, out-of-range indices
 * and non-finite transforms are rejected instead of coerced, so a corrupt or
 * newer manifest can never silently change scene meaning.
 */

export const OEGPACK_SCENE_MANIFEST_SCHEMA_V3 = "oengine-scene-v3";

export interface OegPackSceneManifestPackV3 {
  /** 32-byte pack content hash as lowercase hex; equals the Product identity. */
  readonly packId: string;
  /** Pack file reference, relative to the manifest URL. */
  readonly uri: string;
}

export interface OegPackSceneManifestAssetV3 {
  /** 32-byte cooked geometry asset id as lowercase hex. */
  readonly assetId: string;
  readonly pack: number;
  /** Asset record index inside `pack`; this is the Product asset index. */
  readonly assetRecordIndex: number;
}

export interface OegPackSceneManifestInstanceV3 {
  /** Index into `assets`. */
  readonly asset: number;
  /** Material binding table id; only 0 exists before the material manifest. */
  readonly materialBindingTable: number;
  readonly flags: number;
  /** Column-major world matrix, matching glTF and Runtime instance records. */
  readonly transform: Float32Array;
}

export interface OegPackSceneManifestV3 {
  readonly schema: typeof OEGPACK_SCENE_MANIFEST_SCHEMA_V3;
  readonly packs: readonly OegPackSceneManifestPackV3[];
  readonly assets: readonly OegPackSceneManifestAssetV3[];
  readonly instances: readonly OegPackSceneManifestInstanceV3[];
}

export class OegPackSceneManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OegPackSceneManifestError";
  }
}

/** Parses and validates a `scene.oescene` payload. Accepts text or UTF-8 bytes. */
export function parseOegPackSceneManifestV3(payload: string | ArrayBuffer | Uint8Array): OegPackSceneManifestV3 {
  const text = typeof payload === "string" ? payload : new TextDecoder("utf-8", { fatal: true }).decode(payload);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new OegPackSceneManifestError(`scene manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new OegPackSceneManifestError("scene manifest must be a JSON object");
  requireExactKeys(value, ["schema", "packs", "assets", "instances"], "scene manifest");
  if (value.schema !== OEGPACK_SCENE_MANIFEST_SCHEMA_V3) {
    throw new OegPackSceneManifestError(`scene manifest schema must be '${OEGPACK_SCENE_MANIFEST_SCHEMA_V3}'`);
  }
  const packs = readArray(value.packs, "packs").map((entry, index) => readPack(entry, index));
  const assets = readArray(value.assets, "assets").map((entry, index) => readAsset(entry, index, packs.length));
  const instances = readArray(value.instances, "instances").map((entry, index) => readInstance(entry, index, assets.length));
  return Object.freeze({
    schema: OEGPACK_SCENE_MANIFEST_SCHEMA_V3,
    packs: Object.freeze(packs),
    assets: Object.freeze(assets),
    instances: Object.freeze(instances)
  });
}

/**
 * Resolves the pack file URL for one manifest pack. `manifestUrl` may be a page
 * relative specifier; the returned URL keeps the pack next to the manifest.
 */
export function resolveOegPackScenePackUrlV3(manifestUrl: string, pack: OegPackSceneManifestPackV3): string {
  if (typeof manifestUrl !== "string" || manifestUrl.length === 0) throw new OegPackSceneManifestError("manifest URL must be a non-empty string");
  return new URL(pack.uri, new URL(manifestUrl, globalThis.location?.href ?? "http://localhost/")).href;
}

function readPack(value: unknown, index: number): OegPackSceneManifestPackV3 {
  if (!isRecord(value)) throw new OegPackSceneManifestError(`packs[${index}] must be an object`);
  requireExactKeys(value, ["packId", "uri"], `packs[${index}]`);
  return Object.freeze({
    packId: readHex32(value.packId, `packs[${index}].packId`),
    uri: readNonEmptyString(value.uri, `packs[${index}].uri`)
  });
}

function readAsset(value: unknown, index: number, packCount: number): OegPackSceneManifestAssetV3 {
  if (!isRecord(value)) throw new OegPackSceneManifestError(`assets[${index}] must be an object`);
  requireExactKeys(value, ["assetId", "pack", "assetRecordIndex"], `assets[${index}]`);
  const pack = readU32(value.pack, `assets[${index}].pack`);
  if (pack >= packCount) throw new OegPackSceneManifestError(`assets[${index}].pack ${pack} is outside packs`);
  return Object.freeze({
    assetId: readHex32(value.assetId, `assets[${index}].assetId`),
    pack,
    assetRecordIndex: readU32(value.assetRecordIndex, `assets[${index}].assetRecordIndex`)
  });
}

function readInstance(value: unknown, index: number, assetCount: number): OegPackSceneManifestInstanceV3 {
  if (!isRecord(value)) throw new OegPackSceneManifestError(`instances[${index}] must be an object`);
  requireExactKeys(value, ["asset", "materialBindingTable", "flags", "transform"], `instances[${index}]`);
  const asset = readU32(value.asset, `instances[${index}].asset`);
  if (asset >= assetCount) throw new OegPackSceneManifestError(`instances[${index}].asset ${asset} is outside assets`);
  const raw = readArray(value.transform, `instances[${index}].transform`);
  if (raw.length !== 16) throw new OegPackSceneManifestError(`instances[${index}].transform must have 16 entries`);
  const transform = new Float32Array(16);
  for (let entry = 0; entry < 16; entry++) {
    const component = raw[entry];
    if (typeof component !== "number" || !Number.isFinite(component)) throw new OegPackSceneManifestError(`instances[${index}].transform[${entry}] must be a finite number`);
    transform[entry] = component;
  }
  return Object.freeze({
    asset,
    materialBindingTable: readU32(value.materialBindingTable, `instances[${index}].materialBindingTable`),
    flags: readU32(value.flags, `instances[${index}].flags`),
    transform
  });
}

function readHex32(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new OegPackSceneManifestError(`${label} must be 64 lowercase hex characters`);
  return value;
}

function readU32(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) throw new OegPackSceneManifestError(`${label} must be a u32`);
  return value as number;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new OegPackSceneManifestError(`${label} must be a non-empty string`);
  return value;
}

function readArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new OegPackSceneManifestError(`${label} must be a non-empty array`);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new OegPackSceneManifestError(`${label} contains unknown key '${key}'`);
  for (const key of keys) if (!(key in value)) throw new OegPackSceneManifestError(`${label} is missing '${key}'`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
