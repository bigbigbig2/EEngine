import { SURFACE_METADATA_GROUP_FLAG, SURFACE_PRIMITIVE_BYTES } from "../gpu/SurfacePrimitiveAbi.js";

export function surfaceContinuityWgsl(virtualGeometry:boolean,bankCount:number):string {
  const headers = Array.from({ length: bankCount }, (_, bank) =>
    `if location.bank_index == ${bank}u {
      header = oengine_virtual_group_header_v1(&virtual_product_bank_${bank}, location, group);
      meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_${bank}, location, group, header, work.meshlet_slot & 127u);
    }`).join("\n");
  return /* wgsl */ `
struct SurfaceTriangle {
  valid: bool, metadata: vec4u, uv_span: vec4f, ref0: SparseVertexRef, ref1: SparseVertexRef, ref2: SparseVertexRef,
}
fn surface_triangle(work: OEngineMeshletRasterWork, primitive: u32) -> SurfaceTriangle {
  var result: SurfaceTriangle;
  ${virtualGeometry ? `
  let asset = oengine_geometry_product_resolve_asset_v1(&virtual_product_metadata,
    work.geometry_slot, oengine_instance_geometry_generation(surface_instance_record(work.instance_slot)));
  let group = oengine_virtual_group_v1(&virtual_product_metadata, asset, work.meshlet_slot >> 7u);
  let location = oengine_geometry_product_lookup_page_heap_v1(&virtual_product_metadata, asset, group.page_id);
  if !asset.valid || !group.valid || !location.valid || (group.flags & ${SURFACE_METADATA_GROUP_FLAG}u) == 0u {
    return result;
  }
  var header = oengine_virtual_invalid_group_header_v1();
  var meshlet = oengine_virtual_invalid_meshlet_header_v1();
  ${headers}
  let begin = (meshlet.triangle_byte_offset + meshlet.triangle_count * 3u + 3u) & ~3u;
  let offset = begin + primitive * ${SURFACE_PRIMITIVE_BYTES}u;
  if !header.valid || !meshlet.valid || primitive >= meshlet.triangle_count ||
    offset > header.vertex_data_offset || header.vertex_data_offset - offset < ${SURFACE_PRIMITIVE_BYTES}u ||
    header.vertex_format_id >= asset.vertex_format_count { return result; }
  let word = (location.byte_offset + group.offset_in_page + offset) >> 2u;
  result.metadata = vec4u(sparse_virtual_bank_word(location.bank_index, word),
    sparse_virtual_bank_word(location.bank_index, word + 1u),
    sparse_virtual_bank_word(location.bank_index, word + 2u),
    sparse_virtual_bank_word(location.bank_index, word + 3u));
  result.uv_span = bitcast<vec4f>(vec4u(sparse_virtual_bank_word(location.bank_index, word + 4u),
    sparse_virtual_bank_word(location.bank_index, word + 5u),
    sparse_virtual_bank_word(location.bank_index, word + 6u),
    sparse_virtual_bank_word(location.bank_index, word + 7u)));
  let format_at = asset.vertex_format_word_offset + header.vertex_format_id * 4u;
  let format0 = virtual_product_metadata[format_at];
  let format1 = virtual_product_metadata[format_at + 1u];
  let format2 = virtual_product_metadata[format_at + 2u];
  let stride = format0 & 0xffffu;
  if stride < 16u || ((format2 >> 16u) & 255u) != 1u ||
    meshlet.vertex_byte_offset > header.payload_bytes ||
    meshlet.vertex_count * stride > header.payload_bytes - meshlet.vertex_byte_offset { return result; }
  let base = location.byte_offset + group.offset_in_page;
  var refs: array<SparseVertexRef, 3>;
  for (var corner = 0u; corner < 3u; corner++) {
    let vertex = sparse_virtual_u8(location.bank_index, base + meshlet.triangle_byte_offset + primitive * 3u + corner);
    if vertex >= meshlet.vertex_count { return result; }
    refs[corner] = SparseVertexRef(vertex, 0u, true, location.bank_index,
      base + meshlet.vertex_byte_offset + vertex * stride, format0, format1, format2,
      meshlet.bounds_min, meshlet.bounds_max);
  }
  result.ref0 = refs[0]; result.ref1 = refs[1]; result.ref2 = refs[2]; result.valid = true;
  ` : ""}
  return result;
}
`;
}
