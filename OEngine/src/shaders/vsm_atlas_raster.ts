import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_GEOMETRY_RECORD_WGSL, GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { RASTER_PARTITION_CONSUMER_WGSL } from "./raster_work_partitions.js";
import { GPU_FRAME_ATTRIBUTE_VECTORS } from "../gpu/GpuFrameGeometryAttributesAbi.js";
import type { AppearancePublishedCoverage } from "../gpu/GpuAppearancePublication.js";

export const VSM_ATLAS_PAGE_CLEAR_WGSL = /* wgsl */ `
struct Constants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, 6>,
  dimensions: vec4u, // pages/axis, page size, border, atlas dimension
  control: vec4u,    // generation, work capacity, caster capacity, resident slots
};
struct PageWork {
  virtual_page: u32, slot: u32, priority: u32, generation: u32,
  flags: u32, fallback_mip: u32, reserved_0: u32, reserved_1: u32,
};
struct Allocation {
  attempted: u32, written: u32, overflow: u32, generation: u32,
  records: array<PageWork>,
};
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> allocation: Allocation;
const corners = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
  vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
@vertex fn clear_page(@builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) record_index: u32) -> @builtin(position) vec4f {
  if (record_index >= min(allocation.written, constants.control.w)) { return vec4f(2.0); }
  let record = allocation.records[record_index];
  if (record.generation != constants.control.x || (record.flags & 2u) == 0u ||
      record.slot >= constants.control.w) { return vec4f(2.0); }
  let pitch = constants.dimensions.y + constants.dimensions.z * 2u;
  let slots_per_axis = max(1u, constants.dimensions.w / pitch);
  let origin = vec2f(f32((record.slot % slots_per_axis) * pitch),
    f32((record.slot / slots_per_axis) * pitch));
  let texel = origin + corners[vertex_index] * f32(pitch);
  let extent = f32(constants.dimensions.w);
  return vec4f(texel.x / extent * 2.0 - 1.0,
    1.0 - texel.y / extent * 2.0, 0.0, 1.0);
}
@fragment fn clear_depth() -> @builtin(frag_depth) f32 { return 0.0; }
`;

const VSM_PAGE_ALLOCATED = 1,
  VSM_PAGE_DIRTY = 2,
  VSM_PAGE_GENERATION_VALID = 8;
export const VSM_ATLAS_PAGE_MATH = /* wgsl */ `
fn atlas_position(light: vec3f, entry: VsmPageEntry, virtual_page: u32) -> vec4f {
  let pages = constants.dimensions.x;
  let coordinates = vsm_page_entry_coordinates(virtual_page, pages);
  let level = min(5u, coordinates.x);
  let page_axis = max(1u, pages >> min(entry.mip, 5u));
  let page_x = coordinates.z;
  let page_y = coordinates.w;
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
`;
const PRODUCT_READERS = /* wgsl */ `
fn product_word(bank: u32, word: u32) -> u32 { if (bank == 0u) { return product_bank_0[word]; } if (bank == 1u) { return product_bank_1[word]; } if (bank == 2u) { return product_bank_2[word]; } return product_bank_3[word]; }
fn product_u16(bank: u32, at: u32) -> u32 { let a = product_word(bank, at >> 2u); let b = product_word(bank, (at + 1u) >> 2u); return ((a >> ((at & 3u) * 8u)) & 0xffu) | (((b >> (((at + 1u) & 3u) * 8u)) & 0xffu) << 8u); }
fn product_group_header(bank: u32, location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1) -> OEngineVirtualGroupHeaderV1 { if (bank == 0u) { return oengine_virtual_group_header_v1(&product_bank_0, location, group); } if (bank == 1u) { return oengine_virtual_group_header_v1(&product_bank_1, location, group); } if (bank == 2u) { return oengine_virtual_group_header_v1(&product_bank_2, location, group); } return oengine_virtual_group_header_v1(&product_bank_3, location, group); }
fn product_meshlet_header(bank: u32, location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1, header: OEngineVirtualGroupHeaderV1, local: u32) -> OEngineVirtualMeshletHeaderV1 { if (bank == 0u) { return oengine_virtual_meshlet_header_v1(&product_bank_0, location, group, header, local); } if (bank == 1u) { return oengine_virtual_meshlet_header_v1(&product_bank_1, location, group, header, local); } if (bank == 2u) { return oengine_virtual_meshlet_header_v1(&product_bank_2, location, group, header, local); } return oengine_virtual_meshlet_header_v1(&product_bank_3, location, group, header, local); }
`;

