import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_GEOMETRY_VERTEX_DECODE_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_UV_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL } from "../gpu/GpuTextureRefAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";

export const MESHLET_BUCKET_SETTINGS_STRIDE = 256;
export const MESHLET_BUCKET_SETTINGS_SIZE = 16;
export function meshletBucketVisibilityWgsl(
  primitiveIndex: boolean,
  includeShadingBinId = true
): string {
  const primitiveIndexEnable = primitiveIndex ? "enable primitive_index;" : "";
  const triangleVarying = primitiveIndex
    ? ""
    : "  @location(2) @interpolate(flat) triangle: u32,";
  const triangleAssignment = primitiveIndex ? "" : "  output.triangle = triangle;";
  const fragmentTriangleInput = primitiveIndex
    ? "@builtin(primitive_index) triangle: u32"
    : "@location(2) @interpolate(flat) triangle: u32";
  const shadingBinVarying = includeShadingBinId
    ? "  @location(9) @interpolate(flat) shading_bin_id: u32,"
    : "";
  const shadingBinAssignment = includeShadingBinId
    ? "  output.shading_bin_id = oengine_instance_shading_bin_id(work.packed_raster_flags);"
    : "";
  const fragmentShadingBinInput = includeShadingBinId
    ? ",\n  @location(9) @interpolate(flat) shading_bin_id: u32"
    : "";
  const fragmentOutputDeclaration = includeShadingBinId
    ? `struct OEngineMeshletVisibilityOutput {
  @location(0) visibility_key: u32,
  @location(1) shading_bin_id: u32,
};`
    : `struct OEngineMeshletVisibilityOutput {
  @location(0) visibility_key: u32,
};`;
  const fragmentReturnType = "OEngineMeshletVisibilityOutput";
  const fragmentReturn = includeShadingBinId
    ? "return OEngineMeshletVisibilityOutput(key, shading_bin_id);"
    : "return OEngineMeshletVisibilityOutput(key);";
  return /* wgsl */ `
${primitiveIndexEnable}
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_VISIBILITY_KEY_WGSL}

override OENGINE_ACTIVE_TEXTURE_BINDING_SET: u32 = 0u;

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
${shadingBinVarying}
};
${fragmentOutputDeclaration}

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
@group(0) @binding(10) var<storage, read> meshlet_materials: array<OEngineShadingMaterialRecord>;
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
${shadingBinAssignment}
  return output;
}

@fragment
fn write_meshlet_opaque(
  ${fragmentTriangleInput},
  @location(8) @interpolate(flat) meshlet_work_slot: u32${fragmentShadingBinInput}
) -> ${fragmentReturnType} {
  let key = oengine_visibility_key_try_encode(meshlet_work_slot, triangle).key;
  ${fragmentReturn}
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
  @location(8) @interpolate(flat) meshlet_work_slot: u32${fragmentShadingBinInput}
) -> ${fragmentReturnType} {
  if material_handle >= arrayLength(&meshlet_materials) { discard; }
  let record = meshlet_materials[material_handle].payload;
  if record.texture_binding_set_id != OENGINE_ACTIVE_TEXTURE_BINDING_SET { discard; }
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
  let key = oengine_visibility_key_try_encode(meshlet_work_slot, triangle).key;
  ${fragmentReturn}
}
`;
}

/** Production portable VisibilityKey + ShadingBinId dual-MRT shader. */
export const MESHLET_BUCKET_VISIBILITY_WGSL = meshletBucketVisibilityWgsl(false);

/** Production WebGPU 2026 specialization using the primitive-index builtin. */
export const MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_WGSL =
  meshletBucketVisibilityWgsl(true);

/** Production portable VisibilityKey single-MRT shader. */
export const MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL =
  meshletBucketVisibilityWgsl(false, false);

/** Production primitive-index VisibilityKey single-MRT shader. */
export const MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_SINGLE_WGSL =
  meshletBucketVisibilityWgsl(true, false);

/** S1 Product raster consumer. It shares the VisibilityKey/depth contract with V2. */
export const VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}
${GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL}

struct OEngineProductBucketOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) instance_slot: u32,
  @location(1) @interpolate(flat) meshlet_slot: u32,
  @location(2) @interpolate(flat) triangle: u32,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) uv2: vec2f,
  @location(6) @interpolate(flat) uv_valid_mask: u32,
  @location(7) @interpolate(flat) material_handle: u32,
  @location(8) @interpolate(flat) meshlet_work_slot: u32,
};

