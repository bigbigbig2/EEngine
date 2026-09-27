/** Exact Phase 2 extraction of visibility-to-Surface reconstruction, material evaluation, and direct-light WGSL.
 * Program closure and physical bindings stay with their owning runtime. */
import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../assets/GeometryAssetPackage.js";
import { GPU_NORMAL_FORMAT, GPU_POSITION_FORMAT, GPU_UV_FORMAT } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MESHLET_DECODE_PROFILE } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_MATERIAL_VISIBILITY_FLAGS } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_SHADING_PROGRAM, shadingProgramUsesTextures } from "../gpu/GpuShadingProgramAbi.js";
import { gpuSurfaceProgramSpecialization } from "../gpu/GpuSurfaceProgramSpecialization.js";
import { gpuTextureBankSampleWgsl, GPU_TEXTURE_REF_INVALID } from "../gpu/GpuTextureRefAbi.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";
import { createProductionSparseDirectLightingWgsl } from "./lighting_direct.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "./environment_ibl.js";
import { SPECULAR_AMBIENT_OCCLUSION_WGSL } from "./specular_ambient_occlusion.js";

/** Shader-semantic specialization only; publication revisions and bind groups are not part of the kernel identity. */
export interface SurfaceKernelProfile {
  readonly programId: number;
  readonly outputDependencyMask: number;
  readonly textureBankMask: number;
}

/**
 * Emits the geometry reconstruction helpers.
 *
 * The virtual-product half of this block reads `virtual_product_metadata` and
 * `virtual_product_bank_0..3`, which the pipeline contract only declares when
 * the descriptor is specialized for virtual geometry. Emitting that half into
 * a `reconstructTriangle` program without those bindings produced WGSL with
 * unresolved values, so both halves are keyed off the same specialization.
 */
