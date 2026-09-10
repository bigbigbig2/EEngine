import { GPU_CLASSIFIED_RASTER_HEADER_BYTES } from "./GpuWorkGenerationAbi.js";
import type { RasterWorkCpu } from "./GpuWorkGenerationAbi.js";

/** Exact-raster and bounded TriangleSetup contracts for M5. */
export const GPU_EXACT_RASTER_ABI_VERSION = 1;
export const GPU_EXACT_RASTER_RECORD_STRIDE = 32;
export const GPU_TRIANGLE_SETUP_RECORD_STRIDE = 40;
export const GPU_TRIANGLE_SETUP_FALLBACK = 0xffffffff;
export const GPU_TRIANGLE_SETUP_DEFAULT_THRESHOLD_PIXELS = 32;
export const GPU_TRIANGLE_SETUP_MAX_BYTES = 8 * 1024 * 1024;
export const GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET = 128;

export const GPU_EXACT_RASTER_SETUP_FLAGS = Object.freeze({
  valid: 1 << 0,
  nearCrossing: 1 << 1,
  degenerate: 1 << 2,
  queueOverflow: 1 << 3
} as const);

/** Dense frame-local mapping used by VisibilityKey V2 consumers. */
export function largeTriangleSetupIndex(meshletWorkSlot: number, localPrimitive: number): number {
  if (!Number.isSafeInteger(meshletWorkSlot) || meshletWorkSlot < 0) {
    throw new RangeError("LargeTriangleSetup meshletWorkSlot must be a non-negative integer");
  }
  if (!Number.isSafeInteger(localPrimitive) || localPrimitive < 0 ||
      localPrimitive >= GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET) {
    throw new RangeError("LargeTriangleSetup localPrimitive must be in [0, 127]");
  }
  const index = meshletWorkSlot * GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET +
    localPrimitive;
  if (!Number.isSafeInteger(index)) {
    throw new RangeError("LargeTriangleSetup index is not a safe integer");
  }
  return index;
}

export function exactRasterWorkBufferByteLength(capacityPerClass: number): number {
  if (!Number.isSafeInteger(capacityPerClass) || capacityPerClass <= 0) {
    throw new RangeError("Exact RasterWork capacity must be a positive integer");
  }
  const bytes = GPU_CLASSIFIED_RASTER_HEADER_BYTES + capacityPerClass * 2 * GPU_EXACT_RASTER_RECORD_STRIDE;
  if (!Number.isSafeInteger(bytes)) throw new RangeError("Exact RasterWork byte length is invalid");
  return bytes;
}

export const GPU_EXACT_RASTER_RECORD_WGSL = /* wgsl */ `
struct OEngineExactRasterRecord {
  instance_record_index: u32,
  geometry_record_index: u32,
  meshlet_record_index: u32,
  local_triangle_index: u32,
  material_handle: u32,
  raster_flags: u32,
  setup_index: u32,
  exact_flags: u32,
};

struct OEngineClassifiedExactRasterWorkQueue {
  opaque_header: OEngineWorkQueueHeader,
  mask_header: OEngineWorkQueueHeader,
  elements: array<OEngineExactRasterRecord>,
};

struct OEngineClassifiedExactRasterWorkQueueRead {
  opaque_header: OEngineWorkQueueHeaderRead,
  mask_header: OEngineWorkQueueHeaderRead,
  elements: array<OEngineExactRasterRecord>,
};
`;

/** RFC Appendix B record: q at viewport center plus constant q derivatives. */
export const GPU_TRIANGLE_SETUP_RECORD_WGSL = /* wgsl */ `
struct OEngineTriangleSetupRecord {
  q_center0: f32,
  q_center1: f32,
  q_center2: f32,
  dqdx0: f32,
  dqdx1: f32,
  dqdx2: f32,
  dqdy0: f32,
  dqdy1: f32,
  dqdy2: f32,
  flags: u32,
};
`;

export interface ExactRasterRecordCpu extends RasterWorkCpu {
  readonly setupIndex: number;
  readonly exactFlags: number;
}

export interface TriangleSetupRecordCpu {
  readonly qCenter: readonly [number, number, number];
  readonly dqDx: readonly [number, number, number];
  readonly dqDy: readonly [number, number, number];
  readonly flags: number;
}

