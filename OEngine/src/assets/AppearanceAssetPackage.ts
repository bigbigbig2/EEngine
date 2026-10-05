import {
  openRuntimeAssetPackageV2,
  writeRuntimeAssetPackageV2,
  type RuntimeAssetPackageV2,
  type RuntimeAssetChunkInputV2,
  type RuntimeAssetDependencyV2,
} from "./RuntimeAssetManifestV2.js";
import type { AppearanceCookedProduct } from "../material/AppearanceMipCooker.js";
import { encodeFloat16, decodeFloat16 } from "../core/Float16.js";
import {
  APPEARANCE_NORMAL_FILTER_MODEL,
  type AppearanceNormalFilterContract,
} from "../material/AppearanceNormalFilter.js";
import type { AppearanceFieldIdentity } from "../material/AppearanceFieldIdentity.js";

export const APPEARANCE_ASSET_SCHEMA_VERSION = 3;
export const APPEARANCE_COOKER_VERSION = "typed-half-fields-v3";
const METADATA = "appearance-metadata",
  PROFILE = "portable-half-fields";

export interface AppearanceAssetSource {
  readonly uri: string;
  readonly contentHash: string;
  readonly dependencies: readonly RuntimeAssetDependencyV2[];
}
export interface AppearanceAssetMip {
  readonly width: number;
  readonly height: number;
  readonly chunkId: string;
  readonly payload: Uint8Array;
}
export interface AppearanceAssetField {
  /** Validated exact field data/filter identity; unrelated fields do not change this hash. */
  readonly contentKey: string;
  readonly sourceIdentity: AppearanceFieldIdentity;
  readonly name: string;
  readonly width: number;
  readonly format: "r16float" | "rg16float" | "rgba16float" | null;
  readonly constant?: readonly number[];
  readonly mips: readonly AppearanceAssetMip[];
}
export interface AppearanceAssetPackage {
  readonly runtime: RuntimeAssetPackageV2;
  readonly kind: AppearanceCookedProduct["kind"];
  readonly normalFilters: readonly AppearanceNormalFilterContract[];
  readonly fields: readonly AppearanceAssetField[];
  readonly coordinateDomain: string | null;
  readonly domainMin: readonly [number, number];
  readonly domainMax: readonly [number, number];
  readonly residentBytes: number;
  readonly errorBudget: Readonly<{ absolute: number; relative: number }>;
  readonly validation: AppearanceCookedProduct["validation"];
}