export function geometryWgsl(virtualGeometry: boolean): string {
  const virtualProductWgsl = virtualGeometry ? /* wgsl */ `
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}

fn sparse_virtual_bank_word(bank: u32, word: u32) -> u32 {
  if (bank == 0u) { return virtual_product_bank_0[word]; }
  if (bank == 1u) { return virtual_product_bank_1[word]; }
  if (bank == 2u) { return virtual_product_bank_2[word]; }
  return virtual_product_bank_3[word];
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
    work.geometry_slot, oengine_instance_geometry_generation(instance_records[work.instance_slot]));
  let group = oengine_virtual_group_v1(&virtual_product_metadata, asset, work.meshlet_slot >> 7u);
  let location = oengine_geometry_product_lookup_page_heap_v1(&virtual_product_metadata, asset, group.page_id);
  if (!asset.valid || !group.valid || !location.valid) { return 0u; }
  let local = work.meshlet_slot & 127u;
  var header = oengine_virtual_invalid_group_header_v1();
  if (location.bank_index == 0u) { header = oengine_virtual_group_header_v1(&virtual_product_bank_0, location, group); }
  else if (location.bank_index == 1u) { header = oengine_virtual_group_header_v1(&virtual_product_bank_1, location, group); }
  else if (location.bank_index == 2u) { header = oengine_virtual_group_header_v1(&virtual_product_bank_2, location, group); }
  else { header = oengine_virtual_group_header_v1(&virtual_product_bank_3, location, group); }
  var meshlet = oengine_virtual_invalid_meshlet_header_v1();
  if (location.bank_index == 0u) { meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_0, location, group, header, local); }
  else if (location.bank_index == 1u) { meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_1, location, group, header, local); }
  else if (location.bank_index == 2u) { meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_2, location, group, header, local); }
  else { meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_3, location, group, header, local); }
  if (!meshlet.valid || primitive >= meshlet.triangle_count || corner >= 3u) { return 0u; }
  return sparse_virtual_u8(location.bank_index,
    location.byte_offset + group.offset_in_page + meshlet.triangle_byte_offset + primitive * 3u + corner);
}
fn sparse_virtual_vertex_ref(work: OEngineMeshletRasterWork, vertex: u32) -> SparseVertexRef {
  let asset = oengine_geometry_product_resolve_asset_v1(&virtual_product_metadata,
    work.geometry_slot, oengine_instance_geometry_generation(instance_records[work.instance_slot]));
  let group = oengine_virtual_group_v1(&virtual_product_metadata, asset, work.meshlet_slot >> 7u);
  let location = oengine_geometry_product_lookup_page_heap_v1(&virtual_product_metadata, asset, group.page_id);
  var result = SparseVertexRef(vertex, 0u, false, 0u, 0u, 0u, 0u, 0u,
    vec3f(0.0), vec3f(0.0));
  if (!asset.valid || !group.valid || !location.valid) {
    sparse_identity_error(); return result;
  }
  let local = work.meshlet_slot & 127u;
  var header = oengine_virtual_invalid_group_header_v1();
  if (location.bank_index == 0u) { header = oengine_virtual_group_header_v1(&virtual_product_bank_0, location, group); }
  else if (location.bank_index == 1u) { header = oengine_virtual_group_header_v1(&virtual_product_bank_1, location, group); }
  else if (location.bank_index == 2u) { header = oengine_virtual_group_header_v1(&virtual_product_bank_2, location, group); }
  else { header = oengine_virtual_group_header_v1(&virtual_product_bank_3, location, group); }
  var meshlet = oengine_virtual_invalid_meshlet_header_v1();
  if (location.bank_index == 0u) { meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_0, location, group, header, local); }
  else if (location.bank_index == 1u) { meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_1, location, group, header, local); }
  else if (location.bank_index == 2u) { meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_2, location, group, header, local); }
  else { meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_3, location, group, header, local); }
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
  let q = vec3f(f32(sparse_virtual_u16(vertex_ref.bank, at)),
    f32(sparse_virtual_u16(vertex_ref.bank, at + 2u)),
    f32(sparse_virtual_u16(vertex_ref.bank, at + 4u))) / 65535.0;
  return mix(vertex_ref.bounds_min, vertex_ref.bounds_max, q);
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
${GPU_INSTANCE_RECORD_WGSL}
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

struct SparseBarycentric { weights: vec3f, ddx: vec3f, ddy: vec3f, valid: bool, }
fn sparse_projected_pixel(value: vec4f) -> vec2f {
  let ndc = value.xy / value.w;
  return vec2f(
    (ndc.x * 0.5 + 0.5) * f32(shading_view.width),
    (0.5 - ndc.y * 0.5) * f32(shading_view.height)
  );
}
fn sparse_barycentric(pixel: vec2f, c0: vec4f, c1: vec4f, c2: vec4f) -> SparseBarycentric {
  var result = SparseBarycentric(vec3f(1.0, 0.0, 0.0), vec3f(0.0), vec3f(0.0), false);
  if any(abs(vec3f(c0.w, c1.w, c2.w)) < vec3f(1e-8)) { return result; }
  let p0 = sparse_projected_pixel(c0); let p1 = sparse_projected_pixel(c1); let p2 = sparse_projected_pixel(c2);
  let d = (p1.y-p2.y)*(p0.x-p2.x)+(p2.x-p1.x)*(p0.y-p2.y);
  if abs(d) < 1e-8 { return result; }
  let l0=((p1.y-p2.y)*(pixel.x-p2.x)+(p2.x-p1.x)*(pixel.y-p2.y))/d;
  let l1=((p2.y-p0.y)*(pixel.x-p2.x)+(p0.x-p2.x)*(pixel.y-p2.y))/d;
  let s=vec3f(l0,l1,1.0-l0-l1); let sx=vec3f(p1.y-p2.y,p2.y-p0.y,p0.y-p1.y)/d; let sy=vec3f(p2.x-p1.x,p0.x-p2.x,p1.x-p0.x)/d;
  let rw=1.0/vec3f(c0.w,c1.w,c2.w); let w=s*rw; let wx=sx*rw; let wy=sy*rw; let sum=dot(w,vec3f(1.0));
  if abs(sum) < 1e-8 { return result; }
  let ix=dot(wx,vec3f(1.0)); let iy=dot(wy,vec3f(1.0));
  // The Forge CalcFullBary: finite one-pixel projected differences match the
  // raster texture footprint better than the infinitesimal quotient derivative.
  if abs(sum+ix) < 1e-8 || abs(sum+iy) < 1e-8 { return result; }
  result.weights=w/sum;
  result.ddx=(w+wx)/(sum+ix)-result.weights;
  result.ddy=(w+wy)/(sum+iy)-result.weights;
  result.valid=true; return result;
}
fn sparse_affine(instance: OEngineInstanceRecord) -> mat4x4f { return oengine_instance_current_object_to_world(instance); }
fn sparse_world_normal(model: mat4x4f, local: vec3f, geometric: vec3f) -> vec3f {
  let x = model[0].xyz; let y = model[1].xyz; let z = model[2].xyz;
  let cofactors = mat3x3f(cross(y, z), cross(z, x), cross(x, y));
  let determinant = dot(x, cofactors[0]);
  if abs(determinant) < 1e-8 { return geometric; }
  return normalize((cofactors * local) * sign(determinant));
}
`;
}

export function textureWgsl(descriptor: Readonly<SurfaceKernelProfile>): string {
  const specialization = gpuSurfaceProgramSpecialization(
    descriptor.programId,
    descriptor.outputDependencyMask
  );
  const slots = [
    specialization.baseTexture !== "never" ? 0 : -1,
    specialization.normalTexture !== "never" ? 1 : -1,
    specialization.ormTexture !== "never" ? 2 : -1,
    specialization.emissiveTexture !== "never" ? 3 : -1,
    specialization.occlusionTexture !== "never" ? 4 : -1
  ].filter((slot) => slot >= 0);
  return /* wgsl */ `
${gpuTextureBankSampleWgsl(descriptor.textureBankMask)}
fn sparse_sample(texture_ref: u32, sampler_class: u32, uv: vec2f, dx: vec2f, dy: vec2f, valid: bool, fallback: vec4f) -> vec4f {
  if valid { return oengine_sample_texture_bank(texture_ref, sampler_class, uv, dx, dy, fallback); }
  return oengine_sample_texture_bank_level_zero(texture_ref, sampler_class, uv, fallback);
}
fn sparse_material_uv_set(material: OEngineShadingMaterialRecord, slot: u32) -> u32 {
  if slot == 4u { return material.payload.occlusion_uv_set; }
  return (material.payload.texture_uv_sets >> (slot * 8u)) & 255u;
}
fn sparse_transform_closure_uv(role: OEngineClosureTextureRole, uv: vec2f, derivative: bool) -> vec2f {
  let value = uv * role.uv_offset_scale.zw;
  let rotated = vec2f(role.uv_rotation.x * value.x - role.uv_rotation.y * value.y,
                      role.uv_rotation.y * value.x + role.uv_rotation.x * value.y);
  return select(role.uv_offset_scale.xy, vec2f(0.0), derivative) + rotated;
}
${slots.map((slot) => textureSlotAccessWgsl(slot)).join("\n")}
`;
}