export interface ClipVertexCpu { readonly x: number; readonly y: number; readonly z: number; readonly w: number; }

export interface TriangleSetupRequest {
  readonly vertices: readonly [ClipVertexCpu, ClipVertexCpu, ClipVertexCpu];
  readonly width: number;
  readonly height: number;
  readonly coverageThresholdPixels?: number;
}

export type TriangleSetupResult =
  | Readonly<{ kind: "cached"; record: TriangleSetupRecordCpu; coveragePixels: number }>
  | Readonly<{ kind: "fallback"; reason: "invalid-viewport" | "non-finite" | "near-crossing" | "degenerate" | "below-threshold" }>;

export function packExactRasterRecord(record: ExactRasterRecordCpu): Uint8Array<ArrayBuffer> {
  return packU32([
    record.instanceRecordIndex, record.geometryRecordIndex, record.meshletRecordIndex,
    record.localTriangleIndex, record.materialHandle, record.rasterFlags,
    record.setupIndex, record.exactFlags
  ], GPU_EXACT_RASTER_RECORD_STRIDE, "ExactRasterRecord");
}

export function unpackExactRasterRecord(bytes: Uint8Array, byteOffset = 0): Readonly<ExactRasterRecordCpu> {
  const values = readU32(bytes, byteOffset, GPU_EXACT_RASTER_RECORD_STRIDE, "ExactRasterRecord");
  return Object.freeze({
    instanceRecordIndex: values[0]!, geometryRecordIndex: values[1]!, meshletRecordIndex: values[2]!,
    localTriangleIndex: values[3]!, materialHandle: values[4]!, rasterFlags: values[5]!,
    setupIndex: values[6]!, exactFlags: values[7]!
  });
}

export function packTriangleSetupRecord(record: TriangleSetupRecordCpu): Uint8Array<ArrayBuffer> {
  validateSetup(record);
  const bytes = new Uint8Array(GPU_TRIANGLE_SETUP_RECORD_STRIDE);
  const view = new DataView(bytes.buffer);
  [...record.qCenter, ...record.dqDx, ...record.dqDy].forEach((value, index) => view.setFloat32(index * 4, value, true));
  view.setUint32(36, record.flags, true);
  return bytes;
}

export function unpackTriangleSetupRecord(bytes: Uint8Array, byteOffset = 0): Readonly<TriangleSetupRecordCpu> {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset + GPU_TRIANGLE_SETUP_RECORD_STRIDE > bytes.byteLength) {
    throw new RangeError("TriangleSetupRecord byte range is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, GPU_TRIANGLE_SETUP_RECORD_STRIDE);
  const f = Array.from({ length: 9 }, (_, index) => view.getFloat32(index * 4, true));
  return Object.freeze({
    qCenter: [f[0]!, f[1]!, f[2]!] as [number, number, number],
    dqDx: [f[3]!, f[4]!, f[5]!] as [number, number, number],
    dqDy: [f[6]!, f[7]!, f[8]!] as [number, number, number],
    flags: view.getUint32(36, true)
  });
}

/** Builds the bounded candidate; near-plane/degenerate/small triangles fail open. */
export function tryBuildTriangleSetup(request: TriangleSetupRequest): TriangleSetupResult {
  const { vertices, width, height } = request;
  const threshold = request.coverageThresholdPixels ?? GPU_TRIANGLE_SETUP_DEFAULT_THRESHOLD_PIXELS;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || !Number.isFinite(threshold) || threshold < 0) {
    return Object.freeze({ kind: "fallback", reason: "invalid-viewport" });
  }
  if (vertices.some((v) => ![v.x, v.y, v.z, v.w].every(Number.isFinite))) return Object.freeze({ kind: "fallback", reason: "non-finite" });
  if (vertices.some((v) => v.w <= 0 || v.z < 0)) return Object.freeze({ kind: "fallback", reason: "near-crossing" });
  const screen = vertices.map((v) => [
    (v.x / v.w * 0.5 + 0.5) * width,
    (0.5 - v.y / v.w * 0.5) * height
  ] as [number, number]) as [[number, number], [number, number], [number, number]];
  const [p0, p1, p2] = screen;
  const denominator = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1]);
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-8) return Object.freeze({ kind: "fallback", reason: "degenerate" });
  const coveragePixels = Math.abs(denominator) * 0.5;
  if (coveragePixels < threshold) return Object.freeze({ kind: "fallback", reason: "below-threshold" });
  const dLambdaDx: [number, number, number] = [
    (p1[1] - p2[1]) / denominator, (p2[1] - p0[1]) / denominator, (p0[1] - p1[1]) / denominator
  ];
  const dLambdaDy: [number, number, number] = [
    (p2[0] - p1[0]) / denominator, (p0[0] - p2[0]) / denominator, (p1[0] - p0[0]) / denominator
  ];
  const centerX = width * 0.5, centerY = height * 0.5;
  const lambda0 = dLambdaDx[0]! * (centerX - p2[0]) + dLambdaDy[0]! * (centerY - p2[1]);
  const lambda1 = dLambdaDx[1]! * (centerX - p2[0]) + dLambdaDy[1]! * (centerY - p2[1]);
  const lambda = [lambda0, lambda1, 1 - lambda0 - lambda1] as const;
  const invW = vertices.map((v) => 1 / v.w) as [number, number, number];
  return Object.freeze({
    kind: "cached", coveragePixels,
    record: Object.freeze({
      qCenter: lambda.map((value, index) => value * invW[index]!) as [number, number, number],
      dqDx: dLambdaDx.map((value, index) => value * invW[index]!) as [number, number, number],
      dqDy: dLambdaDy.map((value, index) => value * invW[index]!) as [number, number, number],
      flags: GPU_EXACT_RASTER_SETUP_FLAGS.valid
    })
  });
}

