import {
  RUNTIME_ASSET_DIRECTORY_ENTRY_SIZE,
  RUNTIME_ASSET_FORMAT_VERSION_V2,
  RUNTIME_ASSET_HEADER_SIZE,
  openRuntimeAssetPackage,
  writeRuntimeAssetPackage,
  type RuntimeAssetPackage,
  type RuntimeAssetValidationIssue
} from "./RuntimeAssetPackage.js";

export const RUNTIME_ASSET_MANIFEST_V2_SCHEMA_VERSION = 2;
export const RUNTIME_ASSET_MANIFEST_V2_SECTION = 0x100;

export interface RuntimeAssetSourceProvenanceV2 {
  readonly uri: string;
  readonly contentHash: string;
}

export interface RuntimeAssetDependencyV2 {
  readonly assetId: string;
  readonly required: boolean;
}

export interface RuntimeAssetChunkV2 {
  readonly id: string;
  readonly sectionType: number;
  readonly semantic: string;
  readonly compression: string;
  readonly alignment: number;
  /** Absolute byte range in the canonical Runtime Asset container. */
  readonly byteOffset: number;
  readonly compressedBytes: number;
  readonly decodedBytes: number;
  readonly expectedResidentBytes: number;
  /** Variants which consume this chunk; shared metadata may name several. */
  readonly variantIds: readonly string[];
  readonly checksum: string;
}

export interface RuntimeAssetVariantV2 {
  readonly id: string;
  readonly profile: string;
  readonly requiredFeatures: readonly string[];
  readonly requiredLimits: readonly RuntimeAssetLimitRequirementV2[];
  readonly chunkIds: readonly string[];
}

export interface RuntimeAssetLimitRequirementV2 {
  readonly name: string;
  readonly min: number;
}

export interface RuntimeAssetManifestV2 {
  readonly schemaVersion: 2;
  readonly assetSchemaVersion: number;
  readonly assetId: string;
  readonly assetType: string;
  readonly cookerVersion: string;
  readonly recipeHash: string;
  readonly sourceProvenance: RuntimeAssetSourceProvenanceV2;
  readonly dependencies: readonly RuntimeAssetDependencyV2[];
  readonly variants: readonly RuntimeAssetVariantV2[];
  readonly chunks: readonly RuntimeAssetChunkV2[];
}

export interface RuntimeAssetChunkInputV2 {
  readonly id: string;
  readonly sectionType: number;
  readonly semantic: string;
  readonly compression: string;
  readonly alignment?: number;
  readonly decodedBytes: number;
  readonly expectedResidentBytes: number;
  readonly data: ArrayBuffer | ArrayBufferView;
}

export interface RuntimeAssetPackageWriteInputV2 {
  readonly manifest: Omit<RuntimeAssetManifestV2, "schemaVersion" | "chunks">;
  readonly chunks: readonly RuntimeAssetChunkInputV2[];
}

export interface RuntimeAssetPackageV2 {
  readonly package: RuntimeAssetPackage;
  readonly manifest: RuntimeAssetManifestV2;
  readonly chunks: ReadonlyMap<string, Uint8Array>;
  readonly metadataBytes: Uint8Array;
}

export class RuntimeAssetManifestV2Error extends Error {
  readonly issues: readonly RuntimeAssetValidationIssue[];

  constructor(issues: readonly RuntimeAssetValidationIssue[]) {
    super(issues[0]?.message ?? "Runtime Asset Manifest V2 validation failed");
    this.name = "RuntimeAssetManifestV2Error";
    this.issues = issues;
  }
}

