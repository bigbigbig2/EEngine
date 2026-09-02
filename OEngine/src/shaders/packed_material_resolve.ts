import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../assets/GeometryAssetPackage.js";
import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_POSITION_FORMAT,
  GPU_UV_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_SURFACE_ABI_WGSL } from "../gpu/GpuSurfaceAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import {
  GPU_RASTER_WORK_SCHEMA
} from "../gpu/GpuWorkGenerationAbi.js";
import { GPU_VIEW_TYPE } from "../render/ViewManager.js";
import { GBUFFER_ENCODE_WGSL } from "./gbuffer_encode.js";

export const PACKED_MATERIAL_RESOLVE_WGSL = /* wgsl */ `
${GPU_VIEW_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_SURFACE_ABI_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_RASTER_WORK_SCHEMA.wgsl}
${GBUFFER_ENCODE_WGSL}

const STREAM_DESCRIPTOR_WORDS: u32 = 32u;

struct R4ResolveQueueHeaderRead {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  rejected_cone: u32,
  rejected_hzb: u32,
}

struct R4ResolveRasterWorkQueue {
  opaque_header: R4ResolveQueueHeaderRead,
  mask_header: R4ResolveQueueHeaderRead,
  elements: array<OEngineRasterWork>,
}

@group(0) @binding(0) var visibility_keys: texture_2d<u32>;
@group(0) @binding(1) var<uniform> view: PipelineCacheKey;
@group(0) @binding(2) var<uniform> previous_view_projection: mat4x4f;
@group(0) @binding(3) var material_textures: texture_2d_array<f32>;
@group(0) @binding(4) var sampler_repeat_linear: sampler;
@group(0) @binding(5) var sampler_clamp_linear: sampler;
@group(0) @binding(6) var sampler_mirror_linear: sampler;
@group(0) @binding(7) var sampler_repeat_nearest: sampler;
@group(0) @binding(8) var sampler_clamp_nearest: sampler;
@group(0) @binding(9) var sampler_mirror_nearest: sampler;
@group(0) @binding(10) var<storage, read> materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(11) var high_resolution_material_textures: texture_2d_array<f32>;

@group(1) @binding(0) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(1) @binding(1) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(1) @binding(2) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(1) @binding(3) var<storage, read> meshlet_vertices: array<u32>;
@group(1) @binding(4) var<storage, read> meshlet_triangles: array<u32>;
@group(1) @binding(5) var<storage, read> stream_descriptors: array<u32>;
@group(1) @binding(6) var<storage, read> vertex_data: array<u32>;
@group(1) @binding(7) var<storage, read> raster_work: R4ResolveRasterWorkQueue;

fn read_u8(byte_offset: u32) -> u32 {
  let word = vertex_data[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

fn read_meshlet_u8(byte_offset: u32) -> u32 {
  let word = meshlet_triangles[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

fn read_u16(byte_offset: u32) -> u32 {
  return read_u8(byte_offset) | (read_u8(byte_offset + 1u) << 8u);
}

fn sign_extend(value: u32, bits: u32) -> i32 {
  let shift = 32u - bits;
  return bitcast<i32>(value << shift) >> shift;
}

fn stream_component(byte_offset: u32, data_type: u32, normalized: bool) -> f32 {
  if data_type == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.int8}u {
    let value = sign_extend(read_u8(byte_offset), 8u);
    return select(f32(value), max(f32(value) / 127.0, -1.0), normalized);
  }
  if data_type == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.uint8}u {
    let value = read_u8(byte_offset);
    return select(f32(value), f32(value) / 255.0, normalized);
  }
  if data_type == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.int16}u {
    let value = sign_extend(read_u16(byte_offset), 16u);
    return select(f32(value), max(f32(value) / 32767.0, -1.0), normalized);
  }
  if data_type == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.uint16}u {
    let value = read_u16(byte_offset);
    return select(f32(value), f32(value) / 65535.0, normalized);
  }
  let word = vertex_data[byte_offset >> 2u];
  if data_type == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.int32}u {
    let value = bitcast<i32>(word);
    return select(f32(value), max(f32(value) / 2147483647.0, -1.0), normalized);
  }
  if data_type == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.uint32}u {
    return select(f32(word), f32(word) / 4294967295.0, normalized);
  }
  return bitcast<f32>(word);
}

fn component_bytes(data_type: u32) -> u32 {
  if data_type <= 2u { return 1u; }
  if data_type <= 4u { return 2u; }
  return 4u;
}

fn read_stream4_from_descriptor(
  descriptor: u32,
  vertex: u32,
  fallback: vec4f
) -> vec4f {
  if descriptor == 0xffffffffu { return fallback; }
  let base = descriptor * STREAM_DESCRIPTOR_WORDS;
  let data_offset = stream_descriptors[base + 8u];
  let stride = stream_descriptors[base + 10u];
  let component_count = stream_descriptors[base + 12u];
  let data_type = stream_descriptors[base + 13u];
  let normalized = stream_descriptors[base + 14u] != 0u;
  let bytes = component_bytes(data_type);
  var result = fallback;
  for (var component = 0u; component < min(component_count, 4u); component++) {
    result[component] = stream_component(
      data_offset + vertex * stride + component * bytes,
      data_type,
      normalized
    );
  }
  return result;
}

fn read_position_direct(geometry: GpuGeometryRecord, vertex: u32) -> vec3f {
  let offset = geometry.position_byte_offset + vertex * geometry.position_stride;
  if geometry.position_format == ${GPU_POSITION_FORMAT.Float32x3}u ||
      geometry.position_format == ${GPU_POSITION_FORMAT.Float32x4}u {
    return vec3f(
      bitcast<f32>(vertex_data[offset >> 2u]),
      bitcast<f32>(vertex_data[(offset >> 2u) + 1u]),
      bitcast<f32>(vertex_data[(offset >> 2u) + 2u])
    );
  }
  return vec3f(0.0);
}

fn read_uv_direct(geometry: GpuGeometryRecord, uv_set: u32, vertex: u32) -> vec2f {
  var offset = geometry.uv0_byte_offset;
  var stride = geometry.uv0_stride;
  var format = geometry.uv0_format;
  if uv_set == 1u {
    offset = geometry.uv1_byte_offset;
    stride = geometry.uv1_stride;
    format = geometry.uv1_format;
  }
  if uv_set == 2u {
    offset = geometry.uv2_byte_offset;
    stride = geometry.uv2_stride;
    format = geometry.uv2_format;
  }
  offset += vertex * stride;
  if format == ${GPU_UV_FORMAT.Float32x2}u {
    return vec2f(
      bitcast<f32>(vertex_data[offset >> 2u]),
      bitcast<f32>(vertex_data[(offset >> 2u) + 1u])
    );
  }
  if format == ${GPU_UV_FORMAT.Unorm8x2}u {
    return vec2f(read_u8(offset), read_u8(offset + 1u)) / 255.0;
  }
  if format == ${GPU_UV_FORMAT.Unorm16x2}u {
    return vec2f(read_u16(offset), read_u16(offset + 2u)) / 65535.0;
  }
  return vec2f(0.0);
}

fn triangle_source_vertices(meshlet: GpuMeshletRecord, triangle: u32) -> vec3u {
  let byte_offset = meshlet.triangle_byte_offset + triangle * 3u;
  return vec3u(
    meshlet_vertices[meshlet.vertex_offset + read_meshlet_u8(byte_offset)],
    meshlet_vertices[meshlet.vertex_offset + read_meshlet_u8(byte_offset + 1u)],
    meshlet_vertices[meshlet.vertex_offset + read_meshlet_u8(byte_offset + 2u)]
  );
}

fn projected_pixel(projected: vec4f) -> vec2f {
  // GPUViewContext.projection_matrix already contains the viewport transform.
  return projected.xy / projected.w;
}

struct PerspectiveBarycentric {
  weights: vec3f,
  ddx: vec3f,
  ddy: vec3f,
  valid: u32,
}

fn perspective_barycentric_with_derivatives(
  pixel: vec2f,
  projected0: vec4f,
  projected1: vec4f,
  projected2: vec4f
) -> PerspectiveBarycentric {
  var output: PerspectiveBarycentric;
  output.weights = vec3f(1.0, 0.0, 0.0);
  output.ddx = vec3f(0.0);
  output.ddy = vec3f(0.0);
  output.valid = 0u;
  let p0 = projected_pixel(projected0);
  let p1 = projected_pixel(projected1);
  let p2 = projected_pixel(projected2);
  let denominator = (p1.y - p2.y) * (p0.x - p2.x)
    + (p2.x - p1.x) * (p0.y - p2.y);
  if abs(denominator) < 1e-8 { return output; }
  let l0 = ((p1.y - p2.y) * (pixel.x - p2.x)
    + (p2.x - p1.x) * (pixel.y - p2.y)) / denominator;
  let l1 = ((p2.y - p0.y) * (pixel.x - p2.x)
    + (p0.x - p2.x) * (pixel.y - p2.y)) / denominator;
  let screen = vec3f(l0, l1, 1.0 - l0 - l1);
  let screen_ddx = vec3f(
    p1.y - p2.y,
    p2.y - p0.y,
    p0.y - p1.y
  ) / denominator;
  let screen_ddy = vec3f(
    p2.x - p1.x,
    p0.x - p2.x,
    p1.x - p0.x
  ) / denominator;
  let reciprocal_w = 1.0 / vec3f(projected0.w, projected1.w, projected2.w);
  let weighted = screen * reciprocal_w;
  let weighted_sum = dot(weighted, vec3f(1.0));
  if abs(weighted_sum) < 1e-8 { return output; }
  let weighted_ddx = screen_ddx * reciprocal_w;
  let weighted_ddy = screen_ddy * reciprocal_w;
  let sum_ddx = dot(weighted_ddx, vec3f(1.0));
  let sum_ddy = dot(weighted_ddy, vec3f(1.0));
  let inverse_sum = 1.0 / weighted_sum;
  let inverse_sum_squared = inverse_sum * inverse_sum;
  output.weights = weighted * inverse_sum;
  output.ddx = (weighted_ddx * weighted_sum - weighted * sum_ddx) * inverse_sum_squared;
  output.ddy = (weighted_ddy * weighted_sum - weighted * sum_ddy) * inverse_sum_squared;
  output.valid = 1u;
  return output;
}

fn safe_normalize(value: vec3f, fallback: vec3f) -> vec3f {
  let length_squared = dot(value, value);
  if length_squared <= 1e-16 { return fallback; }
  return value * inverseSqrt(length_squared);
}

struct ObjectTransformFrame {
  normal_matrix: mat3x3f,
  tangent_matrix: mat3x3f,
  orientation: f32,
}

fn object_transform_frame(matrix: mat4x4f) -> ObjectTransformFrame {
  var output: ObjectTransformFrame;
  output.tangent_matrix = mat3x3f(matrix[0].xyz, matrix[1].xyz, matrix[2].xyz);
  let linear_determinant = dot(matrix[0].xyz, cross(matrix[1].xyz, matrix[2].xyz));
  output.orientation = select(1.0, -1.0, linear_determinant < 0.0);
  if abs(linear_determinant) <= 1e-12 {
    output.normal_matrix = mat3x3f(
      vec3f(1.0, 0.0, 0.0),
      vec3f(0.0, 1.0, 0.0),
      vec3f(0.0, 0.0, 1.0)
    );
    output.tangent_matrix = output.normal_matrix;
    output.orientation = 1.0;
    return output;
  }
  let cofactor = mat3x3f(
    cross(matrix[1].xyz, matrix[2].xyz),
    cross(matrix[2].xyz, matrix[0].xyz),
    cross(matrix[0].xyz, matrix[1].xyz)
  );
  output.normal_matrix = cofactor * output.orientation;
  return output;
}

@group(0) @binding(12) var<storage, read> shade_work: array<u32>;
override OENGINE_ACTIVE_KERNEL_CLASS: u32 = OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR;
override OENGINE_VELOCITY_ENABLED: bool = true;

@vertex
fn packed_material_vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  let linear_pixel = shade_work[vertex_index];
  let pixel = vec2f(
    f32(linear_pixel % view.width) + 0.5,
    f32(linear_pixel / view.width) + 0.5
  );
  let ndc = vec2f(
    pixel.x / f32(view.width) * 2.0 - 1.0,
    1.0 - pixel.y / f32(view.height) * 2.0
  );
  return vec4f(ndc, 0.0, 1.0);
}

fn material_sampler_class(material: OEngineMaterialVisibilityRecord, slot: u32) -> u32 {
  if slot == 0u { return material.sampler_class; }
  return (material.texture_sampler_classes >> ((slot - 1u) * 8u)) & 0xffu;
}

fn sample_material_texture(
  texture_ref: u32,
  sampler_class: u32,
  uv: vec2f,
  uv_dx: vec2f,
  uv_dy: vec2f,
  fallback: vec4f
) -> vec4f {
  if texture_ref == OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE {
    return fallback;
  }
  let high_resolution = (texture_ref & OENGINE_MATERIAL_HIGH_RESOLUTION_BIT) != 0u;
  let layer = i32(texture_ref & OENGINE_MATERIAL_TEXTURE_LAYER_MASK);
  let address = sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK;
  let linear = (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) != 0u;
  if high_resolution {
    if linear {
      if address == 0u {
        return textureSampleGrad(high_resolution_material_textures, sampler_clamp_linear, uv, layer, uv_dx, uv_dy);
      }
      if address == 2u {
        return textureSampleGrad(high_resolution_material_textures, sampler_mirror_linear, uv, layer, uv_dx, uv_dy);
      }
      return textureSampleGrad(high_resolution_material_textures, sampler_repeat_linear, uv, layer, uv_dx, uv_dy);
    }
    if address == 0u {
      return textureSampleGrad(high_resolution_material_textures, sampler_clamp_nearest, uv, layer, uv_dx, uv_dy);
    }
    if address == 2u {
      return textureSampleGrad(high_resolution_material_textures, sampler_mirror_nearest, uv, layer, uv_dx, uv_dy);
    }
    return textureSampleGrad(high_resolution_material_textures, sampler_repeat_nearest, uv, layer, uv_dx, uv_dy);
  }
  if linear {
    if address == 0u {
      return textureSampleGrad(material_textures, sampler_clamp_linear, uv, layer, uv_dx, uv_dy);
    }
    if address == 2u {
      return textureSampleGrad(material_textures, sampler_mirror_linear, uv, layer, uv_dx, uv_dy);
    }
    return textureSampleGrad(material_textures, sampler_repeat_linear, uv, layer, uv_dx, uv_dy);
  }
  if address == 0u {
    return textureSampleGrad(material_textures, sampler_clamp_nearest, uv, layer, uv_dx, uv_dy);
  }
  if address == 2u {
    return textureSampleGrad(material_textures, sampler_mirror_nearest, uv, layer, uv_dx, uv_dy);
  }
  return textureSampleGrad(material_textures, sampler_repeat_nearest, uv, layer, uv_dx, uv_dy);
}

fn material_uv_set(material: OEngineMaterialVisibilityRecord, slot: u32) -> u32 {
  return (material.texture_uv_sets >> (slot * 8u)) & 0xffu;
}

fn material_uv_offset_scale(material: OEngineMaterialVisibilityRecord, slot: u32) -> vec4f {
  if slot == 1u { return material.normal_uv_offset_scale; }
  if slot == 2u { return material.orm_uv_offset_scale; }
  if slot == 3u { return material.emissive_uv_offset_scale; }
  return material.uv_offset_scale;
}

fn material_uv_rotation(material: OEngineMaterialVisibilityRecord, slot: u32) -> vec4f {
  if slot == 1u { return material.normal_uv_rotation; }
  if slot == 2u { return material.orm_uv_rotation; }
  if slot == 3u { return material.emissive_uv_rotation; }
  return material.uv_rotation;
}

fn transform_material_uv(material: OEngineMaterialVisibilityRecord, slot: u32, uv: vec2f) -> vec2f {
  let offset_scale = material_uv_offset_scale(material, slot);
  let rotation = material_uv_rotation(material, slot);
  let scaled = uv * offset_scale.zw;
  return offset_scale.xy + vec2f(
    rotation.x * scaled.x - rotation.y * scaled.y,
    rotation.y * scaled.x + rotation.x * scaled.y
  );
}

fn transform_material_gradient(material: OEngineMaterialVisibilityRecord, slot: u32, gradient: vec2f) -> vec2f {
  let offset_scale = material_uv_offset_scale(material, slot);
  let rotation = material_uv_rotation(material, slot);
  let scaled = gradient * offset_scale.zw;
  return vec2f(
    rotation.x * scaled.x - rotation.y * scaled.y,
    rotation.y * scaled.x + rotation.x * scaled.y
  );
}

struct ReconstructedMaterialUv {
  uv: vec2f,
  ddx: vec2f,
  ddy: vec2f,
}

fn reconstruct_material_uv(
  material: OEngineMaterialVisibilityRecord,
  slot: u32,
  geometry: GpuGeometryRecord,
  vertices: vec3u,
  bary: PerspectiveBarycentric
) -> ReconstructedMaterialUv {
  let uv_set = material_uv_set(material, slot);
  let value0 = read_uv_direct(geometry, uv_set, vertices.x);
  let value1 = read_uv_direct(geometry, uv_set, vertices.y);
  let value2 = read_uv_direct(geometry, uv_set, vertices.z);
  let reconstructed = value0 * bary.weights.x + value1 * bary.weights.y + value2 * bary.weights.z;
  let reconstructed_dx = (value0 * bary.ddx.x + value1 * bary.ddx.y + value2 * bary.ddx.z) / view.upscale_ratio.x;
  let reconstructed_dy = (value0 * bary.ddy.x + value1 * bary.ddy.y + value2 * bary.ddy.z) / view.upscale_ratio.y;
  return ReconstructedMaterialUv(
    transform_material_uv(material, slot, reconstructed),
    transform_material_gradient(material, slot, reconstructed_dx),
    transform_material_gradient(material, slot, reconstructed_dy)
  );
}

struct PackedMaterialOutput {
  @location(0) pbr: vec2f,
  @location(1) normal: vec4u,
  @location(2) albedo: vec4f,
  @location(3) emissive: u32,
  @location(4) velocity: vec2f,
  @location(5) metadata: u32,
}

@fragment
fn packed_material_fs(@builtin(position) position: vec4f) -> PackedMaterialOutput {
  let pixel = vec2i(position.xy);
  let key = textureLoad(visibility_keys, pixel, 0).r;
  if !oengine_visibility_key_is_valid(key) { discard; }
  let raster_slot = oengine_visibility_key_raster_work_slot(key);
  let opaque_written = min(
    raster_work.opaque_header.written,
    raster_work.opaque_header.capacity
  );
  let mask_written = min(
    raster_work.mask_header.written,
    raster_work.mask_header.capacity
  );
  let valid_opaque = raster_slot < opaque_written;
  let valid_mask = raster_slot >= raster_work.opaque_header.capacity &&
    raster_slot - raster_work.opaque_header.capacity < mask_written;
  if !valid_opaque && !valid_mask { discard; }
  let work = raster_work.elements[raster_slot];
  if work.instance_record_index >= arrayLength(&instances) ||
    work.geometry_record_index >= arrayLength(&geometries) ||
    work.meshlet_record_index >= arrayLength(&meshlets) ||
    work.material_handle >= arrayLength(&materials) {
    discard;
  }
  let instance = instances[work.instance_record_index];
  let geometry = geometries[work.geometry_record_index];
  let meshlet = meshlets[work.meshlet_record_index];
  if !oengine_instance_active(instance) ||
    instance.geometry_record_index != work.geometry_record_index ||
    instance.material_handle != work.material_handle ||
    work.meshlet_record_index < geometry.meshlet_begin ||
    work.meshlet_record_index - geometry.meshlet_begin >= geometry.meshlet_count {
    discard;
  }
  let triangle_index = work.local_triangle_index;
  if triangle_index >= meshlet.triangle_count { discard; }
  let material_info = materials[work.material_handle];
  if (material_info.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u {
    discard;
  }
  if material_info.kernel_class != OENGINE_ACTIVE_KERNEL_CLASS { discard; }
  let vertices = triangle_source_vertices(meshlet, triangle_index);
  let normal_descriptor = geometry.normal_descriptor;
  let tangent_descriptor = geometry.tangent_descriptor;
  let color_descriptor = geometry.color_descriptor;
  let local0 = read_position_direct(geometry, vertices.x);
  let local1 = read_position_direct(geometry, vertices.y);
  let local2 = read_position_direct(geometry, vertices.z);
  let world0 = instance.current_object_to_world * vec4f(local0, 1.0);
  let world1 = instance.current_object_to_world * vec4f(local1, 1.0);
  let world2 = instance.current_object_to_world * vec4f(local2, 1.0);
  let projected0 = view.projection_matrix * world0;
  let projected1 = view.projection_matrix * world1;
  let projected2 = view.projection_matrix * world2;
  let bary = perspective_barycentric_with_derivatives(
    position.xy,
    projected0,
    projected1,
    projected2
  );
  let face_local = safe_normalize(cross(local2 - local1, local0 - local1), vec3f(0.0, 0.0, 1.0));
  let normal0 = read_stream4_from_descriptor(normal_descriptor, vertices.x, vec4f(face_local, 0.0)).xyz;
  let normal1 = read_stream4_from_descriptor(normal_descriptor, vertices.y, vec4f(face_local, 0.0)).xyz;
  let normal2 = read_stream4_from_descriptor(normal_descriptor, vertices.z, vec4f(face_local, 0.0)).xyz;
  let tangent0 = read_stream4_from_descriptor(tangent_descriptor, vertices.x, vec4f(1.0, 0.0, 0.0, 1.0));
  let tangent1 = read_stream4_from_descriptor(tangent_descriptor, vertices.y, vec4f(1.0, 0.0, 0.0, 1.0));
  let tangent2 = read_stream4_from_descriptor(tangent_descriptor, vertices.z, vec4f(1.0, 0.0, 0.0, 1.0));
  let color0 = read_stream4_from_descriptor(color_descriptor, vertices.x, vec4f(1.0)).rgb;
  let color1 = read_stream4_from_descriptor(color_descriptor, vertices.y, vec4f(1.0)).rgb;
  let color2 = read_stream4_from_descriptor(color_descriptor, vertices.z, vec4f(1.0)).rgb;
  let empty_uv = ReconstructedMaterialUv(vec2f(0.0), vec2f(0.0), vec2f(0.0));
  var albedo_uv = empty_uv;
  var normal_uv = empty_uv;
  var orm_uv = empty_uv;
  var emissive_uv = empty_uv;
  if OENGINE_ACTIVE_KERNEL_CLASS != OENGINE_MATERIAL_KERNEL_BASE_FACTOR {
    albedo_uv = reconstruct_material_uv(material_info, 0u, geometry, vertices, bary);
  }
  if OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    normal_uv = reconstruct_material_uv(material_info, 1u, geometry, vertices, bary);
  }
  if OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    orm_uv = reconstruct_material_uv(material_info, 2u, geometry, vertices, bary);
  }
  if OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    emissive_uv = reconstruct_material_uv(material_info, 3u, geometry, vertices, bary);
  }
  let vertex_color = color0 * bary.weights.x + color1 * bary.weights.y + color2 * bary.weights.z;
  let local_normal = safe_normalize(
    normal0 * bary.weights.x + normal1 * bary.weights.y + normal2 * bary.weights.z,
    face_local
  );
  let local_tangent4 = tangent0 * bary.weights.x + tangent1 * bary.weights.y + tangent2 * bary.weights.z;
  let frame = object_transform_frame(instance.current_object_to_world);
  let shading_normal = safe_normalize(frame.normal_matrix * local_normal, face_local);
  let geometric_normal = safe_normalize(frame.normal_matrix * face_local, shading_normal);
  var tangent = frame.tangent_matrix * local_tangent4.xyz;
  tangent = safe_normalize(
    tangent - shading_normal * dot(shading_normal, tangent),
    safe_normalize(cross(vec3f(0.0, 1.0, 0.0), shading_normal), vec3f(1.0, 0.0, 0.0))
  );
  let tangent_handedness = select(-1.0, 1.0, local_tangent4.w >= 0.0);
  let bitangent = safe_normalize(
    cross(shading_normal, tangent) * tangent_handedness * frame.orientation,
    safe_normalize(cross(shading_normal, tangent), vec3f(0.0, 1.0, 0.0))
  );
  var mapped_normal = shading_normal;
  if OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    var sampled_normal = sample_material_texture(
      material_info.normal_texture_ref,
      material_sampler_class(material_info, 1u),
      normal_uv.uv,
      normal_uv.ddx,
      normal_uv.ddy,
      vec4f(0.5, 0.5, 1.0, 1.0)
    ).xyz * 2.0 - 1.0;
    sampled_normal = vec3f(sampled_normal.xy * material_info.pbr_factors.z, sampled_normal.z);
    mapped_normal = safe_normalize(
      mat3x3f(tangent, bitangent, shading_normal) * sampled_normal,
      shading_normal
    );
  }
  var orm = vec4f(1.0);
  if OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    orm = sample_material_texture(
      material_info.orm_texture_ref,
      material_sampler_class(material_info, 2u),
      orm_uv.uv,
      orm_uv.ddx,
      orm_uv.ddy,
      vec4f(1.0)
    );
  }
  var albedo_sample = vec4f(1.0);
  if OENGINE_ACTIVE_KERNEL_CLASS != OENGINE_MATERIAL_KERNEL_BASE_FACTOR {
    albedo_sample = sample_material_texture(
      material_info.texture_ref,
      material_sampler_class(material_info, 0u),
      albedo_uv.uv,
      albedo_uv.ddx,
      albedo_uv.ddy,
      vec4f(1.0)
    );
  }
  var emissive_sample = vec4f(1.0);
  if OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      OENGINE_ACTIVE_KERNEL_CLASS == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    emissive_sample = sample_material_texture(
      material_info.emissive_texture_ref,
      material_sampler_class(material_info, 3u),
      emissive_uv.uv,
      emissive_uv.ddx,
      emissive_uv.ddy,
      vec4f(1.0)
    );
  }
  let albedo = albedo_sample.rgb * vertex_color * material_info.base_color_factor.rgb;
  let is_unlit = (material_info.flags & OENGINE_MATERIAL_UNLIT) != 0u;
  let ambient = select(
    1.0,
    mix(1.0, orm.r, material_info.pbr_factors.w),
    (material_info.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u
  );
  let metallic_sample = select(1.0, orm.b, (material_info.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u);
  let roughness_sample = select(1.0, orm.g, (material_info.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u);
  var output: PackedMaterialOutput;
  output.pbr = vec2f(
    metallic_sample * material_info.pbr_factors.x,
    clamp(roughness_sample * material_info.pbr_factors.y, 0.0, 1.0)
  );
  output.normal = vec4u(
    encode_g_buffer_normal(mapped_normal),
    encode_g_buffer_normal(geometric_normal)
  );
  output.albedo = vec4f(albedo, ambient);
  output.emissive = rgbe9995_encode(emissive_sample.rgb * material_info.emissive_factor.rgb);
  if is_unlit {
    output.pbr = vec2f(0.0, 1.0);
    output.normal = vec4u(
      encode_g_buffer_normal(shading_normal),
      encode_g_buffer_normal(geometric_normal)
    );
    output.albedo = vec4f(vec3f(0.0), 1.0);
    output.emissive = rgbe9995_encode(albedo);
  }
  output.velocity = vec2f(0.0);
  var surface_flags = OENGINE_SURFACE_FLAG_VALID;
  if (material_info.flags & OENGINE_MATERIAL_HAS_NORMAL_TEXTURE) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_NORMAL_TEXTURE;
  }
  if (material_info.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_ORM_TEXTURE;
  }
  if (material_info.flags & OENGINE_MATERIAL_HAS_EMISSIVE_TEXTURE) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE;
  }
  if (material_info.flags & OENGINE_MATERIAL_UNLIT) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_UNLIT;
  }
  if bary.valid == 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK | OENGINE_SURFACE_FLAG_REACTIVE;
  }
  if OENGINE_VELOCITY_ENABLED && oengine_instance_motion_valid(instance) && bary.valid != 0u {
    let current_world = world0 * bary.weights.x + world1 * bary.weights.y + world2 * bary.weights.z;
    let previous_world_h = instance.previous_from_current * current_world;
    if previous_world_h.w > 1e-8 {
      let previous_clip = previous_view_projection * vec4f(previous_world_h.xyz / previous_world_h.w, 1.0);
      if previous_clip.w > 1e-8 {
        let previous_ndc = previous_clip.xy / previous_clip.w;
        let resolution = vec2f(textureDimensions(visibility_keys));
        let previous_pixel = vec2f(
          (previous_ndc.x + 1.0) * 0.5 * resolution.x,
          (1.0 - previous_ndc.y) * 0.5 * resolution.y
        );
        output.velocity = position.xy - previous_pixel;
        surface_flags |= OENGINE_SURFACE_FLAG_MOTION_VALID;
      } else {
        surface_flags |= OENGINE_SURFACE_FLAG_REACTIVE;
      }
    } else {
      surface_flags |= OENGINE_SURFACE_FLAG_REACTIVE;
    }
  } else {
    surface_flags |= OENGINE_SURFACE_FLAG_REACTIVE;
  }
  output.metadata = oengine_surface_pack(work.material_handle, surface_flags);
  return output;
}
`;