function textureSlotAccessWgsl(slot: number): string {
  const fields = [
    ["uv_offset_scale", "uv_rotation", "material.payload.sampler_class"],
    ["normal_uv_offset_scale", "normal_uv_rotation", "material.payload.texture_sampler_classes&255u"],
    ["orm_uv_offset_scale", "orm_uv_rotation", "((material.payload.texture_sampler_classes >> 8u) & 255u)"],
    ["emissive_uv_offset_scale", "emissive_uv_rotation", "((material.payload.texture_sampler_classes >> 16u) & 255u)"],
    ["occlusion_uv_offset_scale", "occlusion_uv_rotation", "((material.payload.texture_sampler_classes >> 24u) & 255u)"]
  ][slot];
  if (fields === undefined) throw new RangeError(`Unsupported material texture slot ${slot}`);
  return /* wgsl */ `
fn sparse_transform_uv_${slot}(material: OEngineShadingMaterialRecord, uv: vec2f, derivative: bool) -> vec2f {
  let os=material.payload.${fields[0]}; let rotation=material.payload.${fields[1]};
  let value=uv*os.zw; return select(os.xy,vec2f(0.0),derivative)+vec2f(rotation.x*value.x-rotation.y*value.y,rotation.y*value.x+rotation.x*value.y);
}
fn sparse_sampler_${slot}(material: OEngineShadingMaterialRecord) -> u32 { return ${fields[2]}; }`;
}

