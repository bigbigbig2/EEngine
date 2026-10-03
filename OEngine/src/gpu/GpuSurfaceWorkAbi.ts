/** SurfaceWork V3 fixed prefixes. Offsets are byte offsets inside one frame
 * work buffer; payload partitions are independently bounded and may overflow
 * only into the tile's explicit full-rate exception path. */
export const SURFACE_WORK_HEADER_STRIDE = 64;
export const SURFACE_TILE_DESCRIPTOR_STRIDE = 48;
export const SURFACE_SAMPLE_RECORD_STRIDE = 32;
export const SURFACE_EXCEPTION_RECORD_STRIDE = 16;
export const SURFACE_COUNTER_BLOCK_STRIDE = 128;
export const SURFACE_GEOMETRY_RECORD_STRIDE = 192;
export const SURFACE_WORK_TILE_SIZE = 8;

// SurfaceWork counter buffer layout. The first four words are atomics while
// the indirect dispatch triplet starts at byte 16 and is written by finalize.
export const SURFACE_WORK_COUNT_SAMPLE = 0;
export const SURFACE_WORK_COUNT_EXCEPTION = 1;
export const SURFACE_WORK_COUNT_OVERFLOW = 2;
export const SURFACE_WORK_COUNT_VISIBLE = 3;
export const SURFACE_WORK_COUNT_IMPLICIT = 4;
export const SURFACE_WORK_COUNT_UNIFORM = 5;
export const SURFACE_WORK_COUNT_MIXED = 6;
export const SURFACE_WORK_COUNT_GEOMETRY = 7;
// Immutable diagnostic values copied before finalize rewrites dispatch fields.
export const SURFACE_WORK_COUNT_SAMPLE_REQUESTED = 12;
export const SURFACE_WORK_COUNT_EXCEPTION_REQUESTED = 13;
export const SURFACE_WORK_COUNT_SAMPLE_OVERFLOW = 14;
export const SURFACE_WORK_COUNT_EXCEPTION_OVERFLOW = 15;
export const SURFACE_WORK_INDIRECT_OFFSET = 32;
export const SURFACE_WORK_COUNTER_BYTES = 128;

export const SURFACE_WORK_OVERFLOW = Object.freeze({
  tile: 1,
  sample: 2,
  exception: 4,
  geometry: 8,
  signal: 16
} as const);

export const SURFACE_WORK_HEADER_WGSL = /* wgsl */ `
struct SurfaceWorkHeader {
  generation: u32,
  width: u32,
  height: u32,
  tile_count: u32,
  work_count: u32,
  material_miss_count: u32,
  geometry_record_count: u32,
  diffuse_packet_count: u32,
  specular_packet_count: u32,
  coat_packet_count: u32,
  ibl_packet_count: u32,
  overflow_flags: u32,
  tile_offset: u32,
  sample_offset: u32,
  exception_offset: u32,
  counter_offset: u32,
}
struct SurfaceTileDescriptor {
  origin_size: vec4u,
  profile_rate: vec4u,
  mask_offset: u32,
  sample_offset: u32,
  geometry_offset: u32,
  reserved: u32,
}
struct SurfaceSampleRecord {
  pixel: u32,
  winner_identity: u32,
  sharing_identity: u32,
  signal_mask: u32,
  cache_field_mask: u32,
  output_mapping: u32,
  geometry_index: u32,
  flags: u32,
}
struct SurfaceExceptionRecord {
  pixel_mask: u32,
  reason: u32,
  signal_group: u32,
  flags: u32,
}
`;

export interface SurfaceWorkBudget {
  readonly maxTiles: number;
  readonly maxSamples: number;
  readonly maxExceptions: number;
  readonly maxGeometryRecords: number;
  readonly maxBytes: number;
}

export interface SurfaceWorkLayout {
  readonly tileCapacity: number;
  readonly sampleCapacity: number;
  readonly exceptionCapacity: number;
  readonly geometryCapacity: number;
  readonly tileOffset: number;
  readonly sampleOffset: number;
  readonly exceptionOffset: number;
  readonly counterOffset: number;
  readonly geometryOffset: number;
  readonly byteLength: number;
}

const align = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;

export function surfaceWorkLayout(width: number, height: number, budget: SurfaceWorkBudget,
  limits: GPUSupportedLimits): SurfaceWorkLayout {
  if (![width, height, budget.maxTiles, budget.maxSamples, budget.maxExceptions,
    budget.maxGeometryRecords, budget.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError("SurfaceWork budget values must be positive integers");
  }
  const tilesX = Math.ceil(width / SURFACE_WORK_TILE_SIZE);
  const tilesY = Math.ceil(height / SURFACE_WORK_TILE_SIZE);
  const tiles = tilesX * tilesY;
  if (tiles > budget.maxTiles || width > limits.maxTextureDimension2D || height > limits.maxTextureDimension2D) {
    throw new RangeError("SurfaceWork tile capacity exceeds the negotiated profile");
  }
  const tileOffset = SURFACE_WORK_HEADER_STRIDE;
  const sampleCapacity = Math.min(width * height, budget.maxSamples, budget.maxGeometryRecords);
  const exceptionCapacity = Math.min(tiles * 2, budget.maxExceptions);
  const sampleOffset = align(tileOffset + tiles * SURFACE_TILE_DESCRIPTOR_STRIDE, 256);
  const exceptionOffset = align(sampleOffset + sampleCapacity * SURFACE_SAMPLE_RECORD_STRIDE, 256);
  const counterOffset = align(exceptionOffset + exceptionCapacity * SURFACE_EXCEPTION_RECORD_STRIDE, 256);
  const geometryOffset = align(counterOffset + SURFACE_COUNTER_BLOCK_STRIDE, 256);
  const geometryCapacity = sampleCapacity;
  const geometryBytes = geometryCapacity * SURFACE_GEOMETRY_RECORD_STRIDE;
  const byteLength = geometryOffset + geometryBytes;
  if (byteLength > budget.maxBytes || Math.max(geometryOffset, geometryBytes) > Number(limits.maxBufferSize) ||
      Math.max(geometryOffset, geometryBytes) > Number(limits.maxStorageBufferBindingSize)) {
    throw new RangeError("SurfaceWork allocation exceeds the negotiated storage budget");
  }
  return Object.freeze({ tileCapacity: tiles, sampleCapacity,
    exceptionCapacity, geometryCapacity,
    tileOffset, sampleOffset, exceptionOffset, counterOffset, geometryOffset, byteLength });
}

export function writeSurfaceWorkHeader(target: Uint32Array, layout: SurfaceWorkLayout,
  width: number, height: number, generation: number): void {
  if (target.length < SURFACE_WORK_HEADER_STRIDE / 4) throw new RangeError("SurfaceWork header target is too small");
  target.fill(0, 0, SURFACE_WORK_HEADER_STRIDE / 4);
  target.set([generation >>> 0, width >>> 0, height >>> 0,
    Math.ceil(width / SURFACE_WORK_TILE_SIZE) * Math.ceil(height / SURFACE_WORK_TILE_SIZE),
    0, 0, 0, 0, 0, 0, 0, 0, layout.tileOffset / 4, layout.sampleOffset / 4,
    layout.exceptionOffset / 4, layout.counterOffset / 4], 0);
}