/** Local deterministic packing. Only products probed AFTER half quantization enter this profile. */
export async function writeAppearanceAssetPackage(
  product: AppearanceCookedProduct,
  source: AppearanceAssetSource,
): Promise<ArrayBuffer> {
  if (
    (product.kind !== "reevaluated-mip-fields" && product.kind !== "coupled-vmf-moments") ||
    product.storagePrecision !== "float16" ||
    product.validation.maxBudgetRatio > 1
  )
    throw new RangeError("Appearance packing requires a validated half-field product");
  const chunks: RuntimeAssetChunkInputV2[] = [];
  const fields = Object.entries(product.fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, field], index) => {
      if (field.constant !== undefined)
        return {
          name,
          width: field.width,
          sourceIdentity: field.sourceIdentity,
          format: null,
          constantBits: field.constant.map(floatBits),
          mips: [],
        };
      const channels = field.width === 3 ? 4 : field.width;
      const format = channels === 1 ? "r16float" : channels === 2 ? "rg16float" : "rgba16float";
      const mips = field.mips.map((mip, level) => {
        const chunkId = `field-${index}-mip-${level}`;
        const payload = new Uint8Array(mip.width * mip.height * channels * 2),
          view = new DataView(payload.buffer);
        for (let pixel = 0; pixel < mip.width * mip.height; pixel++)
          for (let channel = 0; channel < channels; channel++) {
            const value = channel < field.width ? mip.data[pixel * field.width + channel]! : 1;
            const half = encodeFloat16(value);
            if (!Number.isFinite(value) || !Object.is(decodeFloat16(half), value)) {
              throw new RangeError("Appearance packing cannot quantize unvalidated texels");
            }
            view.setUint16((pixel * channels + channel) * 2, half, true);
          }
        chunks.push({
          id: chunkId,
          sectionType: 0x3000 + chunks.length,
          semantic: `appearance-field-${name}-mip-${level}`,
          compression: format,
          decodedBytes: mip.data.byteLength,
          expectedResidentBytes: payload.byteLength,
          data: payload,
        });
        return { width: mip.width, height: mip.height, chunkId };
      });
      return { name, width: field.width, sourceIdentity: field.sourceIdentity, format, mips };
    });
  const metadata = {
    schemaVersion: APPEARANCE_ASSET_SCHEMA_VERSION,
    colorSpace: "scene-linear-rec709",
    kind: product.kind,
    normalFilters: product.normalFilters ?? [],
    coordinateDomain: product.coordinateDomain,
    domainMin: product.domainMin,
    domainMax: product.domainMax,
    errorBudget: product.errorBudget,
    validation: product.validation,
    fields,
  };
  // Round-trip typed validation also rejects malformed externally constructed products.
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  chunks.unshift({
    id: METADATA,
    sectionType: 0x300,
    semantic: METADATA,
    compression: "none",
    decodedBytes: metadataBytes.byteLength,
    expectedResidentBytes: 0,
    data: metadataBytes,
  });
  const recipeHash = await hash(
    new TextEncoder().encode(
      JSON.stringify({
        cooker: APPEARANCE_COOKER_VERSION,
        kind: product.kind,
        normalFilters: product.normalFilters ?? [],
        filter: product.validation.filter,
        precision: product.storagePrecision,
        errorBudget: product.errorBudget,
      }),
    ),
  );
  const payloadHashes = await Promise.all(
    [...chunks].sort((a, b) => a.id.localeCompare(b.id)).map((chunk) => hash(chunk.data as Uint8Array)),
  );
  const assetId = await hash(
    new TextEncoder().encode(JSON.stringify([source.contentHash.toLowerCase(), recipeHash, payloadHashes])),
  );
  const width = Math.max(1, ...fields.flatMap((field) => field.mips.map((mip) => mip.width)));
  const height = Math.max(1, ...fields.flatMap((field) => field.mips.map((mip) => mip.height)));
  const bytes = await writeRuntimeAssetPackageV2({
    manifest: {
      assetSchemaVersion: APPEARANCE_ASSET_SCHEMA_VERSION,
      assetId,
      assetType: "appearance-fields",
      cookerVersion: APPEARANCE_COOKER_VERSION,
      recipeHash,
      sourceProvenance: { uri: source.uri, contentHash: source.contentHash },
      dependencies: source.dependencies,
      variants: [
        {
          id: PROFILE,
          profile: PROFILE,
          requiredFeatures: [],
          requiredLimits: [
            { name: "maxTextureDimension2D", min: Math.max(width, height) },
            { name: "maxTextureArrayLayers", min: 1 },
          ],
          chunkIds: chunks.map((chunk) => chunk.id),
        },
      ],
    },
    chunks,
  });
  await openAppearanceAssetPackage(bytes);
  return bytes;
}

