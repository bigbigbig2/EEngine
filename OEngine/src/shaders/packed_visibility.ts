import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_UV_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import {
  GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE
} from "../gpu/GpuMaterialVisibilityTable.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const PACKED_HIERARCHY_VISIBILITY_FIXED_VERTEX_COUNT = 384;

/** R4 Hardware Visibility consumer for VisibleCluster -> RasterWork. */
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

struct R3VisibleClusterRecord {
  instance_record_index: u32,
  geometry_record_index: u32,
  cluster_record_index: u32,
  material_handle: u32,
  raster_flags: u32,
}

struct R3VisibleClusterQueueRead {
  header: R3QueueHeaderRead,
  elements: array<R3VisibleClusterRecord>,
}

struct R3RasterWork {
  visible_cluster_slot: u32,
  meshlet_record_index: u32,
  raster_flags: u32,
}

struct R3RasterWorkQueueRead {
  header: R3QueueHeaderRead,
  elements: array<R3RasterWork>,
}

struct R3VisibilityVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) instance_record_index: u32,
  @location(1) @interpolate(flat) encoded_triangle: u32,
  @location(2) @interpolate(flat) visibility_key: u32,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) @interpolate(flat) uv_valid_mask: u32,
  @location(6) @interpolate(flat) material_handle: u32,
  @location(7) @interpolate(flat) mirrored: u32,
}

@group(0) @binding(0) var<uniform> r3_raster_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> r3_raster_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> r3_raster_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> r3_raster_meshlet_vertices: array<u32>;
@group(0) @binding(4) var<storage, read> r3_raster_meshlet_triangles: array<u32>;
@group(0) @binding(5) var<storage, read> r3_raster_vertex_data: array<u32>;
@group(0) @binding(6) var<storage, read> r3_raster_geometries: array<GpuGeometryRecord>;
@group(0) @binding(7) var<storage, read> r3_visible_clusters: R3VisibleClusterQueueRead;
@group(0) @binding(8) var<storage, read> r3_raster_work: R3RasterWorkQueueRead;
@group(0) @binding(9) var<storage, read> r4_material_visibility: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(10) var r4_alpha_atlas: texture_2d_array<f32>;

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
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) work_index: u32
) -> R3VisibilityVertexOutput {
  let work = r3_raster_work.elements[work_index];
  let visible = r3_visible_clusters.elements[work.visible_cluster_slot];
  let instance = r3_raster_instances[visible.instance_record_index];
  let geometry = r3_raster_geometries[visible.geometry_record_index];
  let meshlet = r3_raster_meshlets[work.meshlet_record_index];
  let last_corner = max(meshlet.triangle_count * 3u, 1u) - 1u;
  let corner = min(vertex_index, last_corner);
  let triangle_index = corner / 3u;
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
  var output: R3VisibilityVertexOutput;
  output.position = r3_raster_camera.view_projection_matrix
    * instance.current_object_to_world
    * vec4f(local_position, 1.0);
  output.instance_record_index = visible.instance_record_index;
  output.encoded_triangle = (work.meshlet_record_index << 8u) | triangle_index;
  output.visibility_key = oengine_visibility_key_try_encode(
    work_index,
    triangle_index
  ).key;
  output.uv0 = select(vec2f(0.0), uv0.xy / uv0.z, uv0.z > 0.0);
  output.uv1 = select(vec2f(0.0), uv1.xy / uv1.z, uv1.z > 0.0);
  output.uv_valid_mask = select(0u, 1u, uv0.z > 0.0) |
    select(0u, 2u, uv1.z > 0.0);
  output.material_handle = visible.material_handle;
  let linear = instance.current_object_to_world;
  let determinant = dot(linear[0].xyz, cross(linear[1].xyz, linear[2].xyz));
  output.mirrored = select(0u, 1u, determinant < 0.0);
  return output;
}

fn r4_wrap_texel(value: i32, mode: u32) -> u32 {
  const size = ${GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE}i;
  if mode == 0u {
    return u32(clamp(value, 0i, size - 1i));
  }
  if mode == 2u {
    const period = size * 2i;
    let wrapped = ((value % period) + period) % period;
    return u32(select(wrapped, period - 1i - wrapped, wrapped >= size));
  }
  return u32(((value % size) + size) % size);
}

fn r4_alpha_texel(texture_ref: u32, x: i32, y: i32, sampler_class: u32) -> f32 {
  let address_u = sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK;
  let address_v = (sampler_class >> OENGINE_MATERIAL_SAMPLER_ADDRESS_V_BITS) &
    OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK;
  let pixel = vec2u(
    r4_wrap_texel(x, address_u),
    r4_wrap_texel(y, address_v)
  );
  return textureLoad(r4_alpha_atlas, vec2i(pixel), i32(texture_ref), 0).a;
}

fn r4_sample_alpha(texture_ref: u32, uv: vec2f, sampler_class: u32) -> f32 {
  let position = uv * ${GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE}.0 - 0.5;
  let base = vec2i(floor(position));
  if (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) == 0u {
    let nearest = vec2i(floor(uv * ${GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE}.0));
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
  @location(5) @interpolate(flat) uv_valid_mask: u32,
  @location(6) @interpolate(flat) material_handle: u32,
  @location(7) @interpolate(flat) mirrored: u32,
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
    0u
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
    let uv_bit = select(0u, 1u << record.uv_set, record.uv_set < 2u);
    if (record.flags & OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE) != 0u &&
      record.texture_ref != OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE &&
      (uv_valid_mask & uv_bit) != 0u {
      let uv = select(uv0, uv1, record.uv_set == 1u);
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
