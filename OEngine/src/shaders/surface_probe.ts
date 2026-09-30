import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL, GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_SPARSE_SHADING_VIEW_WGSL } from "../gpu/GpuSparseShadingFrameAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { SURFACE_METADATA_GROUP_FLAG, SURFACE_PRIMITIVE_BYTES } from "../gpu/SurfacePrimitiveAbi.js";
import { geometryWgsl } from "./surface_material_kernel.js";
import { SURFACE_SIGNAL_WGSL } from "../render/surface/SurfaceSignalPlan.js";

export function surfaceProbeWgsl(virtualGeometry: boolean, bankCount: number, lighting = false): string {
  const headers = Array.from({ length: bankCount }, (_, bank) =>
    `if location.bank_index == ${bank}u {
      header = oengine_virtual_group_header_v1(&virtual_product_bank_${bank}, location, group);
      meshlet = oengine_virtual_meshlet_header_v1(&virtual_product_bank_${bank}, location, group, header, work.meshlet_slot & 127u);
    }`).join("\n");
  return /* wgsl */ `
requires unrestricted_pointer_parameters;
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_SPARSE_SHADING_VIEW_WGSL}
${SURFACE_SIGNAL_WGSL}
struct ProbeBudget { color: f32, parameter: f32, normal: f32, depth: f32, uv: f32, lighting_position: f32, lighting_view: f32, minimum_roughness: f32, }
@group(0) @binding(0) var probe_key: texture_2d<u32>;
@group(0) @binding(1) var probe_depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read> probe_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> material_records: array<OEngineShadingMaterialRecord>;
@group(0) @binding(4) var<storage, read> instance_records: array<OEngineInstanceRecord>;
@group(0) @binding(5) var<uniform> shading_view: OEngineSparseShadingView;
@group(0) @binding(6) var<storage, read> asset_metadata_heap: array<u32>;
@group(0) @binding(7) var<storage, read> vertex_payload_heap: array<u32>;
@group(0) @binding(8) var<storage, read> probe_routes: array<OEngineShadingTextureRoute>;
@group(0) @binding(9) var<storage, read> probe_residency: array<u32>;
@group(0) @binding(10) var<uniform> probe_budget: ProbeBudget;
@group(0) @binding(11) var probe_output: texture_storage_2d<r32uint, write>;
@group(0) @binding(12) var<storage, read_write> probe_counters: array<atomic<u32>>;
${virtualGeometry ? `@group(1) @binding(0) var<storage, read> virtual_product_metadata: array<u32>;
${Array.from({ length: bankCount }, (_, bank) => `@group(1) @binding(${bank + 1}) var<storage, read> virtual_product_bank_${bank}: array<u32>;`).join("\n")}` : ""}
var<private> probe_failed: bool;
fn sparse_identity_error() { probe_failed = true; }
${geometryWgsl(virtualGeometry, bankCount)}
struct ProbeFact {
  valid: bool, key: u32, instance: u32, material: u32, geometry: u32, representation: u32,
  domain: u32, risk: u32, depth: f32, normal: vec3f, color: vec3f,
  uv0: vec2f, uv1: vec2f, dx0: vec2f, dy0: vec2f, dx1: vec2f, dy1: vec2f,
  normal_variation: f32, color_variation: f32,
  ${lighting ? "position: vec3f, view_direction: vec3f," : ""}
}
fn probe_reject(reason: u32) -> bool {
  atomicAdd(&probe_counters[reason], 1u); return false;
}
struct ProbeTriangle {
  valid: bool, metadata: vec4u, uv_span: vec4f, ref0: SparseVertexRef, ref1: SparseVertexRef, ref2: SparseVertexRef,
}
fn probe_triangle(work: OEngineMeshletRasterWork, primitive: u32) -> ProbeTriangle {
  var result: ProbeTriangle;
  ${virtualGeometry ? `
  let asset = oengine_geometry_product_resolve_asset_v1(&virtual_product_metadata,
    work.geometry_slot, oengine_instance_geometry_generation(instance_records[work.instance_slot]));
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
fn probe_fact(pixel: vec2u) -> ProbeFact {
  var result: ProbeFact;
  if any(pixel >= vec2u(shading_view.width, shading_view.height)) { return result; }
  let key = textureLoad(probe_key, vec2i(pixel), 0).x;
  if !oengine_visibility_key_is_valid(key) || probe_work.header.generation == 0u { return result; }
  let slot = oengine_visibility_key_meshlet_work_slot(key);
  if slot >= min(probe_work.header.written_count, arrayLength(&probe_work.elements)) { return result; }
  let work = probe_work.elements[slot];
  if work.instance_slot >= arrayLength(&instance_records) ||
    work.material_slot_or_range >= arrayLength(&material_records) { return result; }
  let material = material_records[work.material_slot_or_range];
  let published_instance = instance_records[work.instance_slot];
  if (published_instance.flags & 1u) == 0u ||
    published_instance.geometry_record_index != work.geometry_slot ||
    ((work.packed_raster_flags >> 8u) & 63u) != material.texture_binding_set_id * 16u + material.program_id ||
    work.material_slot_or_range >= shading_view.material_count { return result; }
  if material.family == 1u { atomicAdd(&probe_counters[1u], 1u); }
  if material.family != 1u || material.payload.alpha_mode != 0u ||
    (material.payload.flags & (2u | 8u | 16u)) != 0u ||
    material.material_generation != shading_view.material_generation ||
    material.texture_generation != shading_view.texture_generation ||
    material.publication_revision != shading_view.publication_revision { return result; }
  ${lighting ? `if !(material.payload.pbr_factors.y >= probe_budget.minimum_roughness && material.payload.pbr_factors.y <= 1.0) ||
    material.payload.orm_texture_ref != 0xffffffffu { return result; }` : ""}
  let primitive = oengine_visibility_key_local_primitive(key);
  let triangle = probe_triangle(work, primitive);
  let metadata = triangle.metadata;
  if !triangle.valid || metadata.x == 0u || metadata.y != 0u ||
    !all(triangle.uv_span >= vec4f(0.0)) || !all(triangle.uv_span <= vec4f(65504.0)) { return result; }
  probe_failed = false;
  let instance = instance_records[work.instance_slot];
  let model = sparse_affine(instance);
  let scale = vec3f(length(model[0].xyz), length(model[1].xyz), length(model[2].xyz));
  if any(scale <= vec3f(1e-8)) || any(abs(scale - vec3f(scale.x)) > vec3f(1e-6)) ||
    abs(dot(model[0].xyz, model[1].xyz)) > scale.x * scale.y * 1e-6 ||
    abs(dot(model[0].xyz, model[2].xyz)) > scale.x * scale.z * 1e-6 ||
    abs(dot(model[1].xyz, model[2].xyz)) > scale.y * scale.z * 1e-6 ||
    dot(model[0].xyz, cross(model[1].xyz, model[2].xyz)) <= 0.0 { return result; }
  let ref0 = triangle.ref0; let ref1 = triangle.ref1; let ref2 = triangle.ref2;
  if probe_failed || !ref0.valid || !ref1.valid || !ref2.valid { return result; }
  atomicAdd(&probe_counters[15u], 1u);
  let p0 = model * vec4f(sparse_position_ref(ref0), 1.0);
  let p1 = model * vec4f(sparse_position_ref(ref1), 1.0);
  let p2 = model * vec4f(sparse_position_ref(ref2), 1.0);
  let clip0 = shading_view.current_view_projection * p0;
  let clip1 = shading_view.current_view_projection * p1;
  let clip2 = shading_view.current_view_projection * p2;
  if min(clip0.w, min(clip1.w, clip2.w)) <= 1e-6 || min(clip0.z, min(clip1.z, clip2.z)) < 0.0 { return result; }
  let bary = sparse_barycentric(vec2f(pixel) + vec2f(0.5), clip0, clip1, clip2);
  let face = cross(p1.xyz - p0.xyz, p2.xyz - p0.xyz);
  if !bary.valid || dot(face, face) <= 1e-16 { return result; }
  result.normal = sparse_world_normal(model, sparse_normal_ref(ref0) * bary.weights.x +
    sparse_normal_ref(ref1) * bary.weights.y + sparse_normal_ref(ref2) * bary.weights.z, normalize(face));
  ${lighting ? `result.position = p0.xyz * bary.weights.x + p1.xyz * bary.weights.y + p2.xyz * bary.weights.z;
  result.view_direction = normalize(shading_view.camera_position.xyz - result.position);` : ""}
  result.color = sparse_color_ref(ref0) * bary.weights.x + sparse_color_ref(ref1) * bary.weights.y + sparse_color_ref(ref2) * bary.weights.z;
  let uv00 = sparse_uv_ref(ref0, 0u); let uv01 = sparse_uv_ref(ref1, 0u); let uv02 = sparse_uv_ref(ref2, 0u);
  let uv10 = sparse_uv_ref(ref0, 1u); let uv11 = sparse_uv_ref(ref1, 1u); let uv12 = sparse_uv_ref(ref2, 1u);
  result.uv0 = uv00 * bary.weights.x + uv01 * bary.weights.y + uv02 * bary.weights.z;
  result.uv1 = uv10 * bary.weights.x + uv11 * bary.weights.y + uv12 * bary.weights.z;
  result.dx0 = uv00 * bary.ddx.x + uv01 * bary.ddx.y + uv02 * bary.ddx.z;
  result.dy0 = uv00 * bary.ddy.x + uv01 * bary.ddy.y + uv02 * bary.ddy.z;
  result.dx1 = uv10 * bary.ddx.x + uv11 * bary.ddx.y + uv12 * bary.ddx.z;
  result.dy1 = uv10 * bary.ddy.x + uv11 * bary.ddy.y + uv12 * bary.ddy.z;
  result.key = key; result.instance = work.instance_slot; result.material = work.material_slot_or_range;
  result.geometry = work.geometry_slot; result.representation = work.packed_profile_lod;
  result.domain = metadata.x; result.risk = metadata.y;
  result.normal_variation = bitcast<f32>(metadata.z); result.color_variation = bitcast<f32>(metadata.w);
  result.depth = textureLoad(probe_depth, vec2i(pixel), 0);
  result.valid = !probe_failed &&
    ${lighting ? "all(abs(result.position) < vec3f(65504.0)) && all(abs(result.view_direction) <= vec3f(1.001)) &&" : ""}
    result.normal_variation >= 0.0 && result.normal_variation <= 2.0 &&
    result.color_variation >= 0.0 && result.color_variation <= 1.0 && result.depth > 0.0001 && all(abs(result.normal) < vec3f(65504.0)) &&
    all(abs(result.color) < vec3f(65504.0)) && all(abs(result.uv0) < vec2f(65504.0)) && all(abs(result.uv1) < vec2f(65504.0));
  return result;
}
fn probe_ref(material: OEngineShadingMaterialRecord, role: u32) -> u32 {
  switch role {
    case 0u: { return material.payload.texture_ref; }
    case 1u: { return material.payload.normal_texture_ref; }
    case 2u: { return material.payload.orm_texture_ref; }
    case 3u: { return material.payload.emissive_texture_ref; }
    case 4u: { return material.payload.occlusion_texture_ref; }
    case 5u: { return material.closure.specular.texture_ref; }
    case 6u: { return material.closure.specular_color.texture_ref; }
    default: { return OENGINE_TEXTURE_REF_INVALID; }
  }
}
fn probe_role(material: OEngineShadingMaterialRecord, role: u32) -> OEngineClosureTextureRole {
  var result: OEngineClosureTextureRole;
  result.texture_ref = probe_ref(material, role);
  result.uv_set = (material.payload.texture_uv_sets >> (role * 8u)) & 255u;
  switch role {
    case 0u: { result.uv_offset_scale = material.payload.uv_offset_scale; result.uv_rotation = material.payload.uv_rotation; result.sampler_class = material.payload.sampler_class; }
    case 1u: { result.uv_offset_scale = material.payload.normal_uv_offset_scale; result.uv_rotation = material.payload.normal_uv_rotation; result.sampler_class = material.payload.texture_sampler_classes & 255u; }
    case 2u: { result.uv_offset_scale = material.payload.orm_uv_offset_scale; result.uv_rotation = material.payload.orm_uv_rotation; result.sampler_class = (material.payload.texture_sampler_classes >> 8u) & 255u; }
    case 3u: { result.uv_offset_scale = material.payload.emissive_uv_offset_scale; result.uv_rotation = material.payload.emissive_uv_rotation; result.sampler_class = (material.payload.texture_sampler_classes >> 16u) & 255u; }
    case 4u: { result.uv_set = material.payload.occlusion_uv_set; result.uv_offset_scale = material.payload.occlusion_uv_offset_scale; result.uv_rotation = material.payload.occlusion_uv_rotation; result.sampler_class = (material.payload.texture_sampler_classes >> 24u) & 255u; }
    case 5u: { result = material.closure.specular; }
    default: { result = material.closure.specular_color; }
  }
  return result;
}
fn probe_uv(role: OEngineClosureTextureRole, value: vec2f, derivative: bool) -> vec2f {
  let scaled = value * role.uv_offset_scale.zw;
  return select(role.uv_offset_scale.xy, vec2f(0.0), derivative) +
    vec2f(role.uv_rotation.x * scaled.x - role.uv_rotation.y * scaled.y,
      role.uv_rotation.y * scaled.x + role.uv_rotation.x * scaled.y);
}
fn probe_pair(begin: ProbeFact, end: ProbeFact) -> bool {
  if !begin.valid || !end.valid { return probe_reject(6u); }
  if begin.instance != end.instance || begin.material != end.material || begin.geometry != end.geometry ||
    begin.domain != end.domain || begin.representation != end.representation { return probe_reject(8u); }
  if max(begin.normal_variation, end.normal_variation) > probe_budget.normal ||
    any(abs(begin.normal - end.normal) > vec3f(probe_budget.normal)) ||
    abs(begin.depth - end.depth) > probe_budget.depth { return probe_reject(7u); }
  ${lighting ? `if any(abs(begin.position - end.position) > vec3f(probe_budget.lighting_position)) ||
    any(abs(begin.view_direction - end.view_direction) > vec3f(probe_budget.lighting_view)) { return probe_reject(7u); }` : ""}
  let material = material_records[begin.material];
  if any(abs(begin.color - end.color) * abs(material.payload.base_color_factor.xyz) > vec3f(probe_budget.color)) ||
    max(begin.color_variation, end.color_variation) > probe_budget.color { return probe_reject(11u); }
  for (var role = 0u; role < 7u; role++) {
    let texture_ref = probe_ref(material, role);
    if texture_ref == OENGINE_TEXTURE_REF_INVALID { continue; }
    let route_index = begin.material * ${GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL}u + role;
    if route_index >= arrayLength(&probe_routes) { return probe_reject(9u); }
    let route = probe_routes[route_index];
    if route.texture_ref != texture_ref || route.texture_generation != material.texture_generation ||
      route.publication_revision != material.publication_revision || route.texture_binding_set_id != material.texture_binding_set_id ||
      route.sampling_signature == 0u { return probe_reject(9u); }
    if route.residency_slot >= arrayLength(&probe_residency) || route.residency_revision == 0u ||
      probe_residency[route.residency_slot] != route.residency_revision { return probe_reject(10u); }
    if route.variation_known != 1u || !all(abs(route.variation_low) <= vec4f(65504.0)) ||
      !all(abs(route.variation_high) <= vec4f(65504.0)) || !all(route.variation_low <= route.variation_high) { return probe_reject(11u); }
    let variation = route.variation_high - route.variation_low;
    var budget = vec4f(probe_budget.parameter);
    var scaled_variation = variation;
    if role == 0u { budget = vec4f(probe_budget.color); scaled_variation *= abs(material.payload.base_color_factor); }
    if role == 1u { return probe_reject(11u); }
    if role == 2u { scaled_variation.y *= abs(material.payload.pbr_factors.y); scaled_variation.z *= abs(material.payload.pbr_factors.x); }
    if role == 3u { budget = vec4f(probe_budget.color); scaled_variation = vec4f(variation.xyz * abs(material.payload.emissive_factor.xyz), 0.0); }
    if role == 5u { scaled_variation = vec4f(0.0, 0.0, 0.0, variation.w * abs(material.closure.factors.y)); }
    if role == 6u { scaled_variation = vec4f(variation.xyz * abs(material.closure.specular_color_and_normal_scale.xyz), 0.0); }
    if any(scaled_variation > budget) || any(abs(scaled_variation) > vec4f(65504.0)) { return probe_reject(11u); }
    let sampling = probe_role(material, role);
    if sampling.uv_set > 1u { return probe_reject(12u); }
    let uv_begin = probe_uv(sampling, select(begin.uv0, begin.uv1, sampling.uv_set == 1u), false);
    let uv_end = probe_uv(sampling, select(end.uv0, end.uv1, sampling.uv_set == 1u), false);
    let dx = probe_uv(sampling, select(begin.dx0, begin.dx1, sampling.uv_set == 1u), true);
    let dy = probe_uv(sampling, select(begin.dy0, begin.dy1, sampling.uv_set == 1u), true);
    if !all(abs(dx) < vec2f(65504.0)) || !all(abs(dy) < vec2f(65504.0)) ||
      !all(abs(uv_begin) < vec2f(65504.0)) || !all(abs(uv_end) < vec2f(65504.0)) ||
      (any(variation != vec4f(0.0)) && any(abs(uv_begin - uv_end) > vec2f(probe_budget.uv))) { return probe_reject(12u); }
  }
  atomicAdd(&probe_counters[select(14u, 13u, begin.key == end.key)], 1u);
  return true;
}
var<workgroup> probe_facts: array<ProbeFact, 64>;
@compute @workgroup_size(8, 8)
fn probe(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) local_index: u32) {
  probe_facts[local_index] = probe_fact(id.xy);
  workgroupBarrier();
  if (id.x & 1u) != 0u || (id.y & 1u) != 0u ||
    any(id.xy >= vec2u(shading_view.width, shading_view.height)) { return; }
  atomicAdd(&probe_counters[0u], 1u);
  var rate = 0u;
  if all(id.xy + vec2u(1u) < vec2u(shading_view.width, shading_view.height)) {
    let first = probe_facts[local_index]; let second = probe_facts[local_index + 1u];
    let third = probe_facts[local_index + 8u]; let fourth = probe_facts[local_index + 9u];
    let pair01 = probe_pair(first, second); let pair23 = probe_pair(third, fourth);
    let pair02 = probe_pair(first, third); let pair13 = probe_pair(second, fourth);
    let horizontal = pair01 && pair23; let vertical = pair02 && pair13;
    rate = select(select(0u, 2u, vertical), select(1u, 3u, vertical), horizontal);
  }
  atomicAdd(&probe_counters[2u + rate], 1u);
  var packed = rate;
  let first = probe_facts[local_index];
  if first.valid && first.material < arrayLength(&material_records) {
    let material = material_records[first.material];
    if material.payload.normal_texture_ref != OENGINE_TEXTURE_REF_INVALID {
      packed = rate | (rate << SURFACE_SIGNAL_MATERIAL_SHIFT) |
        (rate << SURFACE_SIGNAL_EMISSIVE_SHIFT) | (rate << SURFACE_SIGNAL_NORMAL_SHIFT) |
        SURFACE_SIGNAL_PACKED_FLAG;
      packed = surface_signal_set(packed, SURFACE_SIGNAL_NORMAL_SHIFT, 0u);
    }
    if material.payload.orm_texture_ref != OENGINE_TEXTURE_REF_INVALID {
      packed = rate | (rate << SURFACE_SIGNAL_MATERIAL_SHIFT) |
        (rate << SURFACE_SIGNAL_EMISSIVE_SHIFT) | (rate << SURFACE_SIGNAL_NORMAL_SHIFT) |
        SURFACE_SIGNAL_PACKED_FLAG;
      packed = surface_signal_set(packed, SURFACE_SIGNAL_MATERIAL_SHIFT, 0u);
    }
    if material.payload.emissive_texture_ref != OENGINE_TEXTURE_REF_INVALID {
      packed = rate | (rate << SURFACE_SIGNAL_MATERIAL_SHIFT) |
        (rate << SURFACE_SIGNAL_EMISSIVE_SHIFT) | (rate << SURFACE_SIGNAL_NORMAL_SHIFT) |
        SURFACE_SIGNAL_PACKED_FLAG;
      packed = surface_signal_set(packed, SURFACE_SIGNAL_EMISSIVE_SHIFT, 0u);
    }
  }
  textureStore(probe_output, vec2i(id.xy / 2u), vec4u(packed, 0u, 0u, 0u));
}
`;
}
