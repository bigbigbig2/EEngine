/**
 * R2-C Geometry residency ABI.
 *
 * Package records are device-independent serialization records. They are not
 * bound directly because several package offsets are intentionally byte-packed
 * rather than WGSL aligned. This module is the single source of truth for the
 * host packers, byte offsets, strides and WGSL declarations used by the GPU
 * resident tables.
 */

export const GPU_GEOMETRY_ABI_VERSION = 3;
export const GPU_FALLBACK_RECORD_INDEX = 0;
export const GPU_GEOMETRY_RECORD_STRIDE = 176;
export const GPU_CLUSTER_RECORD_STRIDE = 128;
export const GPU_MESHLET_RECORD_STRIDE = 112;

type GpuAbiFieldKind = "u32" | "f32" | "vec4f";

export interface GpuAbiField {
  readonly name: string;
  readonly kind: GpuAbiFieldKind;
  readonly byteOffset: number;
}

export interface GpuRecordSchema {
  readonly name: string;
  readonly stride: number;
  readonly fields: readonly GpuAbiField[];
  readonly offsets: Readonly<Record<string, number>>;
  readonly wgsl: string;
}

const GEOMETRY_FIELDS: readonly GpuAbiField[] = [
  { name: "bounds_sphere", kind: "vec4f", byteOffset: 0 },
  { name: "bounds_min", kind: "vec4f", byteOffset: 16 },
  { name: "bounds_max", kind: "vec4f", byteOffset: 32 },
  { name: "vertex_count", kind: "u32", byteOffset: 48 },
  { name: "index_begin", kind: "u32", byteOffset: 52 },
  { name: "index_count", kind: "u32", byteOffset: 56 },
  { name: "meshlet_begin", kind: "u32", byteOffset: 60 },
  { name: "meshlet_count", kind: "u32", byteOffset: 64 },
  { name: "cluster_begin", kind: "u32", byteOffset: 68 },
  { name: "cluster_root", kind: "u32", byteOffset: 72 },
  { name: "cluster_count", kind: "u32", byteOffset: 76 },
  { name: "bvh_begin", kind: "u32", byteOffset: 80 },
  { name: "bvh_root", kind: "u32", byteOffset: 84 },
  { name: "bvh_count", kind: "u32", byteOffset: 88 },
  { name: "material_range_begin", kind: "u32", byteOffset: 92 },
  { name: "material_range_count", kind: "u32", byteOffset: 96 },
  { name: "stream_descriptor_begin", kind: "u32", byteOffset: 100 },
  { name: "stream_descriptor_count", kind: "u32", byteOffset: 104 },
  { name: "vertex_data_byte_begin", kind: "u32", byteOffset: 108 },
  { name: "vertex_data_byte_length", kind: "u32", byteOffset: 112 },
  { name: "position_byte_offset", kind: "u32", byteOffset: 116 },
  { name: "position_stride", kind: "u32", byteOffset: 120 },
  { name: "position_format", kind: "u32", byteOffset: 124 },
  { name: "flags", kind: "u32", byteOffset: 128 },
  { name: "uv0_byte_offset", kind: "u32", byteOffset: 132 },
  { name: "uv0_stride", kind: "u32", byteOffset: 136 },
  { name: "uv0_format", kind: "u32", byteOffset: 140 },
  { name: "uv1_byte_offset", kind: "u32", byteOffset: 144 },
  { name: "uv1_stride", kind: "u32", byteOffset: 148 },
  { name: "uv1_format", kind: "u32", byteOffset: 152 },
  { name: "uv2_byte_offset", kind: "u32", byteOffset: 156 },
  { name: "uv2_stride", kind: "u32", byteOffset: 160 },
  { name: "uv2_format", kind: "u32", byteOffset: 164 },
  { name: "_pad0", kind: "u32", byteOffset: 168 },
  { name: "_pad1", kind: "u32", byteOffset: 172 }
];

