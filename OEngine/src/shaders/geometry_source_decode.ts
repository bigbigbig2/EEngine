import { GPU_GEOMETRY_RECORD_WGSL, GPU_MESHLET_RECORD_WGSL, GPU_GEOMETRY_VERTEX_DECODE_WGSL, GPU_UV_FORMAT, GPU_NORMAL_FORMAT } from "../gpu/GpuGeometryAbi.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";
import { GEOMETRY_VERTEX_DATA_TYPE_CODE as T } from "../assets/GeometryAssetPackage.js";
import { GPU_FRAME_ATTRIBUTE_VECTORS } from "../gpu/GpuFrameGeometryAttributesAbi.js";

/** Selected meshlet-local vertices once per frame; ordinary decode is the
 * published Geometry ABI; Product attributes are decoded once at residency
 * fulfillment and read here through the same bounded four-bank page owner. */
export function frameGeometrySourceWgsl(product: boolean, perInvocation = false): string {
  const sources = product ? /* wgsl */ `
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}
@group(0) @binding(8) var<storage, read> product_heap: array<u32>;
${Array.from({ length: 4 }, (_, i) => `@group(0) @binding(${i + 9}) var<storage, read> product_bank_${i}: array<u32>;`).join("\n")}
fn frame_vertex_word(bank: u32, word: u32) -> u32 {
${Array.from({ length: 4 }, (_, i) => `  if bank == ${i}u { return product_bank_${i}[word]; }`).join("\n")}
  return 0u;
}
fn frame_vertex_group_header(location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1) -> OEngineVirtualGroupHeaderV1 {
${Array.from({ length: 4 }, (_, i) => `  if location.bank_index == ${i}u { return oengine_virtual_group_header_v1(&product_bank_${i}, location, group); }`).join("\n")}
  return oengine_virtual_invalid_group_header_v1();
}
fn frame_vertex_meshlet_header(location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1,
  header: OEngineVirtualGroupHeaderV1, local: u32) -> OEngineVirtualMeshletHeaderV1 {
${Array.from({ length: 4 }, (_, i) => `  if location.bank_index == ${i}u { return oengine_virtual_meshlet_header_v1(&product_bank_${i}, location, group, header, local); }`).join("\n")}
  return oengine_virtual_invalid_meshlet_header_v1();
}
var<workgroup> source_bank: u32;
var<workgroup> source_triangle_byte: u32;
var<workgroup> source_resident_address: u32;
fn frame_vertex_load_source(work: OEngineMeshletRasterWork) -> vec2u {
  let asset = oengine_geometry_product_resolve_asset_v1(&product_heap, work.geometry_slot,
    oengine_instance_geometry_generation(frame_instances[work.instance_slot].source));
  let group = oengine_virtual_group_v1(&product_heap, asset, work.meshlet_slot >> 7u);
  let location = oengine_geometry_product_lookup_page_heap_v1(&product_heap, asset, group.page_id);
  if !asset.valid || !group.valid || !location.valid || location.bank_index >= 4u { return vec2u(0u); }
  let header = frame_vertex_group_header(location, group);
  let meshlet = frame_vertex_meshlet_header(location, group, header, work.meshlet_slot & 127u);
  if !header.valid || !meshlet.valid || header.vertex_format_id >= asset.vertex_format_count { return vec2u(0u); }
  source_bank = location.bank_index;
  source_triangle_byte = location.byte_offset + group.offset_in_page + meshlet.triangle_byte_offset;
  let resident_directory = frame_vertex_word(location.resident_bank, location.resident_word + group.offset_in_page / 16u);
  source_resident_address = frame_vertex_word(location.resident_bank, location.resident_word + resident_directory + (work.meshlet_slot & 127u));
  return vec2u(meshlet.vertex_count, meshlet.triangle_count);
}
fn frame_vertex_resident(vertex: u32, field: u32) -> vec4f {
  let bank = source_resident_address >> 30u;
  let at = (source_resident_address & 0x3fffffffu) + (vertex * ${GPU_FRAME_ATTRIBUTE_VECTORS}u + field) * 4u;
  return bitcast<vec4f>(vec4u(frame_vertex_word(bank, at), frame_vertex_word(bank, at + 1u),
    frame_vertex_word(bank, at + 2u), frame_vertex_word(bank, at + 3u)));
}
fn frame_vertex_position(vertex: u32) -> vec3f {
  return frame_vertex_resident(vertex, 5u).xyz;
}
fn frame_vertex_normal(vertex: u32) -> vec4f {
  return frame_vertex_resident(vertex, 0u);
}
fn frame_vertex_tangent(vertex: u32) -> vec4f {
  return frame_vertex_resident(vertex, 1u);
}
fn frame_vertex_uv(vertex: u32, uvSet: u32) -> vec2f {
  if uvSet == 2u { return frame_vertex_resident(vertex, 4u).xy; }
  let uv = frame_vertex_resident(vertex, 2u);
  return select(uv.xy, uv.zw, uvSet == 1u);
}
fn frame_vertex_color(vertex: u32) -> vec4f {
  return frame_vertex_resident(vertex, 3u);
}
fn frame_triangle_corner(triangle: u32, corner: u32) -> u32 {
  let byte = source_triangle_byte + triangle * 3u + corner;
  return (frame_vertex_word(source_bank, byte >> 2u) >> ((byte & 3u) * 8u)) & 255u;
}` : /* wgsl */ `
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
@group(0) @binding(3) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(0) @binding(4) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(0) @binding(5) var<storage, read> meshlet_vertices: array<u32>;
@group(0) @binding(6) var<storage, read> meshlet_triangles: array<u32>;
@group(0) @binding(7) var<storage, read> vertex_payload: array<u32>;
var<workgroup> source_geometry: GpuGeometryRecord;
var<workgroup> source_meshlet: GpuMeshletRecord;
fn frame_vertex_load_source(work: OEngineMeshletRasterWork) -> vec2u {
  if work.geometry_slot >= arrayLength(&geometries) || work.meshlet_slot >= arrayLength(&meshlets) { return vec2u(0u); }
  source_geometry = geometries[work.geometry_slot]; source_meshlet = meshlets[work.meshlet_slot];
  return vec2u(source_meshlet.vertex_count, source_meshlet.triangle_count);
}
fn frame_vertex_position(vertex: u32) -> vec3f {
  return oengine_geometry_position(&vertex_payload, source_geometry, meshlet_vertices[source_meshlet.vertex_offset + vertex]);
}
fn frame_vertex_normal(vertex: u32) -> vec4f {
  let index = meshlet_vertices[source_meshlet.vertex_offset + vertex];
  if source_geometry.normal_format == ${GPU_NORMAL_FORMAT.OctSnorm16x2}u {
    let byte = source_geometry.normal_byte_offset + index * source_geometry.normal_stride;
    return vec4f(frame_oct_decode(vertex_payload[byte >> 2u]), 0.0);
  }
  return frame_stream(vertex, source_geometry.normal_byte_offset, source_geometry.normal_stride,
    source_geometry.normal_format, source_geometry.normal_normalized, 3u, vec4f(0.0, 0.0, 1.0, 0.0));
}
fn frame_vertex_tangent(vertex: u32) -> vec4f {
  return frame_stream(vertex, source_geometry.tangent_byte_offset, source_geometry.tangent_stride,
    source_geometry.tangent_format, source_geometry.tangent_normalized, 4u, vec4f(1.0, 0.0, 0.0, 1.0));
}
fn frame_source_u8(byte: u32) -> u32 { return (vertex_payload[byte >> 2u] >> ((byte & 3u) * 8u)) & 255u; }
fn frame_source_u16(byte: u32) -> u32 { return frame_source_u8(byte) | (frame_source_u8(byte + 1u) << 8u); }
fn frame_component(byte: u32, format: u32, normalized: bool) -> f32 {
  switch format {
    case ${T.int8}u: { let v = bitcast<i32>(frame_source_u8(byte) << 24u) >> 24u; return select(f32(v), max(f32(v) / 127.0, -1.0), normalized); }
    case ${T.uint8}u: { let v = f32(frame_source_u8(byte)); return select(v, v / 255.0, normalized); }
    case ${T.int16}u: { let v = bitcast<i32>(frame_source_u16(byte) << 16u) >> 16u; return select(f32(v), max(f32(v) / 32767.0, -1.0), normalized); }
    case ${T.uint16}u: { let v = f32(frame_source_u16(byte)); return select(v, v / 65535.0, normalized); }
    case ${T.int32}u: { let v = f32(bitcast<i32>(vertex_payload[byte >> 2u])); return select(v, max(v / 2147483647.0, -1.0), normalized); }
    case ${T.uint32}u: { let v = f32(vertex_payload[byte >> 2u]); return select(v, v / 4294967295.0, normalized); }
    default: { return bitcast<f32>(vertex_payload[byte >> 2u]); }
  }
}
fn frame_stream(vertex: u32, offset: u32, stride: u32, format: u32, normalized: u32, components: u32, fallback: vec4f) -> vec4f {
  if format == 0u { return fallback; }
  let index = meshlet_vertices[source_meshlet.vertex_offset + vertex];
  let at = offset + index * stride;
  let bytes = select(4u, select(2u, 1u, format <= ${T.uint8}u), format <= ${T.uint16}u);
  var value = fallback;
  for (var channel = 0u; channel < components; channel++) { value[channel] = frame_component(at + channel * bytes, format, normalized != 0u); }
  return value;
}
fn frame_vertex_uv(vertex: u32, uvSet: u32) -> vec2f {
  let index = meshlet_vertices[source_meshlet.vertex_offset + vertex];
  var offset = source_geometry.uv0_byte_offset; var stride = source_geometry.uv0_stride; var format = source_geometry.uv0_format;
  if uvSet == 1u { offset = source_geometry.uv1_byte_offset; stride = source_geometry.uv1_stride; format = source_geometry.uv1_format; }
  if uvSet == 2u { offset = source_geometry.uv2_byte_offset; stride = source_geometry.uv2_stride; format = source_geometry.uv2_format; }
  let byte = offset + index * stride;
  if format == ${GPU_UV_FORMAT.Float32x2}u { let at = byte >> 2u; return vec2f(bitcast<f32>(vertex_payload[at]), bitcast<f32>(vertex_payload[at + 1u])); }
  if format == ${GPU_UV_FORMAT.Float16x2}u { return unpack2x16float(vertex_payload[byte >> 2u]); }
  if format == ${GPU_UV_FORMAT.Unorm8x2}u { return vec2f(f32(frame_source_u8(byte)), f32(frame_source_u8(byte + 1u))) / 255.0; }
  if format == ${GPU_UV_FORMAT.Unorm16x2}u { return vec2f(f32(frame_source_u16(byte)), f32(frame_source_u16(byte + 2u))) / 65535.0; }
  return vec2f(0.0);
}
fn frame_vertex_color(vertex: u32) -> vec4f {
  return frame_stream(vertex, source_geometry.color_byte_offset, source_geometry.color_stride,
    source_geometry.color_format, source_geometry.color_normalized, source_geometry.color_components, vec4f(1.0));
}
fn frame_triangle_corner(triangle: u32, corner: u32) -> u32 {
  let byte = source_meshlet.triangle_byte_offset + triangle * 3u + corner;
  return (meshlet_triangles[byte >> 2u] >> ((byte & 3u) * 8u)) & 255u;
}`;
  return perInvocation ? sources.replaceAll("var<workgroup>", "var<private>") : sources;
}

export const FRAME_ATTRIBUTE_OCT_DECODE_WGSL = /* wgsl */ `
fn frame_oct_decode(packed: u32) -> vec3f {
  let encoded = unpack2x16snorm(packed);
  var n = vec3f(encoded, 1.0 - abs(encoded.x) - abs(encoded.y));
  if n.z < 0.0 { n = vec3f((1.0 - abs(n.y)) * select(-1.0, 1.0, n.x >= 0.0), (1.0 - abs(n.x)) * select(-1.0, 1.0, n.y >= 0.0), n.z); }
  return normalize(n);
}
`;

