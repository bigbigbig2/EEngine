import { APPEARANCE_FIELD_WIDTHS } from "./GpuAppearanceFieldAbi.js";

export const SURFACE_WORK_BANKS = 4;
export const SURFACE_WORK_SETS = 4;
export const SURFACE_WORK_FAMILIES = 2;
export const SURFACE_WORK_PRIVATE_SLOTS = 32;
export const SURFACE_WORK_TILE_EDGE = 8;
/** Position/depth 4, fallback basis 3, numeric guard 1, geometric normal 3,
 * published Appearance entry 1. Tangent/sign are producer-local guide inputs. */
export const SURFACE_WORK_HOT_WORDS = 12;
export const SURFACE_WORK_SIGNALS = 6;
export const SURFACE_WORK_CONTROL_WORDS = 512;
export const SURFACE_WORK_TILE_WORDS = 8;
export const SURFACE_WORK_BUDGET_BYTES = 768 * 1024 * 1024;
export const SURFACE_WORK_INVALID = 0xffffffff;
export const SURFACE_WORK_SIGNAL_OFFSET_WORD = 18;
export const SURFACE_WORK_SIGNAL_WORDS = 19;
export const SURFACE_WORK_COHERENCE_HEADER = 384;
export const SURFACE_WORK_COHERENCE_BINS = 16;
export const SURFACE_WORK_COHERENCE_BUCKET_WORDS = 3;
/** Alpha is consumed by Coverage. Raw TS normals/validity are consumed locally
 * by guide and numeric-guard sinks; Lighting reads world guides only. */
export const SURFACE_WORK_LOCAL_FIELDS = (1 << 1) | (1 << 6) | (1 << 12) | (1 << 13) | (1 << 14);
export const SURFACE_WORK_RETAINED_FIELDS = 0x7fff & ~SURFACE_WORK_LOCAL_FIELDS;

export interface SurfaceWorkCapacity {
  readonly width: number;
  readonly height: number;
  readonly tilesX: number;
  readonly bankRows: number;
  readonly bankPixels: number;
  readonly bankTiles: number;
  readonly tileBase: number;
  readonly queueBase: number;
  readonly recipeBase: number;
  readonly controlBytes: number;
  readonly heapBytes: number;
  readonly signalBytes: number;
  readonly scratchBytes: number;
  readonly fieldOffsets: readonly number[];
  readonly fieldChannels: number;
  readonly workStrideBytes: number;
  readonly hotWords: number;
  readonly guideChannels: number;
  readonly templateCount: number;
  readonly histogramBase: number;
  readonly histogramWords: number;
  readonly coherenceIndexBase: number;
  readonly coherenceCapacity: number;
}

/** Mandatory exact destinations exist independently of sparse admission. Four
 * physical banks are a negotiated resource profile, never reused batch scratch.
 * Per-binding preflight precedes allocation and all arithmetic is checked. */