const CLUSTER_FIELDS: readonly GpuAbiField[] = [
  { name: "child_begin", kind: "u32", byteOffset: 0 },
  { name: "child_count", kind: "u32", byteOffset: 4 },
  { name: "meshlet_begin", kind: "u32", byteOffset: 8 },
  { name: "meshlet_count", kind: "u32", byteOffset: 12 },
  { name: "parent", kind: "u32", byteOffset: 16 },
  { name: "depth", kind: "u32", byteOffset: 20 },
  { name: "material_id", kind: "u32", byteOffset: 24 },
  { name: "flags", kind: "u32", byteOffset: 28 },
  { name: "geometric_error", kind: "f32", byteOffset: 32 },
  { name: "_pad0", kind: "u32", byteOffset: 36 },
  { name: "_pad1", kind: "u32", byteOffset: 40 },
  { name: "_pad2", kind: "u32", byteOffset: 44 },
  { name: "bounds_min", kind: "vec4f", byteOffset: 48 },
  { name: "bounds_max", kind: "vec4f", byteOffset: 64 },
  { name: "bounds_sphere", kind: "vec4f", byteOffset: 80 },
  { name: "cone_apex", kind: "vec4f", byteOffset: 96 },
  { name: "cone_axis_cutoff", kind: "vec4f", byteOffset: 112 }
];

const MESHLET_FIELDS: readonly GpuAbiField[] = [
  { name: "vertex_offset", kind: "u32", byteOffset: 0 },
  { name: "vertex_count", kind: "u32", byteOffset: 4 },
  { name: "triangle_byte_offset", kind: "u32", byteOffset: 8 },
  { name: "triangle_count", kind: "u32", byteOffset: 12 },
  { name: "material_range_index", kind: "u32", byteOffset: 16 },
  { name: "material_id", kind: "u32", byteOffset: 20 },
  { name: "flags", kind: "u32", byteOffset: 24 },
  { name: "_pad0", kind: "u32", byteOffset: 28 },
  { name: "bounds_min", kind: "vec4f", byteOffset: 32 },
  { name: "bounds_max", kind: "vec4f", byteOffset: 48 },
  { name: "bounds_sphere", kind: "vec4f", byteOffset: 64 },
  { name: "cone_apex", kind: "vec4f", byteOffset: 80 },
  { name: "cone_axis_cutoff", kind: "vec4f", byteOffset: 96 }
];

export const GPU_GEOMETRY_RECORD_SCHEMA = createSchema(
  "GpuGeometryRecord",
  GPU_GEOMETRY_RECORD_STRIDE,
  GEOMETRY_FIELDS
);
export const GPU_CLUSTER_RECORD_SCHEMA = createSchema(
  "GpuClusterRecord",
  GPU_CLUSTER_RECORD_STRIDE,
  CLUSTER_FIELDS
);
export const GPU_MESHLET_RECORD_SCHEMA = createSchema(
  "GpuMeshletRecord",
  GPU_MESHLET_RECORD_STRIDE,
  MESHLET_FIELDS
);

export const GPU_GEOMETRY_RECORD_WGSL = GPU_GEOMETRY_RECORD_SCHEMA.wgsl;
export const GPU_CLUSTER_RECORD_WGSL = GPU_CLUSTER_RECORD_SCHEMA.wgsl;
export const GPU_MESHLET_RECORD_WGSL = GPU_MESHLET_RECORD_SCHEMA.wgsl;

export const GPU_POSITION_FORMAT = Object.freeze({
  Unknown: 0,
  Float32x3: 1,
  Float32x4: 2
});

export const GPU_UV_FORMAT = Object.freeze({
  Unknown: 0,
  Float32x2: 1,
  Unorm8x2: 2,
  Unorm16x2: 3
});

