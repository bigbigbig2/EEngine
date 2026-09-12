/** ADR-0013 packed lighting input for the three-buffer specialized-shading budget. */
export const GPU_SPARSE_SHADING_LIGHT_ABI_VERSION = 1;
export const GPU_SPARSE_SHADING_LIGHT_HEADER_WORDS = 8;
export const GPU_SPARSE_SHADING_LIGHT_RECORD_WORDS = 24;
export const GPU_SPARSE_SHADING_SHADOW_RECORD_WORDS = 20;

export const GPU_SPARSE_SHADING_LIGHT_TYPE = Object.freeze({
  Directional: 0,
  Point: 1,
  Spot: 2
} as const);

export const GPU_SPARSE_SHADING_LIGHT_FLAGS = Object.freeze({
  CastsShadow: 1 << 0
} as const);

export interface GpuSparseShadingLightRecordCpu {
  readonly type: number;
  readonly flags: number;
  readonly shadowRecord: number;
  /** Contiguous shadow records; directional lights use up to three cascades. */
  readonly shadowRecordCount: number;
  readonly position: readonly [number, number, number];
  readonly range: number;
  /** Direction points from the shaded surface toward the light. */
  readonly direction: readonly [number, number, number];
  readonly outerConeCos: number;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly radius: number;
  readonly innerConeCos: number;
}

export interface GpuSparseShadingLightDatabaseCpu {
  readonly directional: readonly GpuSparseShadingLightRecordCpu[];
  readonly local: readonly GpuSparseShadingLightRecordCpu[];
  /** Projection records follow all light records in the same physical buffer. */
  readonly shadowRecords: readonly Readonly<{
    projection: ArrayLike<number>;
    atlas: readonly [number, number, number, number];
  }>[];
}

/**
 * Packs header, all light records and shadow records into one raw-u32 database.
 * Cluster headers and cluster indices remain the other two group-3 buffers.
 */
export function packGpuSparseShadingLightDatabase(
  input: GpuSparseShadingLightDatabaseCpu
): Uint32Array<ArrayBuffer> {
  for (const light of input.directional) {
    if (light.type !== GPU_SPARSE_SHADING_LIGHT_TYPE.Directional) {
      throw new RangeError("Directional light segment contains a non-directional record");
    }
  }
  for (const light of input.local) {
    if (light.type === GPU_SPARSE_SHADING_LIGHT_TYPE.Directional) {
      throw new RangeError("Local light segment contains a directional record");
    }
  }
  const lightCount = input.directional.length + input.local.length;
  const shadowWordOffset = GPU_SPARSE_SHADING_LIGHT_HEADER_WORDS +
    lightCount * GPU_SPARSE_SHADING_LIGHT_RECORD_WORDS;
  const words = new Uint32Array(shadowWordOffset +
    input.shadowRecords.length * GPU_SPARSE_SHADING_SHADOW_RECORD_WORDS);
  words.set([
    GPU_SPARSE_SHADING_LIGHT_ABI_VERSION,
    input.directional.length,
    input.local.length,
    GPU_SPARSE_SHADING_LIGHT_HEADER_WORDS,
    shadowWordOffset,
    input.shadowRecords.length,
    0,
    0
  ]);
  const view = new DataView(words.buffer);
  let record = 0;
  for (const light of [...input.directional, ...input.local]) {
    validateLight(light, input.shadowRecords.length);
    const byte = (GPU_SPARSE_SHADING_LIGHT_HEADER_WORDS +
      record * GPU_SPARSE_SHADING_LIGHT_RECORD_WORDS) * 4;
    view.setUint32(byte, light.type, true);
    view.setUint32(byte + 4, light.flags, true);
    view.setUint32(byte + 8, light.shadowRecord, true);
    writeFloats(view, byte + 16, [...light.position, light.range]);
    writeFloats(view, byte + 32, [...light.direction, light.outerConeCos]);
    writeFloats(view, byte + 48, [...light.color, light.intensity]);
    writeFloats(view, byte + 64, [light.radius, light.innerConeCos, light.shadowRecordCount, 0]);
    record++;
  }
  input.shadowRecords.forEach((shadow, index) => {
    if (shadow.projection.length < 16) throw new RangeError("Shadow projection requires 16 floats");
    const byte = (shadowWordOffset + index * GPU_SPARSE_SHADING_SHADOW_RECORD_WORDS) * 4;
    writeFloats(view, byte, Array.from({ length: 16 }, (_, lane) => Number(shadow.projection[lane])));
    writeFloats(view, byte + 64, shadow.atlas);
  });
  return words;
}

