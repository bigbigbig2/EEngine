import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_UV_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const PACKED_HIERARCHY_VISIBILITY_VERTICES_PER_TRIANGLE = 3;

/** Position-only OPAQUE Visibility consumer; no material or texture binding. */
export const PACKED_OPAQUE_VISIBILITY_RASTER_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_VISIBILITY_KEY_WGSL}

struct ExactQueueHeaderRead {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  rejected0: u32,
  rejected1: u32,
}
struct ExactRasterWork {
  instance_record_index: u32,
  geometry_record_index: u32,
  meshlet_record_index: u32,
  local_triangle_index: u32,
  material_handle: u32,
  raster_flags: u32,
}
struct ExactRasterWorkQueueRead {
  opaque_header: ExactQueueHeaderRead,
  mask_header: ExactQueueHeaderRead,
  elements: array<ExactRasterWork>,
}
struct ExactOpaqueVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) visibility_key: u32,
}
@group(0) @binding(0) var<uniform> opaque_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> opaque_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> opaque_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> opaque_meshlet_vertices: array<u32>;
@group(0) @binding(4) var<storage, read> opaque_meshlet_triangles: array<u32>;
@group(0) @binding(5) var<storage, read> opaque_vertex_data: array<u32>;
@group(0) @binding(6) var<storage, read> opaque_geometries: array<GpuGeometryRecord>;
@group(0) @binding(7) var<storage, read> opaque_work: ExactRasterWorkQueueRead;

