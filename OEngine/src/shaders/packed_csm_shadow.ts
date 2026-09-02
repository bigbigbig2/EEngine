import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_UV_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_SECONDARY_RASTER_FLAGS } from "../gpu/GpuSecondaryRasterAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

/** Depth-only SecondaryRasterWork consumer; alpha semantics match main Visibility. */
export const PACKED_CSM_SHADOW_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}

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
@group(0) @binding(8) var<storage, read> materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(9) var alpha_atlas: texture_2d_array<f32>;
@group(0) @binding(10) var high_resolution_alpha_atlas: texture_2d_array<f32>;

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
  let position_word = geometry.position_byte_offset / 4u +
    source_vertex * (geometry.position_stride / 4u);
  let local_position = vec3f(
    bitcast<f32>(vertex_data[position_word]),
    bitcast<f32>(vertex_data[position_word + 1u]),
    bitcast<f32>(vertex_data[position_word + 2u])
  );
  let uv0 = read_uv(&vertex_data, geometry.uv0_byte_offset, geometry.uv0_stride,
    geometry.uv0_format, source_vertex);
  let uv1 = read_uv(&vertex_data, geometry.uv1_byte_offset, geometry.uv1_stride,
    geometry.uv1_format, source_vertex);
  let uv2 = read_uv(&vertex_data, geometry.uv2_byte_offset, geometry.uv2_stride,
    geometry.uv2_format, source_vertex);
  var output: ShadowVertexOutput;
  output.position = shadow_camera.view_projection_matrix *
    instance.current_object_to_world * vec4f(local_position, 1.0);
  output.uv0 = select(vec2f(0.0), uv0.xy / uv0.z, uv0.z > 0.0);
  output.uv1 = select(vec2f(0.0), uv1.xy / uv1.z, uv1.z > 0.0);
  output.uv2 = select(vec2f(0.0), uv2.xy / uv2.z, uv2.z > 0.0);
  output.uv_valid_mask = select(0u, 1u, uv0.z > 0.0) |
    select(0u, 2u, uv1.z > 0.0) |
    select(0u, 4u, uv2.z > 0.0);
  output.material_handle = work.material_handle;
  let linear = instance.current_object_to_world;
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
  let high_resolution = (texture_ref & OENGINE_MATERIAL_HIGH_RESOLUTION_BIT) != 0u;
  let layer = i32(texture_ref & OENGINE_MATERIAL_TEXTURE_LAYER_MASK);
  let size = select(i32(textureDimensions(alpha_atlas).x),
    i32(textureDimensions(high_resolution_alpha_atlas).x), high_resolution);
  let pixel = vec2i(
    wrap_texel(x, sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size),
    wrap_texel(y, (sampler_class >> OENGINE_MATERIAL_SAMPLER_ADDRESS_V_BITS) &
      OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK, size)
  );
  if high_resolution {
    return textureLoad(high_resolution_alpha_atlas, pixel, layer, 0).a;
  }
  return textureLoad(alpha_atlas, pixel, layer, 0).a;
}
fn sample_alpha(texture_ref: u32, uv: vec2f, sampler_class: u32) -> f32 {
  let high_resolution = (texture_ref & OENGINE_MATERIAL_HIGH_RESOLUTION_BIT) != 0u;
  let size = select(f32(textureDimensions(alpha_atlas).x),
    f32(textureDimensions(high_resolution_alpha_atlas).x), high_resolution);
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
  let record = materials[input.material_handle];
  if (record.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u ||
    record.material_id != input.material_handle { return; }
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
      record.texture_ref != OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE &&
      (input.uv_valid_mask & uv_bit) != 0u {
      alpha *= sample_alpha(record.texture_ref,
        transform_uv(record, select(select(input.uv0, input.uv1, uv_set == 1u), input.uv2, uv_set == 2u)),
        record.sampler_class);
    }
    if alpha < record.alpha_cutoff { discard; }
  }
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
