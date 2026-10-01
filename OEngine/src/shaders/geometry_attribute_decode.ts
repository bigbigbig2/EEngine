import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../assets/GeometryAssetPackage.js";
import { GPU_NORMAL_FORMAT, GPU_POSITION_FORMAT, GPU_UV_FORMAT } from "../gpu/GpuGeometryAbi.js";
import { GPU_MESHLET_DECODE_PROFILE } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";
export function geometryAttributeDecodeWgsl(virtualGeometry: boolean, virtualBankCount = 4): string {
  if (virtualGeometry && (!Number.isInteger(virtualBankCount) ||
      virtualBankCount < 1 || virtualBankCount > 4)) {
    throw new RangeError("Surface virtual geometry needs 1 to 4 physical banks");
  }
  const bankCases = Array.from({ length: virtualBankCount }, (_, bank) => bank);
  const bankWords = bankCases.map(bank =>
    `if (bank == ${bank}u) { return virtual_product_bank_${bank}[word]; }`).join("\n  ");
  const groupHeaders = bankCases.map(bank =>
    `if (location.bank_index == ${bank}u) { header = oengine_virtual_group_header_v1(&virtual_product_bank_${bank}, location, group); }`).join("\n  ");
  const meshletHeaders = bankCases.map(bank =>
    `if (location.bank_index == ${bank}u) { meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_${bank}, location, group, header, local); }`).join("\n  ");
  const virtualProductWgsl = virtualGeometry ? /* wgsl */ `
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}

fn sparse_virtual_bank_word(bank: u32, word: u32) -> u32 {
  ${bankWords}
  return 0u;
}

fn sparse_virtual_u8(bank: u32, byte_offset: u32) -> u32 {
  return (sparse_virtual_bank_word(bank, byte_offset >> 2u) >> ((byte_offset & 3u) * 8u)) & 0xffu;
}
fn sparse_virtual_u16(bank: u32, byte_offset: u32) -> u32 {
  return sparse_virtual_u8(bank, byte_offset) |
    (sparse_virtual_u8(bank, byte_offset + 1u) << 8u);
}
fn sparse_virtual_triangle_vertex(work: OEngineMeshletRasterWork, primitive: u32, corner: u32) -> u32 {
  let asset = oengine_geometry_product_resolve_asset_v1(&virtual_product_metadata,
    work.geometry_slot, oengine_instance_geometry_generation(surface_instance_record(work.instance_slot)));
  let group = oengine_virtual_group_v1(&virtual_product_metadata, asset, work.meshlet_slot >> 7u);
  let location = oengine_geometry_product_lookup_page_heap_v1(&virtual_product_metadata, asset, group.page_id);
  if (!asset.valid || !group.valid || !location.valid) { return 0u; }
  let local = work.meshlet_slot & 127u;
  var header = oengine_virtual_invalid_group_header_v1();
  ${groupHeaders}
  var meshlet = oengine_virtual_invalid_meshlet_header_v1();
  ${meshletHeaders}
  if (!meshlet.valid || primitive >= meshlet.triangle_count || corner >= 3u) { return 0u; }
  return sparse_virtual_u8(location.bank_index,
    location.byte_offset + group.offset_in_page + meshlet.triangle_byte_offset + primitive * 3u + corner);
}
fn sparse_virtual_vertex_ref(work: OEngineMeshletRasterWork, vertex: u32) -> SparseVertexRef {
  let asset = oengine_geometry_product_resolve_asset_v1(&virtual_product_metadata,
    work.geometry_slot, oengine_instance_geometry_generation(surface_instance_record(work.instance_slot)));
  let group = oengine_virtual_group_v1(&virtual_product_metadata, asset, work.meshlet_slot >> 7u);
  let location = oengine_geometry_product_lookup_page_heap_v1(&virtual_product_metadata, asset, group.page_id);
  var result = SparseVertexRef(vertex, 0u, false, 0u, 0u, 0u, 0u, 0u,
    vec3f(0.0), vec3f(0.0));
  if (!asset.valid || !group.valid || !location.valid) {
    sparse_identity_error(); return result;
  }
  let local = work.meshlet_slot & 127u;
  var header = oengine_virtual_invalid_group_header_v1();
  ${groupHeaders}
  var meshlet = oengine_virtual_invalid_meshlet_header_v1();
  ${meshletHeaders}
  if (!meshlet.valid || vertex >= meshlet.vertex_count ||
      header.vertex_format_id >= asset.vertex_format_count) {
    sparse_identity_error(); return result;
  }
  let format_at = asset.vertex_format_word_offset + header.vertex_format_id * 4u;
  let format0 = virtual_product_metadata[format_at];
  result.geometry_base = 0u;
  result.valid = true;
  result.bank = location.bank_index;
  result.byte_offset = location.byte_offset + group.offset_in_page +
    meshlet.vertex_byte_offset + vertex * (format0 & 0xffffu);
  result.format0 = format0;
  result.format1 = virtual_product_metadata[format_at + 1u];
  result.format2 = virtual_product_metadata[format_at + 2u];
  result.bounds_min = meshlet.bounds_min;
  result.bounds_max = meshlet.bounds_max;
  return result;
}` : "";
  const reconstructForWorkWgsl = virtualGeometry ? /* wgsl */ `
fn sparse_work_is_virtual(work: OEngineMeshletRasterWork) -> bool {
  return (work.packed_profile_lod & 0xffu) == ${GPU_MESHLET_DECODE_PROFILE.VirtualGeometryProductV1}u;
}
fn sparse_meshlet_vertices_for_work(work: OEngineMeshletRasterWork, meshlet_base: u32, primitive: u32) -> vec3u {
  if (sparse_work_is_virtual(work)) {
    return vec3u(sparse_virtual_triangle_vertex(work, primitive, 0u),
      sparse_virtual_triangle_vertex(work, primitive, 1u),
      sparse_virtual_triangle_vertex(work, primitive, 2u));
  }
  return sparse_meshlet_vertices(meshlet_base, primitive);
}
fn sparse_vertex_ref_for_work(work: OEngineMeshletRasterWork, geometry_base: u32,
  vertex: u32) -> SparseVertexRef {
  if (sparse_work_is_virtual(work)) { return sparse_virtual_vertex_ref(work, vertex); }
  return SparseVertexRef(vertex, geometry_base, true, 0u, 0u, 0u, 0u, 0u,
    vec3f(0.0), vec3f(0.0));
}` : /* wgsl */ `
fn sparse_meshlet_vertices_for_work(work: OEngineMeshletRasterWork, meshlet_base: u32, primitive: u32) -> vec3u {
  return sparse_meshlet_vertices(meshlet_base, primitive);
}
fn sparse_vertex_ref_for_work(_work: OEngineMeshletRasterWork, geometry_base: u32,
  vertex: u32) -> SparseVertexRef {
  return SparseVertexRef(vertex, geometry_base, true, 0u, 0u, 0u, 0u, 0u,
    vec3f(0.0), vec3f(0.0));
}`;
  const virtualAttributeWgsl = virtualGeometry ? /* wgsl */ `
fn sparse_ref_is_virtual(vertex_ref: SparseVertexRef) -> bool { return vertex_ref.format0 != 0u; }
fn sparse_position_ref(vertex_ref: SparseVertexRef) -> vec3f {
  if !sparse_ref_is_virtual(vertex_ref) { return sparse_position(vertex_ref.geometry_base, vertex_ref.vertex); }
  let at = vertex_ref.byte_offset + (vertex_ref.format1 & 0xffu);
  return vec3f(bitcast<f32>(sparse_virtual_bank_word(vertex_ref.bank, at >> 2u)),
    bitcast<f32>(sparse_virtual_bank_word(vertex_ref.bank, (at + 4u) >> 2u)),
    bitcast<f32>(sparse_virtual_bank_word(vertex_ref.bank, (at + 8u) >> 2u)));
}
fn sparse_virtual_oct(vertex_ref: SparseVertexRef, at: u32) -> vec3f {
  let packed = sparse_virtual_u16(vertex_ref.bank, at) |
    (sparse_virtual_u16(vertex_ref.bank, at + 2u) << 16u);
  let encoded = unpack2x16snorm(packed);
  var n = vec3f(encoded, 1.0 - abs(encoded.x) - abs(encoded.y));
  if n.z < 0.0 {
    n = vec3f((1.0 - abs(n.y)) * select(-1.0, 1.0, n.x >= 0.0),
      (1.0 - abs(n.x)) * select(-1.0, 1.0, n.y >= 0.0), n.z);
  }
  return normalize(n);
}
fn sparse_normal_ref(vertex_ref: SparseVertexRef) -> vec3f {
  if !sparse_ref_is_virtual(vertex_ref) { return sparse_normal(vertex_ref.geometry_base, vertex_ref.vertex); }
  return sparse_virtual_oct(vertex_ref, vertex_ref.byte_offset + ((vertex_ref.format1 >> 8u) & 0xffu));
}
fn sparse_tangent_ref(vertex_ref: SparseVertexRef) -> vec4f {
  if !sparse_ref_is_virtual(vertex_ref) { return sparse_tangent(vertex_ref.geometry_base, vertex_ref.vertex); }
  let offset = (vertex_ref.format1 >> 16u) & 0xffu;
  if offset == 0xffu { return vec4f(1.0, 0.0, 0.0, 1.0); }
  let at = vertex_ref.byte_offset + offset;
  let sign = select(1.0, -1.0, sparse_virtual_u16(vertex_ref.bank, at + 4u) >= 0x8000u);
  return vec4f(sparse_virtual_oct(vertex_ref, at), sign);
}
fn sparse_uv_ref(vertex_ref: SparseVertexRef, uv_set: u32) -> vec2f {
  if !sparse_ref_is_virtual(vertex_ref) { return sparse_uv(vertex_ref.geometry_base, vertex_ref.vertex, uv_set); }
  let bit = select(8u, 16u, uv_set == 1u);
  let offset = select((vertex_ref.format1 >> 24u) & 0xffu, vertex_ref.format2 & 0xffu,
    uv_set == 1u);
  if uv_set > 1u || ((vertex_ref.format0 >> 16u) & bit) == 0u || offset == 0xffu {
    return vec2f(0.0);
  }
  let at = vertex_ref.byte_offset + offset;
  return unpack2x16float(sparse_virtual_u16(vertex_ref.bank, at) |
    (sparse_virtual_u16(vertex_ref.bank, at + 2u) << 16u));
}
fn sparse_color_ref(vertex_ref: SparseVertexRef) -> vec3f {
  if !sparse_ref_is_virtual(vertex_ref) { return sparse_color(vertex_ref.geometry_base, vertex_ref.vertex); }
  let offset = (vertex_ref.format2 >> 8u) & 0xffu;
  if ((vertex_ref.format0 >> 16u) & 32u) == 0u || offset == 0xffu { return vec3f(1.0); }
  let at = vertex_ref.byte_offset + offset;
  return vec3f(f32(sparse_virtual_u8(vertex_ref.bank, at)),
    f32(sparse_virtual_u8(vertex_ref.bank, at + 1u)),
    f32(sparse_virtual_u8(vertex_ref.bank, at + 2u))) / 255.0;
}
fn sparse_has_tangent_ref(vertex_ref: SparseVertexRef) -> bool {
  if !sparse_ref_is_virtual(vertex_ref) { return sparse_meta_u32(vertex_ref.geometry_base, 51u) != 0u; }
  return ((vertex_ref.format0 >> 16u) & 4u) != 0u;
}
fn sparse_has_color_ref(vertex_ref: SparseVertexRef) -> bool {
  if !sparse_ref_is_virtual(vertex_ref) { return sparse_meta_u32(vertex_ref.geometry_base, 44u) != 0u; }
  return ((vertex_ref.format0 >> 16u) & 32u) != 0u;
}` : /* wgsl */ `
fn sparse_position_ref(vertex_ref: SparseVertexRef) -> vec3f { return sparse_position(vertex_ref.geometry_base, vertex_ref.vertex); }
fn sparse_normal_ref(vertex_ref: SparseVertexRef) -> vec3f { return sparse_normal(vertex_ref.geometry_base, vertex_ref.vertex); }
fn sparse_tangent_ref(vertex_ref: SparseVertexRef) -> vec4f { return sparse_tangent(vertex_ref.geometry_base, vertex_ref.vertex); }
fn sparse_uv_ref(vertex_ref: SparseVertexRef, uv_set: u32) -> vec2f { return sparse_uv(vertex_ref.geometry_base, vertex_ref.vertex, uv_set); }
fn sparse_color_ref(vertex_ref: SparseVertexRef) -> vec3f { return sparse_color(vertex_ref.geometry_base, vertex_ref.vertex); }
fn sparse_has_tangent_ref(vertex_ref: SparseVertexRef) -> bool { return sparse_meta_u32(vertex_ref.geometry_base, 51u) != 0u; }
fn sparse_has_color_ref(vertex_ref: SparseVertexRef) -> bool { return sparse_meta_u32(vertex_ref.geometry_base, 44u) != 0u; }
`;
  return /* wgsl */ `
const SPARSE_GEOMETRY_WORDS: u32 = 60u;
const SPARSE_MESHLET_WORDS: u32 = 28u;
struct SparseVertexRef {
  vertex: u32, geometry_base: u32, valid: bool,
  bank: u32, byte_offset: u32,
  format0: u32, format1: u32, format2: u32,
  bounds_min: vec3f, bounds_max: vec3f,
}
${virtualProductWgsl}
${reconstructForWorkWgsl}


fn sparse_meta_u32(base: u32, field: u32) -> u32 { return asset_metadata_heap[base + field]; }
fn sparse_meta_f32(base: u32, field: u32) -> f32 { return bitcast<f32>(sparse_meta_u32(base, field)); }
fn sparse_payload_u8(byte_offset: u32) -> u32 {
  let absolute = shading_view.vertex_data_word_base * 4u + byte_offset;
  let word = vertex_payload_heap[absolute >> 2u];
  return (word >> ((absolute & 3u) * 8u)) & 0xffu;
}
fn sparse_payload_u16(byte_offset: u32) -> u32 {
  return sparse_payload_u8(byte_offset) | (sparse_payload_u8(byte_offset + 1u) << 8u);
}
fn sparse_triangle_u8(byte_offset: u32) -> u32 {
  let absolute = shading_view.meshlet_triangle_word_base * 4u + byte_offset;
  let word = vertex_payload_heap[absolute >> 2u];
  return (word >> ((absolute & 3u) * 8u)) & 0xffu;
}
fn sparse_geometry_base(index: u32) -> u32 {
  return shading_view.geometry_word_base + index * SPARSE_GEOMETRY_WORDS;
}
fn sparse_meshlet_base(index: u32) -> u32 {
  return shading_view.meshlet_word_base + index * SPARSE_MESHLET_WORDS;
}
fn sparse_meshlet_vertices(meshlet_base: u32, primitive: u32) -> vec3u {
  let vertex_offset = sparse_meta_u32(meshlet_base, 0u);
  let byte_offset = sparse_meta_u32(meshlet_base, 2u) + primitive * 3u;
  let local = vec3u(sparse_triangle_u8(byte_offset), sparse_triangle_u8(byte_offset + 1u), sparse_triangle_u8(byte_offset + 2u));
  return vec3u(
    vertex_payload_heap[shading_view.meshlet_vertex_word_base + vertex_offset + local.x],
    vertex_payload_heap[shading_view.meshlet_vertex_word_base + vertex_offset + local.y],
    vertex_payload_heap[shading_view.meshlet_vertex_word_base + vertex_offset + local.z]
  );
}
fn sparse_position(geometry_base: u32, vertex: u32) -> vec3f {
  let byte_offset = sparse_meta_u32(geometry_base, 29u) + vertex * sparse_meta_u32(geometry_base, 30u);
  let format = sparse_meta_u32(geometry_base, 31u);
  let absolute_word = shading_view.vertex_data_word_base + (byte_offset >> 2u);
  if format == ${GPU_POSITION_FORMAT.Float32x3}u || format == ${GPU_POSITION_FORMAT.Float32x4}u {
    return vec3f(bitcast<f32>(vertex_payload_heap[absolute_word]), bitcast<f32>(vertex_payload_heap[absolute_word + 1u]), bitcast<f32>(vertex_payload_heap[absolute_word + 2u]));
  }
  if format == ${GPU_POSITION_FORMAT.AabbUnorm16x3}u {
    let q = vec3f(f32(sparse_payload_u16(byte_offset)), f32(sparse_payload_u16(byte_offset + 2u)), f32(sparse_payload_u16(byte_offset + 4u))) / 65535.0;
    let minimum = vec3f(sparse_meta_f32(geometry_base, 4u), sparse_meta_f32(geometry_base, 5u), sparse_meta_f32(geometry_base, 6u));
    let maximum = vec3f(sparse_meta_f32(geometry_base, 8u), sparse_meta_f32(geometry_base, 9u), sparse_meta_f32(geometry_base, 10u));
    return mix(minimum, maximum, q);
  }
  return vec3f(0.0);
}
fn sparse_uv(geometry_base: u32, vertex: u32, uv_set: u32) -> vec2f {
  let field = 33u + min(uv_set, 2u) * 3u;
  let byte_offset = sparse_meta_u32(geometry_base, field) + vertex * sparse_meta_u32(geometry_base, field + 1u);
  let format = sparse_meta_u32(geometry_base, field + 2u);
  let word = shading_view.vertex_data_word_base + (byte_offset >> 2u);
  if format == ${GPU_UV_FORMAT.Float32x2}u { return vec2f(bitcast<f32>(vertex_payload_heap[word]), bitcast<f32>(vertex_payload_heap[word + 1u])); }
  if format == ${GPU_UV_FORMAT.Unorm8x2}u { return vec2f(f32(sparse_payload_u8(byte_offset)), f32(sparse_payload_u8(byte_offset + 1u))) / 255.0; }
  if format == ${GPU_UV_FORMAT.Unorm16x2}u { return vec2f(f32(sparse_payload_u16(byte_offset)), f32(sparse_payload_u16(byte_offset + 2u))) / 65535.0; }
  if format == ${GPU_UV_FORMAT.Float16x2}u { return unpack2x16float(vertex_payload_heap[word]); }
  return vec2f(0.0);
}
fn sparse_component(byte_offset: u32, format: u32, normalized: bool) -> f32 {
  if format == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.uint8}u { let v = sparse_payload_u8(byte_offset); return select(f32(v), f32(v) / 255.0, normalized); }
  if format == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.uint16}u { let v = sparse_payload_u16(byte_offset); return select(f32(v), f32(v) / 65535.0, normalized); }
  return bitcast<f32>(vertex_payload_heap[shading_view.vertex_data_word_base + (byte_offset >> 2u)]);
}
fn sparse_stream(geometry_base: u32, offset_field: u32, vertex: u32, fallback: vec4f) -> vec4f {
  let byte_offset = sparse_meta_u32(geometry_base, offset_field) + vertex * sparse_meta_u32(geometry_base, offset_field + 1u);
  let format = sparse_meta_u32(geometry_base, offset_field + 2u);
  let normalized = sparse_meta_u32(geometry_base, offset_field + 3u) != 0u;
  if format == 0u { return fallback; }
  let bytes = select(4u, select(2u, 1u, format <= 2u), format <= 4u);
  return vec4f(sparse_component(byte_offset, format, normalized), sparse_component(byte_offset + bytes, format, normalized), sparse_component(byte_offset + bytes * 2u, format, normalized), sparse_component(byte_offset + bytes * 3u, format, normalized));
}
fn sparse_normal(geometry_base: u32, vertex: u32) -> vec3f {
  let byte_offset = sparse_meta_u32(geometry_base, 45u) + vertex * sparse_meta_u32(geometry_base, 46u);
  if sparse_meta_u32(geometry_base, 47u) == ${GPU_NORMAL_FORMAT.OctSnorm16x2}u {
    let encoded = unpack2x16snorm(vertex_payload_heap[shading_view.vertex_data_word_base + (byte_offset >> 2u)]);
    var n = vec3f(encoded, 1.0 - abs(encoded.x) - abs(encoded.y));
    if n.z < 0.0 { n = vec3f((1.0 - abs(n.y)) * select(-1.0, 1.0, n.x >= 0.0), (1.0 - abs(n.x)) * select(-1.0, 1.0, n.y >= 0.0), n.z); }
    return normalize(n);
  }
  return normalize(sparse_stream(geometry_base, 45u, vertex, vec4f(0.0, 0.0, 1.0, 0.0)).xyz);
}
fn sparse_tangent(geometry_base: u32, vertex: u32) -> vec4f { return sparse_stream(geometry_base, 49u, vertex, vec4f(1.0, 0.0, 0.0, 1.0)); }
fn sparse_fallback_tangent(normal: vec3f) -> vec3f {
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.x) > 0.9);
  return normalize(cross(axis, normal));
}
fn sparse_color(geometry_base: u32, vertex: u32) -> vec3f { return sparse_stream(geometry_base, 53u, vertex, vec4f(1.0)).xyz; }
${virtualAttributeWgsl}

`;
}