export interface GpuGeometryRecordCpu {
  readonly boundsSphere: ArrayLike<number>;
  readonly boundsMin: ArrayLike<number>;
  readonly boundsMax: ArrayLike<number>;
  readonly vertexCount: number;
  readonly indexBegin: number;
  readonly indexCount: number;
  readonly meshletBegin: number;
  readonly meshletCount: number;
  readonly clusterBegin: number;
  readonly clusterRoot: number;
  readonly clusterCount: number;
  readonly bvhBegin: number;
  readonly bvhRoot: number;
  readonly bvhCount: number;
  readonly materialRangeBegin: number;
  readonly materialRangeCount: number;
  readonly streamDescriptorBegin: number;
  readonly streamDescriptorCount: number;
  readonly vertexDataByteBegin: number;
  readonly vertexDataByteLength: number;
  readonly positionByteOffset: number;
  readonly positionStride: number;
  readonly positionFormat: number;
  readonly flags: number;
  readonly uv0ByteOffset: number;
  readonly uv0Stride: number;
  readonly uv0Format: number;
  readonly uv1ByteOffset: number;
  readonly uv1Stride: number;
  readonly uv1Format: number;
  readonly uv2ByteOffset: number;
  readonly uv2Stride: number;
  readonly uv2Format: number;
}

export interface GpuClusterRecordCpu {
  readonly childBegin: number;
  readonly childCount: number;
  readonly meshletBegin: number;
  readonly meshletCount: number;
  readonly parent: number;
  readonly depth: number;
  readonly materialId: number;
  readonly flags: number;
  readonly geometricError: number;
  readonly boundsMin: ArrayLike<number>;
  readonly boundsMax: ArrayLike<number>;
  readonly boundsSphere: ArrayLike<number>;
  readonly coneApex: ArrayLike<number>;
  readonly coneAxisCutoff: ArrayLike<number>;
}

export interface GpuMeshletRecordCpu {
  readonly vertexOffset: number;
  readonly vertexCount: number;
  readonly triangleByteOffset: number;
  readonly triangleCount: number;
  readonly materialRangeIndex: number;
  readonly materialId: number;
  readonly flags: number;
  readonly boundsMin: ArrayLike<number>;
  readonly boundsMax: ArrayLike<number>;
  readonly boundsSphere: ArrayLike<number>;
  readonly coneApex: ArrayLike<number>;
  readonly coneAxisCutoff: ArrayLike<number>;
}

export function packGpuGeometryRecord(record: GpuGeometryRecordCpu): Uint8Array {
  const bytes = new Uint8Array(GPU_GEOMETRY_RECORD_STRIDE);
  const view = new DataView(bytes.buffer);
  writeVec4(view, 0, record.boundsSphere);
  writeVec4(view, 16, record.boundsMin);
  writeVec4(view, 32, record.boundsMax);
  const values = [
    record.vertexCount,
    record.indexBegin,
    record.indexCount,
    record.meshletBegin,
    record.meshletCount,
    record.clusterBegin,
    record.clusterRoot,
    record.clusterCount,
    record.bvhBegin,
    record.bvhRoot,
    record.bvhCount,
    record.materialRangeBegin,
    record.materialRangeCount,
    record.streamDescriptorBegin,
    record.streamDescriptorCount,
    record.vertexDataByteBegin,
    record.vertexDataByteLength,
    record.positionByteOffset,
    record.positionStride,
    record.positionFormat,
    record.flags,
    record.uv0ByteOffset,
    record.uv0Stride,
    record.uv0Format,
    record.uv1ByteOffset,
    record.uv1Stride,
    record.uv1Format,
    record.uv2ByteOffset,
    record.uv2Stride,
    record.uv2Format
  ];
  for (let index = 0; index < values.length; index++) {
    view.setUint32(48 + index * 4, checkedU32(values[index]!, "GeometryRecord"), true);
  }
  return bytes;
}

