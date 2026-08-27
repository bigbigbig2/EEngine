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
  if data_type == 1u {
    let value = sign_extend(read_u8(byte_offset), 8u);
    return select(f32(value), max(f32(value) / 127.0, -1.0), normalized);
  }
  if data_type == 2u {
    let value = read_u8(byte_offset);
    return select(f32(value), f32(value) / 255.0, normalized);
  }
  if data_type == 3u {
    let value = sign_extend(read_u16(byte_offset), 16u);
    return select(f32(value), max(f32(value) / 32767.0, -1.0), normalized);
  }
  if data_type == 4u {
    let value = read_u16(byte_offset);
    return select(f32(value), f32(value) / 65535.0, normalized);
  }
  let word = vertex_data[byte_offset >> 2u];
  if data_type == 5u { return f32(bitcast<i32>(word)); }
  if data_type == 6u { return f32(word); }
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

fn read_stream4(
  geometry: GpuGeometryRecord,
  semantic: u32,
  vertex: u32,
  fallback: vec4f
) -> vec4f {
  let descriptor = find_stream(geometry, semantic);
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

fn screen_position(clip: vec4f) -> vec2f {
  let ndc = clip.xy / clip.w;
  return vec2f(
    (ndc.x + 1.0) * 0.5 * f32(view.width),
    (1.0 - ndc.y) * 0.5 * f32(view.height)
  );
}

fn perspective_barycentric(
  pixel: vec2f,
  clip0: vec4f,
  clip1: vec4f,
  clip2: vec4f
) -> vec3f {
  let p0 = screen_position(clip0);
  let p1 = screen_position(clip1);
  let p2 = screen_position(clip2);
  let denominator = (p1.y - p2.y) * (p0.x - p2.x)
    + (p2.x - p1.x) * (p0.y - p2.y);
  let safe_denominator = select(1e-8, denominator, abs(denominator) > 1e-8);
  let l0 = ((p1.y - p2.y) * (pixel.x - p2.x)
    + (p2.x - p1.x) * (pixel.y - p2.y)) / safe_denominator;
  let l1 = ((p2.y - p0.y) * (pixel.x - p2.x)
    + (p0.x - p2.x) * (pixel.y - p2.y)) / safe_denominator;
  let screen = vec3f(l0, l1, 1.0 - l0 - l1);
  let corrected = screen / vec3f(clip0.w, clip1.w, clip2.w);
  return corrected / max(dot(corrected, vec3f(1.0)), 1e-8);
}

fn normal_matrix(matrix: mat4x4f) -> mat3x3f {
  return mat3x3f(
    cross(matrix[1].xyz, matrix[2].xyz),
    cross(matrix[2].xyz, matrix[0].xyz),
    cross(matrix[0].xyz, matrix[1].xyz)
  );
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
  let local0 = read_stream4(geometry, SEMANTIC_POSITION, vertices.x, vec4f(0.0)).xyz;
  let local1 = read_stream4(geometry, SEMANTIC_POSITION, vertices.y, vec4f(0.0)).xyz;
  let local2 = read_stream4(geometry, SEMANTIC_POSITION, vertices.z, vec4f(0.0)).xyz;
  let world0 = instance.current_object_to_world * vec4f(local0, 1.0);
  let world1 = instance.current_object_to_world * vec4f(local1, 1.0);
  let world2 = instance.current_object_to_world * vec4f(local2, 1.0);
  let clip0 = view.projection_matrix * world0;
  let clip1 = view.projection_matrix * world1;
  let clip2 = view.projection_matrix * world2;
  let bary = perspective_barycentric(position.xy, clip0, clip1, clip2);
  let face_local = normalize(cross(local2 - local1, local0 - local1));
  let normal0 = read_stream4(geometry, SEMANTIC_NORMAL, vertices.x, vec4f(face_local, 0.0)).xyz;
  let normal1 = read_stream4(geometry, SEMANTIC_NORMAL, vertices.y, vec4f(face_local, 0.0)).xyz;
  let normal2 = read_stream4(geometry, SEMANTIC_NORMAL, vertices.z, vec4f(face_local, 0.0)).xyz;
  let tangent0 = read_stream4(geometry, SEMANTIC_TANGENT, vertices.x, vec4f(1.0, 0.0, 0.0, 1.0));
  let tangent1 = read_stream4(geometry, SEMANTIC_TANGENT, vertices.y, vec4f(1.0, 0.0, 0.0, 1.0));
  let tangent2 = read_stream4(geometry, SEMANTIC_TANGENT, vertices.z, vec4f(1.0, 0.0, 0.0, 1.0));
  let uv0 = read_stream4(geometry, SEMANTIC_UV0, vertices.x, vec4f(0.0)).xy;
  let uv1 = read_stream4(geometry, SEMANTIC_UV0, vertices.y, vec4f(0.0)).xy;
  let uv2 = read_stream4(geometry, SEMANTIC_UV0, vertices.z, vec4f(0.0)).xy;
  let color0 = read_stream4(geometry, SEMANTIC_COLOR, vertices.x, vec4f(1.0)).rgb;
  let color1 = read_stream4(geometry, SEMANTIC_COLOR, vertices.y, vec4f(1.0)).rgb;
  let color2 = read_stream4(geometry, SEMANTIC_COLOR, vertices.z, vec4f(1.0)).rgb;
  let uv = uv0 * bary.x + uv1 * bary.y + uv2 * bary.z;
  let uv_dx = dpdx(uv) / view.upscale_ratio.x;
  let uv_dy = dpdy(uv) / view.upscale_ratio.y;
  let vertex_color = color0 * bary.x + color1 * bary.y + color2 * bary.z;
  let local_normal = normalize(normal0 * bary.x + normal1 * bary.y + normal2 * bary.z);
  let local_tangent4 = tangent0 * bary.x + tangent1 * bary.y + tangent2 * bary.z;
  let matrix = normal_matrix(instance.current_object_to_world);
  let shading_normal = normalize(matrix * local_normal);
  let geometric_normal = normalize(matrix * face_local);
  var tangent = normalize(matrix * local_tangent4.xyz);
  tangent = normalize(tangent - shading_normal * dot(shading_normal, tangent));
  let bitangent = normalize(cross(shading_normal, tangent) * sign(local_tangent4.w));
  let sampled_normal = textureSampleGrad(texture_normal, sampler_normal, uv, uv_dx, uv_dy).xyz * 2.0 - 1.0;
  let mapped_normal = normalize(mat3x3f(tangent, bitangent, shading_normal) * sampled_normal);
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