export async function writeRuntimeAssetPackageV2(
  input: RuntimeAssetPackageWriteInputV2
): Promise<ArrayBuffer> {
  const chunks = [...input.chunks].sort((a, b) => a.id.localeCompare(b.id));
  const seenIds = new Set<string>();
  const seenSections = new Set<number>([RUNTIME_ASSET_MANIFEST_V2_SECTION]);
  const payloads = new Map<number, Uint8Array>();
  const manifestChunks: RuntimeAssetChunkV2[] = [];
  for (const chunk of chunks) {
    assertIdentifier(chunk.id, "chunk id");
    if (seenIds.has(chunk.id)) throw new RangeError(`Duplicate chunk id '${chunk.id}'`);
    seenIds.add(chunk.id);
    assertSectionType(chunk.sectionType);
    if (seenSections.has(chunk.sectionType)) {
      throw new RangeError(`Duplicate or reserved chunk section type ${chunk.sectionType}`);
    }
    seenSections.add(chunk.sectionType);
    const data = copyBytes(chunk.data);
    payloads.set(chunk.sectionType, data);
    const alignment = chunk.alignment ?? 4;
    assertPowerOfTwo(alignment, `Chunk '${chunk.id}' alignment`);
    assertNonNegativeInteger(chunk.decodedBytes, `Chunk '${chunk.id}' decodedBytes`);
    assertNonNegativeInteger(chunk.expectedResidentBytes, `Chunk '${chunk.id}' expectedResidentBytes`);
    manifestChunks.push(Object.freeze({
      id: chunk.id,
      sectionType: chunk.sectionType,
      semantic: requireText(chunk.semantic, `Chunk '${chunk.id}' semantic`),
      compression: requireText(chunk.compression, `Chunk '${chunk.id}' compression`),
      alignment,
      byteOffset: 0,
      compressedBytes: data.byteLength,
      decodedBytes: chunk.decodedBytes,
      expectedResidentBytes: chunk.expectedResidentBytes,
      variantIds: Object.freeze([]),
      checksum: await sha256Hex(data)
    }));
  }
  let manifest = normalizeManifest({
    ...input.manifest,
    schemaVersion: RUNTIME_ASSET_MANIFEST_V2_SCHEMA_VERSION,
    chunks: manifestChunks
  });
  for (let iteration = 0; iteration < 8; iteration++) {
    const metadataBytes = new TextEncoder().encode(canonicalJson(manifest));
    const byteOffsets = packageSectionOffsets(metadataBytes.byteLength, chunks, payloads);
    let changed = false;
    const laidOutChunks = manifest.chunks.map((chunk) => {
      const byteOffset = byteOffsets.get(chunk.sectionType);
      if (byteOffset === undefined) throw new Error(`Runtime package writer lost chunk '${chunk.id}'`);
      changed ||= chunk.byteOffset !== byteOffset;
      return { ...chunk, byteOffset };
    });
    if (!changed) {
      return writeRuntimeAssetPackage({
        formatVersion: RUNTIME_ASSET_FORMAT_VERSION_V2,
        sections: [
          {
            type: RUNTIME_ASSET_MANIFEST_V2_SECTION,
            required: true,
            data: metadataBytes,
            elementStride: 1,
            elementCount: metadataBytes.byteLength,
            alignment: 4
          },
          ...chunks.map((chunk) => {
            const bytes = payloads.get(chunk.sectionType)!;
            return {
              type: chunk.sectionType,
              required: false,
              data: bytes,
              elementStride: 1,
              elementCount: bytes.byteLength,
              alignment: chunk.alignment ?? 4
            };
          })
        ]
      });
    }
    manifest = normalizeManifest({ ...manifest, chunks: laidOutChunks });
  }
  throw new Error("Runtime Asset Manifest V2 layout did not converge");
}

function packageSectionOffsets(
  manifestBytes: number,
  chunks: readonly RuntimeAssetChunkInputV2[],
  payloads: ReadonlyMap<number, Uint8Array>
): ReadonlyMap<number, number> {
  const sections = [
    { type: RUNTIME_ASSET_MANIFEST_V2_SECTION, alignment: 4, byteLength: manifestBytes },
    ...chunks.map((chunk) => ({
      type: chunk.sectionType,
      alignment: chunk.alignment ?? 4,
      byteLength: payloads.get(chunk.sectionType)!.byteLength
    }))
  ].sort((left, right) => left.type - right.type);
  let cursor = RUNTIME_ASSET_HEADER_SIZE + sections.length * RUNTIME_ASSET_DIRECTORY_ENTRY_SIZE;
  const result = new Map<number, number>();
  for (const section of sections) {
    cursor = Math.ceil(cursor / section.alignment) * section.alignment;
    if (!Number.isSafeInteger(cursor)) throw new RangeError("Runtime Asset Manifest V2 layout overflows JavaScript safe integers");
    result.set(section.type, cursor);
    cursor += section.byteLength;
  }
  return result;
}

