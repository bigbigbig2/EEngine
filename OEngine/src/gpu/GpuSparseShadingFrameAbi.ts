import type { GpuSparseShadingAssetHeapBindings } from "./GpuAssetStore.js";

export const GPU_SPARSE_SHADING_VIEW_ABI_VERSION = 1;
export const GPU_SPARSE_SHADING_VIEW_BYTES = 240;

export const GPU_SPARSE_SHADING_VIEW_OFFSETS = Object.freeze({
  width: 0,
  height: 4,
  materialCount: 8,
  geometryCount: 12,
  materialGeneration: 16,
  textureGeneration: 20,
  reservedGeometryGeneration: 24,
  publicationRevision: 28,
  geometryWordBase: 32,
  meshletWordBase: 36,
  geometryGenerationWordBase: 40,
  meshletVertexWordBase: 44,
  meshletTriangleWordBase: 48,
  vertexDataWordBase: 52,
  frameIndex: 56,
  preExposure: 64,
  upscaleRatio: 72,
  cameraPosition: 96,
  currentViewProjection: 112,
  previousViewProjection: 176
} as const);

export interface GpuSparseShadingViewCpu {
  readonly width: number;
  readonly height: number;
  readonly materialCount: number;
  readonly materialGeneration: number;
  readonly textureGeneration: number;
  readonly publicationRevision: number;
  readonly assets: Readonly<GpuSparseShadingAssetHeapBindings>;
  readonly frameIndex: number;
  readonly preExposure: number;
  /** Output pixels per internal shading pixel, matching GPUViewContext. */
  readonly upscaleRatio: readonly [number, number];
  readonly cameraPosition: readonly [number, number, number];
  readonly currentViewProjection: ArrayLike<number>;
  readonly previousViewProjection: ArrayLike<number>;
}

export const GPU_SPARSE_SHADING_VIEW_WGSL = /* wgsl */ `
struct OEngineSparseShadingView {
  width: u32,
  height: u32,
  material_count: u32,
  geometry_count: u32,
  material_generation: u32,
  texture_generation: u32,
  _reserved_geometry_generation: u32,
  publication_revision: u32,
  geometry_word_base: u32,
  meshlet_word_base: u32,
  geometry_generation_word_base: u32,
  meshlet_vertex_word_base: u32,
  meshlet_triangle_word_base: u32,
  vertex_data_word_base: u32,
  frame_index: u32,
  _pad0: u32,
  pre_exposure: f32,
  _pad1: f32,
  upscale_ratio: vec2f,
  _pad2: vec2f,
  camera_position: vec4f,
  current_view_projection: mat4x4f,
  previous_view_projection: mat4x4f,
}
`;

export function packGpuSparseShadingView(
  input: Readonly<GpuSparseShadingViewCpu>
): ArrayBuffer {
  assertPositiveU32(input.width, "width");
  assertPositiveU32(input.height, "height");
  assertPositiveU32(input.materialCount, "materialCount");
  assertPositiveU32(input.materialGeneration, "materialGeneration");
  assertPositiveU32(input.textureGeneration, "textureGeneration");
  assertPositiveU32(input.publicationRevision, "publicationRevision");
  assertU32(input.frameIndex, "frameIndex");
  const assets = input.assets;
  if (assets.schemaVersion !== 1) {
    throw new RangeError(`Sparse shading asset heap schema ${assets.schemaVersion} is unsupported`);
  }
  assertPositiveU32(assets.epoch, "assets.epoch");
  assertPositiveU32(assets.geometryCount, "assets.geometryCount");
  for (const [name, value] of [
    ["geometryWordBase", assets.geometryWordBase],
    ["meshletWordBase", assets.meshletWordBase],
    ["geometryGenerationWordBase", assets.geometryGenerationWordBase],
    ["meshletVertexWordBase", assets.meshletVertexWordBase],
    ["meshletTriangleWordBase", assets.meshletTriangleWordBase],
    ["vertexDataWordBase", assets.vertexDataWordBase]
  ] as const) assertU32(value, `assets.${name}`);
  assertFinitePositive(input.preExposure, "preExposure");
  assertFinitePositive(input.upscaleRatio[0], "upscaleRatio[0]");
  assertFinitePositive(input.upscaleRatio[1], "upscaleRatio[1]");
  assertFiniteVector(input.cameraPosition, 3, "cameraPosition");
  assertFiniteVector(input.currentViewProjection, 16, "currentViewProjection");
  assertFiniteVector(input.previousViewProjection, 16, "previousViewProjection");

  const buffer = new ArrayBuffer(GPU_SPARSE_SHADING_VIEW_BYTES);
  const view = new DataView(buffer);
  const offsets = GPU_SPARSE_SHADING_VIEW_OFFSETS;
  writeU32(view, offsets.width, input.width);
  writeU32(view, offsets.height, input.height);
  writeU32(view, offsets.materialCount, input.materialCount);
  writeU32(view, offsets.geometryCount, assets.geometryCount);
  writeU32(view, offsets.materialGeneration, input.materialGeneration);
  writeU32(view, offsets.textureGeneration, input.textureGeneration);
  writeU32(view, offsets.reservedGeometryGeneration, 0);
  writeU32(view, offsets.publicationRevision, input.publicationRevision);
  writeU32(view, offsets.geometryWordBase, assets.geometryWordBase);
  writeU32(view, offsets.meshletWordBase, assets.meshletWordBase);
  writeU32(view, offsets.geometryGenerationWordBase, assets.geometryGenerationWordBase);
  writeU32(view, offsets.meshletVertexWordBase, assets.meshletVertexWordBase);
  writeU32(view, offsets.meshletTriangleWordBase, assets.meshletTriangleWordBase);
  writeU32(view, offsets.vertexDataWordBase, assets.vertexDataWordBase);
  writeU32(view, offsets.frameIndex, input.frameIndex);
  view.setFloat32(offsets.preExposure, input.preExposure, true);
  view.setFloat32(offsets.upscaleRatio, input.upscaleRatio[0], true);
  view.setFloat32(offsets.upscaleRatio + 4, input.upscaleRatio[1], true);
  for (let index = 0; index < 3; index++) {
    view.setFloat32(offsets.cameraPosition + index * 4, input.cameraPosition[index]!, true);
  }
  view.setFloat32(offsets.cameraPosition + 12, 1, true);
  writeMatrix(buffer, offsets.currentViewProjection, input.currentViewProjection);
  writeMatrix(buffer, offsets.previousViewProjection, input.previousViewProjection);
  return buffer;
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function writeMatrix(buffer: ArrayBuffer, offset: number, value: ArrayLike<number>): void {
  const output = new Float32Array(buffer, offset, 16);
  for (let index = 0; index < 16; index++) output[index] = value[index]!;
}

function assertFiniteVector(value: ArrayLike<number>, length: number, name: string): void {
  if (value.length !== length) throw new RangeError(`${name} must contain exactly ${length} values`);
  for (let index = 0; index < length; index++) {
    if (!Number.isFinite(value[index])) throw new RangeError(`${name}[${index}] must be finite`);
  }
}

function assertFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
}

function assertPositiveU32(value: number, name: string): void {
  assertU32(value, name);
  if (value === 0) throw new RangeError(`${name} must be non-zero`);
}

function assertU32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be a uint32`);
  }
}