@group(0) @binding(0) var<uniform> product_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> product_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> product_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> product_heap_raster: array<u32>;
@group(0) @binding(4) var<storage, read> product_bank_raster_0: array<u32>;
@group(0) @binding(5) var<storage, read> product_bank_raster_1: array<u32>;
@group(0) @binding(6) var<storage, read> product_bank_raster_2: array<u32>;
@group(0) @binding(7) var<storage, read> product_bank_raster_3: array<u32>;
@group(0) @binding(8) var<storage, read> product_materials: array<OEngineShadingMaterialRecord>;
@group(0) @binding(9) var oengine_texture_bank_0: texture_2d_array<f32>;
@group(0) @binding(10) var oengine_texture_bank_1: texture_2d_array<f32>;
@group(0) @binding(11) var oengine_texture_bank_2: texture_2d_array<f32>;
@group(0) @binding(12) var oengine_texture_bank_3: texture_2d_array<f32>;
@group(0) @binding(13) var oengine_texture_bank_4: texture_2d_array<f32>;
@group(0) @binding(14) var oengine_texture_bank_5: texture_2d_array<f32>;
@group(0) @binding(15) var oengine_texture_bank_6: texture_2d_array<f32>;
@group(0) @binding(16) var oengine_texture_bank_7: texture_2d_array<f32>;
@group(0) @binding(17) var oengine_texture_bank_8: texture_2d_array<f32>;

override OENGINE_ACTIVE_TEXTURE_BINDING_SET: u32 = 0u;

fn product_raster_bank_word(bank: u32, word: u32) -> u32 {
  if (bank == 0u) { return product_bank_raster_0[word]; }
  if (bank == 1u) { return product_bank_raster_1[word]; }
  if (bank == 2u) { return product_bank_raster_2[word]; }
  return product_bank_raster_3[word];
}
fn product_raster_u16(bank: u32, byte_offset: u32) -> u32 {
  let first = product_raster_bank_word(bank, byte_offset >> 2u);
  let second = product_raster_bank_word(bank, (byte_offset + 1u) >> 2u);
  return ((first >> ((byte_offset & 3u) * 8u)) & 0xffu) |
    (((second >> (((byte_offset + 1u) & 3u) * 8u)) & 0xffu) << 8u);
}
fn product_raster_group_header(bank: u32, location: OEngineGeometryPageLookupV1,
  group: OEngineVirtualGroupV1) -> OEngineVirtualGroupHeaderV1 {
  if (bank == 0u) { return oengine_virtual_group_header_v1(&product_bank_raster_0, location, group); }
  if (bank == 1u) { return oengine_virtual_group_header_v1(&product_bank_raster_1, location, group); }
  if (bank == 2u) { return oengine_virtual_group_header_v1(&product_bank_raster_2, location, group); }
  return oengine_virtual_group_header_v1(&product_bank_raster_3, location, group);
}
fn product_raster_meshlet_header(bank: u32, location: OEngineGeometryPageLookupV1,
  group: OEngineVirtualGroupV1, header: OEngineVirtualGroupHeaderV1,
  local: u32) -> OEngineVirtualMeshletHeaderV1 {
  if (bank == 0u) { return oengine_virtual_meshlet_header_v1(&product_bank_raster_0, location, group, header, local); }
  if (bank == 1u) { return oengine_virtual_meshlet_header_v1(&product_bank_raster_1, location, group, header, local); }
  if (bank == 2u) { return oengine_virtual_meshlet_header_v1(&product_bank_raster_2, location, group, header, local); }
  return oengine_virtual_meshlet_header_v1(&product_bank_raster_3, location, group, header, local);
}
fn product_raster_position(bank: u32, byte_offset: u32, meshlet: OEngineVirtualMeshletHeaderV1,
  format_word0: u32, format_word1: u32, vertex: u32) -> vec3f {
  let stride = format_word0 & 0xffffu;
  let position_offset = format_word1 & 0xffu;
  let at = byte_offset + meshlet.vertex_byte_offset + vertex * stride + position_offset;
  let q = vec3f(f32(product_raster_u16(bank, at)), f32(product_raster_u16(bank, at + 2u)),
    f32(product_raster_u16(bank, at + 4u))) / 65535.0;
  return mix(meshlet.bounds_min, meshlet.bounds_max, q);
}

