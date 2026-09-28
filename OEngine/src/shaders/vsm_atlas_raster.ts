import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_UV_FORMAT,
  GPU_POSITION_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL, GPU_MESHLET_RASTER_FLAGS, GPU_MESHLET_DECODE_PROFILE } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL } from "../gpu/GpuTextureRefAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";

const VSM_PAGE_ALLOCATED = 1;
const VSM_PAGE_DIRTY = 2;
const VSM_PAGE_GENERATION_VALID = 8;

const COMMON = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL}

struct VsmAtlasConstants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, 6>,
  dimensions: vec4u,
  control: vec4u,
};
struct VsmCasterRecord {
  instance_record_index: u32, geometry_record_index: u32, meshlet_record_index: u32,
  material_handle: u32, page_slot: u32, virtual_page: u32, raster_flags: u32, packed_profile_lod: u32,
};
struct VsmCasterHeaderRead { attempted: u32, written: u32, overflow: u32, generation: u32 };
struct VsmCasterBuffer { header: VsmCasterHeaderRead, records: array<VsmCasterRecord> };
struct VsmPageTableBuffer { entries: array<VsmPageEntry> };

@group(0) @binding(0) var<uniform> constants: VsmAtlasConstants;
@group(0) @binding(1) var<storage, read> caster: VsmCasterBuffer;
@group(0) @binding(2) var<storage, read> page_table: VsmPageTableBuffer;
@group(0) @binding(3) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(4) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(0) @binding(5) var<storage, read> meshlet_vertices: array<u32>;
@group(0) @binding(6) var<storage, read> meshlet_triangles: array<u32>;
@group(0) @binding(7) var<storage, read> vertex_data: array<u32>;
@group(0) @binding(8) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(0) @binding(9) var<storage, read> materials: array<OEngineShadingMaterialRecord>;
@group(0) @binding(10) var oengine_texture_bank_0: texture_2d_array<f32>;
@group(0) @binding(11) var oengine_texture_bank_1: texture_2d_array<f32>;
@group(0) @binding(12) var oengine_texture_bank_2: texture_2d_array<f32>;
@group(0) @binding(13) var oengine_texture_bank_3: texture_2d_array<f32>;
@group(0) @binding(14) var oengine_texture_bank_4: texture_2d_array<f32>;
@group(0) @binding(15) var oengine_texture_bank_5: texture_2d_array<f32>;
@group(0) @binding(16) var oengine_texture_bank_6: texture_2d_array<f32>;
@group(0) @binding(17) var oengine_texture_bank_7: texture_2d_array<f32>;
@group(0) @binding(18) var oengine_texture_bank_8: texture_2d_array<f32>;
fn atlas_read_u16(byte_offset: u32) -> u32 {
  let word = vertex_data[byte_offset >> 2u];
  return (word >> ((byte_offset & 2u) * 8u)) & 0xffffu;
}
fn atlas_geometry_position(geometry: GpuGeometryRecord, vertex: u32) -> vec3f {
  let offset = geometry.position_byte_offset + vertex * geometry.position_stride;
  if (geometry.position_format == ${GPU_POSITION_FORMAT.Float32x3}u || geometry.position_format == ${GPU_POSITION_FORMAT.Float32x4}u) {
    let word = offset >> 2u;
    return vec3f(bitcast<f32>(vertex_data[word]), bitcast<f32>(vertex_data[word + 1u]), bitcast<f32>(vertex_data[word + 2u]));
  }
  if (geometry.position_format == ${GPU_POSITION_FORMAT.AabbUnorm16x3}u) {
    let q = vec3f(f32(atlas_read_u16(offset)), f32(atlas_read_u16(offset + 2u)), f32(atlas_read_u16(offset + 4u))) / 65535.0;
    return geometry.bounds_min.xyz + q * (geometry.bounds_max.xyz - geometry.bounds_min.xyz);
  }
  return vec3f(0.0);
}
override OENGINE_ACTIVE_TEXTURE_BINDING_SET: u32 = 0u;
override OENGINE_VSM_BATCH: u32 = 0u;