/** Caster record is selected by instance_index; vertex_index only selects the
 * triangle and corner within that caster's meshlet. */
export function vsmAtlasRasterWgsl(product: boolean, coverage?: AppearancePublishedCoverage): string {
  return /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_SHADING_MATERIAL_WGSL}
${product ? VIRTUAL_GEOMETRY_PRODUCT_WGSL : GPU_GEOMETRY_RECORD_WGSL + GPU_MESHLET_RECORD_WGSL}
${RASTER_PARTITION_CONSUMER_WGSL}
struct VsmAtlasConstants { light_view:mat4x4f,clip_origin_extent:array<vec4f,6>,dimensions:vec4u,control:vec4u }
struct VsmCasterRecord { instance_record_index:u32,geometry_record_index:u32,meshlet_record_index:u32,
  material_handle:u32,page_slot:u32,virtual_page:u32,raster_flags:u32,packed_profile_lod:u32 }
struct CasterHeader { attempted:u32,written:u32,overflow:u32,generation:u32 }
struct VsmCasterBuffer { header:CasterHeader,records:array<VsmCasterRecord> }
struct VsmPageTableBuffer { entries:array<VsmPageEntry> }
@group(0) @binding(0) var<uniform> constants:VsmAtlasConstants;
@group(0) @binding(1) var<storage,read> caster:VsmCasterBuffer;
@group(0) @binding(2) var<storage,read> page_table:VsmPageTableBuffer;
@group(0) @binding(3) var<storage,read> instances:array<OEngineInstanceRecord>;
${
  product
    ? `@group(0) @binding(4) var<storage,read> product_heap:array<u32>;
${Array.from({ length: 4 }, (_, i) => `@group(0) @binding(${5 + i}) var<storage,read> product_bank_${i}:array<u32>;`).join("\n")}`
    : `
@group(0) @binding(4) var<storage,read> meshlets:array<GpuMeshletRecord>;
@group(0) @binding(5) var<storage,read> meshlet_vertices:array<u32>;
@group(0) @binding(6) var<storage,read> meshlet_triangles:array<u32>;
@group(0) @binding(7) var<storage,read> vertex_data:array<u32>;
@group(0) @binding(8) var<storage,read> geometries:array<GpuGeometryRecord>;`
}
@group(0) @binding(9) var<storage,read> materials:array<OEngineShadingMaterialRecord>;
${
  coverage
    ? `@group(0) @binding(30) var<storage,read> frame_instances:array<OEngineFrameInstanceRecord>;
@group(0) @binding(31) var<uniform> camera:CommandEncoder;`
    : ""
}
${VSM_ATLAS_PAGE_MATH}
${
  product
    ? PRODUCT_READERS +
      `fn resident_attribute(address:u32,vertex:u32,field:u32)->vec4f {
  let bank=address>>30u;
  let at=(address & 0x3fffffffu)+(vertex*${GPU_FRAME_ATTRIBUTE_VECTORS}u+field)*4u;
  return bitcast<vec4f>(vec4u(product_word(bank,at),product_word(bank,at+1u),product_word(bank,at+2u),product_word(bank,at+3u)));
}`
    : `fn resident_attribute(base:u32,vertex:u32,field:u32)->vec4f {
  let at=base+(vertex*${GPU_FRAME_ATTRIBUTE_VECTORS}u+field)*4u;
  return bitcast<vec4f>(vec4u(vertex_data[at],vertex_data[at+1u],vertex_data[at+2u],vertex_data[at+3u]));
}`
}
struct AtlasVertex {
  @builtin(position) position:vec4f,
  @location(0) @interpolate(flat) page_bounds:vec4f,
${
  coverage
    ? `  @location(1) uv0:vec2f,@location(2) uv1:vec2f,@location(3) uv2:vec2f,
  @location(4) @interpolate(flat) material:u32,@location(5) @interpolate(flat) instance:u32,
  @location(6) normal:vec4f,@location(7) tangent:vec4f,@location(8) color:vec4f,@location(9) local_position:vec3f,`
    : ""
}
}
@vertex fn vsm_atlas_vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance_id:u32)->AtlasVertex {
  var out:AtlasVertex;
  out.position=vec4f(2.0,2.0,2.0,1.0);
  let record=caster.records[raster_source_work(instance_id)];
  let page=valid_page(record);
  if (page.flags & ${VSM_PAGE_ALLOCATED}u)==0u { return out; }
  let instance=instances[record.instance_record_index];
  let transform=oengine_instance_current_object_to_world(instance);
  let mirrored=dot(transform[0].xyz,cross(transform[1].xyz,transform[2].xyz))<0.0;
  let triangle=vertex/3u; let input_corner=vertex%3u;
  let corner=select(input_corner,3u-input_corner,mirrored && input_corner!=0u);
  var address:u32; var source_vertex:u32;
${
  product
    ? `  let asset=oengine_geometry_product_resolve_asset_v1(&product_heap,record.geometry_record_index,oengine_instance_geometry_generation(instance));
  let group=oengine_virtual_group_v1(&product_heap,asset,record.meshlet_record_index>>7u);
  let location=oengine_geometry_product_lookup_page_heap_v1(&product_heap,asset,group.page_id);
  if !asset.valid || !group.valid || !location.valid { return out; }
  let header=product_group_header(location.bank_index,location,group);
  let meshlet=product_meshlet_header(location.bank_index,location,group,header,record.meshlet_record_index & 127u);
  if !header.valid || !meshlet.valid || triangle>=meshlet.triangle_count { return out; }
  let byte=location.byte_offset+group.offset_in_page+meshlet.triangle_byte_offset+triangle*3u+corner;
  source_vertex=(product_word(location.bank_index,byte>>2u)>>((byte & 3u)*8u)) & 255u;
  let directory=product_word(location.resident_bank,location.resident_word+group.offset_in_page/16u);
  address=product_word(location.resident_bank,location.resident_word+directory+(record.meshlet_record_index & 127u));`
    : `
  let meshlet=meshlets[record.meshlet_record_index];
  if triangle>=meshlet.triangle_count { return out; }
  let byte=meshlet.triangle_byte_offset+triangle*3u+corner;
  let local=(meshlet_triangles[byte>>2u]>>((byte & 3u)*8u)) & 255u;
  source_vertex=meshlet_vertices[meshlet.vertex_offset+local];
  address=geometries[record.geometry_record_index].resident_attribute_word_offset;`
}
  let position=resident_attribute(address,source_vertex,5u).xyz;
  let world=transform*vec4f(position,1.0);
  out.position=atlas_position((constants.light_view*world).xyz,page,record.virtual_page);
  let pitch=constants.dimensions.y+constants.dimensions.z*2u;
  let origin=vec2f(vec2u(page.slot_x,page.slot_y)*pitch);
  out.page_bounds=vec4f(origin,origin+f32(pitch));
${
  coverage
    ? `  let uv=resident_attribute(address,source_vertex,2u);
  out.uv0=uv.xy;out.uv1=uv.zw;out.uv2=resident_attribute(address,source_vertex,4u).xy;
  out.material=record.material_handle;out.instance=record.instance_record_index;
  out.normal=resident_attribute(address,source_vertex,0u);out.tangent=resident_attribute(address,source_vertex,1u);
  out.color=resident_attribute(address,source_vertex,3u);out.local_position=position;`
    : ""
}
  return out;
}
${coverage?.kernel.descriptor.source ?? ""}
@fragment fn vsm_atlas_fragment(input:AtlasVertex) {
${
  coverage
    ? `  let alpha=appearance_fragment_alpha(input.material,frame_instances[input.instance],camera,
    input.uv0,input.uv1,input.uv2,input.color,input.normal,input.tangent,input.local_position);`
    : ""
}
  if any(input.position.xy<input.page_bounds.xy) || any(input.position.xy>=input.page_bounds.zw) { discard; }
${coverage ? `  if alpha<appearance_fragment_cutoff() { discard; }` : ""}
}
`;
}
