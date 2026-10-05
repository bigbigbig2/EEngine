import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_GEOMETRY_VERTEX_DECODE_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_UV_FORMAT,
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import type { AppearancePublishedCoverage } from "../gpu/GpuAppearancePublication.js";
import { RASTER_PARTITION_CONSUMER_WGSL } from "./raster_work_partitions.js";
import {
  COVERAGE_VERTEX_VARYINGS,
  coverageVertexAttributesWgsl,
  coverageVertexAssignment,
  rasterCoverageFragmentWgsl,
} from "./raster_coverage_fragment.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";
import { GPU_FRAME_ATTRIBUTE_VECTORS } from "../gpu/GpuFrameGeometryAttributesAbi.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { frameGeometryRasterWgsl } from "./frame_geometry_raster.js";

export const MESHLET_BUCKET_SETTINGS_STRIDE = 256;
export const MESHLET_BUCKET_SETTINGS_SIZE = 16;
export function meshletBucketVisibilityWgsl(
  primitiveIndex: boolean,
  includeShadingBinId = true,
  coverage?: AppearancePublishedCoverage,
): string {
  const primitiveIndexEnable = primitiveIndex ? "enable primitive_index;" : "";
  const triangleVarying = primitiveIndex ? "" : "  @location(2) @interpolate(flat) triangle: u32,";
  const triangleAssignment = primitiveIndex ? "" : "  output.triangle = triangle;";
  const shadingBinVarying = includeShadingBinId
    ? "  @location(9) @interpolate(flat) shading_bin_id: u32,"
    : "";
  const shadingBinAssignment = includeShadingBinId
    ? "  output.shading_bin_id = oengine_instance_shading_bin_id(work.packed_raster_flags);"
    : "";
  return /* wgsl */ `
${primitiveIndexEnable}
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${frameGeometryRasterWgsl(20, 21)}



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
${coverage ? COVERAGE_VERTEX_VARYINGS : ""}
};
${RASTER_PARTITION_CONSUMER_WGSL}
${coverage ? coverageVertexAttributesWgsl(false) : ""}

@group(0) @binding(0) var<uniform> meshlet_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> meshlet_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(2) var<storage, read> meshlet_records: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> meshlet_vertices: array<u32>;
@group(0) @binding(4) var<storage, read> meshlet_triangles: array<u32>;
@group(0) @binding(5) var<storage, read> meshlet_vertex_data: array<u32>;
@group(0) @binding(6) var<storage, read> meshlet_geometries: array<GpuGeometryRecord>;
@group(0) @binding(7) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(10) var<storage, read> meshlet_materials: array<OEngineShadingMaterialRecord>;



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
  let work_index = raster_source_work(instance_index);
  let work = meshlet_work.elements[work_index];
  let frame_instance = meshlet_instances[work.instance_slot];
  let instance = frame_instance.source;
  let geometry = meshlet_geometries[work.geometry_slot];
  let meshlet = meshlet_records[work.meshlet_slot];
  let triangle = vertex_index / 3u;
  let input_corner = vertex_index % 3u;
  let determinant = frame_instance.normal_x.w;
  let corner = select(input_corner, 3u - input_corner,
    determinant < 0.0 && input_corner != 0u);
  let valid = triangle < meshlet.triangle_count;
  let safe_triangle = min(triangle, max(meshlet.triangle_count, 1u) - 1u);
  let shared_meshlet = frame_raster_meshlet(work_index);
  let cached_geometry = shared_meshlet.z != 0u;
  var local_vertex: u32;
  if cached_geometry { local_vertex = frame_raster_corner(shared_meshlet, safe_triangle, corner); }
  else { local_vertex = meshlet_read_u8(meshlet.triangle_byte_offset + safe_triangle * 3u + corner); }
  let source_vertex = meshlet_vertices[meshlet.vertex_offset + local_vertex];
  let uv0 = meshlet_read_uv(geometry, 0u, source_vertex);
  let uv1 = meshlet_read_uv(geometry, 1u, source_vertex);
  let uv2 = meshlet_read_uv(geometry, 2u, source_vertex);
  var output: OEngineMeshletBucketVertexOutput;
  output.position = vec4f(2.0, 2.0, 2.0, 1.0);
  if valid {
    if cached_geometry { output.position = frame_raster_clip(shared_meshlet, local_vertex); }
    else { output.position = frame_instance.object_to_clip * vec4f(oengine_geometry_position(&meshlet_vertex_data, geometry, source_vertex), 1.0); }
  }
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
${coverage ? coverageVertexAssignment(false) : ""}
  return output;
}

${rasterCoverageFragmentWgsl(false, primitiveIndex, includeShadingBinId, coverage)}
`;
}

/** Production portable VisibilityKey + ShadingBinId dual-MRT shader. */
export const MESHLET_BUCKET_VISIBILITY_WGSL = meshletBucketVisibilityWgsl(false);

/** Production WebGPU 2026 specialization using the primitive-index builtin. */
export const MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_WGSL = meshletBucketVisibilityWgsl(true);

/** Production portable VisibilityKey single-MRT shader. */
export const MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL = meshletBucketVisibilityWgsl(false, false);

/** Production primitive-index VisibilityKey single-MRT shader. */
export const MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_SINGLE_WGSL = meshletBucketVisibilityWgsl(true, false);

/** Product uses the same partition/source-slot and compiled coverage protocol. */
export function productMeshletVisibilityWgsl(
  coverage?: AppearancePublishedCoverage,
  includeShadingBinId = false,
): string {
  return /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${frameGeometryRasterWgsl(18, 19)}
${RASTER_PARTITION_CONSUMER_WGSL}
${coverage ? coverageVertexAttributesWgsl(true) : ""}
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}


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
${includeShadingBinId ? "  @location(9) @interpolate(flat) shading_bin_id: u32," : ""}
${coverage ? COVERAGE_VERTEX_VARYINGS : ""}
};

