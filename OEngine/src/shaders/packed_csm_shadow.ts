import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_GEOMETRY_VERTEX_DECODE_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_UV_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL } from "../gpu/GpuTextureRefAbi.js";
import { GPU_SECONDARY_RASTER_FLAGS } from "../gpu/GpuSecondaryRasterAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL, GPU_MESHLET_RASTER_FLAGS } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";

/** Depth-only SecondaryRasterWork consumer; alpha semantics match main Visibility. */
export const PACKED_CSM_SHADOW_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_SHADING_MATERIAL_WGSL}

struct QueueHeaderRead {
  written: u32, attempted: u32, peak: u32, overflow: u32,
  fallback: u32, capacity: u32, rejected_cone: u32, rejected_hzb: u32,
}
struct SecondaryRasterWork {
  instance_record_index: u32,
  geometry_record_index: u32,
  meshlet_record_index: u32,
  local_triangle_index: u32,
  material_handle: u32,
  raster_flags: u32,
}
struct SecondaryRasterQueue { header: QueueHeaderRead, elements: array<SecondaryRasterWork> }
struct ShadowVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv0: vec2f,
  @location(1) uv1: vec2f,
  @location(2) uv2: vec2f,
  @location(3) @interpolate(flat) uv_valid_mask: u32,
  @location(4) @interpolate(flat) material_handle: u32,
  @location(5) @interpolate(flat) mirrored: u32,
  @location(6) @interpolate(flat) raster_flags: u32,
}

@group(0) @binding(0) var<uniform> shadow_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> meshlet_vertices: array<u32>;
@group(0) @binding(4) var<storage, read> meshlet_triangles: array<u32>;
@group(0) @binding(5) var<storage, read> vertex_data: array<u32>;
@group(0) @binding(6) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(0) @binding(7) var<storage, read> raster_work: SecondaryRasterQueue;
@group(0) @binding(8) var<storage, read> materials: array<OEngineShadingMaterialRecord>;
@group(0) @binding(9) var oengine_texture_bank_0: texture_2d_array<f32>;
@group(0) @binding(10) var oengine_texture_bank_1: texture_2d_array<f32>;
@group(0) @binding(11) var oengine_texture_bank_2: texture_2d_array<f32>;
@group(0) @binding(12) var oengine_texture_bank_3: texture_2d_array<f32>;
@group(0) @binding(13) var oengine_texture_bank_4: texture_2d_array<f32>;
@group(0) @binding(14) var oengine_texture_bank_5: texture_2d_array<f32>;
@group(0) @binding(15) var oengine_texture_bank_6: texture_2d_array<f32>;
@group(0) @binding(16) var oengine_texture_bank_7: texture_2d_array<f32>;
@group(0) @binding(17) var oengine_texture_bank_8: texture_2d_array<f32>;

${GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL}

override OENGINE_ACTIVE_TEXTURE_BINDING_SET: u32 = 0u;

