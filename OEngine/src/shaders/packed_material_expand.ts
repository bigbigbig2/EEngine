import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../assets/GeometryAssetPackage.js";
import { MATERIAL_META_TYPE } from "../gpu/MaterialMetadataTable.js";
import { GPU_GEOMETRY_RECORD_WGSL, GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_VIEW_TYPE } from "../render/ViewManager.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { GBUFFER_ENCODE_WGSL } from "./gbuffer_encode.js";

export const PACKED_MATERIAL_EXPAND_WGSL = /* wgsl */ `
${MATERIAL_META_TYPE.wgsl_declaration}
${GPU_VIEW_TYPE.wgsl_declaration}
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GBUFFER_ENCODE_WGSL}

const VISIBILITY_SENTINEL: u32 = 16777216u;
const SEMANTIC_POSITION: u32 = 0x69736f70u;
const SEMANTIC_NORMAL: u32 = 0x6d726f6eu;
const SEMANTIC_TANGENT: u32 = 0x676e6174u;
const SEMANTIC_COLOR: u32 = 0x6f6c6f63u;
const SEMANTIC_UV0: u32 = 0x00307675u;
const STREAM_DESCRIPTOR_WORDS: u32 = 32u;

@group(0) @binding(0) var<uniform> material_info: EventDispatcher;
@group(0) @binding(1) var texture_albedo: texture_2d<f32>;
@group(0) @binding(2) var sampler_albedo: sampler;
@group(0) @binding(3) var texture_normal: texture_2d<f32>;
@group(0) @binding(4) var sampler_normal: sampler;
@group(0) @binding(5) var texture_orm: texture_2d<f32>;
@group(0) @binding(6) var sampler_orm: sampler;
@group(0) @binding(7) var texture_emissive: texture_2d<f32>;
@group(0) @binding(8) var sampler_emissive: sampler;

@group(1) @binding(0) var triangle_ids: texture_2d<u32>;
@group(1) @binding(1) var instance_ids: texture_2d<u32>;
@group(1) @binding(2) var<uniform> view: PipelineCacheKey;
@group(1) @binding(3) var<uniform> camera: CommandEncoder;

@group(2) @binding(0) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(2) @binding(1) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(2) @binding(2) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(2) @binding(3) var<storage, read> meshlet_vertices: array<u32>;
@group(2) @binding(4) var<storage, read> meshlet_triangles: array<u32>;
@group(2) @binding(5) var<storage, read> stream_descriptors: array<u32>;
@group(2) @binding(6) var<storage, read> vertex_data: array<u32>;

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

fn find_stream(geometry: GpuGeometryRecord, semantic: u32) -> u32 {
  for (var index = 0u; index < geometry.stream_descriptor_count; index++) {
    let descriptor = geometry.stream_descriptor_begin + index;
    if stream_descriptors[descriptor * STREAM_DESCRIPTOR_WORDS] == semantic {
      return descriptor;
    }
  }
  return 0xffffffffu;
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

const FULLSCREEN = array<vec2f, 3>(
  vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
);

@vertex
fn packed_material_vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(FULLSCREEN[vertex_index], 0.0, 1.0);
}

struct PackedMaterialOutput {
  @location(0) pbr: vec2f,
  @location(1) normal: vec4u,
  @location(2) albedo: vec4f,
  @location(3) emissive: u32,
}

@fragment
fn packed_material_fs(@builtin(position) position: vec4f) -> PackedMaterialOutput {
  let pixel = vec2i(position.xy);
  let instance_index = textureLoad(instance_ids, pixel, 0).r;
  if instance_index == VISIBILITY_SENTINEL { discard; }
  let instance = instances[instance_index];
  if instance.material_handle != material_info.id { discard; }
  let encoded = textureLoad(triangle_ids, pixel, 0).r;
  let meshlet_index = encoded >> 8u;
  let triangle_index = encoded & 0xffu;
  let geometry = geometries[instance.geometry_record_index];
  let meshlet = meshlets[meshlet_index];
  let vertices = triangle_source_vertices(meshlet, triangle_index);
  let position_descriptor = find_stream(geometry, SEMANTIC_POSITION);
  let normal_descriptor = find_stream(geometry, SEMANTIC_NORMAL);
  let tangent_descriptor = find_stream(geometry, SEMANTIC_TANGENT);
  let uv_descriptor = find_stream(geometry, SEMANTIC_UV0);
  let color_descriptor = find_stream(geometry, SEMANTIC_COLOR);
  let local0 = read_stream4_from_descriptor(position_descriptor, vertices.x, vec4f(0.0)).xyz;
  let local1 = read_stream4_from_descriptor(position_descriptor, vertices.y, vec4f(0.0)).xyz;
  let local2 = read_stream4_from_descriptor(position_descriptor, vertices.z, vec4f(0.0)).xyz;
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
  let uv0 = read_stream4_from_descriptor(uv_descriptor, vertices.x, vec4f(0.0)).xy;
  let uv1 = read_stream4_from_descriptor(uv_descriptor, vertices.y, vec4f(0.0)).xy;
  let uv2 = read_stream4_from_descriptor(uv_descriptor, vertices.z, vec4f(0.0)).xy;
  let color0 = read_stream4_from_descriptor(color_descriptor, vertices.x, vec4f(1.0)).rgb;
  let color1 = read_stream4_from_descriptor(color_descriptor, vertices.y, vec4f(1.0)).rgb;
  let color2 = read_stream4_from_descriptor(color_descriptor, vertices.z, vec4f(1.0)).rgb;
  let uv = uv0 * bary.weights.x + uv1 * bary.weights.y + uv2 * bary.weights.z;
  let uv_dx = (uv0 * bary.ddx.x + uv1 * bary.ddx.y + uv2 * bary.ddx.z) / view.upscale_ratio.x;
  let uv_dy = (uv0 * bary.ddy.x + uv1 * bary.ddy.y + uv2 * bary.ddy.z) / view.upscale_ratio.y;
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
  let sampled_normal = textureSampleGrad(texture_normal, sampler_normal, uv, uv_dx, uv_dy).xyz * 2.0 - 1.0;
  let mapped_normal = safe_normalize(
    mat3x3f(tangent, bitangent, shading_normal) * sampled_normal,
    shading_normal
  );
  let orm = textureSampleGrad(texture_orm, sampler_orm, uv, uv_dx, uv_dy);
  let albedo_sample = textureSampleGrad(texture_albedo, sampler_albedo, uv, uv_dx, uv_dy);
  let emissive_sample = textureSampleGrad(texture_emissive, sampler_emissive, uv, uv_dx, uv_dy);
  let albedo = albedo_sample.rgb * vertex_color * material_info.albedo_color.rgb;
  let ambient = fma(orm.r, material_info.ambient_factors.x, material_info.ambient_factors.y);
  var output: PackedMaterialOutput;
  output.pbr = vec2f(
    orm.b * material_info.metallic_factor,
    clamp(orm.g * material_info.roughness_factor, 0.0, 1.0)
  );
  output.normal = vec4u(
    encode_g_buffer_normal(mapped_normal),
    encode_g_buffer_normal(geometric_normal)
  );
  output.albedo = vec4f(albedo, ambient);
  output.emissive = rgbe9995_encode(emissive_sample.rgb * material_info.emissive_factor);
  return output;
}
`;
