import { VSM_FILTER_DATA_BYTES } from "./GpuVsmFilterAbi.js";
/** Internal V5 ABI used by the production Final Pixel frame program. */
export const FINAL_PIXEL_DIRECTORY_WORDS = 8;
export const FINAL_PIXEL_SOLAR_WIDTH = 256;
export const FINAL_PIXEL_SOLAR_HEIGHT = 64;
export const FINAL_PIXEL_SOLAR_BYTES = FINAL_PIXEL_SOLAR_WIDTH * FINAL_PIXEL_SOLAR_HEIGHT * 8;
export const FINAL_PIXEL_LIGHTING_RANGES_BYTES = 112;
export const FINAL_PIXEL_DIRECTORY_WGSL = /* wgsl */ `
struct NativeMaterialDirectoryEntry {
  constant_base: u32,
  program_index: u32,
  binding_set: u32,
  execution_bin: u32,
  signature: u32,
  value_revision: u32,
  reserved: vec2u,
}
`;

export const NATIVE_TEMPORAL_SEED_BYTES = 16;
export const NATIVE_TEMPORAL_RESPONSE_BYTES = 4;
export const NATIVE_TEMPORAL_IDENTITY_BYTES = 16;
export const NATIVE_TEMPORAL_ALLOCATION_BYTES =
  NATIVE_TEMPORAL_SEED_BYTES + NATIVE_TEMPORAL_RESPONSE_BYTES + 2 * NATIVE_TEMPORAL_IDENTITY_BYTES;
export const NATIVE_TEMPORAL_SEED_VIEW_BYTES = 272;
export function packNativeTemporalSeedView(
  width: number,
  height: number,
  previousValid: boolean,
  matrices: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
): Uint8Array<ArrayBuffer> {
  for (const value of [width, height]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
      throw new RangeError("Seed view extent must be a nonzero u32");
    }
  }
  const bytes = new Uint8Array(NATIVE_TEMPORAL_SEED_VIEW_BYTES);
  const floats = new Float32Array(bytes.buffer);
  matrices.forEach((matrix, index) => {
    if (matrix.length !== 16) {
      throw new RangeError("Seed cameras require complete matrices");
    }
    for (let lane = 0; lane < 16; lane++) {
      const value = Math.fround(matrix[lane]!);
      if (!Number.isFinite(value)) {
        throw new RangeError("Seed camera must be finite f32");
      }
      floats[index * 16 + lane] = value;
    }
  });
  new Uint32Array(bytes.buffer).set([width, height, Number(previousValid), 0], 64);
  return bytes;
}
export const NATIVE_TEMPORAL_SEED_VIEW_WGSL = /* wgsl */ `
struct NativeTemporalSeedView {
  current_inverse_projection: mat4x4f,
  current_inverse_view: mat4x4f,
  previous_view: mat4x4f,
  previous_projection: mat4x4f,
  control: vec4u, // width, height, previous-valid, reserved
}
`;

export interface FinalPixelLightingDirectoryPlan {
  readonly residual: boolean;
  readonly giOffset: number;
  readonly giBytes: number;
  readonly giWidth: number;
  readonly giHeight: number;
  readonly windowRows: number;
  readonly windowWidth: number;
  readonly remapped: boolean;
  readonly nativeBytes: number;
  readonly lookupCount: number;
  readonly descriptorCount: number;
  readonly descriptorOffset: number;
  readonly lookupOffset: number;
  readonly lookupBytes: number;
  readonly descriptorBytes: number;
  readonly solarOffset: number;
  readonly solarBytes: number;
  readonly filterNoiseOffset: number;
  readonly filterNoiseBytes: number;
  readonly bytes: number;
  readonly words: Uint32Array<ArrayBuffer>;
}

/** Disjoint VSM/local producer views and one fixed solar publication, one binding.
 * Descriptor offset respects storage binding alignment; padding is <=255B on
 * the supported 256-byte-alignment profile. Reject incompatible capabilities
 * before allocation, rather than truncate a producer's domain. */