fn read_u8(words: ptr<storage, array<u32>, read>, byte_offset: u32) -> u32 {
  let word = (*words)[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}
fn read_u16(words: ptr<storage, array<u32>, read>, byte_offset: u32) -> u32 {
  return read_u8(words, byte_offset) | (read_u8(words, byte_offset + 1u) << 8u);
}
fn read_uv(
  words: ptr<storage, array<u32>, read>, byte_offset: u32, stride: u32,
  format: u32, source_vertex: u32
) -> vec3f {
  let offset = byte_offset + source_vertex * stride;
  if format == ${GPU_UV_FORMAT.Float32x2}u {
    let word = offset >> 2u;
    return vec3f(bitcast<f32>((*words)[word]), bitcast<f32>((*words)[word + 1u]), 1.0);
  }
  if format == ${GPU_UV_FORMAT.Unorm8x2}u {
    return vec3f(f32(read_u8(words, offset)), f32(read_u8(words, offset + 1u)), 255.0);
  }
  if format == ${GPU_UV_FORMAT.Unorm16x2}u {
    return vec3f(f32(read_u16(words, offset)), f32(read_u16(words, offset + 2u)), 65535.0);
  }
  if format == ${GPU_UV_FORMAT.Float16x2}u {
    return vec3f(unpack2x16float((*words)[offset >> 2u]), 1.0);
  }
  return vec3f(0.0);
}

@vertex
fn packed_csm_vertex(
  @builtin(vertex_index) vertex_index: u32
) -> ShadowVertexOutput {
  let work_index = vertex_index / 3u;
  let triangle_corner = vertex_index % 3u;
  let work = raster_work.elements[work_index];
  let instance = instances[work.instance_record_index];
  let geometry = geometries[work.geometry_record_index];
  let meshlet = meshlets[work.meshlet_record_index];
  let corner = work.local_triangle_index * 3u + triangle_corner;
  let local_vertex = read_u8(&meshlet_triangles, meshlet.triangle_byte_offset + corner);
  let source_vertex = meshlet_vertices[meshlet.vertex_offset + local_vertex];
  let local_position = oengine_geometry_position(&vertex_data, geometry, source_vertex);
  let uv0 = read_uv(&vertex_data, geometry.uv0_byte_offset, geometry.uv0_stride,
    geometry.uv0_format, source_vertex);
  let uv1 = read_uv(&vertex_data, geometry.uv1_byte_offset, geometry.uv1_stride,
    geometry.uv1_format, source_vertex);
  let uv2 = read_uv(&vertex_data, geometry.uv2_byte_offset, geometry.uv2_stride,
    geometry.uv2_format, source_vertex);
  var output: ShadowVertexOutput;
  output.position = shadow_camera.view_projection_matrix *
    oengine_instance_current_object_to_world(instance) * vec4f(local_position, 1.0);
  output.uv0 = select(vec2f(0.0), uv0.xy / uv0.z, uv0.z > 0.0);
  output.uv1 = select(vec2f(0.0), uv1.xy / uv1.z, uv1.z > 0.0);
  output.uv2 = select(vec2f(0.0), uv2.xy / uv2.z, uv2.z > 0.0);
  output.uv_valid_mask = select(0u, 1u, uv0.z > 0.0) |
    select(0u, 2u, uv1.z > 0.0) |
    select(0u, 4u, uv2.z > 0.0);
  output.material_handle = work.material_handle;
  let linear = oengine_instance_current_object_to_world(instance);
  output.mirrored = select(
    0u, 1u, dot(linear[0].xyz, cross(linear[1].xyz, linear[2].xyz)) < 0.0
  );
  output.raster_flags = work.raster_flags;
  return output;
}

fn wrap_texel(value: i32, mode: u32, size: i32) -> i32 {
  if mode == 0u { return clamp(value, 0i, size - 1i); }
  if mode == 2u {
    let period = size * 2i;
    let wrapped = ((value % period) + period) % period;
    return select(wrapped, period - 1i - wrapped, wrapped >= size);
  }
  return ((value % size) + size) % size;
}
fn alpha_texel(texture_ref: u32, x: i32, y: i32, sampler_class: u32) -> f32 {
  let bank = oengine_texture_ref_bank(texture_ref);
  let layer = i32(oengine_texture_ref_layer(texture_ref));
  let size = oengine_texture_bank_size(bank);
  let pixel = vec2i(
    wrap_texel(x, sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size),
    wrap_texel(y, (sampler_class >> OENGINE_MATERIAL_SAMPLER_ADDRESS_V_BITS) &
      OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size)
  );
  return oengine_texture_bank_alpha(texture_ref, pixel);
}
fn sample_alpha(texture_ref: u32, uv: vec2f, sampler_class: u32) -> f32 {
  let size = f32(oengine_texture_bank_size(oengine_texture_ref_bank(texture_ref)));
  let position = uv * size - 0.5;
  let base = vec2i(floor(position));
  if (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) == 0u {
    let nearest = vec2i(floor(uv * size));
    return alpha_texel(texture_ref, nearest.x, nearest.y, sampler_class);
  }
  let f = fract(position);
  return mix(
    mix(alpha_texel(texture_ref, base.x, base.y, sampler_class),
      alpha_texel(texture_ref, base.x + 1i, base.y, sampler_class), f.x),
    mix(alpha_texel(texture_ref, base.x, base.y + 1i, sampler_class),
      alpha_texel(texture_ref, base.x + 1i, base.y + 1i, sampler_class), f.x), f.y
  );
}
fn transform_uv(record: OEngineMaterialVisibilityRecord, uv: vec2f) -> vec2f {
  let scaled = uv * record.uv_offset_scale.zw;
  return record.uv_offset_scale.xy + vec2f(
    record.uv_rotation.x * scaled.x - record.uv_rotation.y * scaled.y,
    record.uv_rotation.y * scaled.x + record.uv_rotation.x * scaled.y
  );
}

@fragment
fn packed_csm_fragment(input: ShadowVertexOutput, @builtin(front_facing) front: bool) {
  if (input.raster_flags & ${GPU_SECONDARY_RASTER_FLAGS.CastsShadow}u) == 0u { discard; }
  if input.material_handle >= arrayLength(&materials) { return; }
  let record = materials[input.material_handle].payload;
  if record.texture_binding_set_id != OENGINE_ACTIVE_TEXTURE_BINDING_SET { discard; }
  if (record.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u { return; }
  let corrected_front = front != (input.mirrored != 0u);
  if (record.flags & OENGINE_MATERIAL_VISIBILITY_DOUBLE_SIDED) == 0u && !corrected_front {
    discard;
  }
  if record.alpha_mode == OENGINE_MATERIAL_ALPHA_BLEND { discard; }
  if record.alpha_mode == OENGINE_MATERIAL_ALPHA_MASK {
    var alpha = record.base_color_factor_alpha;
    let uv_set = record.texture_uv_sets & 0xffu;
    let uv_bit = select(0u, 1u << uv_set, uv_set < 3u);
    if (record.flags & OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE) != 0u &&
      oengine_texture_ref_valid(record.texture_ref) &&
      (input.uv_valid_mask & uv_bit) != 0u {
      alpha *= sample_alpha(record.texture_ref,
        transform_uv(record, select(select(input.uv0, input.uv1, uv_set == 1u), input.uv2, uv_set == 2u)),
        record.sampler_class);
    }
    if alpha < record.alpha_cutoff { discard; }
  }
}
`;

/** Product MeshletWork depth-only consumer used by the shared CSM producer. */
export const PACKED_CSM_PRODUCT_SHADOW_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}

struct ProductShadowVertex {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) material_handle: u32,
  @location(1) @interpolate(flat) raster_flags: u32,
};

@group(0) @binding(0) var<uniform> shadow_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> product_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> product_heap: array<u32>;
@group(0) @binding(4) var<storage, read> product_bank_0: array<u32>;
@group(0) @binding(5) var<storage, read> product_bank_1: array<u32>;
@group(0) @binding(6) var<storage, read> product_bank_2: array<u32>;
@group(0) @binding(7) var<storage, read> product_bank_3: array<u32>;
@group(0) @binding(8) var<storage, read> materials: array<OEngineShadingMaterialRecord>;

fn product_bank_word(bank: u32, word: u32) -> u32 {
  if (bank == 0u) { return product_bank_0[word]; }
  if (bank == 1u) { return product_bank_1[word]; }
  if (bank == 2u) { return product_bank_2[word]; }
  return product_bank_3[word];
}
fn product_u16(bank: u32, byte_offset: u32) -> u32 {
  let first = product_bank_word(bank, byte_offset >> 2u);
  let second = product_bank_word(bank, (byte_offset + 1u) >> 2u);
  return ((first >> ((byte_offset & 3u) * 8u)) & 0xffu) |
    (((second >> (((byte_offset + 1u) & 3u) * 8u)) & 0xffu) << 8u);
}
fn product_group_header(bank: u32, location: OEngineGeometryPageLookupV1,
  group: OEngineVirtualGroupV1) -> OEngineVirtualGroupHeaderV1 {
  if (bank == 0u) { return oengine_virtual_group_header_v1(&product_bank_0, location, group); }
  if (bank == 1u) { return oengine_virtual_group_header_v1(&product_bank_1, location, group); }
  if (bank == 2u) { return oengine_virtual_group_header_v1(&product_bank_2, location, group); }
  return oengine_virtual_group_header_v1(&product_bank_3, location, group);
}
fn product_meshlet_header(bank: u32, location: OEngineGeometryPageLookupV1,
  group: OEngineVirtualGroupV1, header: OEngineVirtualGroupHeaderV1,
  local: u32) -> OEngineVirtualMeshletHeaderV1 {
  if (bank == 0u) { return oengine_virtual_meshlet_header_v1(&product_bank_0, location, group, header, local); }
  if (bank == 1u) { return oengine_virtual_meshlet_header_v1(&product_bank_1, location, group, header, local); }
  if (bank == 2u) { return oengine_virtual_meshlet_header_v1(&product_bank_2, location, group, header, local); }
  return oengine_virtual_meshlet_header_v1(&product_bank_3, location, group, header, local);
}
fn product_position(bank: u32, byte_offset: u32, meshlet: OEngineVirtualMeshletHeaderV1,
  format_word0: u32, format_word1: u32, vertex: u32) -> vec3f {
  let stride = format_word0 & 0xffffu;
  let position_offset = format_word1 & 0xffu;
  let at = byte_offset + meshlet.vertex_byte_offset + vertex * stride + position_offset;
  let q = vec3f(f32(product_u16(bank, at)), f32(product_u16(bank, at + 2u)),
    f32(product_u16(bank, at + 4u))) / 65535.0;
  return mix(meshlet.bounds_min, meshlet.bounds_max, q);
}

@vertex
fn packed_csm_product_vertex(@builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32) -> ProductShadowVertex {
  let safe_work = min(instance_index, max(product_work.header.written_count, 1u) - 1u);
  let work = product_work.elements[safe_work];
  let instance = instances[work.instance_slot];
  let local_meshlet = work.meshlet_slot & 127u;
  let group_id = work.meshlet_slot >> 7u;
  let asset = oengine_geometry_product_resolve_asset_v1(&product_heap,
    work.geometry_slot, oengine_instance_geometry_generation(instance));
  let group = oengine_virtual_group_v1(&product_heap, asset, group_id);
  let location = oengine_geometry_product_lookup_page_heap_v1(&product_heap, asset, group.page_id);
  var valid = false;
  var position = vec3f(0.0);
  if (asset.valid && group.valid && location.valid) {
    let header = product_group_header(location.bank_index, location, group);
    let meshlet = product_meshlet_header(location.bank_index, location, group, header, local_meshlet);
    if (header.valid && meshlet.valid && vertex_index / 3u < meshlet.triangle_count &&
        header.vertex_format_id < asset.vertex_format_count) {
      let format_at = asset.vertex_format_word_offset + header.vertex_format_id * 4u;
      let format_word0 = product_heap[format_at];
      let format_word1 = product_heap[format_at + 1u];
      let triangle = vertex_index / 3u;
      let corner = vertex_index % 3u;
      let triangle_byte = location.byte_offset + group.offset_in_page +
        meshlet.triangle_byte_offset + triangle * 3u + corner;
      let local_vertex = (product_bank_word(location.bank_index, triangle_byte >> 2u) >>
        ((triangle_byte & 3u) * 8u)) & 0xffu;
      position = product_position(location.bank_index,
        location.byte_offset + group.offset_in_page, meshlet,
        format_word0, format_word1, local_vertex);
      valid = true;
    }
  }
  var output: ProductShadowVertex;
  output.position = select(vec4f(2.0, 2.0, 2.0, 1.0),
    shadow_camera.view_projection_matrix *
      oengine_instance_current_object_to_world(instance) * vec4f(position, 1.0), valid);
  output.material_handle = work.material_slot_or_range;
  output.raster_flags = work.packed_raster_flags;
  return output;
}

@fragment
fn packed_csm_product_fragment(input: ProductShadowVertex) {
  if (input.raster_flags & ${GPU_MESHLET_RASTER_FLAGS.Transparent}u) != 0u { discard; }
  if (input.material_handle >= arrayLength(&materials)) { discard; }
  let record = materials[input.material_handle].payload;
  if (record.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u { discard; }
  if (record.alpha_mode == OENGINE_MATERIAL_ALPHA_BLEND) { discard; }
  if (record.alpha_mode == OENGINE_MATERIAL_ALPHA_MASK &&
      record.base_color_factor_alpha < record.alpha_cutoff) { discard; }
}
`;

export const PACKED_CSM_COUNTER_WGSL = /* wgsl */ `
struct QueueHeaderRead {
  written: u32, attempted: u32, peak: u32, overflow: u32,
  fallback: u32, capacity: u32, rejected_cone: u32, rejected_hzb: u32,
}
struct SecondaryRasterWork {
  instance_record_index: u32, geometry_record_index: u32,
  meshlet_record_index: u32, local_triangle_index: u32,
  material_handle: u32, raster_flags: u32,
}
struct SecondaryRasterQueue { header: QueueHeaderRead, elements: array<SecondaryRasterWork> }
struct EvidenceParams { cascade_index: u32, atlas_pixels: u32, reserved0: u32, reserved1: u32 }
@group(0) @binding(0) var<storage, read> work: SecondaryRasterQueue;
@group(0) @binding(1) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: EvidenceParams;
const CASCADE0: u32 = 58u;
const ATLAS_PIXELS: u32 = 61u;
const ALPHA_WORK: u32 = 62u;
const OVERFLOW: u32 = 63u;
@compute @workgroup_size(64)
fn packed_csm_evidence(@builtin(local_invocation_index) lane: u32) {
  let count = min(work.header.written, work.header.capacity);
  if lane == 0u {
    atomicAdd(&counters[CASCADE0 + min(params.cascade_index, 2u)], count);
    atomicAdd(&counters[ATLAS_PIXELS], params.atlas_pixels);
    if work.header.overflow != 0u { atomicOr(&counters[OVERFLOW], 1u << params.cascade_index); }
  }
  var alpha = 0u;
  for (var index = lane; index < count; index += 64u) {
    alpha += select(0u, 1u,
      (work.elements[index].raster_flags & ${GPU_SECONDARY_RASTER_FLAGS.AlphaTested}u) != 0u);
  }
  if alpha != 0u { atomicAdd(&counters[ALPHA_WORK], alpha); }
}
`;

export const PACKED_CSM_PRODUCT_COUNTER_WGSL = /* wgsl */ `
struct ProductWorkHeaderRead {
  attempted_count: u32, written_count: u32, consumed_count: u32, capacity: u32,
  overflow_count: u32, generation: u32, invalid_count: u32, reserved: u32,
}
struct ProductRasterWork {
  instance_slot: u32, geometry_slot: u32, meshlet_slot: u32,
  material_slot_or_range: u32, packed_raster_flags: u32, packed_profile_lod: u32,
}
struct ProductWorkQueue { header: ProductWorkHeaderRead, elements: array<ProductRasterWork> }
struct EvidenceParams { cascade_index: u32, atlas_pixels: u32, reserved0: u32, reserved1: u32 }
@group(0) @binding(0) var<storage, read> work: ProductWorkQueue;
@group(0) @binding(1) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: EvidenceParams;
const CASCADE0: u32 = 58u;
const ATLAS_PIXELS: u32 = 61u;
const ALPHA_WORK: u32 = 62u;
const OVERFLOW: u32 = 63u;
@compute @workgroup_size(64)
fn packed_csm_product_evidence(@builtin(local_invocation_index) lane: u32) {
  let count = min(work.header.written_count, work.header.capacity);
  if lane == 0u {
    atomicAdd(&counters[CASCADE0 + min(params.cascade_index, 2u)], count);
    atomicAdd(&counters[ATLAS_PIXELS], params.atlas_pixels);
    if work.header.overflow_count != 0u { atomicOr(&counters[OVERFLOW], 1u << params.cascade_index); }
  }
  var alpha = 0u;
  for (var index = lane; index < count; index += 64u) {
    alpha += select(0u, 1u,
      (work.elements[index].packed_raster_flags & ${GPU_MESHLET_RASTER_FLAGS.AlphaTested}u) != 0u);
  }
  if alpha != 0u { atomicAdd(&counters[ALPHA_WORK], alpha); }
}
`;