fn product_raster_uv(bank: u32, byte_offset: u32, meshlet: OEngineVirtualMeshletHeaderV1,
  format_word0: u32, format_word1: u32, format_word2: u32, vertex: u32, uv_set: u32) -> vec2f {
  let attribute_bit = select(8u, 16u, uv_set == 1u);
  let offset = select((format_word1 >> 24u) & 0xffu, format_word2 & 0xffu, uv_set == 1u);
  if (uv_set > 1u || ((format_word0 >> 16u) & attribute_bit) == 0u || offset == 0xffu) {
    return vec2f(0.0);
  }
  let at = byte_offset + meshlet.vertex_byte_offset + vertex * (format_word0 & 0xffffu) + offset;
  let first = product_raster_u16(bank, at);
  let second = product_raster_u16(bank, at + 2u);
  return unpack2x16float(first | (second << 16u));
}

fn product_wrap_texel(value: i32, mode: u32, size: i32) -> i32 {
  if mode == 0u { return clamp(value, 0i, size - 1i); }
  if mode == 2u {
    let period = size * 2i;
    let wrapped = ((value % period) + period) % period;
    return select(wrapped, period - 1i - wrapped, wrapped >= size);
  }
  return ((value % size) + size) % size;
}

fn product_alpha_texel(texture_ref: u32, x: i32, y: i32, sampler_class: u32) -> f32 {
  let size = oengine_texture_bank_size(oengine_texture_ref_bank(texture_ref));
  return oengine_texture_bank_alpha(texture_ref, vec2i(
    product_wrap_texel(x, sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size),
    product_wrap_texel(y, (sampler_class >> OENGINE_MATERIAL_SAMPLER_ADDRESS_V_BITS) &
      OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size)));
}

fn product_sample_alpha(texture_ref: u32, uv: vec2f, sampler_class: u32) -> f32 {
  let size = f32(oengine_texture_bank_size(oengine_texture_ref_bank(texture_ref)));
  let position = uv * size - 0.5;
  let base = vec2i(floor(position));
  if (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) == 0u {
    let nearest = vec2i(floor(uv * size));
    return product_alpha_texel(texture_ref, nearest.x, nearest.y, sampler_class);
  }
  let fraction = fract(position);
  let a = product_alpha_texel(texture_ref, base.x, base.y, sampler_class);
  let b = product_alpha_texel(texture_ref, base.x + 1i, base.y, sampler_class);
  let c = product_alpha_texel(texture_ref, base.x, base.y + 1i, sampler_class);
  let d = product_alpha_texel(texture_ref, base.x + 1i, base.y + 1i, sampler_class);
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}

@vertex
fn raster_virtual_meshlet(@builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32) -> OEngineProductBucketOutput {
  var output: OEngineProductBucketOutput;
  let safe_work = min(instance_index, max(product_work.header.written_count, 1u) - 1u);
  let work = product_work.elements[safe_work];
  let local_meshlet = work.meshlet_slot & 127u;
  let group_id = work.meshlet_slot >> 7u;
  let instance = product_instances[work.instance_slot];
  let asset = oengine_geometry_product_resolve_asset_v1(&product_heap_raster,
    work.geometry_slot, oengine_instance_geometry_generation(instance));
  let group = oengine_virtual_group_v1(&product_heap_raster, asset, group_id);
  let location = oengine_geometry_product_lookup_page_heap_v1(&product_heap_raster, asset, group.page_id);
  let triangle = vertex_index / 3u;
  let corner = vertex_index % 3u;
  var header = oengine_virtual_invalid_group_header_v1();
  var meshlet = oengine_virtual_invalid_meshlet_header_v1();
  var format_word0 = 0u;
  var format_word1 = 0u;
  var format_word2 = 0u;
  var local_vertex = 0u;
  var valid = false;
  var position = vec3f(0.0);
  if (asset.valid && group.valid && location.valid) {
    header = product_raster_group_header(location.bank_index, location, group);
    if (header.valid) {
      meshlet = product_raster_meshlet_header(location.bank_index, location, group, header, local_meshlet);
      let format_valid = header.vertex_format_id < asset.vertex_format_count;
      if (format_valid) {
        let format_at = asset.vertex_format_word_offset + header.vertex_format_id * 4u;
        format_word0 = product_heap_raster[format_at];
        format_word1 = product_heap_raster[format_at + 1u];
        format_word2 = product_heap_raster[format_at + 2u];
      }
      if (meshlet.valid && triangle < meshlet.triangle_count && format_valid) {
        let triangle_byte = location.byte_offset + group.offset_in_page + meshlet.triangle_byte_offset + triangle * 3u + corner;
        local_vertex = (product_raster_bank_word(location.bank_index, triangle_byte >> 2u) >> ((triangle_byte & 3u) * 8u)) & 0xffu;
        valid = true;
        position = product_raster_position(location.bank_index,
          location.byte_offset + group.offset_in_page, meshlet, format_word0, format_word1, local_vertex);
      }
    }
  }
  let matrix = oengine_instance_current_object_to_world(instance);
  output.position = select(vec4f(2.0, 2.0, 2.0, 1.0),
    product_camera.view_projection_matrix * matrix * vec4f(position, 1.0), valid);
  output.instance_slot = work.instance_slot;
  output.meshlet_slot = work.meshlet_slot;
  output.triangle = triangle;
  output.uv0 = vec2f(0.0);
  output.uv1 = vec2f(0.0);
  if (valid) {
    output.uv0 = product_raster_uv(location.bank_index,
      location.byte_offset + group.offset_in_page, meshlet, format_word0,
      format_word1, format_word2, local_vertex, 0u);
    output.uv1 = product_raster_uv(location.bank_index,
      location.byte_offset + group.offset_in_page, meshlet, format_word0,
      format_word1, format_word2, local_vertex, 1u);
  }
  output.uv2 = vec2f(0.0);
  output.uv_valid_mask = select(0u, 1u, ((format_word0 >> 16u) & 8u) != 0u) |
    select(0u, 2u, ((format_word0 >> 16u) & 16u) != 0u);
  output.material_handle = work.material_slot_or_range;
  output.meshlet_work_slot = safe_work;
  return output;
}