fn opaque_read_u8(byte_offset: u32) -> u32 {
  let word = opaque_meshlet_triangles[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

@vertex
fn raster_opaque_exact(@builtin(vertex_index) vertex_index: u32) -> ExactOpaqueVertexOutput {
  let work_index = vertex_index / 3u;
  let corner_index = vertex_index % 3u;
  let work = opaque_work.elements[work_index];
  let instance = opaque_instances[work.instance_record_index];
  let geometry = opaque_geometries[work.geometry_record_index];
  let meshlet = opaque_meshlets[work.meshlet_record_index];
  let local_vertex = opaque_read_u8(
    meshlet.triangle_byte_offset + work.local_triangle_index * 3u + corner_index
  );
  let source_vertex = opaque_meshlet_vertices[meshlet.vertex_offset + local_vertex];
  let word = geometry.position_byte_offset / 4u +
    source_vertex * (geometry.position_stride / 4u);
  let local_position = vec3f(
    bitcast<f32>(opaque_vertex_data[word]),
    bitcast<f32>(opaque_vertex_data[word + 1u]),
    bitcast<f32>(opaque_vertex_data[word + 2u])
  );
  var output: ExactOpaqueVertexOutput;
  output.position = opaque_camera.view_projection_matrix *
    instance.current_object_to_world * vec4f(local_position, 1.0);
  output.visibility_key = oengine_visibility_key_try_encode(work_index).key;
  return output;
}

@fragment
fn write_opaque_visibility(
  @location(0) @interpolate(flat) visibility_key: u32
) -> @location(0) u32 {
  return visibility_key;
}
`;

/** Hardware Visibility consumer for exact-triangle RasterWork. */
export const PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}

struct R3QueueHeaderRead {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  _pad0: u32,
  _pad1: u32,
}

struct R3RasterWork {
  instance_record_index: u32,
  geometry_record_index: u32,
  meshlet_record_index: u32,
  local_triangle_index: u32,
  material_handle: u32,
  raster_flags: u32,
}

struct R3RasterWorkQueueRead {
  opaque_header: R3QueueHeaderRead,
  mask_header: R3QueueHeaderRead,
  elements: array<R3RasterWork>,
}

struct R3VisibilityVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) instance_record_index: u32,
  @location(1) @interpolate(flat) encoded_triangle: u32,
  @location(2) @interpolate(flat) visibility_key: u32,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) uv2: vec2f,
  @location(6) @interpolate(flat) uv_valid_mask: u32,
  @location(7) @interpolate(flat) material_handle: u32,
  @location(8) @interpolate(flat) mirrored: u32,
}

@group(0) @binding(0) var<uniform> r3_raster_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> r3_raster_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> r3_raster_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> r3_raster_meshlet_vertices: array<u32>;
@group(0) @binding(4) var<storage, read> r3_raster_meshlet_triangles: array<u32>;
@group(0) @binding(5) var<storage, read> r3_raster_vertex_data: array<u32>;
@group(0) @binding(6) var<storage, read> r3_raster_geometries: array<GpuGeometryRecord>;
@group(0) @binding(7) var<storage, read> r3_raster_work: R3RasterWorkQueueRead;
@group(0) @binding(8) var<storage, read> r4_material_visibility: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(9) var r4_alpha_atlas: texture_2d_array<f32>;
@group(0) @binding(10) var r4_high_resolution_alpha_atlas: texture_2d_array<f32>;

fn r3_read_u8(words: ptr<storage, array<u32>, read>, byte_offset: u32) -> u32 {
  let word = (*words)[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

fn r4_read_u16(words: ptr<storage, array<u32>, read>, byte_offset: u32) -> u32 {
  return r3_read_u8(words, byte_offset) |
    (r3_read_u8(words, byte_offset + 1u) << 8u);
}

fn r4_read_uv(
  words: ptr<storage, array<u32>, read>,
  byte_offset: u32,
  stride: u32,
  format: u32,
  source_vertex: u32
) -> vec3f {
  let offset = byte_offset + source_vertex * stride;
  if format == ${GPU_UV_FORMAT.Float32x2}u {
    let word = offset >> 2u;
    return vec3f(
      bitcast<f32>((*words)[word]),
      bitcast<f32>((*words)[word + 1u]),
      1.0
    );
  }
  if format == ${GPU_UV_FORMAT.Unorm8x2}u {
    return vec3f(
      f32(r3_read_u8(words, offset)),
      f32(r3_read_u8(words, offset + 1u)),
      255.0
    );
  }
  if format == ${GPU_UV_FORMAT.Unorm16x2}u {
    return vec3f(
      f32(r4_read_u16(words, offset)),
      f32(r4_read_u16(words, offset + 2u)),
      65535.0
    );
  }
  return vec3f(0.0);
}

@vertex
fn raster_hierarchy_meshlets(
  @builtin(vertex_index) vertex_index: u32
) -> R3VisibilityVertexOutput {
  let work_index = vertex_index / 3u;
  let triangle_corner = vertex_index % 3u;
  let work = r3_raster_work.elements[work_index];
  let instance = r3_raster_instances[work.instance_record_index];
  let geometry = r3_raster_geometries[work.geometry_record_index];
  let meshlet = r3_raster_meshlets[work.meshlet_record_index];
  let corner = work.local_triangle_index * 3u + triangle_corner;
  let local_vertex = r3_read_u8(
    &r3_raster_meshlet_triangles,
    meshlet.triangle_byte_offset + corner
  );
  let source_vertex = r3_raster_meshlet_vertices[
    meshlet.vertex_offset + local_vertex
  ];
  let position_word = geometry.position_byte_offset / 4u
    + source_vertex * (geometry.position_stride / 4u);
  let local_position = vec3f(
    bitcast<f32>(r3_raster_vertex_data[position_word]),
    bitcast<f32>(r3_raster_vertex_data[position_word + 1u]),
    bitcast<f32>(r3_raster_vertex_data[position_word + 2u])
  );
  let uv0 = r4_read_uv(
    &r3_raster_vertex_data,
    geometry.uv0_byte_offset,
    geometry.uv0_stride,
    geometry.uv0_format,
    source_vertex
  );
  let uv1 = r4_read_uv(
    &r3_raster_vertex_data,
    geometry.uv1_byte_offset,
    geometry.uv1_stride,
    geometry.uv1_format,
    source_vertex
  );
  let uv2 = r4_read_uv(
    &r3_raster_vertex_data,
    geometry.uv2_byte_offset,
    geometry.uv2_stride,
    geometry.uv2_format,
    source_vertex
  );
  var output: R3VisibilityVertexOutput;
  output.position = r3_raster_camera.view_projection_matrix
    * instance.current_object_to_world
    * vec4f(local_position, 1.0);
  output.instance_record_index = work.instance_record_index;
  output.encoded_triangle =
    (work.meshlet_record_index << 8u) | work.local_triangle_index;
  output.visibility_key = oengine_visibility_key_try_encode(work_index).key;
  output.uv0 = select(vec2f(0.0), uv0.xy / uv0.z, uv0.z > 0.0);
  output.uv1 = select(vec2f(0.0), uv1.xy / uv1.z, uv1.z > 0.0);
  output.uv2 = select(vec2f(0.0), uv2.xy / uv2.z, uv2.z > 0.0);
  output.uv_valid_mask = select(0u, 1u, uv0.z > 0.0) |
    select(0u, 2u, uv1.z > 0.0) |
    select(0u, 4u, uv2.z > 0.0);
  output.material_handle = work.material_handle;
  let linear = instance.current_object_to_world;
  let determinant = dot(linear[0].xyz, cross(linear[1].xyz, linear[2].xyz));
  output.mirrored = select(0u, 1u, determinant < 0.0);
  return output;
}

fn r4_wrap_texel(value: i32, mode: u32, size: i32) -> i32 {
  if mode == 0u {
    return clamp(value, 0i, size - 1i);
  }
  if mode == 2u {
    let period = size * 2i;
    let wrapped = ((value % period) + period) % period;
    return select(wrapped, period - 1i - wrapped, wrapped >= size);
  }
  return ((value % size) + size) % size;
}

fn r4_alpha_texel(texture_ref: u32, x: i32, y: i32, sampler_class: u32) -> f32 {
  let address_u = sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK;
  let address_v = (sampler_class >> OENGINE_MATERIAL_SAMPLER_ADDRESS_V_BITS) &
    OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK;
  let high_resolution = (texture_ref & OENGINE_MATERIAL_HIGH_RESOLUTION_BIT) != 0u;
  let layer = i32(texture_ref & OENGINE_MATERIAL_TEXTURE_LAYER_MASK);
  let size = select(
    i32(textureDimensions(r4_alpha_atlas).x),
    i32(textureDimensions(r4_high_resolution_alpha_atlas).x),
    high_resolution
  );
  let pixel = vec2i(
    r4_wrap_texel(x, address_u, size),
    r4_wrap_texel(y, address_v, size)
  );
  if high_resolution {
    return textureLoad(r4_high_resolution_alpha_atlas, pixel, layer, 0).a;
  }
  return textureLoad(r4_alpha_atlas, pixel, layer, 0).a;
}

fn r4_sample_alpha(texture_ref: u32, uv: vec2f, sampler_class: u32) -> f32 {
  let high_resolution = (texture_ref & OENGINE_MATERIAL_HIGH_RESOLUTION_BIT) != 0u;
  let size = select(
    f32(textureDimensions(r4_alpha_atlas).x),
    f32(textureDimensions(r4_high_resolution_alpha_atlas).x),
    high_resolution
  );
  let position = uv * size - 0.5;
  let base = vec2i(floor(position));
  if (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) == 0u {
    let nearest = vec2i(floor(uv * size));
    return r4_alpha_texel(texture_ref, nearest.x, nearest.y, sampler_class);
  }
  let fraction = fract(position);
  let a = r4_alpha_texel(texture_ref, base.x, base.y, sampler_class);
  let b = r4_alpha_texel(texture_ref, base.x + 1i, base.y, sampler_class);
  let c = r4_alpha_texel(texture_ref, base.x, base.y + 1i, sampler_class);
  let d = r4_alpha_texel(texture_ref, base.x + 1i, base.y + 1i, sampler_class);
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}

fn r4_transform_uv(record: OEngineMaterialVisibilityRecord, uv: vec2f) -> vec2f {
  let scaled = uv * record.uv_offset_scale.zw;
  let rotated = vec2f(
    record.uv_rotation.x * scaled.x - record.uv_rotation.y * scaled.y,
    record.uv_rotation.y * scaled.x + record.uv_rotation.x * scaled.y
  );
  return record.uv_offset_scale.xy + rotated;
}

@fragment
fn write_hierarchy_visibility(
  @location(0) @interpolate(flat) instance_record_index: u32,
  @location(1) @interpolate(flat) encoded_triangle: u32,
  @location(2) @interpolate(flat) visibility_key: u32,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) uv2: vec2f,
  @location(6) @interpolate(flat) uv_valid_mask: u32,
  @location(7) @interpolate(flat) material_handle: u32,
  @location(8) @interpolate(flat) mirrored: u32,
  @builtin(front_facing) front_facing: bool
) -> @location(0) u32 {
  var record = OEngineMaterialVisibilityRecord(
    material_handle,
    OENGINE_MATERIAL_ALPHA_OPAQUE,
    0u,
    OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE,
    1.0,
    0.5,
    0u,
    0u,
    vec4f(0.0, 0.0, 1.0, 1.0),
    vec4f(1.0, 0.0, 0.0, 0.0),
    vec4f(1.0),
    vec4f(0.0, 1.0, 1.0, 1.0),
    vec4f(0.0, 0.0, 0.0, 1.0),
    OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE,
    OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE,
    OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE,
    0u,
    vec4f(0.0, 0.0, 1.0, 1.0),
    vec4f(1.0, 0.0, 0.0, 0.0),
    vec4f(0.0, 0.0, 1.0, 1.0),
    vec4f(1.0, 0.0, 0.0, 0.0),
    vec4f(0.0, 0.0, 1.0, 1.0),
    vec4f(1.0, 0.0, 0.0, 0.0)
  );
  if material_handle < arrayLength(&r4_material_visibility) {
    let candidate = r4_material_visibility[material_handle];
    if (candidate.flags & OENGINE_MATERIAL_VISIBILITY_VALID) != 0u &&
      candidate.material_id == material_handle {
      record = candidate;
    }
  }
  let corrected_front_facing = front_facing != (mirrored != 0u);
  if (record.flags & OENGINE_MATERIAL_VISIBILITY_DOUBLE_SIDED) == 0u &&
    !corrected_front_facing {
    discard;
  }
  if record.alpha_mode == OENGINE_MATERIAL_ALPHA_BLEND {
    discard;
  }
  if record.alpha_mode == OENGINE_MATERIAL_ALPHA_MASK {
    var alpha = record.base_color_factor_alpha;
    let uv_set = record.texture_uv_sets & 0xffu;
    let uv_bit = select(0u, 1u << uv_set, uv_set < 3u);
    if (record.flags & OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE) != 0u &&
      record.texture_ref != OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE &&
      (uv_valid_mask & uv_bit) != 0u {
      let uv = select(select(uv0, uv1, uv_set == 1u), uv2, uv_set == 2u);
      alpha *= r4_sample_alpha(
        record.texture_ref,
        r4_transform_uv(record, uv),
        record.sampler_class
      );
    }
    if alpha < record.alpha_cutoff {
      discard;
    }
  }
  return visibility_key;
}
`;