export async function openAppearanceAssetPackage(bytes: ArrayBuffer): Promise<AppearanceAssetPackage> {
  const runtime = await openRuntimeAssetPackageV2(bytes);
  if (
    runtime.manifest.assetType !== "appearance-fields" ||
    runtime.manifest.assetSchemaVersion !== APPEARANCE_ASSET_SCHEMA_VERSION ||
    runtime.manifest.variants.length !== 1 ||
    runtime.manifest.variants[0]!.profile !== PROFILE
  ) {
    throw new Error("Unsupported Appearance asset profile");
  }
  const encoded = runtime.chunks.get(METADATA);
  if (encoded === undefined) throw new Error("Appearance metadata missing");
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded));
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== APPEARANCE_ASSET_SCHEMA_VERSION ||
    raw.colorSpace !== "scene-linear-rec709" ||
    (raw.kind !== "reevaluated-mip-fields" && raw.kind !== "coupled-vmf-moments") ||
    !Array.isArray(raw.normalFilters) ||
    (raw.coordinateDomain !== null &&
      (typeof raw.coordinateDomain !== "string" || raw.coordinateDomain.length === 0)) ||
    !vec2(raw.domainMin) ||
    !vec2(raw.domainMax) ||
    raw.domainMax[0] <= raw.domainMin[0] ||
    raw.domainMax[1] <= raw.domainMin[1] ||
    !Number.isFinite(Math.fround(raw.domainMax[0] - raw.domainMin[0])) ||
    !Number.isFinite(Math.fround(raw.domainMax[1] - raw.domainMin[1])) ||
    !isRecord(raw.errorBudget) ||
    !nonnegative(raw.errorBudget.absolute) ||
    !nonnegative(raw.errorBudget.relative) ||
    !isRecord(raw.validation) ||
    raw.validation.filter !== "bilinear-clamp-trilinear" ||
    !integer(raw.validation.probeCount, 0) ||
    !nonnegative(raw.validation.maxAbsoluteError) ||
    !nonnegative(raw.validation.maxBudgetRatio) ||
    raw.validation.maxBudgetRatio > 1 ||
    !Array.isArray(raw.fields) ||
    raw.fields.length === 0 ||
    raw.fields.length > 4096
  ) {
    throw new RangeError("Invalid Appearance coordinate/filter/quality metadata");
  }
  const names = new Set<string>(),
    used = new Set<string>([METADATA]);
  let residentBytes = 0;
  const decodedFields: Omit<AppearanceAssetField, "contentKey">[] = raw.fields.map((field: unknown) => {
    if (
      !isRecord(field) ||
      typeof field.name !== "string" ||
      field.name.length === 0 ||
      names.has(field.name) ||
      !integer(field.width, 1) ||
      field.width > 4 ||
      !Array.isArray(field.mips)
    )
      throw new RangeError("Invalid Appearance field");
    names.add(field.name);
    const identity = field.sourceIdentity;
    const rootCount = raw.kind === "coupled-vmf-moments" ? 4 : field.width;
    if (
      !isRecord(identity) ||
      typeof identity.key !== "string" ||
      identity.key.length === 0 ||
      identity.key.length > 1024 * 1024 ||
      typeof identity.portable !== "boolean" ||
      !Array.isArray(identity.components) ||
      identity.components.length !== rootCount ||
      !identity.components.every(
        (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 1024 * 1024,
      )
    ) {
      throw new RangeError("Invalid Appearance field source identity");
    }
    const sourceIdentity = Object.freeze({
      key: identity.key,
      portable: identity.portable,
      components: Object.freeze([...identity.components]) as readonly string[],
    });
    if (field.format === null) {
      if (
        field.mips.length !== 0 ||
        !Array.isArray(field.constantBits) ||
        field.constantBits.length !== field.width ||
        !field.constantBits.every((n: unknown) => integer(n, 0) && (n as number) <= 0xffffffff)
      ) {
        throw new RangeError("Invalid Appearance constant field");
      }
      const constant = field.constantBits.map(bitsFloat);
      if (!constant.every(Number.isFinite)) throw new RangeError("Nonfinite Appearance constant");
      return Object.freeze({
        name: field.name,
        width: field.width,
        sourceIdentity,
        format: null,
        constant: Object.freeze(constant),
        mips: Object.freeze([]),
      });
    }
    const channels = field.width === 3 ? 4 : field.width;
    const fieldWidth = field.width;
    const format = channels === 1 ? "r16float" : channels === 2 ? "rg16float" : "rgba16float";
    if (
      field.format !== format ||
      field.constantBits !== undefined ||
      field.mips.length < 1 ||
      field.mips.length > 15
    ) {
      throw new RangeError("Invalid Appearance field format/mip count");
    }
    let previous: { width: number; height: number } | undefined;
    const mips = field.mips.map((mip: unknown, level: number): AppearanceAssetMip => {
      if (
        !isRecord(mip) ||
        !integer(mip.width, 1) ||
        !integer(mip.height, 1) ||
        mip.width > 16384 ||
        mip.height > 16384 ||
        typeof mip.chunkId !== "string" ||
        used.has(mip.chunkId) ||
        (previous !== undefined &&
          (mip.width !== Math.max(1, Math.floor(previous.width / 2)) ||
            mip.height !== Math.max(1, Math.floor(previous.height / 2))))
      ) {
        throw new RangeError("Invalid Appearance mip dimensions/identity");
      }
      if (level > 0 && previous?.width === 1 && previous.height === 1)
        throw new RangeError("Appearance mip chain repeats 1x1");
      const payload = runtime.chunks.get(mip.chunkId);
      const directory = runtime.manifest.chunks.find((chunk) => chunk.id === mip.chunkId);
      const bytes = mip.width * mip.height * channels * 2;
      if (
        payload === undefined ||
        directory === undefined ||
        payload.byteLength !== bytes ||
        directory.expectedResidentBytes !== bytes ||
        directory.compression !== format ||
        directory.decodedBytes !== mip.width * mip.height * fieldWidth * 4
      ) {
        throw new RangeError("Appearance mip payload ABI mismatch");
      }
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      for (let i = 0; i < bytes; i += 2)
        if (!Number.isFinite(decodeFloat16(view.getUint16(i, true)))) {
          throw new RangeError("Nonfinite Appearance mip payload");
        }
      used.add(mip.chunkId);
      previous = { width: mip.width, height: mip.height };
      residentBytes += bytes;
      return Object.freeze({ width: mip.width, height: mip.height, chunkId: mip.chunkId, payload });
    });
    return Object.freeze({
      name: field.name,
      width: field.width,
      sourceIdentity,
      format,
      mips: Object.freeze(mips),
    });
  });
  const filter = raw.validation.filter;
  const fields: AppearanceAssetField[] = await Promise.all(
    decodedFields.map(async (field) =>
      Object.freeze({
        ...field,
        contentKey: await hash(
          new TextEncoder().encode(
            JSON.stringify([
              "appearance-filtered-field-v1",
              raw.kind,
              raw.kind === "coupled-vmf-moments" ? APPEARANCE_NORMAL_FILTER_MODEL : null,
              raw.coordinateDomain,
              raw.domainMin,
              raw.domainMax,
              filter,
              field.width,
              field.format,
              field.sourceIdentity.key,
              field.constant?.map(floatBits) ?? null,
              field.mips.map((mip) => [
                mip.width,
                mip.height,
                runtime.manifest.chunks.find((chunk) => chunk.id === mip.chunkId)!.checksum,
              ]),
            ]),
          ),
        ),
      }),
    ),
  );
  if (
    used.size !== runtime.chunks.size ||
    runtime.manifest.variants[0]!.chunkIds.some((id) => !used.has(id)) ||
    (fields.some((field) => field.mips.length > 0) &&
      (raw.coordinateDomain === null || raw.validation.probeCount === 0))
  ) {
    throw new RangeError("Appearance chunks or variable field domain/validation are incomplete");
  }
  const momentFields = new Set<string>(),
    normalOutputs = new Set<string>();
  const normalFilters: AppearanceNormalFilterContract[] = raw.normalFilters.map((item: unknown) => {
    if (
      !isRecord(item) ||
      item.model !== APPEARANCE_NORMAL_FILTER_MODEL ||
      typeof item.momentField !== "string" ||
      momentFields.has(item.momentField) ||
      !fields.some((field) => field.name === item.momentField && field.width === 3) ||
      typeof item.normalOutput !== "string" ||
      !item.normalOutput ||
      normalOutputs.has(item.normalOutput) ||
      typeof item.roughnessOutput !== "string" ||
      !item.roughnessOutput ||
      normalOutputs.has(item.roughnessOutput) ||
      item.normalOutput === item.roughnessOutput ||
      !nonnegative(item.maxAngleRadians) ||
      item.maxAngleRadians > Math.PI ||
      !nonnegative(item.maxRoughnessError) ||
      !nonnegative(item.measuredAngleRadians) ||
      !nonnegative(item.measuredRoughnessError) ||
      item.measuredAngleRadians > item.maxAngleRadians ||
      item.measuredRoughnessError > item.maxRoughnessError
    )
      throw new RangeError("Invalid Appearance normal filter contract");
    momentFields.add(item.momentField);
    normalOutputs.add(item.normalOutput);
    normalOutputs.add(item.roughnessOutput);
    return Object.freeze({
      model: APPEARANCE_NORMAL_FILTER_MODEL,
      momentField: item.momentField,
      normalOutput: item.normalOutput,
      roughnessOutput: item.roughnessOutput,
      maxAngleRadians: item.maxAngleRadians,
      maxRoughnessError: item.maxRoughnessError,
      measuredAngleRadians: item.measuredAngleRadians,
      measuredRoughnessError: item.measuredRoughnessError,
    });
  });
  if (
    (raw.kind === "coupled-vmf-moments" && momentFields.size !== fields.length) ||
    (raw.kind === "reevaluated-mip-fields" && momentFields.size !== 0)
  ) {
    throw new RangeError("Appearance product kind does not match its normal filter fields");
  }
  const expectedAssetId = await hash(
    new TextEncoder().encode(
      JSON.stringify([
        runtime.manifest.sourceProvenance.contentHash,
        runtime.manifest.recipeHash,
        runtime.manifest.chunks.map((chunk) => chunk.checksum),
      ]),
    ),
  );
  if (runtime.manifest.assetId !== expectedAssetId)
    throw new RangeError("Appearance assetId does not identify its validated content");
  return Object.freeze({
    runtime,
    kind: raw.kind,
    normalFilters: Object.freeze(normalFilters),
    fields: Object.freeze(fields),
    coordinateDomain: raw.coordinateDomain,
    domainMin: Object.freeze([...raw.domainMin]) as readonly [number, number],
    domainMax: Object.freeze([...raw.domainMax]) as readonly [number, number],
    residentBytes,
    errorBudget: Object.freeze({ absolute: raw.errorBudget.absolute, relative: raw.errorBudget.relative }),
    validation: Object.freeze({
      filter: "bilinear-clamp-trilinear",
      probeCount: raw.validation.probeCount,
      maxAbsoluteError: raw.validation.maxAbsoluteError,
      maxBudgetRatio: raw.validation.maxBudgetRatio,
    }),
  });
}

function floatBits(value: number): number {
  const data = new DataView(new ArrayBuffer(4));
  data.setFloat32(0, value, true);
  return data.getUint32(0, true);
}
function bitsFloat(value: number): number {
  const data = new DataView(new ArrayBuffer(4));
  data.setUint32(0, value, true);
  return data.getFloat32(0, true);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown, min: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function vec2(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === "number" && Number.isFinite(Math.fround(n)))
  );
}
async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
}
