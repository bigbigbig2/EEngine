/** V5 target ABI. Internal, not selected by the production frame program yet. */
export const FINAL_PIXEL_DIRECTORY_WORDS = 8;
export const FINAL_PIXEL_SOLAR_WIDTH = 256;
export const FINAL_PIXEL_SOLAR_HEIGHT = 64;
export const FINAL_PIXEL_SOLAR_BYTES = FINAL_PIXEL_SOLAR_WIDTH * FINAL_PIXEL_SOLAR_HEIGHT * 8;
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
  readonly lookupCount: number;
  readonly descriptorCount: number;
  readonly descriptorOffset: number;
  readonly lookupOffset: number;
  readonly lookupBytes: number;
  readonly descriptorBytes: number;
  readonly solarOffset: number;
  readonly solarBytes: number;
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
  // Put 16-byte descriptors first: padding is at most 240B, so the
  // 16-byte ranges uniform plus padding stays inside the 256B contract.
  const descriptorOffset = 0;
  const solarOffset = descriptorBytes;
  const solarBytes = FINAL_PIXEL_SOLAR_BYTES;
  const lookupOffset = Math.ceil((solarOffset + solarBytes) / alignment) * alignment;
  const bytes = lookupOffset + lookupBytes;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes / 4 > 0xffffffff ||
    bytes > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)
  ) {
    throw new RangeError("Final Pixel lighting directory exceeds negotiated capacity");
  }
  return Object.freeze({
    lookupCount,
    descriptorCount,
    descriptorOffset,
    lookupOffset,
    lookupBytes,
    descriptorBytes,
    solarOffset,
    solarBytes,
    bytes,
    words: new Uint32Array([lookupOffset / 4, lookupCount, descriptorOffset / 4, descriptorCount]),
  });
}

export const FINAL_PIXEL_LIGHTING_DIRECTORY_WGSL = /* wgsl */ `
@group(1) @binding(2) var<storage, read> lighting_directory: array<u32>;
@group(1) @binding(9) var<uniform> lighting_ranges: vec4u;
fn final_pixel_local_lookup(index: u32) -> LocalLightLookup {
  let at = lighting_ranges.x + index * 2u;
  if (index >= lighting_ranges.y || at + 1u >= arrayLength(&lighting_directory)) {
    return LocalLightLookup(0u, 0u);
  }
  return LocalLightLookup(lighting_directory[at], lighting_directory[at + 1u]);
}
fn final_pixel_vsm_descriptor_count() -> u32 {
  return lighting_ranges.w;
}
fn final_pixel_vsm_descriptor(index: u32) -> VsmSamplingDescriptor {
  let at = lighting_ranges.z + index * 4u;
  if (index >= lighting_ranges.w || at + 3u >= arrayLength(&lighting_directory)) {
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
  let at = lighting_ranges.z + lighting_ranges.w * 4u + (xy.y * ${FINAL_PIXEL_SOLAR_WIDTH}u + xy.x) * 2u;
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