export function lightingWgsl(
  shadowSamplingEnabled: boolean,
  environmentIblEnabled: boolean,
  scalarAoEnabled = false
): string {
  return /* wgsl */ `
struct PhysicalEnvironmentSun {
  direction_world: vec3f,
  world_to_unit: f32,
  irradiance: vec3f,
  generation: f32,
  sky_luminance_scale: f32,
}
${createProductionSparseDirectLightingWgsl(shadowSamplingEnabled)}
${environmentIblEnabled ? `${OCTAHEDRAL_SAMPLE_WGSL}
// Filament R03 DFV_Multiscatter: x = integrated Schlick Fc, y = total
// visibility. F90 can differ from one for KHR_materials_specular.
fn filament_specular_dfg(dfg:vec2f,f0:vec3f,f90:f32)->vec3f {
  return vec3f(f90*dfg.x)+f0*(dfg.y-dfg.x);
}
fn filament_energy_compensation(dfg:vec2f,f0:vec3f)->vec3f {
  return vec3f(1.0)+f0*(1.0/max(dfg.y,1e-4)-1.0);
}
fn filament_clearcoat_to_surface_f0(f0:vec3f)->vec3f {
  let root=sqrt(clamp(f0,vec3f(0.0),vec3f(0.9999)));
  let ior=(vec3f(1.0)+root)/(vec3f(1.0)-root);
  let ratio=(ior-vec3f(1.5))/(ior+vec3f(1.5));
  return ratio*ratio;
}
${SPECULAR_AMBIENT_OCCLUSION_WGSL}` : ""}
${scalarAoEnabled ? `
fn xe_scalar_visibility(pixel: vec2u) -> f32 {
  let index = pixel.y * shading_view.width + pixel.x;
  let packed = xe_visibility_words[index >> 2u];
  return f32((packed >> ((index & 3u) * 8u)) & 255u) / 255.0;
}` : ""}
fn sparse_direct(surface:OEngineSparseSurface,pixel:vec2u)->vec3f{
  if (oengine_surface_has_flag(surface.flags, OENGINE_SURFACE_FLAG_UNLIT)) {
    return surface.emissive;
  }
  var material: StandardMaterial;
  material.diffuse = surface.base_color * (1.0 - surface.metallic);
  material.occlusion = surface.material_ao;
  let indirect_visibility = ${scalarAoEnabled
    ? "min(surface.material_ao, xe_scalar_visibility(pixel))"
    : "surface.material_ao"};
  material.roughness = max(surface.roughness, 0.045);
  let eta = max(surface.ior, 1.0);
  let dielectric_f0 = pow((eta - 1.0) / (eta + 1.0), 2.0);
  material.specularF0 = mix(vec3f(dielectric_f0) * surface.specular_color *
    surface.specular_weight, surface.base_color, surface.metallic);
  material.specularF90 = mix(surface.specular_weight, 1.0, surface.metallic);
  material.emissive = vec3f(0.0);
  material.opacity = surface.alpha;
  material.coatFactor = surface.coat_factor;
  material.coatRoughness = max(surface.coat_roughness, 0.045);
  material.coatNormal = surface.coat_normal;
  material.energyCompensation = vec3f(1.0);
  ${environmentIblEnabled ? `if material.coatFactor > 0.0 {
    material.specularF0 = mix(material.specularF0,
      filament_clearcoat_to_surface_f0(material.specularF0),material.coatFactor);
    material.roughness = mix(material.roughness,
      max(material.roughness,material.coatRoughness),material.coatFactor);
  }` : ""}
  let geometry = SurfaceGeometry(
    surface.shading_normal,
    surface.geometric_normal,
    surface.position_ws,
    normalize(shading_view.camera_position.xyz - surface.position_ws)
  );
  ${environmentIblEnabled ? `let no_v = clamp(dot(surface.shading_normal, geometry.view_direction),0.0,1.0);
  let dfg = textureSampleLevel(split_sum,environment_sampler,
    vec2f(no_v,material.roughness),0.0).rg;
  material.energyCompensation = filament_energy_compensation(dfg,material.specularF0);` : ""}
  random_initialize(
    vec3u(pixel, shading_view.frame_index),
    vec3u(0xEE6B2807u, 7u, 0xD0974829u)
  );
  let direct = shade_standard_material_direct(
    material,
    geometry,
    vec2f(pixel) + vec2f(0.5),
    surface.view_depth
  );
  let environment_position = atmosphere_world_to_planet(surface.position_ws,
    physical_environment_sun.world_to_unit);
  let environment_radius = length(environment_position);
  let environment_altitude = clamp((environment_radius - 6360.0) / 60.0, 0.0, 1.0);
  let environment_mu_s = clamp(dot(normalize(environment_position),
    normalize(-physical_environment_sun.direction_world)), -1.0, 1.0);
  let sun_transmittance = textureSampleLevel(physical_environment_transmittance, physical_sky_sampler,
    atmosphere_transmittance_uv(environment_radius, environment_mu_s), 0.0).rgb;
  var sun_incident: GpuPrimitiveTypeTable;
  sun_incident.direction = normalize(-physical_environment_sun.direction_world);
  sun_incident.color = physical_environment_sun.irradiance * sun_transmittance;
  sun_incident.radius = 0.004675;
  sun_incident.distance = 1.496e11;
  var sun_reflected = ReflectedLight(vec3f(0.0), vec3f(0.0));
  re_direct_physical(sun_incident, geometry, material, &sun_reflected);
  let physical_sun = sun_reflected.diffuse + sun_reflected.specular;
  let sky_irradiance = textureSampleLevel(physical_sky_irradiance, physical_sky_sampler,
    vec2f(environment_mu_s * 0.5 + 0.5, environment_altitude), 0.0).rgb *
    (vec3f(114974.91644, 71305.954816, 65310.548555) * 0.000013207021769386792) *
    physical_environment_sun.sky_luminance_scale;
  var physical_sky = sky_irradiance * material.diffuse * indirect_visibility * ${1 / Math.PI};
  ${environmentIblEnabled ? `
  let specular_direction = normalize(mix(
    reflect(-geometry.view_direction, surface.shading_normal),
    surface.shading_normal,
    material.roughness * material.roughness
  ));
  let radiance = sample_prefiltered_environment(
    environment_specular,
    specular_direction,
    material.roughness
  );
  let directional_albedo = filament_specular_dfg(
    dfg,
    material.specularF0,
    material.specularF90
  );
  let energy = max(vec3f(0.0),vec3f(1.0)-directional_albedo);
  let specular_ao = oengine_specular_ao_cones(
    specular_direction,
    surface.shading_normal,
    indirect_visibility,
    material.roughness
  );
  var environment_specular_contribution = radiance * directional_albedo *
    material.energyCompensation * specular_ao;
  var environment_diffuse_contribution = physical_sky * energy;
  if surface.coat_factor > 0.0 {
    // Filament evaluateClearCoatIBL: attenuate both base terms and add the
    // filtered secondary lobe using the fixed 1.5-IOR coat Fresnel.
    let coat_no_v = clamp(dot(surface.coat_normal, geometry.view_direction), 0.0, 1.0);
    let coat_fresnel = (0.04 + 0.96 * pow(1.0 - coat_no_v, 5.0)) * surface.coat_factor;
    let attenuation = 1.0 - coat_fresnel;
    environment_specular_contribution *= attenuation;
    environment_diffuse_contribution *= attenuation;
    let coat_direction = reflect(-geometry.view_direction, surface.coat_normal);
    let coat_radiance = sample_prefiltered_environment(
      environment_specular, coat_direction, surface.coat_roughness);
    let coat_ao = oengine_specular_ao_cones(coat_direction, surface.coat_normal,
      indirect_visibility, surface.coat_roughness);
    environment_specular_contribution += coat_radiance * coat_ao * coat_fresnel;
  }
  return direct + physical_sun + environment_specular_contribution +
    environment_diffuse_contribution + surface.emissive;` : `
  if surface.coat_factor > 0.0 {
    let coat_no_v = clamp(dot(surface.coat_normal, geometry.view_direction), 0.0, 1.0);
    let coat_fresnel = (0.04 + 0.96 * pow(1.0 - coat_no_v, 5.0)) * surface.coat_factor;
    physical_sky *= 1.0 - coat_fresnel;
  }
  return direct + physical_sun + physical_sky + surface.emissive;`}
}
`;
}