export function reconstructTriangleSetupBarycentrics(setup: TriangleSetupRecordCpu, pixelX: number, pixelY: number, width: number, height: number): Readonly<{
  weights: readonly [number, number, number]; ddx: readonly [number, number, number]; ddy: readonly [number, number, number]
}> {
  const deltaX = pixelX - width * 0.5, deltaY = pixelY - height * 0.5;
  const q = setup.qCenter.map((value, index) => value + deltaX * setup.dqDx[index]! + deltaY * setup.dqDy[index]!) as [number, number, number];
  const sum = q[0]! + q[1]! + q[2]!;
  if (Math.abs(sum) < 1e-8) return Object.freeze({ weights: [1, 0, 0], ddx: [0, 0, 0], ddy: [0, 0, 0] });
  const ddxSum = setup.dqDx[0]! + setup.dqDx[1]! + setup.dqDx[2]!, ddySum = setup.dqDy[0]! + setup.dqDy[1]! + setup.dqDy[2]!;
  const inv = 1 / sum, inv2 = inv * inv;
  return Object.freeze({
    weights: q.map((value) => value * inv) as [number, number, number],
    ddx: setup.dqDx.map((value, index) => (value * sum - q[index]! * ddxSum) * inv2) as [number, number, number],
    ddy: setup.dqDy.map((value, index) => (value * sum - q[index]! * ddySum) * inv2) as [number, number, number]
  });
}

function validateSetup(record: TriangleSetupRecordCpu): void {
  const values = [...record.qCenter, ...record.dqDx, ...record.dqDy];
  if (values.length !== 9 || values.some((value) => !Number.isFinite(value)) || !Number.isSafeInteger(record.flags) || record.flags < 0 || record.flags > 0xffffffff) {
    throw new RangeError("TriangleSetupRecord must contain finite q/dq values and u32 flags");
  }
}

function packU32(values: readonly number[], byteLength: number, label: string): Uint8Array<ArrayBuffer> {
  if (values.length * 4 !== byteLength) throw new Error(`${label} value count does not match stride`);
  const bytes = new Uint8Array(byteLength), view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${label}[${index}] is outside u32`);
    view.setUint32(index * 4, value, true);
  });
  return bytes;
}

function readU32(bytes: Uint8Array, byteOffset: number, byteLength: number, label: string): number[] {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset + byteLength > bytes.byteLength) throw new RangeError(`${label} byte range is invalid`);
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, byteLength);
  return Array.from({ length: byteLength / 4 }, (_, index) => view.getUint32(index * 4, true));
}
