/** Bounded frame-local source chunks; no persistent geometry cache. */
export const VSM_SOURCE_VERTICES = 256;
export const VSM_SOURCE_TRIANGLES = 128;
export const VSM_SOURCE_MESHLET_WORDS = 8;
export const VSM_RASTER_STATUS_BYTES = 256;
export const VSM_RASTER_STATUS_LIVE_BYTES = 48;
export const VSM_CHUNK_SETTINGS_BYTES = 64;
export const VSM_RASTER_STATUS_WGSL = /* wgsl */ `
struct VsmRasterStatus {
  failure: atomic<u32>,
  expected_chunks: u32,
  completed_chunks: atomic<u32>,
  generation: u32,
  source_generation: u32,
  dirty_count: u32,
  source_count: u32,
  vertices: atomic<u32>,
  triangles: atomic<u32>,
  incidences: atomic<u32>,
  rejected_triangles: atomic<u32>,
  incidence_high: atomic<u32>,
}
`;
export const VSM_RASTER_COMPLETION_WGSL = VSM_RASTER_STATUS_WGSL.replaceAll("atomic<u32>", "u32");

export function planVsmGeometryChunks(
  workCapacity: number,
  pageCapacity: number,
  maxBytes: number,
  vertexVectors = 1
) {
  if (
    ![workCapacity, pageCapacity, maxBytes, vertexVectors].every(Number.isSafeInteger) ||
    workCapacity < 1 ||
    pageCapacity < 1 ||
    pageCapacity > 2048 ||
    maxBytes < 1 ||
    vertexVectors < 1 ||
    vertexVectors > 7
  ) {
    throw new RangeError("VSM geometry requires bounded source/page/attribute capacities");
  }
  const pageWords = Math.ceil(pageCapacity / 32);
  const sourceStride =
    (VSM_SOURCE_MESHLET_WORDS + VSM_SOURCE_VERTICES * vertexVectors * 4 + VSM_SOURCE_TRIANGLES) * 4;
  // CSR masks preserve all triangle/page hits without materializing 16/80B per
  // incidence. One 16B source range indexes a bin, regardless of hit count.
  const maskStride = (pageWords + 1) * 4;
  const perSource = sourceStride + VSM_SOURCE_TRIANGLES * maskStride + 16;
  const chunkSize = Math.min(
    workCapacity,
    Math.floor(maxBytes / perSource),
    Math.floor(0xffffffff / (VSM_SOURCE_TRIANGLES * pageCapacity))
  );
  if (chunkSize < 1 || chunkSize * VSM_SOURCE_TRIANGLES * pageCapacity > 0xffffffff) {
    throw new RangeError("VSM scratch cannot hold even one complete source meshlet");
  }
  return Object.freeze({
    chunkSize,
    chunkCount: Math.ceil(workCapacity / chunkSize),
    sourceBytes: chunkSize * sourceStride,
    sourceStride,
    vertexVectors,
    pageWords,
    maskStride,
    streamBytes: chunkSize * VSM_SOURCE_TRIANGLES * maskStride,
    indexBytes: chunkSize * 16
  });
}

export function vsmGeometryWgsl(vertexVectors: number, pageWords = 1): string {
  return /* wgsl */ `
struct VsmPreparedMeshlet {
  counts: vec2u,
  material: u32,
  raster_bin: u32,
  flags: u32,
  attributes: u32,
  source_slot: u32,
  reserved: u32,
  vertices: array<array<vec4f, ${vertexVectors}>, ${VSM_SOURCE_VERTICES}>,
  triangles: array<u32, ${VSM_SOURCE_TRIANGLES}>,
}
struct VsmTrianglePages {
  end: u32,
  bits: array<u32, ${pageWords}>,
}
struct VsmSourceRange {
  meshlet: u32,
  begin: u32,
  end: u32,
  reserved: u32,
}
struct VsmTrianglePage {
  meshlet: u32,
  triangle: u32,
  page: u32,
}
${VSM_RASTER_STATUS_WGSL}
struct VsmChunkSettings {
  chunk: vec4u,
  source: vec4u,
  source_payload: vec4u,
  control: vec4u,
}
struct VsmPageWork {
  virtual_page: u32, slot: u32, priority: u32, generation: u32,
  flags: u32, fallback_mip: u32, world: vec2i,
}
struct VsmAllocation {
  attempted: u32, written: u32, overflow: u32, generation: u32,
  records: array<VsmPageWork>,
}
`;
}