export async function openRuntimeAssetPackageV2(
  bytes: ArrayBuffer
): Promise<RuntimeAssetPackageV2> {
  const pkg = await openRuntimeAssetPackage(bytes, {
    supportedSectionTypes: new Set([RUNTIME_ASSET_MANIFEST_V2_SECTION])
  });
  if (pkg.manifest.formatVersion !== RUNTIME_ASSET_FORMAT_VERSION_V2) {
    throw manifestError("container-version", `Runtime Asset Manifest V2 requires container version ${RUNTIME_ASSET_FORMAT_VERSION_V2}`);
  }
  const section = pkg.section(RUNTIME_ASSET_MANIFEST_V2_SECTION);
  if (section === undefined) {
    throw manifestError("manifest-missing", "Runtime Asset Manifest V2 section is missing");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(section.bytes));
  } catch (error) {
    throw manifestError("manifest-decode", `Runtime Asset Manifest V2 is not valid UTF-8 JSON: ${errorMessage(error)}`);
  }
  const manifest = validateManifest(raw);
  const chunks = new Map<string, Uint8Array>();
  const declaredSections = new Set<number>([RUNTIME_ASSET_MANIFEST_V2_SECTION]);
  for (const chunk of manifest.chunks) {
    declaredSections.add(chunk.sectionType);
    const payload = pkg.section(chunk.sectionType);
    if (payload === undefined) {
      throw manifestError("chunk-missing", `Manifest chunk '${chunk.id}' section ${chunk.sectionType} is missing`, chunk.sectionType);
    }
    if (payload.byteOffset % chunk.alignment !== 0) {
      throw manifestError("chunk-alignment", `Manifest chunk '${chunk.id}' is not ${chunk.alignment}-byte aligned`, chunk.sectionType);
    }
    if (payload.byteOffset !== chunk.byteOffset || payload.byteLength !== chunk.compressedBytes) {
      throw manifestError(
        "chunk-range",
        `Manifest chunk '${chunk.id}' byte range does not match the container directory`,
        chunk.sectionType
      );
    }
    const checksum = await sha256Hex(payload.bytes);
    if (checksum !== chunk.checksum) {
      throw manifestError("chunk-checksum", `Manifest chunk '${chunk.id}' checksum does not match`, chunk.sectionType);
    }
    chunks.set(chunk.id, payload.bytes);
  }
  for (const payload of pkg.sections) {
    if (!declaredSections.has(payload.type)) {
      throw manifestError("chunk-undeclared", `Container section ${payload.type} is not declared by the manifest`, payload.type);
    }
  }
  return Object.freeze({
    package: pkg,
    manifest,
    chunks,
    metadataBytes: section.bytes
  });
}

export function selectRuntimeAssetVariantV2(
  manifest: RuntimeAssetManifestV2,
  availableFeatures: ReadonlySet<string>,
  preferredProfiles: readonly string[] = [],
  availableLimits?: Readonly<Record<string, number>>
): RuntimeAssetVariantV2 {
  const profileRank = new Map(preferredProfiles.map((profile, index) => [profile, index]));
  const candidates = manifest.variants
    .filter((variant) => variant.requiredFeatures.every((feature) => availableFeatures.has(feature)))
    .filter((variant) => availableLimits === undefined || variant.requiredLimits.every(({ name, min }) => {
      const actual = availableLimits[name];
      return actual !== undefined && Number.isFinite(actual) && actual >= min;
    }))
    .sort((left, right) => {
      const leftRank = profileRank.get(left.profile) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = profileRank.get(right.profile) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.id.localeCompare(right.id);
    });
  const selected = candidates[0];
  if (selected === undefined) {
    throw manifestError(
      "variant-unavailable",
      `Asset '${manifest.assetId}' has no variant compatible with the enabled capability set`
    );
  }
  return selected;
}

function validateManifest(raw: unknown): RuntimeAssetManifestV2 {
  if (!isRecord(raw)) throw manifestError("manifest-shape", "Runtime Asset Manifest V2 must be an object");
  const manifest = normalizeManifest(raw as unknown as RuntimeAssetManifestV2);
  if (canonicalJson(raw) !== canonicalJson(manifest)) {
    throw manifestError("manifest-noncanonical", "Runtime Asset Manifest V2 contains unknown or non-normalized fields");
  }
  return manifest;
}

