export const SURFACE_SAMPLE_PROFILES = 4;
export const SURFACE_SAMPLE_THREADS = 64;
export const SURFACE_SAMPLE_HEADER_WORDS = 64;
export const SURFACE_SAMPLE_TILE_WORDS = 40;
export const SURFACE_SAMPLE_RECORD_WORDS = 6;
export const SURFACE_SAMPLE_PROFILE_BASE = 32;
export const SURFACE_SAMPLE_PROFILE_WORDS = 4;
export const SURFACE_SAMPLE_INDIRECT_BYTES = 128;
export const SURFACE_SAMPLE_HEADER = Object.freeze({ width: 0, height: 1, tilesX: 2, tileCount: 3,
  records: 4, results: 5, maxDispatch: 6, resultWidth: 7, descriptors: 8, recordsBase: 9,
  indicesBase: 10, errorProfile: 11 });
export const SURFACE_SAMPLE_TILE = Object.freeze({ mode: 0, profile: 1, rate: 2, result: 3,
  cellRates: 8, cellResults: 24 });
export const SURFACE_SAMPLE_RECORD = Object.freeze({ tile: 0, pixel: 1, low: 2, high: 3, result: 4, profile: 5 });
export const SURFACE_TILE_MODE = Object.freeze({ Empty: 0, Implicit: 1, Mixed: 2, Fallback: 3 });
export const SURFACE_SAMPLE_COUNTER = Object.freeze({
  records: 16, results: 17, material: 18, lighting: 19, full: 20, coarse: 21,
  fallback: 22, recordOverflow: 23, resultOverflow: 24, implicit: 25, mixed: 26,
  lightingRejected: 27
});
export interface SurfaceSampleCapacity {
  readonly width: number;
  readonly height: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly tileCount: number;
  readonly recordCapacity: number;
  readonly resultCapacity: number;
  readonly descriptorBase: number;
  readonly recordBase: number;
  readonly indexBase: number;
  readonly workBytes: number;
  readonly resultWidth: number;
  readonly resultHeight: number;
  readonly maxDispatchX: number;
}
export function surfaceSampleCapacity(width: number, height: number,
  limits: Pick<GPUSupportedLimits, "maxStorageBufferBindingSize" | "maxBufferSize" |
    "maxTextureDimension2D" | "maxComputeWorkgroupsPerDimension">,
  pools?: Readonly<{ records?: number; results?: number }>): SurfaceSampleCapacity {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 &&
    value <= limits.maxTextureDimension2D)) throw new RangeError("Surface sample extent is invalid");
  const tilesX = Math.ceil(width / 8), tilesY = Math.ceil(height / 8);
  const tileCount = tilesX * tilesY, pixels = width * height;
  const maxDispatchX = Number(limits.maxComputeWorkgroupsPerDimension);
  if (tilesX > maxDispatchX || tilesY > maxDispatchX || pixels * 2 >= 0xffffffff ||
    tileCount > maxDispatchX * maxDispatchX) throw new RangeError("Surface sample dispatch exceeds negotiated limits");
  const descriptorBase = SURFACE_SAMPLE_HEADER_WORDS + tileCount * SURFACE_SAMPLE_TILE_WORDS;
  const recordBase = descriptorBase + SURFACE_SAMPLE_PROFILES * tileCount;
  const storageLimit = Math.min(Number(limits.maxStorageBufferBindingSize), Number(limits.maxBufferSize));
  const available = Math.floor((storageLimit / 4 - recordBase) /
    (SURFACE_SAMPLE_RECORD_WORDS + SURFACE_SAMPLE_PROFILES));
  if (available < 0) throw new RangeError("Surface fixed tile states exceed the storage budget");
  const recordCapacity = pools?.records ?? Math.min(Math.ceil(pixels / 2), available);
  const resultCapacity = pools?.results ?? Math.ceil(pixels / 2);
  if (![recordCapacity, resultCapacity].every(value => Number.isSafeInteger(value) && value >= 0 && value <= pixels) ||
    recordCapacity > available) throw new RangeError("Surface sample pool capacity is invalid");
  const indexBase = recordBase + recordCapacity * SURFACE_SAMPLE_RECORD_WORDS;
  const workBytes = (indexBase + SURFACE_SAMPLE_PROFILES * recordCapacity) * 4;
  const resultWidth = width, resultHeight = Math.max(1, Math.ceil(resultCapacity / width));
  return Object.freeze({ width, height, tilesX, tilesY, tileCount, recordCapacity,
    resultCapacity, descriptorBase, recordBase, indexBase, workBytes, resultWidth,
    resultHeight, maxDispatchX });
}
export function packSurfaceSampleHeader(capacity: SurfaceSampleCapacity): Uint32Array<ArrayBuffer> {
  const words = new Uint32Array(SURFACE_SAMPLE_HEADER_WORDS);
  words.set([capacity.width, capacity.height, capacity.tilesX, capacity.tileCount,
    capacity.recordCapacity, capacity.resultCapacity, capacity.maxDispatchX,
    capacity.resultWidth, capacity.descriptorBase, capacity.recordBase, capacity.indexBase]);
  return words;
}
export function surfaceSampleDispatch(count: number, maxDimension: number): readonly [number, number, number] {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(maxDimension) || maxDimension < 1 ||
    count > maxDimension * maxDimension) throw new RangeError("Surface indirect grid is invalid");
  const dispatchX = Math.min(count, maxDimension);
  return [dispatchX, count === 0 ? 0 : Math.ceil(count / dispatchX), 1];
}
export function surfaceCellSamples(rate: number, cell: number): readonly Readonly<{
  local: number; low: number; high: number;
}>[] {
  if (![0, 1, 2, 3].includes(rate) || !Number.isInteger(cell) || cell < 0 || cell >= 16) {
    throw new RangeError("Surface cell descriptor is invalid");
  }
  const origin = (cell % 4) * 2 + Math.floor(cell / 4) * 16;
  const strideX = (rate & 1) !== 0 ? 2 : 1, strideY = (rate & 2) !== 0 ? 2 : 1;
  const result = [];
  for (let vertical = 0; vertical < 2; vertical += strideY) {
    for (let horizontal = 0; horizontal < 2; horizontal += strideX) {
      const local = origin + vertical * 8 + horizontal;
      let low = 0, high = 0;
      for (let offsetY = 0; offsetY < strideY; offsetY++) {
        for (let offsetX = 0; offsetX < strideX; offsetX++) {
          const target = local + offsetY * 8 + offsetX;
          if (target < 32) low = (low | (1 << target)) >>> 0;
          else high = (high | (1 << (target - 32))) >>> 0;
        }
      }
      result.push(Object.freeze({ local, low, high }));
    }
  }
  return result;
}
export function surfaceTileReservationReference(recordDemand: number, resultDemand: number,
  attempted: Readonly<{ records: number; results: number }>,
  capacity: Readonly<{ records: number; results: number }>) {
  const recordBase = recordDemand === 0 ? 0 : attempted.records;
  const resultBase = resultDemand === 0 ? 0 : attempted.results;
  const committed = recordBase + recordDemand <= capacity.records &&
    resultBase + resultDemand <= capacity.results;
  return Object.freeze({ committed, recordBase, resultBase,
    attempted: { records: attempted.records + recordDemand, results: attempted.results + resultDemand } });
}
export const SURFACE_SAMPLE_WGSL = /* wgsl */ `
${Object.entries(SURFACE_SAMPLE_HEADER).map(([name, offset]) => `const SAMPLE_HEADER_${name}:u32=${offset}u;`).join("\n")}
${Object.entries(SURFACE_SAMPLE_TILE).map(([name, offset]) => `const SAMPLE_TILE_${name}:u32=${offset}u;`).join("\n")}
${Object.entries(SURFACE_SAMPLE_RECORD).map(([name, offset]) => `const SAMPLE_RECORD_${name}:u32=${offset}u;`).join("\n")}
${Object.entries(SURFACE_SAMPLE_COUNTER).map(([name, offset]) => `const SAMPLE_COUNTER_${name}:u32=${offset}u;`).join("\n")}
struct SurfaceSampleWork { words: array<atomic<u32>>, }
fn sample_load(index:u32)->u32 { return atomicLoad(&work.words[index]); }
fn sample_store(index:u32,value:u32) { atomicStore(&work.words[index],value); }
fn sample_add(index:u32,value:u32)->u32 { return atomicAdd(&work.words[index],value); }
fn sample_tile(tile:u32)->u32 { return ${SURFACE_SAMPLE_HEADER_WORDS}u+tile*${SURFACE_SAMPLE_TILE_WORDS}u; }
fn sample_profile(profile:u32)->u32 { return ${SURFACE_SAMPLE_PROFILE_BASE}u+profile*${SURFACE_SAMPLE_PROFILE_WORDS}u; }
fn sample_origin(tile:u32)->vec2u { return vec2u(tile%sample_load(SAMPLE_HEADER_tilesX),tile/sample_load(SAMPLE_HEADER_tilesX))*8u; }
fn sample_stride(rate:u32)->vec2u { return vec2u(1u+(rate&1u),1u+((rate>>1u)&1u)); }
fn sample_count(rate:u32)->u32 { let stride=sample_stride(rate); return 4u/(stride.x*stride.y); }
fn sample_cell_origin(cell:u32)->vec2u { return vec2u(cell%4u,cell/4u)*2u; }
fn sample_result_pixel(index:u32)->vec2i { return vec2i(i32(index%sample_load(SAMPLE_HEADER_resultWidth)),i32(index/sample_load(SAMPLE_HEADER_resultWidth))); }
fn sample_mask(local:u32,rate:u32)->vec2u {
  let stride=sample_stride(rate); var mask=vec2u(0u);
  for(var vertical=0u;vertical<stride.y;vertical++) {
    for(var horizontal=0u;horizontal<stride.x;horizontal++) {
      let destination=local+vertical*8u+horizontal;
      if destination<32u { mask.x|=1u<<destination; } else { mask.y|=1u<<(destination-32u); }
    }
  }
  return mask;
}
`;