export function planFinalPixelLightingDirectory(
  limits: Pick<
    GPUSupportedLimits,
    "minStorageBufferOffsetAlignment" | "maxBufferSize" | "maxStorageBufferBindingSize"
  >,
  lookupCount: number,
  descriptorCount: number,
  filterNoiseBytes = 0,
  giExtent?: readonly [number, number],
  residual = false,
): FinalPixelLightingDirectoryPlan {
  for (const count of [lookupCount, descriptorCount]) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 0xffffffff) {
      throw new RangeError("Final Pixel directory requires complete nonempty u32 domains");
    }
  }
  const alignment = limits.minStorageBufferOffsetAlignment;
  if (alignment < 4 || alignment > 256 || alignment % 4 !== 0) {
    throw new RangeError("Final Pixel directory alignment exceeds its frozen padding budget");
  }
  const lookupBytes = lookupCount * 8;
  const descriptorBytes = descriptorCount * 16;
  // Keep the existing producer offsets independent of Native window admission.
  const descriptorOffset = 0;
  const solarOffset = descriptorBytes;
  const solarBytes = FINAL_PIXEL_SOLAR_BYTES;
  const lookupOffset = Math.ceil((solarOffset + solarBytes) / alignment) * alignment;
  if (filterNoiseBytes !== 0 && filterNoiseBytes !== VSM_FILTER_DATA_BYTES) {
    throw new RangeError("Final Pixel requires a complete VSM noise sequence and rotation table");
  }
  const filterNoiseOffset = lookupOffset + lookupBytes;
  const baseBytes = filterNoiseOffset + filterNoiseBytes;
  const giOffset = Math.ceil(baseBytes / alignment) * alignment;
  const giWidth = giExtent === undefined ? 0 : Math.ceil(giExtent[0] / 2);
  const giHeight = giExtent === undefined ? 0 : Math.ceil(giExtent[1] / 2);
  if (giExtent !== undefined && giExtent.some((v) => !Number.isSafeInteger(v) || v < 1)) {
    throw new RangeError("GI directory requires a complete internal extent");
  }
  const maximum = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  if (
    giExtent !== undefined &&
    (giExtent.some((v) => v > 0xffffffff) ||
      !Number.isSafeInteger(giExtent[0] * giExtent[1]) ||
      giExtent[0] * giExtent[1] > 0xffffffff)
  ) {
    throw new RangeError("GI directory source pixel identity exceeds u32");
  }
  const available = maximum - giOffset;
  const fieldStride = residual ? 144 : 112;
  const rowCapacity = giWidth === 0 ? 0 : Math.floor(available / (giWidth * fieldStride));
  // Two half rows on each side cover the complete bilinear/edge-aware footprint.
  // Windows shade multiples of eight full rows, matching Native work tiles.
  let windowRows = giHeight <= rowCapacity ? (giExtent?.[1] ?? 0) : Math.floor((rowCapacity - 4) / 4) * 8;
  const remapped = giWidth > 0 && windowRows < 1;
  let windowWidth = giExtent?.[0] ?? 0;
  let nativeBytes = 0;
  if (remapped) {
    // One receiver needs its exact local lookup and all seven possible VSM
    // descriptors (fine + six coarse), each with its original index. PCF taps
    // stay inside the selected page and do not add descriptor references.
    const fixed = solarBytes + filterNoiseBytes;
    const windowBytes = (width: number, height: number) =>
      fixed +
      width * height * (8 + 7 * 20) +
      (Math.ceil(width / 2) + 4) * (Math.ceil(height / 2) + 4) * fieldStride +
      alignment * 3;
    windowRows = 8;
    while (windowWidth > 8 && windowBytes(windowWidth, windowRows) > maximum) {
      windowWidth = Math.max(8, Math.floor(windowWidth / 16) * 8);
    }
    if (windowBytes(windowWidth, windowRows) > maximum) {
      throw new RangeError("Complete GI work tile and local/VSM references exceed negotiated capacity");
    }
    while (windowRows + 8 <= giExtent![1] && windowBytes(windowWidth, windowRows + 8) <= maximum) {
      windowRows += 8;
    }
    nativeBytes = windowBytes(windowWidth, windowRows);
  }
  const giBytes = remapped ? 0 : giWidth * Math.min(giHeight, Math.ceil(windowRows / 2) + 4) * fieldStride;
  const bytes = giWidth === 0 || remapped ? baseBytes : giOffset + giBytes;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes / 4 > 0xffffffff ||
    bytes > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)
  ) {
    throw new RangeError("Final Pixel lighting directory exceeds negotiated capacity");
  }
  return Object.freeze({
    residual,
    giOffset,
    giBytes,
    giWidth,
    giHeight,
    windowRows,
    windowWidth,
    remapped,
    nativeBytes: remapped ? nativeBytes : bytes,
    lookupCount,
    descriptorCount,
    descriptorOffset,
    lookupOffset,
    lookupBytes,
    descriptorBytes,
    solarOffset,
    solarBytes,
    filterNoiseOffset,
    filterNoiseBytes,
    bytes,
    words: new Uint32Array([
      lookupOffset / 4,
      lookupCount,
      descriptorOffset / 4,
      descriptorCount,
      solarOffset / 4,
      filterNoiseOffset / 4,
      giOffset / 4,
      giBytes / 4,
      giWidth,
      giHeight,
      0,
      0,
      0,
      giExtent?.[0] ?? 0,
      windowRows,
      0,
      giExtent?.[0] ?? 0,
      giExtent?.[1] ?? 0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]),
  });
}