function normalizeManifest(input: RuntimeAssetManifestV2): RuntimeAssetManifestV2 {
  if (input.schemaVersion !== RUNTIME_ASSET_MANIFEST_V2_SCHEMA_VERSION) {
    throw manifestError("manifest-version", `Unsupported Runtime Asset Manifest schema ${String(input.schemaVersion)}`);
  }
  assertPositiveInteger(input.assetSchemaVersion, "assetSchemaVersion");
  assertHash(input.assetId, "assetId");
  assertHash(input.recipeHash, "recipeHash");
  if (!isRecord(input.sourceProvenance)) {
    throw manifestError("source-provenance", "sourceProvenance must be an object");
  }
  assertHash(input.sourceProvenance.contentHash, "sourceProvenance.contentHash");
  const dependencies = [...requireArray(input.dependencies, "dependencies")].map((dependency, index) => {
    if (!isRecord(dependency) || typeof dependency.required !== "boolean") {
      throw manifestError("dependency-shape", `dependencies[${index}] is invalid`);
    }
    assertHash(dependency.assetId, `dependencies[${index}].assetId`);
    return Object.freeze({ assetId: dependency.assetId.toLowerCase(), required: dependency.required });
  }).sort((a, b) => a.assetId.localeCompare(b.assetId));
  if (new Set(dependencies.map(({ assetId }) => assetId)).size !== dependencies.length) {
    throw manifestError("dependency-duplicate", "Manifest dependency asset ids must be unique");
  }
  if (dependencies.some(({ assetId }) => assetId === input.assetId.toLowerCase())) {
    throw manifestError("dependency-self", "Manifest asset cannot depend on itself");
  }
  const rawChunks = [...requireArray(input.chunks, "chunks")].map((chunk, index) => normalizeChunk(chunk, index))
    .sort((a, b) => a.id.localeCompare(b.id));
  const chunkIds = new Set(rawChunks.map((chunk) => chunk.id));
  if (chunkIds.size !== rawChunks.length) throw manifestError("chunk-duplicate", "Manifest chunk ids must be unique");
  const sectionTypes = new Set(rawChunks.map((chunk) => chunk.sectionType));
  if (sectionTypes.size !== rawChunks.length) throw manifestError("chunk-section-duplicate", "Manifest chunk section types must be unique");
  if (sectionTypes.has(RUNTIME_ASSET_MANIFEST_V2_SECTION)) {
    throw manifestError("chunk-section-reserved", "Manifest payload chunks cannot use the manifest section type");
  }
  const variants = [...requireArray(input.variants, "variants")].map((variant, index) => {
    if (!isRecord(variant)) throw manifestError("variant-shape", `variants[${index}] is invalid`);
    const ids = [...requireArray(variant.chunkIds, `variants[${index}].chunkIds`)].map((id) => requireText(id, "variant chunk id")).sort();
    if (new Set(ids).size !== ids.length) {
      throw manifestError("variant-chunk-duplicate", `Variant '${String(variant.id)}' contains duplicate chunk ids`);
    }
    for (const id of ids) {
      if (!chunkIds.has(id)) throw manifestError("variant-chunk-missing", `Variant '${String(variant.id)}' references unknown chunk '${id}'`);
    }
    const id = requireText(variant.id, `variants[${index}].id`);
    assertIdentifier(id, `variants[${index}].id`);
    const requiredFeatures = [...requireArray(variant.requiredFeatures, `variants[${index}].requiredFeatures`)]
      .map((feature) => requireText(feature, "required feature"))
      .sort();
    if (new Set(requiredFeatures).size !== requiredFeatures.length) {
      throw manifestError("variant-feature-duplicate", `Variant '${id}' contains duplicate required features`);
    }
    const requiredLimits = [...requireArray(variant.requiredLimits, `variants[${index}].requiredLimits`)]
      .map((limit, limitIndex): RuntimeAssetLimitRequirementV2 => {
        if (!isRecord(limit)) throw manifestError("variant-limit-shape", `Variant '${id}' limit ${limitIndex} is invalid`);
        const name = canonicalLimitName(limit.name, `variants[${index}].requiredLimits[${limitIndex}].name`);
        assertPositiveInteger(limit.min, `variants[${index}].requiredLimits[${limitIndex}].min`);
        return Object.freeze({ name, min: limit.min });
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    if (new Set(requiredLimits.map(({ name }) => name)).size !== requiredLimits.length) {
      throw manifestError("variant-limit-duplicate", `Variant '${id}' contains duplicate required limits`);
    }
    return Object.freeze({
      id,
      profile: requireText(variant.profile, `variants[${index}].profile`),
      requiredFeatures: Object.freeze(requiredFeatures),
      requiredLimits: Object.freeze(requiredLimits),
      chunkIds: Object.freeze(ids)
    });
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
    throw manifestError("variant-duplicate", "Manifest variant ids must be unique");
  }
  if (variants.length === 0) throw manifestError("variant-empty", "Manifest must contain at least one variant");
  const variantIdsByChunk = new Map(rawChunks.map((chunk) => [chunk.id, [] as string[]]));
  for (const variant of variants) {
    for (const chunkId of variant.chunkIds) variantIdsByChunk.get(chunkId)!.push(variant.id);
  }
  const chunks = rawChunks.map((chunk) => {
    const variantIds = variantIdsByChunk.get(chunk.id)!;
    if (variantIds.length === 0) {
      throw manifestError("chunk-orphan", `Manifest chunk '${chunk.id}' is not consumed by any variant`, chunk.sectionType);
    }
    return Object.freeze({ ...chunk, variantIds: Object.freeze(variantIds.sort()) });
  });
  return Object.freeze({
    schemaVersion: 2,
    assetSchemaVersion: input.assetSchemaVersion,
    assetId: input.assetId.toLowerCase(),
    assetType: requireText(input.assetType, "assetType"),
    cookerVersion: requireText(input.cookerVersion, "cookerVersion"),
    recipeHash: input.recipeHash.toLowerCase(),
    sourceProvenance: Object.freeze({
      uri: requireText(input.sourceProvenance.uri, "sourceProvenance.uri"),
      contentHash: input.sourceProvenance.contentHash.toLowerCase()
    }),
    dependencies: Object.freeze(dependencies),
    variants: Object.freeze(variants),
    chunks: Object.freeze(chunks)
  });
}

function normalizeChunk(raw: unknown, index: number): RuntimeAssetChunkV2 {
  if (!isRecord(raw)) throw manifestError("chunk-shape", `chunks[${index}] is invalid`);
  assertSectionType(raw.sectionType);
  assertPowerOfTwo(raw.alignment, `chunks[${index}].alignment`);
  assertNonNegativeInteger(raw.byteOffset, `chunks[${index}].byteOffset`);
  assertNonNegativeInteger(raw.compressedBytes, `chunks[${index}].compressedBytes`);
  assertNonNegativeInteger(raw.decodedBytes, `chunks[${index}].decodedBytes`);
  assertNonNegativeInteger(raw.expectedResidentBytes, `chunks[${index}].expectedResidentBytes`);
  assertHash(raw.checksum, `chunks[${index}].checksum`);
  return Object.freeze({
    id: canonicalIdentifier(raw.id, `chunks[${index}].id`),
    sectionType: raw.sectionType,
    semantic: requireText(raw.semantic, `chunks[${index}].semantic`),
    compression: requireText(raw.compression, `chunks[${index}].compression`),
    alignment: raw.alignment,
    byteOffset: raw.byteOffset,
    compressedBytes: raw.compressedBytes,
    decodedBytes: raw.decodedBytes,
    expectedResidentBytes: raw.expectedResidentBytes,
    variantIds: Object.freeze([]),
    checksum: raw.checksum.toLowerCase()
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical package metadata cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`Canonical package metadata cannot contain ${typeof value}`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function copyBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

function assertHash(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw manifestError("hash-invalid", `${name} must be a 64-character SHA-256 hex digest`);
  }
}

function assertSectionType(value: unknown): asserts value is number {
  assertPositiveInteger(value, "sectionType");
  if (value > 0xffffffff) throw new RangeError("sectionType must fit u32");
}

function assertPowerOfTwo(value: unknown, name: string): asserts value is number {
  assertPositiveInteger(value, name);
  if (value < 4 || value > (1 << 20) || (value & (value - 1)) !== 0) {
    throw new RangeError(`${name} must be a power of two in [4, 1 MiB]`);
  }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new RangeError(`${name} '${value}' is not canonical`);
}

function canonicalIdentifier(value: unknown, name: string): string {
  const text = requireText(value, name);
  assertIdentifier(text, name);
  return text;
}

function canonicalLimitName(value: unknown, name: string): string {
  const text = requireText(value, name);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(text)) throw new RangeError(`${name} '${text}' is not a canonical WebGPU limit name`);
  return text;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw manifestError("text-invalid", `${name} must be a non-empty string`);
  return value;
}

function requireArray(value: unknown, name: string): readonly any[] {
  if (!Array.isArray(value)) throw manifestError("array-invalid", `${name} must be an array`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestError(code: string, message: string, sectionType?: number): RuntimeAssetManifestV2Error {
  return new RuntimeAssetManifestV2Error([Object.freeze({ severity: "error", code, message, sectionType })]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