export function materialEvaluationWgsl(descriptor: Readonly<SurfaceKernelProfile>,
  dynamicUnlit = false, includeCoat = true): string {
  const s = gpuSurfaceProgramSpecialization(descriptor.programId, descriptor.outputDependencyMask);
  const writesVelocity = s.publishesVelocity;
  const velocityCode = writesVelocity
    ? "let previous_position=oengine_instance_previous_from_current(instance)*vec4f(position,1.0);let previous_clip=shading_view.previous_view_projection*previous_position;let current_clip=shading_view.current_view_projection*vec4f(position,1.0);let velocity=(current_clip.xy/current_clip.w-previous_clip.xy/previous_clip.w)*vec2f(0.5,-0.5);"
    : "let velocity=vec2f(0.0);";
  const motionFlagCode = writesVelocity
    ? "if oengine_instance_motion_valid(instance){surface_flags|=OENGINE_SURFACE_FLAG_MOTION_VALID;}"
    : "";
  const needsBase = s.baseTexture !== "never";
  const needsOrm = s.ormTexture !== "never";
  const needsNormal = s.normalTexture !== "never";
  const needsEmissive = s.emissiveTexture !== "never";
  const needsOcclusion = s.occlusionTexture !== "never";
  const generic = descriptor.programId === GPU_SHADING_PROGRAM.PbrGeneric;
  const normalMapping = needsNormal ? /* wgsl */ `
  var tangent: vec3f;
  var bitangent: vec3f;
  var normal_basis_valid = true;
  if sparse_has_tangent_ref(ref0) {
    let tangent_value=sparse_tangent_ref(ref0)*bary.weights.x+sparse_tangent_ref(ref1)*bary.weights.y+sparse_tangent_ref(ref2)*bary.weights.z;
    let transformed_tangent=mat3x3f(model[0].xyz,model[1].xyz,model[2].xyz)*tangent_value.xyz;
    let orthogonal_tangent=transformed_tangent-normal*dot(normal,transformed_tangent);
    if dot(orthogonal_tangent,orthogonal_tangent)>1e-8 {
      tangent=normalize(orthogonal_tangent);
    } else {
      tangent=sparse_fallback_tangent(normal);
    }
    bitangent=normalize(cross(normal,tangent))*select(-1.0,1.0,tangent_value.w>=0.0);
  } else {
    let normal_uv_set=sparse_material_uv_set(material,1u);
    let normal_uv0=sparse_transform_uv_1(material,sparse_uv_ref(ref0,normal_uv_set),false);
    let normal_uv1=sparse_transform_uv_1(material,sparse_uv_ref(ref1,normal_uv_set),false);
    let normal_uv2=sparse_transform_uv_1(material,sparse_uv_ref(ref2,normal_uv_set),false);
    let edge1=p1.xyz-p0.xyz;
    let edge2=p2.xyz-p0.xyz;
    let duv1=normal_uv1-normal_uv0;
    let duv2=normal_uv2-normal_uv0;
    let determinant=duv1.x*duv2.y-duv1.y*duv2.x;
    if abs(determinant)>1e-8 {
      let inverse_determinant=1.0/determinant;
      let derived_tangent=(edge1*duv2.y-edge2*duv1.y)*inverse_determinant;
      let derived_bitangent=(edge2*duv1.x-edge1*duv2.x)*inverse_determinant;
      let orthogonal_tangent=derived_tangent-normal*dot(normal,derived_tangent);
      if dot(orthogonal_tangent,orthogonal_tangent)>1e-12 {
        tangent=normalize(orthogonal_tangent);
        bitangent=normalize(cross(normal,tangent))*select(-1.0,1.0,dot(cross(normal,tangent),derived_bitangent)>=0.0);
      } else {
        normal_basis_valid=false;
        tangent=sparse_fallback_tangent(normal);
        bitangent=normalize(cross(normal,tangent));
      }
    } else {
      normal_basis_valid=false;
      tangent=sparse_fallback_tangent(normal);
      bitangent=normalize(cross(normal,tangent));
    }
  }
  if normal_basis_valid {
    let mapped=vec3f((sample_1.xy*2.0-1.0)*material.payload.pbr_factors.z,sample_1.z*2.0-1.0);
    normal=normalize(tangent*mapped.x+bitangent*mapped.y+normal*mapped.z);
  }` : "";
  const aoSource = needsOcclusion
    ? `select(sample_2.r,sample_4.r,(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOcclusionTexture}u)!=0u)`
    : "sample_2.r";
  const sample = (slot: number, ref: string, fallback: string, condition: string) => `
  if ${condition} {
    if !sparse_texture_route_valid(material_slot, ${slot}u, ${ref}) { sparse_identity_error(); return sparse_invalid_surface(); }
    let uv_set_${slot}=sparse_material_uv_set(material,${slot}u);
    let uv${slot}_0=sparse_uv_ref(ref0,uv_set_${slot});let uv${slot}_1=sparse_uv_ref(ref1,uv_set_${slot});let uv${slot}_2=sparse_uv_ref(ref2,uv_set_${slot});
    let uv_${slot}=uv${slot}_0*bary.weights.x+uv${slot}_1*bary.weights.y+uv${slot}_2*bary.weights.z;let uv_${slot}_dx=(uv${slot}_0*bary.ddx.x+uv${slot}_1*bary.ddx.y+uv${slot}_2*bary.ddx.z)/shading_view.upscale_ratio.x;let uv_${slot}_dy=(uv${slot}_0*bary.ddy.x+uv${slot}_1*bary.ddy.y+uv${slot}_2*bary.ddy.z)/shading_view.upscale_ratio.y;
    let sampled_${slot}=sparse_sample(${ref},sparse_sampler_${slot}(material),sparse_transform_uv_${slot}(material,uv_${slot},false),sparse_transform_uv_${slot}(material,uv_${slot}_dx,true),sparse_transform_uv_${slot}(material,uv_${slot}_dy,true),gradient_valid,${fallback});
    sample_${slot}=sampled_${slot};
  }`;
  const closureSample = (slot: number, role: string, fallback: string) => `
  if material.closure.${role}.texture_ref != ${GPU_TEXTURE_REF_INVALID}u {
    let texture_role = material.closure.${role};
    if !sparse_texture_route_valid(material_slot, ${slot}u, texture_role.texture_ref) {
      sparse_identity_error(); return sparse_invalid_surface();
    }
    let uv0=sparse_uv_ref(ref0,texture_role.uv_set);
    let uv1=sparse_uv_ref(ref1,texture_role.uv_set);
    let uv2=sparse_uv_ref(ref2,texture_role.uv_set);
    let uv=uv0*bary.weights.x+uv1*bary.weights.y+uv2*bary.weights.z;
    let uv_dx=(uv0*bary.ddx.x+uv1*bary.ddx.y+uv2*bary.ddx.z)/shading_view.upscale_ratio.x;
    let uv_dy=(uv0*bary.ddy.x+uv1*bary.ddy.y+uv2*bary.ddy.z)/shading_view.upscale_ratio.y;
    sample_${slot}=sparse_sample(texture_role.texture_ref,texture_role.sampler_class,
      sparse_transform_closure_uv(texture_role,uv,false),
      sparse_transform_closure_uv(texture_role,uv_dx,true),
      sparse_transform_closure_uv(texture_role,uv_dy,true),gradient_valid,${fallback});
  }`;
  const closureDefaults = "1.0,vec3f(1.0),1.5,0.0,0.0,vec3f(0.0,0.0,1.0)";
  if (!s.reconstructTriangle) {
    if (isFastUnlitFactor(descriptor)) return /* wgsl */ `
fn sparse_evaluate_unlit_factor(material:OEngineSparseUnlitFactorRecord)->vec4f{
  return material.base_color_factor;
}`;
    return /* wgsl */ `
fn sparse_evaluate(material_slot:u32,material:OEngineShadingMaterialRecord)->OEngineSparseSurface{
  let factor=material.payload.base_color_factor;
  return OEngineSparseSurface(factor.xyz,factor.w,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.y,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.x,vec3f(0.0),1.0,vec3f(0.0),vec2f(0.0),0.0,OENGINE_SURFACE_FLAG_VALID|OENGINE_SURFACE_FLAG_UNLIT,${closureDefaults});
}`;
  }
  if (!s.lit) {
    const usesBase = dynamicUnlit || descriptor.programId === GPU_SHADING_PROGRAM.UnlitTexture ||
      descriptor.programId === GPU_SHADING_PROGRAM.UnlitTextureColor;
    const usesColor = dynamicUnlit || descriptor.programId === GPU_SHADING_PROGRAM.UnlitFactorColor ||
      descriptor.programId === GPU_SHADING_PROGRAM.UnlitTextureColor;
    return /* wgsl */ `
fn sparse_evaluate_geometry(pixel:vec2u,work:OEngineMeshletRasterWork,primitive:u32,material_slot:u32,material:OEngineShadingMaterialRecord)->OEngineSparseSurface{
  let instance=instance_records[work.instance_slot];let geometry_base=sparse_geometry_base(work.geometry_slot);let meshlet_base=sparse_meshlet_base(work.meshlet_slot);let vertices=sparse_meshlet_vertices_for_work(work,meshlet_base,primitive);let ref0=sparse_vertex_ref_for_work(work,geometry_base,vertices.x);let ref1=sparse_vertex_ref_for_work(work,geometry_base,vertices.y);let ref2=sparse_vertex_ref_for_work(work,geometry_base,vertices.z);let model=sparse_affine(instance);
  let p0=model*vec4f(sparse_position_ref(ref0),1.0);let p1=model*vec4f(sparse_position_ref(ref1),1.0);let p2=model*vec4f(sparse_position_ref(ref2),1.0);let c0=shading_view.current_view_projection*p0;let c1=shading_view.current_view_projection*p1;let c2=shading_view.current_view_projection*p2;let bary=sparse_barycentric(vec2f(pixel)+vec2f(0.5),c0,c1,c2);let position=p0.xyz*bary.weights.x+p1.xyz*bary.weights.y+p2.xyz*bary.weights.z;
  var color=vec3f(1.0);${usesColor ? `${dynamicUnlit ? "if sparse_has_color_ref(ref0) {" : ""}color=sparse_color_ref(ref0)*bary.weights.x+sparse_color_ref(ref1)*bary.weights.y+sparse_color_ref(ref2)*bary.weights.z;${dynamicUnlit ? "}" : ""}` : ""}
  var base_sample=vec4f(1.0);${usesBase ? `${dynamicUnlit ? `if material.payload.texture_ref != ${GPU_TEXTURE_REF_INVALID}u {` : ""}let uv_set=sparse_material_uv_set(material,0u);let u0=sparse_uv_ref(ref0,uv_set);let u1=sparse_uv_ref(ref1,uv_set);let u2=sparse_uv_ref(ref2,uv_set);let uv=u0*bary.weights.x+u1*bary.weights.y+u2*bary.weights.z;let uv_dx=(u0*bary.ddx.x+u1*bary.ddx.y+u2*bary.ddx.z)/shading_view.upscale_ratio.x;let uv_dy=(u0*bary.ddy.x+u1*bary.ddy.y+u2*bary.ddy.z)/shading_view.upscale_ratio.y;if !sparse_texture_route_valid(material_slot,0u,material.payload.texture_ref){sparse_identity_error();return sparse_invalid_surface();}base_sample=sparse_sample(material.payload.texture_ref,sparse_sampler_0(material),sparse_transform_uv_0(material,uv,false),sparse_transform_uv_0(material,uv_dx,true),sparse_transform_uv_0(material,uv_dy,true),bary.valid,vec4f(1.0));${dynamicUnlit ? "}" : ""}` : ""}
  ${velocityCode}let factor=material.payload.base_color_factor;
  var surface_flags=OENGINE_SURFACE_FLAG_VALID|OENGINE_SURFACE_FLAG_UNLIT;${motionFlagCode}${usesBase ? "if !bary.valid{surface_flags|=OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK;}" : ""}
  return OEngineSparseSurface(factor.xyz*color*base_sample.xyz,factor.w*base_sample.a,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.y,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.x,vec3f(0.0),1.0,position,velocity,textureLoad(visibility_depth,vec2i(pixel),0),surface_flags,${closureDefaults});
}`;
  }
  return /* wgsl */ `
fn sparse_evaluate_geometry(pixel:vec2u,work:OEngineMeshletRasterWork,primitive:u32,material_slot:u32,material:OEngineShadingMaterialRecord)->OEngineSparseSurface{
  let instance=instance_records[work.instance_slot];let geometry_base=sparse_geometry_base(work.geometry_slot);let meshlet_base=sparse_meshlet_base(work.meshlet_slot);let vertices=sparse_meshlet_vertices_for_work(work,meshlet_base,primitive);let ref0=sparse_vertex_ref_for_work(work,geometry_base,vertices.x);let ref1=sparse_vertex_ref_for_work(work,geometry_base,vertices.y);let ref2=sparse_vertex_ref_for_work(work,geometry_base,vertices.z);let model=sparse_affine(instance);
  let p0=model*vec4f(sparse_position_ref(ref0),1.0);let p1=model*vec4f(sparse_position_ref(ref1),1.0);let p2=model*vec4f(sparse_position_ref(ref2),1.0);let c0=shading_view.current_view_projection*p0;let c1=shading_view.current_view_projection*p1;let c2=shading_view.current_view_projection*p2;let bary=sparse_barycentric(vec2f(pixel)+vec2f(0.5),c0,c1,c2);
  let position=p0.xyz*bary.weights.x+p1.xyz*bary.weights.y+p2.xyz*bary.weights.z;let local_normal=normalize(sparse_normal_ref(ref0)*bary.weights.x+sparse_normal_ref(ref1)*bary.weights.y+sparse_normal_ref(ref2)*bary.weights.z);let geometric=normalize(cross(p1.xyz-p0.xyz,p2.xyz-p0.xyz));var normal=sparse_world_normal(model,local_normal,geometric);
  var color=vec3f(1.0);${s.authoredVertexColor !== "never" ? "if sparse_has_color_ref(ref0) { color=sparse_color_ref(ref0)*bary.weights.x+sparse_color_ref(ref1)*bary.weights.y+sparse_color_ref(ref2)*bary.weights.z; }" : ""}
  let gradient_valid=bary.valid;
  let vertex_normal=normal;
  var sample_0=vec4f(1.0);var sample_1=vec4f(0.5,0.5,1.0,1.0);var sample_2=vec4f(1.0);var sample_3=vec4f(1.0);var sample_4=vec4f(1.0);
  var sample_5=vec4f(1.0);var sample_6=vec4f(1.0);var sample_7=vec4f(1.0);var sample_8=vec4f(1.0);var sample_9=vec4f(0.5,0.5,1.0,1.0);
  ${needsBase ? sample(0, "material.payload.texture_ref", "vec4f(1.0)", generic ? `(material.payload.texture_ref!=${GPU_TEXTURE_REF_INVALID}u)` : "true") : ""}
  ${needsNormal ? sample(1, "material.payload.normal_texture_ref", "vec4f(0.5,0.5,1.0,1.0)", generic ? `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture}u)!=0u` : "true") : ""}
  ${needsOrm ? sample(2, "material.payload.orm_texture_ref", "vec4f(1.0)", generic ? `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture}u)!=0u` : "true") : ""}
  ${needsEmissive ? sample(3, "material.payload.emissive_texture_ref", "vec4f(1.0)", generic ? `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture}u)!=0u` : "true") : ""}
  ${needsOcclusion ? sample(4, "material.payload.occlusion_texture_ref", "vec4f(1.0)", `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOcclusionTexture}u)!=0u`) : ""}
  ${generic ? closureSample(5, "specular", "vec4f(1.0)") : ""}
  ${generic ? closureSample(6, "specular_color", "vec4f(1.0)") : ""}
  ${generic && includeCoat ? closureSample(7, "coat", "vec4f(1.0)") : ""}
  ${generic && includeCoat ? closureSample(8, "coat_roughness", "vec4f(1.0)") : ""}
  ${generic && includeCoat ? closureSample(9, "coat_normal", "vec4f(0.5,0.5,1.0,1.0)") : ""}
  let base=material.payload.base_color_factor.xyz*color*sample_0.xyz;let metallic=clamp(material.payload.pbr_factors.x*sample_2.b,0.0,1.0);let roughness=clamp(material.payload.pbr_factors.y*sample_2.g,0.0,1.0);let ao=mix(1.0,${aoSource},clamp(material.payload.pbr_factors.w,0.0,1.0));let emissive=material.payload.emissive_factor.xyz*sample_3.xyz;
  ${normalMapping}
  var coat_normal=vertex_normal;
  ${generic && includeCoat ? `if material.closure.coat_normal.texture_ref != ${GPU_TEXTURE_REF_INVALID}u {
    let coat_role=material.closure.coat_normal;
    let coat_uv0=sparse_transform_closure_uv(coat_role,
      sparse_uv_ref(ref0,coat_role.uv_set),false);
    let coat_uv1=sparse_transform_closure_uv(coat_role,
      sparse_uv_ref(ref1,coat_role.uv_set),false);
    let coat_uv2=sparse_transform_closure_uv(coat_role,
      sparse_uv_ref(ref2,coat_role.uv_set),false);
    let coat_edge1=p1.xyz-p0.xyz;let coat_edge2=p2.xyz-p0.xyz;
    let coat_duv1=coat_uv1-coat_uv0;let coat_duv2=coat_uv2-coat_uv0;
    let coat_determinant=coat_duv1.x*coat_duv2.y-coat_duv1.y*coat_duv2.x;
    var coat_tangent=tangent;var coat_bitangent=bitangent;
    if abs(coat_determinant)>1e-8 {
      let derived_tangent=(coat_edge1*coat_duv2.y-coat_edge2*coat_duv1.y)/coat_determinant;
      let derived_bitangent=(coat_edge2*coat_duv1.x-coat_edge1*coat_duv2.x)/coat_determinant;
      let orthogonal=derived_tangent-vertex_normal*dot(vertex_normal,derived_tangent);
      if dot(orthogonal,orthogonal)>1e-12 {
        coat_tangent=normalize(orthogonal);
        coat_bitangent=normalize(cross(vertex_normal,coat_tangent))*
          select(-1.0,1.0,dot(cross(vertex_normal,coat_tangent),derived_bitangent)>=0.0);
      }
    }
    let mapped=vec3f((sample_9.xy*2.0-1.0)*material.closure.specular_color_and_normal_scale.w,
      sample_9.z*2.0-1.0);
    coat_normal=normalize(coat_tangent*mapped.x+coat_bitangent*mapped.y+vertex_normal*mapped.z);
  }` : ""}
  let specular_weight=material.closure.factors.y*sample_5.a;
  let specular_color=material.closure.specular_color_and_normal_scale.xyz*sample_6.xyz;
  let coat_factor=${includeCoat ? "material.closure.factors.z*sample_7.r" : "0.0"};
  let coat_roughness=${includeCoat ? "material.closure.factors.w*sample_8.g" : "0.0"};
  ${writesVelocity ? "let previous_position=oengine_instance_previous_from_current(instance)*vec4f(position,1.0);let previous_clip=shading_view.previous_view_projection*previous_position;let current_clip=shading_view.current_view_projection*vec4f(position,1.0);let current_ndc=current_clip.xy/current_clip.w;let previous_ndc=previous_clip.xy/previous_clip.w;let velocity=(current_ndc-previous_ndc)*vec2f(0.5,-0.5);" : "let velocity=vec2f(0.0);"}
  var surface_flags=OENGINE_SURFACE_FLAG_VALID;${motionFlagCode}${shadingProgramUsesTextures(descriptor.programId) ? "if !gradient_valid{surface_flags|=OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK;}" : ""}${generic ? `if (material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture}u)!=0u{surface_flags|=OENGINE_SURFACE_FLAG_NORMAL_TEXTURE;}if (material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture}u)!=0u{surface_flags|=OENGINE_SURFACE_FLAG_ORM_TEXTURE;}if (material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture}u)!=0u{surface_flags|=OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE;}` : `${needsNormal ? "surface_flags|=OENGINE_SURFACE_FLAG_NORMAL_TEXTURE;" : ""}${needsOrm ? "surface_flags|=OENGINE_SURFACE_FLAG_ORM_TEXTURE;" : ""}${needsEmissive ? "surface_flags|=OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE;" : ""}`}
  return OEngineSparseSurface(base,material.payload.base_color_factor.w*sample_0.a,normal,roughness,geometric,metallic,emissive,ao,position,velocity,textureLoad(visibility_depth,vec2i(pixel),0),surface_flags,specular_weight,specular_color,material.closure.factors.x,coat_factor,coat_roughness,coat_normal);
}`;
}

export function isFastUnlitFactor(descriptor: Readonly<SurfaceKernelProfile>): boolean {
  return descriptor.programId === GPU_SHADING_PROGRAM.UnlitFactor &&
    descriptor.outputDependencyMask === 0;
}