@group(0) @binding(0) var<uniform> product_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> product_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(2) var<storage, read> product_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> product_heap_raster: array<u32>;
@group(0) @binding(4) var<storage, read> product_bank_raster_0: array<u32>;
@group(0) @binding(5) var<storage, read> product_bank_raster_1: array<u32>;
@group(0) @binding(6) var<storage, read> product_bank_raster_2: array<u32>;
@group(0) @binding(7) var<storage, read> product_bank_raster_3: array<u32>;
@group(0) @binding(8) var<storage, read> product_materials: array<OEngineShadingMaterialRecord>;



fn product_raster_bank_word(bank: u32, word: u32) -> u32 {
  if (bank == 0u) { return product_bank_raster_0[word]; }
  if (bank == 1u) { return product_bank_raster_1[word]; }
  if (bank == 2u) { return product_bank_raster_2[word]; }
  return product_bank_raster_3[word];
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
// Residency producer has already decoded all attribute formats. The page
// directory and values share the same four banks and GPU retirement boundary.
fn product_raster_resident_address(location: OEngineGeometryPageLookupV1,
  group: OEngineVirtualGroupV1, local_meshlet: u32) -> u32 {
  let directory = product_raster_bank_word(location.resident_bank, location.resident_word + group.offset_in_page / 16u);
  return product_raster_bank_word(location.resident_bank, location.resident_word + directory + local_meshlet);
}
fn product_raster_attribute(address: u32, vertex: u32, field: u32) -> vec4f {
  let bank = address >> 30u;
  let at = (address & 0x3fffffffu) + (vertex * ${GPU_FRAME_ATTRIBUTE_VECTORS}u + field) * 4u;
  return bitcast<vec4f>(vec4u(product_raster_bank_word(bank, at), product_raster_bank_word(bank, at + 1u),
    product_raster_bank_word(bank, at + 2u), product_raster_bank_word(bank, at + 3u)));
}

@vertex
fn raster_virtual_meshlet(@builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32) -> OEngineProductBucketOutput {
  var output: OEngineProductBucketOutput;
  let safe_work = raster_source_work(instance_index);
  let work = product_work.elements[safe_work];
  let local_meshlet = work.meshlet_slot & 127u;
  let group_id = work.meshlet_slot >> 7u;
  let frame_instance = product_instances[work.instance_slot];
  let instance = frame_instance.source;
  let asset = oengine_geometry_product_resolve_asset_v1(&product_heap_raster,
    work.geometry_slot, oengine_instance_geometry_generation(instance));
  let group = oengine_virtual_group_v1(&product_heap_raster, asset, group_id);
  let location = oengine_geometry_product_lookup_page_heap_v1(&product_heap_raster, asset, group.page_id);
  let triangle = vertex_index / 3u;
  let input_corner = vertex_index % 3u;
  let corner = select(input_corner,3u-input_corner,frame_instance.normal_x.w<0.0 && input_corner!=0u);
  var header = oengine_virtual_invalid_group_header_v1();
  var meshlet = oengine_virtual_invalid_meshlet_header_v1();
  var format_word0 = 0u;
  var format_word1 = 0u;
  var format_word2 = 0u;
  var local_vertex = 0u;
  var resident_address = 0u;
  var valid = false;
  var position = vec3f(0.0);
  let shared_meshlet = frame_raster_meshlet(safe_work);
  let cached_geometry = shared_meshlet.z != 0u;
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
        if cached_geometry { local_vertex = frame_raster_corner(shared_meshlet, triangle, corner); }
        else { local_vertex = (product_raster_bank_word(location.bank_index, triangle_byte >> 2u) >> ((triangle_byte & 3u) * 8u)) & 0xffu; }
        valid = true;
        resident_address = product_raster_resident_address(location, group, local_meshlet);
        if !cached_geometry { position = product_raster_attribute(resident_address, local_vertex, 5u).xyz; }
      }
    }
  }
  output.position = select(vec4f(2.0, 2.0, 2.0, 1.0),
    frame_instance.object_to_clip * vec4f(position, 1.0), valid);
  if valid && cached_geometry { output.position = frame_raster_clip(shared_meshlet, local_vertex); }
  output.instance_slot = work.instance_slot;
  output.meshlet_slot = work.meshlet_slot;
  output.triangle = triangle;
  output.uv0 = vec2f(0.0);
  output.uv1 = vec2f(0.0);
  if (valid) {
    let uv = product_raster_attribute(resident_address, local_vertex, 2u);
    output.uv0 = uv.xy; output.uv1 = uv.zw;
  }
  output.uv2 = vec2f(0.0);
  output.uv_valid_mask = select(0u, 1u, ((format_word0 >> 16u) & 8u) != 0u) |
    select(0u, 2u, ((format_word0 >> 16u) & 16u) != 0u);
  output.material_handle = work.material_slot_or_range;
  output.meshlet_work_slot = safe_work;
${includeShadingBinId ? "  output.shading_bin_id = oengine_instance_shading_bin_id(work.packed_raster_flags);" : ""}
${coverage ? coverageVertexAssignment(true) : ""}
  return output;
}

${rasterCoverageFragmentWgsl(true, false, includeShadingBinId, coverage)}
`;
}

export const VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL = productMeshletVisibilityWgsl();
export const VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_SHADING_BIN_WGSL = productMeshletVisibilityWgsl(
  undefined,
  true,
);