fn read_u8(byte_offset: u32) -> u32 {
  return (vertex_data[byte_offset >> 2u] >> ((byte_offset & 3u) * 8u)) & 0xffu;
}
fn read_uv(byte_offset: u32, stride: u32, format: u32, vertex: u32) -> vec3f {
  let at = byte_offset + vertex * stride;
  if (format == ${GPU_UV_FORMAT.Float32x2}u) {
    return vec3f(bitcast<f32>(vertex_data[at >> 2u]), bitcast<f32>(vertex_data[(at >> 2u) + 1u]), 1.0);
  }
  if (format == ${GPU_UV_FORMAT.Unorm8x2}u) { return vec3f(f32(read_u8(at)), f32(read_u8(at + 1u)), 255.0); }
  if (format == ${GPU_UV_FORMAT.Unorm16x2}u) { return vec3f(f32(read_u8(at) | (read_u8(at + 1u) << 8u)), f32(read_u8(at + 2u) | (read_u8(at + 3u) << 8u)), 65535.0); }
  if (format == ${GPU_UV_FORMAT.Float16x2}u) { return vec3f(unpack2x16float(vertex_data[at >> 2u]), 1.0); }
  return vec3f(0.0);
}
fn atlas_position(light: vec3f, entry: VsmPageEntry, virtual_page: u32) -> vec4f {
  let pages = constants.dimensions.x;
  let level_span = pages * pages;
  let level = min(5u, virtual_page / max(1u, level_span));
  // The virtual page index carries the full-page stride; coordinates outside
  // the selected mip are unused and therefore cannot address a dirty page.
  let local = virtual_page - level * level_span;
  let page_axis = max(1u, pages >> min(entry.mip, 5u));
  let page_x = local % pages;
  let page_y = local / pages;
  let extent = constants.clip_origin_extent[level].z;
  let uv = (light.xy - constants.clip_origin_extent[level].xy) / max(extent, 1e-5) * f32(page_axis) - vec2f(f32(page_x), f32(page_y));
  let slot_x = entry.slot_x;
  let slot_y = entry.slot_y;
  let texel = vec2f(f32(slot_x * (constants.dimensions.y + constants.dimensions.z * 2u) + constants.dimensions.z), f32(slot_y * (constants.dimensions.y + constants.dimensions.z * 2u) + constants.dimensions.z)) + uv * f32(constants.dimensions.y);
  let ndc = vec2f(texel.x / f32(constants.dimensions.w) * 2.0 - 1.0, 1.0 - texel.y / f32(constants.dimensions.w) * 2.0);
  let depth = clamp(0.5 - light.z / max(extent * 8.0, 1.0), 0.0, 1.0);
  return vec4f(ndc, depth, 1.0);
}
fn valid_page(record: VsmCasterRecord) -> VsmPageEntry {
  if (record.virtual_page >= arrayLength(&page_table.entries)) { return VsmPageEntry(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u); }
  let entry = page_table.entries[record.virtual_page];
  if (entry.slot_x + entry.slot_y * max(1u, constants.dimensions.w / (constants.dimensions.y + constants.dimensions.z * 2u)) != record.page_slot ||
      entry.generation != constants.control.x ||
      (entry.flags & (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) !=
        (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) {
    return VsmPageEntry(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
  }
  return entry;
}
fn transform_uv(record: OEngineMaterialVisibilityRecord, uv: vec2f) -> vec2f {
  let scaled = uv * record.uv_offset_scale.zw;
  return record.uv_offset_scale.xy + vec2f(record.uv_rotation.x * scaled.x - record.uv_rotation.y * scaled.y, record.uv_rotation.y * scaled.x + record.uv_rotation.x * scaled.y);
}
fn wrap_texel(value: i32, mode: u32, size: i32) -> i32 {
  if (mode == 0u) { return clamp(value, 0i, size - 1i); }
  if (mode == 2u) { let period = size * 2i; let wrapped = ((value % period) + period) % period; return select(wrapped, period - 1i - wrapped, wrapped >= size); }
  return ((value % size) + size) % size;
}
fn alpha_texel(texture_ref: u32, x: i32, y: i32, sampler_class: u32) -> f32 {
  let size = oengine_texture_bank_size(oengine_texture_ref_bank(texture_ref));
  return oengine_texture_bank_alpha(texture_ref, vec2i(wrap_texel(x, sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size), wrap_texel(y, (sampler_class >> OENGINE_MATERIAL_SAMPLER_ADDRESS_V_BITS) & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size)));
}
fn sample_alpha(texture_ref: u32, uv: vec2f, sampler_class: u32) -> f32 {
  let size = f32(oengine_texture_bank_size(oengine_texture_ref_bank(texture_ref)));
  let position = uv * size - 0.5; let base = vec2i(floor(position));
  if ((sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) == 0u) { return alpha_texel(texture_ref, i32(floor(uv.x * size)), i32(floor(uv.y * size)), sampler_class); }
  let f = fract(position);
  return mix(mix(alpha_texel(texture_ref, base.x, base.y, sampler_class), alpha_texel(texture_ref, base.x + 1i, base.y, sampler_class), f.x), mix(alpha_texel(texture_ref, base.x, base.y + 1i, sampler_class), alpha_texel(texture_ref, base.x + 1i, base.y + 1i, sampler_class), f.x), f.y);
}
`;

export const VSM_ATLAS_RASTER_WGSL = /* wgsl */ `${COMMON}
struct VsmAtlasOutput {
  @builtin(position) position: vec4f,
  @location(0) uv0: vec2f,
  @location(1) uv1: vec2f,
  @location(2) uv2: vec2f,
  @location(3) @interpolate(flat) uv_valid_mask: u32,
  @location(4) @interpolate(flat) material_handle: u32,
  @location(5) @interpolate(flat) mirrored: u32,
  @location(6) @interpolate(flat) raster_flags: u32,
  @location(7) @interpolate(flat) valid: u32,
};
@vertex fn vsm_atlas_vertex(@builtin(vertex_index) vertex_index: u32) -> VsmAtlasOutput {
  let record_index = vertex_index / 3u;
  let corner = vertex_index % 3u;
  var out: VsmAtlasOutput;
  if (record_index >= min(caster.header.written, constants.control.z)) { out.position = vec4f(2.0); out.valid = 0u; return out; }
  let record = caster.records[record_index];
  if ((record.packed_profile_lod & 0xffu) == ${GPU_MESHLET_DECODE_PROFILE.VirtualGeometryProductV1}u ||
      ((record.raster_flags & ${GPU_MESHLET_RASTER_FLAGS.AlphaTested}u) != 0u) != (OENGINE_VSM_BATCH == 1u)) { out.position = vec4f(2.0); out.valid = 0u; return out; }
  let entry = valid_page(record);
  if ((entry.flags & ${VSM_PAGE_ALLOCATED}u) == 0u) { out.position = vec4f(2.0); out.valid = 0u; return out; }
  let instance = instances[record.instance_record_index];
  let geometry = geometries[record.geometry_record_index];
  let meshlet = meshlets[record.meshlet_record_index];
  let triangle = vertex_index / 3u;
  if (triangle >= meshlet.triangle_count) { out.position = vec4f(2.0); out.valid = 0u; return out; }
  let local_vertex = (meshlet_triangles[ (meshlet.triangle_byte_offset + triangle * 3u + corner) >> 2u] >> (((meshlet.triangle_byte_offset + triangle * 3u + corner) & 3u) * 8u)) & 0xffu;
  let source_vertex = meshlet_vertices[meshlet.vertex_offset + local_vertex];
  let local = atlas_geometry_position(geometry, source_vertex);
  let object_to_world = oengine_instance_current_object_to_world(instance);
  let world = object_to_world * vec4f(local, 1.0);
  let light = (constants.light_view * world).xyz;
  let uv0 = read_uv(geometry.uv0_byte_offset, geometry.uv0_stride, geometry.uv0_format, source_vertex);
  let uv1 = read_uv(geometry.uv1_byte_offset, geometry.uv1_stride, geometry.uv1_format, source_vertex);
  let uv2 = read_uv(geometry.uv2_byte_offset, geometry.uv2_stride, geometry.uv2_format, source_vertex);
  out.position = atlas_position(light, entry, record.virtual_page); out.uv0 = select(vec2f(0.0), uv0.xy / uv0.z, uv0.z > 0.0); out.uv1 = select(vec2f(0.0), uv1.xy / uv1.z, uv1.z > 0.0); out.uv2 = select(vec2f(0.0), uv2.xy / uv2.z, uv2.z > 0.0);
  out.uv_valid_mask = select(0u, 1u, uv0.z > 0.0) | select(0u, 2u, uv1.z > 0.0) | select(0u, 4u, uv2.z > 0.0);
  out.material_handle = record.material_handle; out.mirrored = select(0u, 1u, dot(object_to_world[0].xyz, cross(object_to_world[1].xyz, object_to_world[2].xyz)) < 0.0); out.raster_flags = record.raster_flags; out.valid = 1u; return out;
}
@fragment fn vsm_atlas_fragment(input: VsmAtlasOutput, @builtin(front_facing) front: bool) {
  if (input.valid == 0u || (input.raster_flags & ${GPU_MESHLET_RASTER_FLAGS.Transparent}u) != 0u) { discard; }
  if (input.material_handle >= arrayLength(&materials)) { discard; }
  let material = materials[input.material_handle].payload;
  if (material.texture_binding_set_id != OENGINE_ACTIVE_TEXTURE_BINDING_SET || (material.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u) { discard; }
  let corrected_front = front != (input.mirrored != 0u);
  if ((material.flags & OENGINE_MATERIAL_VISIBILITY_DOUBLE_SIDED) == 0u && !corrected_front) { discard; }
  if (material.alpha_mode == OENGINE_MATERIAL_ALPHA_BLEND) { discard; }
  if (material.alpha_mode == OENGINE_MATERIAL_ALPHA_MASK) {
    var alpha = material.base_color_factor_alpha; let uv_set = material.texture_uv_sets & 0xffu; let uv_bit = select(0u, 1u << uv_set, uv_set < 3u);
    if ((material.flags & OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE) != 0u && oengine_texture_ref_valid(material.texture_ref) && (input.uv_valid_mask & uv_bit) != 0u) { alpha *= sample_alpha(material.texture_ref, transform_uv(material, select(select(input.uv0, input.uv1, uv_set == 1u), input.uv2, uv_set == 2u)), material.sampler_class); }
    if (alpha < material.alpha_cutoff) { discard; }
  }
}
`;

/** Product caster depth consumer. It shares the same page/generation contract. */
const PRODUCT_COMMON = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL}
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}
struct VsmAtlasConstants { light_view: mat4x4f, clip_origin_extent: array<vec4f, 6>, dimensions: vec4u, control: vec4u };
struct VsmCasterRecord { instance_record_index: u32, geometry_record_index: u32, meshlet_record_index: u32, material_handle: u32, page_slot: u32, virtual_page: u32, raster_flags: u32, packed_profile_lod: u32 };
struct VsmCasterHeaderRead { attempted: u32, written: u32, overflow: u32, generation: u32 };
struct VsmCasterBuffer { header: VsmCasterHeaderRead, records: array<VsmCasterRecord> };
struct VsmPageTableBuffer { entries: array<VsmPageEntry> };
@group(0) @binding(0) var<uniform> constants: VsmAtlasConstants;
@group(0) @binding(1) var<storage, read> caster: VsmCasterBuffer;
@group(0) @binding(2) var<storage, read> page_table: VsmPageTableBuffer;
@group(0) @binding(3) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(4) var<storage, read> product_heap: array<u32>;
@group(0) @binding(5) var<storage, read> product_bank_0: array<u32>;
@group(0) @binding(6) var<storage, read> product_bank_1: array<u32>;
@group(0) @binding(7) var<storage, read> product_bank_2: array<u32>;
@group(0) @binding(8) var<storage, read> product_bank_3: array<u32>;
@group(0) @binding(9) var oengine_texture_bank_0: texture_2d_array<f32>;
@group(0) @binding(10) var oengine_texture_bank_1: texture_2d_array<f32>;
@group(0) @binding(11) var oengine_texture_bank_2: texture_2d_array<f32>;
@group(0) @binding(12) var oengine_texture_bank_3: texture_2d_array<f32>;
@group(0) @binding(13) var oengine_texture_bank_4: texture_2d_array<f32>;
@group(0) @binding(14) var oengine_texture_bank_5: texture_2d_array<f32>;
@group(0) @binding(15) var oengine_texture_bank_6: texture_2d_array<f32>;
@group(0) @binding(16) var oengine_texture_bank_7: texture_2d_array<f32>;
@group(0) @binding(17) var oengine_texture_bank_8: texture_2d_array<f32>;
@group(0) @binding(18) var<storage, read> product_materials: array<OEngineShadingMaterialRecord>;
override OENGINE_ACTIVE_TEXTURE_BINDING_SET: u32 = 0u;
override OENGINE_VSM_BATCH: u32 = 0u;
fn product_word(bank: u32, word: u32) -> u32 { if (bank == 0u) { return product_bank_0[word]; } if (bank == 1u) { return product_bank_1[word]; } if (bank == 2u) { return product_bank_2[word]; } return product_bank_3[word]; }
fn product_u16(bank: u32, at: u32) -> u32 { let a = product_word(bank, at >> 2u); let b = product_word(bank, (at + 1u) >> 2u); return ((a >> ((at & 3u) * 8u)) & 0xffu) | (((b >> (((at + 1u) & 3u) * 8u)) & 0xffu) << 8u); }
fn product_group_header(bank: u32, location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1) -> OEngineVirtualGroupHeaderV1 { if (bank == 0u) { return oengine_virtual_group_header_v1(&product_bank_0, location, group); } if (bank == 1u) { return oengine_virtual_group_header_v1(&product_bank_1, location, group); } if (bank == 2u) { return oengine_virtual_group_header_v1(&product_bank_2, location, group); } return oengine_virtual_group_header_v1(&product_bank_3, location, group); }
fn product_meshlet_header(bank: u32, location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1, header: OEngineVirtualGroupHeaderV1, local: u32) -> OEngineVirtualMeshletHeaderV1 { if (bank == 0u) { return oengine_virtual_meshlet_header_v1(&product_bank_0, location, group, header, local); } if (bank == 1u) { return oengine_virtual_meshlet_header_v1(&product_bank_1, location, group, header, local); } if (bank == 2u) { return oengine_virtual_meshlet_header_v1(&product_bank_2, location, group, header, local); } return oengine_virtual_meshlet_header_v1(&product_bank_3, location, group, header, local); }
fn product_pos(bank: u32, base: u32, meshlet: OEngineVirtualMeshletHeaderV1, format0: u32, format1: u32, vertex: u32) -> vec3f { let at = base + meshlet.vertex_byte_offset + vertex * (format0 & 0xffffu) + (format1 & 0xffu); let q = vec3f(f32(product_u16(bank, at)), f32(product_u16(bank, at + 2u)), f32(product_u16(bank, at + 4u))) / 65535.0; return mix(meshlet.bounds_min, meshlet.bounds_max, q); }
fn product_uv(bank: u32, base: u32, meshlet: OEngineVirtualMeshletHeaderV1, format0: u32, format1: u32, format2: u32, vertex: u32, uv_set: u32) -> vec2f { if (uv_set > 1u) { return vec2f(0.0); } let bit = select(8u, 16u, uv_set == 1u); let offset = select((format1 >> 24u) & 0xffu, format2 & 0xffu, uv_set == 1u); if ((format0 & (bit << 16u)) == 0u || offset == 0xffu) { return vec2f(0.0); } let at = base + meshlet.vertex_byte_offset + vertex * (format0 & 0xffffu) + offset; return unpack2x16float(product_u16(bank, at) | (product_u16(bank, at + 2u) << 16u)); }
fn valid_page(record: VsmCasterRecord) -> VsmPageEntry { if (record.virtual_page >= arrayLength(&page_table.entries)) { return VsmPageEntry(0u,0u,0u,0u,0u,0u,0u,0u); } let entry = page_table.entries[record.virtual_page]; let axis = max(1u, constants.dimensions.w / (constants.dimensions.y + constants.dimensions.z * 2u)); if (entry.slot_x + entry.slot_y * axis != record.page_slot || entry.generation != constants.control.x || (entry.flags & (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) != (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) { return VsmPageEntry(0u,0u,0u,0u,0u,0u,0u,0u); } return entry; }
fn atlas_position(light: vec3f, entry: VsmPageEntry, virtual_page: u32) -> vec4f { let pages = constants.dimensions.x; let span = pages * pages; let level = min(5u, virtual_page / max(1u, span)); let local = virtual_page - level * span; let axis = max(1u, pages >> min(entry.mip, 5u)); let page_x = local % pages; let page_y = local / pages; let extent = constants.clip_origin_extent[level].z; let uv = (light.xy - constants.clip_origin_extent[level].xy) / max(extent, 1e-5) * f32(axis) - vec2f(f32(page_x), f32(page_y)); let pitch = constants.dimensions.y + constants.dimensions.z * 2u; let texel = vec2f(f32(entry.slot_x * pitch + constants.dimensions.z), f32(entry.slot_y * pitch + constants.dimensions.z)) + uv * f32(constants.dimensions.y); return vec4f(texel.x / f32(constants.dimensions.w) * 2.0 - 1.0, 1.0 - texel.y / f32(constants.dimensions.w) * 2.0, clamp(0.5 - light.z / max(extent * 8.0, 1.0), 0.0, 1.0), 1.0); }
fn transform_uv(record: OEngineMaterialVisibilityRecord, uv: vec2f) -> vec2f { let scaled = uv * record.uv_offset_scale.zw; return record.uv_offset_scale.xy + vec2f(record.uv_rotation.x * scaled.x - record.uv_rotation.y * scaled.y, record.uv_rotation.y * scaled.x + record.uv_rotation.x * scaled.y); }
`;

export const VSM_ATLAS_PRODUCT_RASTER_WGSL = /* wgsl */ `${PRODUCT_COMMON}
struct VsmProductOutput { @builtin(position) position: vec4f, @location(0) uv0: vec2f, @location(1) uv1: vec2f, @location(2) @interpolate(flat) material_handle: u32, @location(3) @interpolate(flat) raster_flags: u32, @location(4) @interpolate(flat) valid: u32 };
@vertex fn vsm_atlas_product_vertex(@builtin(vertex_index) vertex_index: u32) -> VsmProductOutput { var out: VsmProductOutput; let index = vertex_index / 3u; let corner = vertex_index % 3u; if (index >= min(caster.header.written, constants.control.z)) { out.position = vec4f(2.0); out.valid = 0u; return out; } let record = caster.records[index]; if ((record.packed_profile_lod & 0xffu) != ${GPU_MESHLET_DECODE_PROFILE.VirtualGeometryProductV1}u || ((record.raster_flags & ${GPU_MESHLET_RASTER_FLAGS.AlphaTested}u) != 0u) != (OENGINE_VSM_BATCH == 1u)) { out.position = vec4f(2.0); out.valid = 0u; return out; } let entry = valid_page(record); if ((entry.flags & ${VSM_PAGE_ALLOCATED}u) == 0u) { out.position = vec4f(2.0); out.valid = 0u; return out; } let instance = instances[record.instance_record_index]; let asset = oengine_geometry_product_resolve_asset_v1(&product_heap, record.geometry_record_index, oengine_instance_geometry_generation(instance)); let group_id = record.meshlet_record_index >> 7u; let local_meshlet = record.meshlet_record_index & 127u; let group = oengine_virtual_group_v1(&product_heap, asset, group_id); let location = oengine_geometry_product_lookup_page_heap_v1(&product_heap, asset, group.page_id); if (!asset.valid || !group.valid || !location.valid) { out.position = vec4f(2.0); out.valid = 0u; return out; } let header = product_group_header(location.bank_index, location, group); let meshlet = product_meshlet_header(location.bank_index, location, group, header, local_meshlet); if (!header.valid || !meshlet.valid || vertex_index / 3u >= meshlet.triangle_count || header.vertex_format_id >= asset.vertex_format_count) { out.position = vec4f(2.0); out.valid = 0u; return out; } let at = asset.vertex_format_word_offset + header.vertex_format_id * 4u; let format0 = product_heap[at]; let format1 = product_heap[at + 1u]; let format2 = product_heap[at + 2u]; let triangle_at = location.byte_offset + group.offset_in_page + meshlet.triangle_byte_offset + vertex_index / 3u * 3u + corner; let local_vertex = (product_word(location.bank_index, triangle_at >> 2u) >> ((triangle_at & 3u) * 8u)) & 0xffu; let base = location.byte_offset + group.offset_in_page; let local = product_pos(location.bank_index, base, meshlet, format0, format1, local_vertex); let world = oengine_instance_current_object_to_world(instance) * vec4f(local, 1.0); let light = (constants.light_view * world).xyz; out.position = atlas_position(light, entry, record.virtual_page); out.uv0 = product_uv(location.bank_index, base, meshlet, format0, format1, format2, local_vertex, 0u); out.uv1 = product_uv(location.bank_index, base, meshlet, format0, format1, format2, local_vertex, 1u); out.material_handle = record.material_handle; out.raster_flags = record.raster_flags; out.valid = 1u; return out; }
@fragment fn vsm_atlas_product_fragment(input: VsmProductOutput) { if (input.valid == 0u || (input.raster_flags & ${GPU_MESHLET_RASTER_FLAGS.Transparent}u) != 0u) { discard; } if (input.material_handle >= arrayLength(&product_materials)) { discard; } let material = product_materials[input.material_handle].payload; if (material.texture_binding_set_id != OENGINE_ACTIVE_TEXTURE_BINDING_SET || (material.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u) { discard; } if (material.alpha_mode == OENGINE_MATERIAL_ALPHA_BLEND) { discard; } if (material.alpha_mode == OENGINE_MATERIAL_ALPHA_MASK) { var alpha = material.base_color_factor_alpha; if ((material.flags & OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE) != 0u && oengine_texture_ref_valid(material.texture_ref)) { alpha *= oengine_texture_bank_alpha(material.texture_ref, vec2i(0, 0)); } if (alpha < material.alpha_cutoff) { discard; } } }
`;

export const VSM_RASTER_BATCH_COUNT = 2;