export function packGpuClusterRecords(
  records: readonly GpuClusterRecordCpu[]
): Uint8Array {
  const bytes = new Uint8Array(records.length * GPU_CLUSTER_RECORD_STRIDE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const base = index * GPU_CLUSTER_RECORD_STRIDE;
    const integers = [
      record.childBegin,
      record.childCount,
      record.meshletBegin,
      record.meshletCount,
      record.parent,
      record.depth,
      record.materialId,
      record.flags
    ];
    for (let field = 0; field < integers.length; field++) {
      view.setUint32(base + field * 4, checkedU32(integers[field]!, "ClusterRecord"), true);
    }
    view.setFloat32(base + 32, record.geometricError, true);
    writeVec4(view, base + 48, record.boundsMin);
    writeVec4(view, base + 64, record.boundsMax);
    writeVec4(view, base + 80, record.boundsSphere);
    writeVec4(view, base + 96, record.coneApex);
    writeVec4(view, base + 112, record.coneAxisCutoff);
  }
  return bytes;
}

export function packGpuMeshletRecords(
  records: readonly GpuMeshletRecordCpu[]
): Uint8Array {
  const bytes = new Uint8Array(records.length * GPU_MESHLET_RECORD_STRIDE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const base = index * GPU_MESHLET_RECORD_STRIDE;
    const integers = [
      record.vertexOffset,
      record.vertexCount,
      record.triangleByteOffset,
      record.triangleCount,
      record.materialRangeIndex,
      record.materialId,
      record.flags
    ];
    for (let field = 0; field < integers.length; field++) {
      view.setUint32(base + field * 4, checkedU32(integers[field]!, "MeshletRecord"), true);
    }
    writeVec4(view, base + 32, record.boundsMin);
    writeVec4(view, base + 48, record.boundsMax);
    writeVec4(view, base + 64, record.boundsSphere);
    writeVec4(view, base + 80, record.coneApex);
    writeVec4(view, base + 96, record.coneAxisCutoff);
  }
  return bytes;
}

function createSchema(
  name: string,
  stride: number,
  fields: readonly GpuAbiField[]
): GpuRecordSchema {
  const offsets: Record<string, number> = {};
  let cursor = 0;
  let structAlignment = 1;
  const lines = [`struct ${name} {`];
  for (const field of fields) {
    const alignment = field.kind === "vec4f" ? 16 : 4;
    const size = field.kind === "vec4f" ? 16 : 4;
    if (field.byteOffset % alignment !== 0 || field.byteOffset < cursor) {
      throw new Error(`${name}.${field.name} has an invalid ABI offset`);
    }
    if (field.byteOffset !== cursor) {
      throw new Error(`${name}.${field.name} leaves implicit ABI padding`);
    }
    offsets[field.name] = field.byteOffset;
    lines.push(`  ${field.name}: ${field.kind},`);
    cursor += size;
    structAlignment = Math.max(structAlignment, alignment);
  }
  if (Math.ceil(cursor / structAlignment) * structAlignment !== stride) {
    throw new Error(`${name} stride ${stride} does not match WGSL layout ${cursor}`);
  }
  lines.push("};");
  return Object.freeze({
    name,
    stride,
    fields: Object.freeze([...fields]),
    offsets: Object.freeze(offsets),
    wgsl: lines.join("\n")
  });
}

function writeVec4(view: DataView, byteOffset: number, values: ArrayLike<number>): void {
  if (values.length < 3 || values.length > 4) {
    throw new RangeError("GPU ABI vec4 input must contain three or four values");
  }
  for (let lane = 0; lane < 4; lane++) {
    const value = lane < values.length ? Number(values[lane]) : 0;
    if (!Number.isFinite(value)) throw new RangeError("GPU ABI float must be finite");
    view.setFloat32(byteOffset + lane * 4, value, true);
  }
}

function checkedU32(value: number, owner: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${owner} value ${value} is outside u32`);
  }
  return value >>> 0;
}
