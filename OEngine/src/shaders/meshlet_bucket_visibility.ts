import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_GEOMETRY_VERTEX_DECODE_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_UV_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL } from "../gpu/GpuTextureRefAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const MESHLET_BUCKET_SETTINGS_STRIDE = 256;
export const MESHLET_BUCKET_SETTINGS_SIZE = 16;
export function meshletBucketVisibilityWgsl(primitiveIndex: boolean): string {
  const primitiveIndexEnable = primitiveIndex ? "enable primitive_index;" : "";
  const triangleVarying = primitiveIndex
    ? ""
    : "  @location(2) @interpolate(flat) triangle: u32,";
  const triangleAssignment = primitiveIndex ? "" : "  output.triangle = triangle;";
  const fragmentTriangleInput = primitiveIndex
    ? "@builtin(primitive_index) triangle: u32"
    : "@location(2) @interpolate(flat) triangle: u32";
  return /* wgsl */ `
${primitiveIndexEnable}
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_VISIBILITY_KEY_WGSL}

struct OEngineMeshletBucketStateRead {
  count: u32,
  base: u32,
  cursor: u32,
  overflow: u32,
};
struct OEngineMeshletBucketSettings {
  bucket: u32,
  indirect_first_instance: u32,
  reserved0: u32,
  reserved1: u32,
};
struct OEngineMeshletBucketVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) instance_slot: u32,
  @location(1) @interpolate(flat) meshlet_slot: u32,
${triangleVarying}
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) uv2: vec2f,
  @location(6) @interpolate(flat) uv_valid_mask: u32,
  @location(7) @interpolate(flat) material_handle: u32,
  @location(8) @interpolate(flat) meshlet_work_slot: u32,
};

@group(0) @binding(0) var<uniform> meshlet_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> meshlet_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> meshlet_records: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> meshlet_vertices: array<u32>;
@group(0) @binding(4) var<storage, read> meshlet_triangles: array<u32>;
@group(0) @binding(5) var<storage, read> meshlet_vertex_data: array<u32>;
@group(0) @binding(6) var<storage, read> meshlet_geometries: array<GpuGeometryRecord>;
@group(0) @binding(7) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(8) var<storage, read> meshlet_buckets: array<OEngineMeshletBucketStateRead>;
@group(0) @binding(9) var<uniform> meshlet_bucket: OEngineMeshletBucketSettings;
@group(0) @binding(10) var<storage, read> meshlet_materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(11) var oengine_texture_bank_0: texture_2d_array<f32>;
@group(0) @binding(12) var oengine_texture_bank_1: texture_2d_array<f32>;
@group(0) @binding(13) var oengine_texture_bank_2: texture_2d_array<f32>;
@group(0) @binding(14) var oengine_texture_bank_3: texture_2d_array<f32>;
@group(0) @binding(15) var oengine_texture_bank_4: texture_2d_array<f32>;
@group(0) @binding(16) var oengine_texture_bank_5: texture_2d_array<f32>;
@group(0) @binding(17) var oengine_texture_bank_6: texture_2d_array<f32>;
@group(0) @binding(18) var oengine_texture_bank_7: texture_2d_array<f32>;
@group(0) @binding(19) var oengine_texture_bank_8: texture_2d_array<f32>;

${GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL}

fn meshlet_read_u8(byte_offset: u32) -> u32 {
  let word = meshlet_triangles[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}
fn meshlet_read_u16(byte_offset: u32) -> u32 {
  let first = meshlet_vertex_data[byte_offset >> 2u];
  let second_offset = byte_offset + 1u;
  let second = meshlet_vertex_data[second_offset >> 2u];
  return ((first >> ((byte_offset & 3u) * 8u)) & 0xffu) |
    (((second >> ((second_offset & 3u) * 8u)) & 0xffu) << 8u);
}
fn meshlet_read_uv(geometry: GpuGeometryRecord, uv_set_index: u32, vertex: u32) -> vec3f {
  var byte_offset = geometry.uv0_byte_offset;
  var stride = geometry.uv0_stride;
  var format = geometry.uv0_format;
  if uv_set_index == 1u {
    byte_offset = geometry.uv1_byte_offset;
    stride = geometry.uv1_stride;
    format = geometry.uv1_format;
  } else if uv_set_index == 2u {
    byte_offset = geometry.uv2_byte_offset;
    stride = geometry.uv2_stride;
    format = geometry.uv2_format;
  }
  let offset = byte_offset + vertex * stride;
  if format == ${GPU_UV_FORMAT.Float32x2}u {
    let word = offset >> 2u;
    return vec3f(bitcast<f32>(meshlet_vertex_data[word]),
      bitcast<f32>(meshlet_vertex_data[word + 1u]), 1.0);
  }
  if format == ${GPU_UV_FORMAT.Unorm8x2}u {
    let x = meshlet_vertex_data[offset >> 2u];
    let y_offset = offset + 1u;
    let y = meshlet_vertex_data[y_offset >> 2u];
    return vec3f(f32((x >> ((offset & 3u) * 8u)) & 0xffu),
      f32((y >> ((y_offset & 3u) * 8u)) & 0xffu), 255.0);
  }
  if format == ${GPU_UV_FORMAT.Unorm16x2}u {
    let x = oengine_geometry_read_u16(&meshlet_vertex_data, offset);
    let y = oengine_geometry_read_u16(&meshlet_vertex_data, offset + 2u);
    return vec3f(f32(x), f32(y), 65535.0);
  }
  if format == ${GPU_UV_FORMAT.Float16x2}u {
    return vec3f(unpack2x16float(meshlet_vertex_data[offset >> 2u]), 1.0);
  }
  return vec3f(0.0);
}

@vertex
fn raster_meshlet_bucket(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32
) -> OEngineMeshletBucketVertexOutput {
  let bucket_state = meshlet_buckets[meshlet_bucket.bucket];
  let work_index = select(bucket_state.base + instance_index, instance_index,
    meshlet_bucket.indirect_first_instance != 0u);
  let work = meshlet_work.elements[work_index];
  let instance = meshlet_instances[work.instance_slot];
  let geometry = meshlet_geometries[work.geometry_slot];
  let meshlet = meshlet_records[work.meshlet_slot];
  let triangle = vertex_index / 3u;
  let input_corner = vertex_index % 3u;
  let matrix = oengine_instance_current_object_to_world(instance);
  let determinant = dot(matrix[0].xyz, cross(matrix[1].xyz, matrix[2].xyz));
  let corner = select(input_corner, 3u - input_corner,
    determinant < 0.0 && input_corner != 0u);
  let valid = triangle < meshlet.triangle_count;
  let safe_triangle = min(triangle, max(meshlet.triangle_count, 1u) - 1u);
  let local_vertex = meshlet_read_u8(meshlet.triangle_byte_offset + safe_triangle * 3u + corner);
  let source_vertex = meshlet_vertices[meshlet.vertex_offset + local_vertex];
  let local_position = oengine_geometry_position(&meshlet_vertex_data, geometry, source_vertex);
  let uv0 = meshlet_read_uv(geometry, 0u, source_vertex);
  let uv1 = meshlet_read_uv(geometry, 1u, source_vertex);
  let uv2 = meshlet_read_uv(geometry, 2u, source_vertex);
  var output: OEngineMeshletBucketVertexOutput;
  output.position = select(vec4f(2.0, 2.0, 2.0, 1.0),
    meshlet_camera.view_projection_matrix * matrix * vec4f(local_position, 1.0), valid);
  output.instance_slot = work.instance_slot;
  output.meshlet_slot = work.meshlet_slot;
${triangleAssignment}
  output.uv0 = select(vec2f(0.0), uv0.xy / uv0.z, uv0.z > 0.0);
  output.uv1 = select(vec2f(0.0), uv1.xy / uv1.z, uv1.z > 0.0);
  output.uv2 = select(vec2f(0.0), uv2.xy / uv2.z, uv2.z > 0.0);
  output.uv_valid_mask = select(0u, 1u, uv0.z > 0.0) |
    select(0u, 2u, uv1.z > 0.0) | select(0u, 4u, uv2.z > 0.0);
  output.material_handle = work.material_slot_or_range;
  output.meshlet_work_slot = work_index;
  return output;
}

@fragment
fn write_meshlet_opaque(
  ${fragmentTriangleInput},
  @location(8) @interpolate(flat) meshlet_work_slot: u32
) -> @location(0) u32 {
  return oengine_visibility_key_try_encode(meshlet_work_slot, triangle).key;
}

fn meshlet_wrap_texel(value: i32, mode: u32, size: i32) -> i32 {
  if mode == 0u { return clamp(value, 0i, size - 1i); }
  if mode == 2u {
    let period = size * 2i;
    let wrapped = ((value % period) + period) % period;
    return select(wrapped, period - 1i - wrapped, wrapped >= size);
  }
  return ((value % size) + size) % size;
}
fn meshlet_alpha_texel(texture_ref: u32, x: i32, y: i32, sampler_class: u32) -> f32 {
  let size = oengine_texture_bank_size(oengine_texture_ref_bank(texture_ref));
  return oengine_texture_bank_alpha(texture_ref, vec2i(
    meshlet_wrap_texel(x, sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size),
    meshlet_wrap_texel(y, (sampler_class >> OENGINE_MATERIAL_SAMPLER_ADDRESS_V_BITS) &
      OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size)));
}
fn meshlet_sample_alpha(texture_ref: u32, uv: vec2f, sampler_class: u32) -> f32 {
  let size = f32(oengine_texture_bank_size(oengine_texture_ref_bank(texture_ref)));
  let position = uv * size - 0.5;
  let base = vec2i(floor(position));
  if (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) == 0u {
    let nearest = vec2i(floor(uv * size));
    return meshlet_alpha_texel(texture_ref, nearest.x, nearest.y, sampler_class);
  }
  let fraction = fract(position);
  let a = meshlet_alpha_texel(texture_ref, base.x, base.y, sampler_class);
  let b = meshlet_alpha_texel(texture_ref, base.x + 1i, base.y, sampler_class);
  let c = meshlet_alpha_texel(texture_ref, base.x, base.y + 1i, sampler_class);
  let d = meshlet_alpha_texel(texture_ref, base.x + 1i, base.y + 1i, sampler_class);
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}

@fragment
fn write_meshlet_mask(
  @location(0) @interpolate(flat) instance_slot: u32,
  @location(1) @interpolate(flat) meshlet_slot: u32,
  ${fragmentTriangleInput},
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) uv2: vec2f,
  @location(6) @interpolate(flat) uv_valid_mask: u32,
  @location(7) @interpolate(flat) material_handle: u32,
  @location(8) @interpolate(flat) meshlet_work_slot: u32
) -> @location(0) u32 {
  if material_handle >= arrayLength(&meshlet_materials) { discard; }
  let record = meshlet_materials[material_handle];
  var alpha = record.base_color_factor_alpha;
  let uv_set = record.texture_uv_sets & 0xffu;
  let uv_bit = select(0u, 1u << uv_set, uv_set < 3u);
  if (record.flags & OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE) != 0u &&
      oengine_texture_ref_valid(record.texture_ref) && (uv_valid_mask & uv_bit) != 0u {
    let source_uv = select(select(uv0, uv1, uv_set == 1u), uv2, uv_set == 2u);
    let scaled = source_uv * record.uv_offset_scale.zw;
    let uv = record.uv_offset_scale.xy + vec2f(
      record.uv_rotation.x * scaled.x - record.uv_rotation.y * scaled.y,
      record.uv_rotation.y * scaled.x + record.uv_rotation.x * scaled.y);
    alpha *= meshlet_sample_alpha(record.texture_ref, uv, record.sampler_class);
  }
  if alpha < record.alpha_cutoff { discard; }
  return oengine_visibility_key_try_encode(meshlet_work_slot, triangle).key;
}
`;
}

/** Correct fallback for devices that do not negotiate primitive-index. */
export const MESHLET_BUCKET_VISIBILITY_WGSL = meshletBucketVisibilityWgsl(false);

/** WebGPU 2026 Desktop specialization; local primitive identity comes from rasterization. */
export const MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_WGSL =
  meshletBucketVisibilityWgsl(true);