@fragment
fn write_virtual_meshlet(@location(0) @interpolate(flat) instance_slot: u32,
  @location(1) @interpolate(flat) meshlet_slot: u32,
  @location(2) @interpolate(flat) triangle: u32,
  @location(7) @interpolate(flat) material_handle: u32,
  @location(8) @interpolate(flat) meshlet_work_slot: u32,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(6) @interpolate(flat) uv_valid_mask: u32) -> @location(0) u32 {
  if material_handle >= arrayLength(&product_materials) { discard; }
  let record = product_materials[material_handle].payload;
  if (record.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u { discard; }
  if record.texture_binding_set_id != OENGINE_ACTIVE_TEXTURE_BINDING_SET { discard; }
  if record.alpha_mode == OENGINE_MATERIAL_ALPHA_BLEND { discard; }
  if record.alpha_mode == OENGINE_MATERIAL_ALPHA_MASK {
    var alpha = record.base_color_factor_alpha;
    let uv_set = record.texture_uv_sets & 0xffu;
    let uv_bit = select(0u, 1u << uv_set, uv_set < 3u);
    if (record.flags & OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE) != 0u {
      if (!oengine_texture_ref_valid(record.texture_ref) || uv_set > 1u ||
          (uv_valid_mask & uv_bit) == 0u) { discard; }
      let source_uv = select(uv0, uv1, uv_set == 1u);
      let scaled = source_uv * record.uv_offset_scale.zw;
      let uv = record.uv_offset_scale.xy + vec2f(
        record.uv_rotation.x * scaled.x - record.uv_rotation.y * scaled.y,
        record.uv_rotation.y * scaled.x + record.uv_rotation.x * scaled.y);
      alpha *= product_sample_alpha(record.texture_ref, uv, record.sampler_class);
    }
    if alpha < record.alpha_cutoff { discard; }
  }
  return oengine_visibility_key_try_encode(meshlet_work_slot, triangle).key;
}
`;

/** Product raster variant used by the sparse ShadingBin MRT path. */
export const VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_SHADING_BIN_WGSL =
  VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL.replace(
    `) -> @location(0) u32 {`,
    `) -> OEngineProductVisibilityOutput {`
  ).replace(
    `  return oengine_visibility_key_try_encode(meshlet_work_slot, triangle).key;
}`,
    `  let key = oengine_visibility_key_try_encode(meshlet_work_slot, triangle).key;
  let shading_bin_id = oengine_instance_shading_bin_id(
    product_work.elements[meshlet_work_slot].packed_raster_flags
  );
  return OEngineProductVisibilityOutput(key, shading_bin_id);
}`
  ).replace(
    `@fragment
fn write_virtual_meshlet`,
    `struct OEngineProductVisibilityOutput {
  @location(0) visibility_key: u32,
  @location(1) shading_bin_id: u32,
};

@fragment
fn write_virtual_meshlet`
  );