export function planSurfaceWorkCapacity(
  width: number,
  height: number,
  limits: Pick<
    GPUSupportedLimits,
    | "maxBufferSize"
    | "maxStorageBufferBindingSize"
    | "maxTextureDimension2D"
    | "maxComputeWorkgroupsPerDimension"
  >,
  varyingFields: number,
  temporaryBytes: number,
  lit = true,
  templateCount = 1,
  requestedCoherenceCapacity?: number
): SurfaceWorkCapacity {
  const checked = (value: number, label: string): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`Surface ${label} exceeds its complete u32 profile`);
    }
    return value;
  };
  checked(width, "width");
  checked(height, "height");
  if (!Number.isInteger(varyingFields) || varyingFields < 0 || varyingFields > 0x7fff) {
    throw new RangeError("Invalid Surface field mask");
  }
  varyingFields &= SURFACE_WORK_RETAINED_FIELDS;
  checked(temporaryBytes, "temporary bytes");
  checked(templateCount, "template count");
  if (temporaryBytes < 4 || temporaryBytes % 4 !== 0) {
    throw new RangeError("Surface temporary storage must contain complete live f32 words");
  }
  if (
    width < 1 ||
    height < 1 ||
    width > limits.maxTextureDimension2D ||
    height > limits.maxTextureDimension2D
  ) {
    throw new RangeError("Surface extent exceeds negotiated texture limits");
  }
  const bankRows = Math.ceil(Math.ceil(height / 8) / SURFACE_WORK_BANKS) * 8;
  const bankPixels = checked(width * bankRows, "bank pixels");
  const tilesX = Math.ceil(width / 8);
  const bankTiles = checked(tilesX * (bankRows / 8), "bank tiles");
  const offsets: number[] = [];
  let fieldChannels = 0;
  for (let field = 0; field < APPEARANCE_FIELD_WIDTHS.length; field++) {
    offsets.push((varyingFields & (1 << field)) === 0 ? SURFACE_WORK_INVALID : fieldChannels);
    if ((varyingFields & (1 << field)) !== 0) {
      fieldChannels += APPEARANCE_FIELD_WIDTHS[field]!;
    }
  }
  const tileBase = SURFACE_WORK_CONTROL_WORDS;
  const queueBase = checked(tileBase + SURFACE_WORK_BANKS * bankTiles * SURFACE_WORK_TILE_WORDS, "tile refs");
  const recipeBase = checked(
    queueBase + SURFACE_WORK_BANKS * (SURFACE_WORK_SETS * SURFACE_WORK_FAMILIES + 1) * bankTiles,
    "family queues"
  );
  const histogramBase = checked(recipeBase + SURFACE_WORK_BANKS * bankTiles * 4, "recipe end");
  const maximum = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  const paddedMaximum = checked(bankPixels + 63 * templateCount, "complete packet padding");
  let coherenceCapacity =
    templateCount > 1 ? Math.min(requestedCoherenceCapacity ?? paddedMaximum, paddedMaximum) : 0;
  checked(coherenceCapacity, "optional coherence capacity");
  let histogramWords =
    coherenceCapacity > 0
      ? checked(
          SURFACE_WORK_COHERENCE_BINS * templateCount * SURFACE_WORK_COHERENCE_BUCKET_WORDS,
          "template buckets"
        )
      : 0;
  if ((histogramBase + histogramWords + SURFACE_WORK_COHERENCE_BINS * coherenceCapacity) * 4 > maximum) {
    coherenceCapacity = 0;
    histogramWords = 0;
  }
  let coherenceIndexBase = checked(histogramBase + histogramWords, "coherence indices");
  let controlBytes = checked(
    (coherenceIndexBase + SURFACE_WORK_COHERENCE_BINS * coherenceCapacity) * 4,
    "work control bytes"
  );
  const hotWords = lit ? SURFACE_WORK_HOT_WORDS : 2;
  const guideChannels = lit ? 6 : 0;
  const workStrideBytes = (hotWords + fieldChannels + guideChannels) * 4;
  const heapBytes = checked(bankPixels * workStrideBytes, "Geometry/field bytes");
  const signalBytes = lit ? checked(bankPixels * SURFACE_WORK_SIGNAL_WORDS * 4, "signal bytes") : 16;
  const mandatoryBytes = checked(
    SURFACE_WORK_BANKS * (heapBytes + signalBytes) + temporaryBytes + 8192,
    "mandatory data bytes"
  );
  if (controlBytes + mandatoryBytes > SURFACE_WORK_BUDGET_BYTES && coherenceCapacity > 0) {
    coherenceCapacity = 0;
    histogramWords = 0;
    coherenceIndexBase = histogramBase;
    controlBytes = checked(histogramBase * 4, "indexed control bytes");
  }
  if ([controlBytes, heapBytes, signalBytes, temporaryBytes].some((size) => size > maximum)) {
    throw new RangeError("Complete Surface mandatory bank/lane storage exceeds negotiated binding limits");
  }
  if (
    bankTiles > limits.maxComputeWorkgroupsPerDimension ||
    tilesX > limits.maxComputeWorkgroupsPerDimension
  ) {
    throw new RangeError("Complete Surface tile dispatch exceeds negotiated workgroup limits");
  }
  const scratchBytes = checked(controlBytes + mandatoryBytes, "physical scratch bytes");
  if (scratchBytes > SURFACE_WORK_BUDGET_BYTES) {
    throw new RangeError("Complete Surface mandatory profile exceeds physical scratch budget");
  }
  return Object.freeze({
    width,
    height,
    tilesX,
    bankRows,
    bankPixels,
    bankTiles,
    tileBase,
    queueBase,
    recipeBase,
    controlBytes,
    heapBytes,
    signalBytes,
    scratchBytes,
    fieldOffsets: Object.freeze(offsets),
    fieldChannels,
    workStrideBytes,
    hotWords,
    guideChannels,
    templateCount,
    histogramBase,
    histogramWords,
    coherenceIndexBase,
    coherenceCapacity
  });
}