export const FINAL_PIXEL_LIGHTING_DIRECTORY_WGSL = /* wgsl */ `
@group(1) @binding(2) var<storage, read> lighting_directory: array<u32>;
struct FinalPixelLightingRanges {
  local_vsm: vec4u,
  segments: vec4u, // solar, noise, GI word offset, GI word length
  gi: vec4u, // half width/height, window first half row, flags
  window: vec4u, // first x, width, height, first y
  extent_debug: vec4u,
  remap: vec4u,
  residual: vec4u, // signed coefficient word offset/length, enabled, reserved
}
@group(1) @binding(9) var<uniform> lighting_ranges: FinalPixelLightingRanges;
fn final_pixel_local_lookup(index: u32) -> LocalLightLookup {
  let at = lighting_ranges.local_vsm.x + index * 2u;
  if (index >= lighting_ranges.local_vsm.y || at + 1u >= arrayLength(&lighting_directory)) {
    return LocalLightLookup(0u, 0u);
  }
  return LocalLightLookup(lighting_directory[at], lighting_directory[at + 1u]);
}
var<private> final_pixel_receiver: vec2u;
fn final_pixel_receiver_index() -> u32 {
  return (final_pixel_receiver.y - lighting_ranges.window.w) * lighting_ranges.window.y +
    final_pixel_receiver.x - lighting_ranges.window.x;
}
fn final_pixel_receiver_lookup(index: u32) -> LocalLightLookup {
  if (lighting_ranges.remap.x == 0u) {
    return final_pixel_local_lookup(index);
  }
  let at = lighting_ranges.local_vsm.x + final_pixel_receiver_index() * 2u;
  return LocalLightLookup(lighting_directory[at], lighting_directory[at + 1u]);
}
fn final_pixel_vsm_descriptor_count() -> u32 {
  return lighting_ranges.local_vsm.w;
}
fn final_pixel_vsm_descriptor(index: u32) -> VsmSamplingDescriptor {
  if (lighting_ranges.remap.x != 0u) {
    let first = lighting_ranges.local_vsm.z + final_pixel_receiver_index() * 35u;
    for (var reference = 0u; reference < 7u; reference++) {
      let at = first + reference * 5u;
      if (lighting_directory[at] == index) {
        return VsmSamplingDescriptor(lighting_directory[at + 1u], lighting_directory[at + 2u],
          lighting_directory[at + 3u], lighting_directory[at + 4u]);
      }
    }
    // Missing gather references are an implementation error, not a missing page.
    return VsmSamplingDescriptor(0u, 0u, VSM_QUERY_MISSING, 0u);
  }
  let at = lighting_ranges.local_vsm.z + index * 4u;
  if (index >= lighting_ranges.local_vsm.w || at + 3u >= arrayLength(&lighting_directory)) {
    return VsmSamplingDescriptor(0u, 0u, VSM_QUERY_MISSING, 0u);
  }
  return VsmSamplingDescriptor(lighting_directory[at], lighting_directory[at + 1u],
    lighting_directory[at + 2u], lighting_directory[at + 3u]);
}
`;

/** Normalized linear/clamp interpolation of the unchanged rgba16float provider.
 * Raw half storage preserves every source texel. No lossy LUT replacement. */
export const FINAL_PIXEL_SOLAR_SAMPLING_WGSL = /* wgsl */ `
fn final_pixel_solar_texel(pixel: vec2i) -> vec3f {
  let xy = vec2u(clamp(pixel, vec2i(0), vec2i(${FINAL_PIXEL_SOLAR_WIDTH - 1}, ${FINAL_PIXEL_SOLAR_HEIGHT - 1})));
  let at = lighting_ranges.segments.x + (xy.y * ${FINAL_PIXEL_SOLAR_WIDTH}u + xy.x) * 2u;
  let rg = unpack2x16float(lighting_directory[at]);
  let ba = unpack2x16float(lighting_directory[at + 1u]);
  return vec3f(rg, ba.x);
}
fn final_pixel_solar_transmittance(uv: vec2f) -> vec3f {
  let point = clamp(uv, vec2f(0.0), vec2f(1.0)) * vec2f(${FINAL_PIXEL_SOLAR_WIDTH}.0, ${FINAL_PIXEL_SOLAR_HEIGHT}.0) - vec2f(0.5);
  let base = vec2i(floor(point));
  let fraction = fract(point);
  let row0 = mix(final_pixel_solar_texel(base), final_pixel_solar_texel(base + vec2i(1, 0)), fraction.x);
  let row1 = mix(final_pixel_solar_texel(base + vec2i(0, 1)), final_pixel_solar_texel(base + vec2i(1, 1)), fraction.x);
  return mix(row0, row1, fraction.y);
}
`;