export const GPU_SPARSE_SHADING_LIGHT_WGSL = /* wgsl */ `
const OENGINE_SPARSE_LIGHT_ABI_VERSION: u32 = ${GPU_SPARSE_SHADING_LIGHT_ABI_VERSION}u;
const OENGINE_SPARSE_LIGHT_HEADER_WORDS: u32 = ${GPU_SPARSE_SHADING_LIGHT_HEADER_WORDS}u;
const OENGINE_SPARSE_LIGHT_RECORD_WORDS: u32 = ${GPU_SPARSE_SHADING_LIGHT_RECORD_WORDS}u;
const OENGINE_SPARSE_SHADOW_RECORD_WORDS: u32 = ${GPU_SPARSE_SHADING_SHADOW_RECORD_WORDS}u;
const OENGINE_SPARSE_LIGHT_DIRECTIONAL: u32 = ${GPU_SPARSE_SHADING_LIGHT_TYPE.Directional}u;
const OENGINE_SPARSE_LIGHT_POINT: u32 = ${GPU_SPARSE_SHADING_LIGHT_TYPE.Point}u;
const OENGINE_SPARSE_LIGHT_SPOT: u32 = ${GPU_SPARSE_SHADING_LIGHT_TYPE.Spot}u;
const OENGINE_SPARSE_LIGHT_CASTS_SHADOW: u32 = ${GPU_SPARSE_SHADING_LIGHT_FLAGS.CastsShadow}u;

struct OEngineSparseLight {
  kind: u32,
  flags: u32,
  shadow_record: u32,
  position_range: vec4f,
  direction_outer: vec4f,
  color_intensity: vec4f,
  radius_inner: vec4f,
}

struct OEngineSparseClusterHeader {
  offset: u32,
  point_count: u32,
  spot_count: u32,
  flags: u32,
}
`;

function validateLight(light: GpuSparseShadingLightRecordCpu, shadowCount: number): void {
  if (!Object.values(GPU_SPARSE_SHADING_LIGHT_TYPE).includes(light.type as never)) {
    throw new RangeError("Sparse shading light type is invalid");
  }
  assertU32(light.flags, "light flags");
  assertU32(light.shadowRecord, "shadow record");
  assertU32(light.shadowRecordCount, "shadow record count");
  if ((light.flags & GPU_SPARSE_SHADING_LIGHT_FLAGS.CastsShadow) !== 0 &&
      (light.shadowRecordCount === 0 ||
       light.shadowRecord + light.shadowRecordCount > shadowCount)) {
    throw new RangeError("Shadow-casting light references a missing shadow record");
  }
  for (const value of [
    ...light.position, light.range, ...light.direction, light.outerConeCos,
    ...light.color, light.intensity, light.radius, light.innerConeCos
  ]) {
    if (!Number.isFinite(value)) throw new RangeError("Sparse shading light contains a non-finite scalar");
  }
}

function writeFloats(view: DataView, byteOffset: number, values: ArrayLike<number>): void {
  for (let index = 0; index < values.length; index++) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) throw new RangeError("Sparse shading float must be finite");
    view.setFloat32(byteOffset + index * 4, value, true);
  }
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`Sparse shading ${label} must be a u32`);
  }
}
