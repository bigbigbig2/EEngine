/** Frame-local local-light product. Offsets address payload words, never header words. */
export const LOCAL_LIGHT_ABI_VERSION = 1;
export const LOCAL_LIGHT_HEADER_WORDS = 32;
export const LOCAL_LIGHT_PARAMETERS_BYTES = 128;
export const LOCAL_LIGHT_TILE_SIZE = 32;
export const LOCAL_LIGHT_DEPTH_SLICES = 24;
export const LOCAL_LIGHT_MAX_ADMITTED = 16_380;
export const LOCAL_LIGHT_INDEX_CAPACITY = 1_048_576;
export const LOCAL_LIGHT_FRAME_BUDGET = 6 * 1024 * 1024;
export const LOCAL_LIGHT_PEAK_BUDGET = 3 * LOCAL_LIGHT_FRAME_BUDGET;
export const LOCAL_LIGHT_MODE = { NONE: 0, DIRECT: 1, SPARSE: 2 } as const;
export const LOCAL_LIGHT_FLAGS = {
  REGION_BUDGET: 1,
  INDEX_CAPACITY: 2,
  COUNT_SCATTER_MISMATCH: 4,
  INVALID_WORK: 8
} as const;

export function localLightId(slot: number, type: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot > 0xffffff || (type !== 0 && type !== 1)) {
    throw new RangeError("Local light identity cannot be represented");
  }
  return (slot | (type << 24)) >>> 0;
}

export function localLightDepthSlice(depth: number, near: number, far: number): number {
  return Math.min(
    23,
    Math.max(0, Math.floor((Math.log2(Math.max(depth, near) / near) * 23) / Math.log2(far / near)))
  );
}

export const LOCAL_LIGHT_TYPES_WGSL = /* wgsl */ `
struct LocalLightParameters {
  grid: vec4u, // width, height, tilesX, tilesY
  context: vec4u, // epoch, frame, publication, admitted
  depth: vec4f, // near, far, device-depth conversion X/Y
  projection: vec4f, // projection X/Y scale, jitter NDC X/Y
  view: mat4x4f,
}
struct LocalLightLookup {
  offset: u32,
  count: u32,
}
struct LocalLightData {
  abi: u32,
  mode: u32,
  flags: u32,
  epoch: u32,
  frame: u32,
  publication: u32,
  admitted: u32,
  all_offset: u32,
  global_count: u32,
  global_offset: u32,
  clusters: u32,
  capacity: u32,
  indices_offset: u32,
  written: u32,
  tasks: u32,
  task_budget: u32,
  reserved: array<u32, 16>,
  ids: array<u32>,
}
fn local_light_slice(depth: f32, parameters: LocalLightParameters) -> u32 {
  let scale = 23.0 / log2(parameters.depth.y / parameters.depth.x);
  return u32(clamp(floor(log2(max(depth, parameters.depth.x) / parameters.depth.x) * scale), 0.0, 23.0));
}
fn local_light_cluster(pixel: vec2u, depth: f32, parameters: LocalLightParameters) -> u32 {
  let tile = min(pixel / 32u, parameters.grid.zw - vec2u(1u));
  return tile.x + (tile.y + local_light_slice(depth, parameters) * parameters.grid.w) * parameters.grid.z;
}
`;