/** Six RGB planes and one explicit state word; metadata is not packed in alpha.
 * Low six state bits publish validity per kind; transport/residual retain their
 * named packet flags. Rate and frame version belong to the current recipe. */
export const SURFACE_WORK_SIGNAL_READ_WGSL = /* wgsl */ `
fn surface_signal_rgb(pixel: u32, kind: u32) -> vec3f {
  let at = kind * 3u * settings.pixels + pixel;
  return bitcast<vec3f>(vec3u(signal_values[at],
    signal_values[at + settings.pixels], signal_values[at + settings.pixels * 2u]));
}
fn surface_signal_state(pixel: u32) -> u32 {
  return signal_values[${SURFACE_WORK_SIGNAL_OFFSET_WORD}u * settings.pixels + pixel];
}
`;

/** Shared access for closed Geometry + narrow fields. Constants have no pixel
 * slot. Only the Geometry/Appearance producer writes this heap. */
export function surfaceWorkReadWgsl(write: boolean): string {
  const vectorFields = APPEARANCE_FIELD_WIDTHS.reduce(
    (mask, width, field) => mask | (width === 3 ? 1 << field : 0),
    0
  );
  const setter = write
    ? /* wgsl */ `
fn surface_work_store4(pixel: u32, offset: u32, value: vec4f) {
  let words = bitcast<vec4u>(value);
  let at = pixel * settings.source_payload.y + offset;
  work_heap[at] = words.x;
  work_heap[at + 1u] = words.y;
  work_heap[at + 2u] = words.z;
  work_heap[at + 3u] = words.w;
}
fn surface_field_store(pixel: u32, field: u32, channel: u32, value: f32) {
  let offset = dag_metadata[settings.field_offsets + field];
  work_heap[settings.pixels * settings.source_payload.y + (offset + channel) * settings.pixels + pixel] = bitcast<u32>(value);
}
`
    : "";
  return /* wgsl */ `
fn surface_work_vec4(pixel: u32, offset: u32) -> vec4f {
  let at = pixel * settings.source_payload.y + offset;
  return bitcast<vec4f>(vec4u(work_heap[at], work_heap[at + 1u], work_heap[at + 2u], work_heap[at + 3u]));
}
fn surface_work_entry(pixel: u32) -> u32 {
  return work_heap[pixel * settings.source_payload.y + settings.source_payload.y - 1u];
}
fn surface_work_guide(pixel: u32, coat: bool) -> vec3f {
  let channels = dag_metadata[settings.field_offsets + 15u] + select(0u, 3u, coat);
  let at = settings.pixels * settings.source_payload.y + channels * settings.pixels + pixel;
  return bitcast<vec3f>(vec3u(work_heap[at], work_heap[at + settings.pixels], work_heap[at + settings.pixels * 2u]));
}
fn surface_field(pixel: u32, field: u32) -> vec4f {
  let entry = surface_work_entry(pixel);
  let palette = settings.palette + entry * 64u;
  if (dag_metadata[palette] & (1u << field)) != 0u {
    let at = palette + 4u + field * 4u;
    return bitcast<vec4f>(vec4u(dag_metadata[at], dag_metadata[at + 1u], dag_metadata[at + 2u], dag_metadata[at + 3u]));
  }
  let offset = dag_metadata[settings.field_offsets + field];
  let at = settings.pixels * settings.source_payload.y + offset * settings.pixels + pixel;
  let x = bitcast<f32>(work_heap[at]);
  if (${vectorFields}u & (1u << field)) != 0u {
    return vec4f(x, bitcast<f32>(work_heap[at + settings.pixels]),
      bitcast<f32>(work_heap[at + settings.pixels * 2u]), 0.0);
  }
  return vec4f(x, 0.0, 0.0, 0.0);
}
${setter}
`;
}
