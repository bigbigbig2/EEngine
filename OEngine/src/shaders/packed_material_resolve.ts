import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../assets/GeometryAssetPackage.js";
import { GPU_GEOMETRY_RECORD_WGSL, GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import {
  GPU_MATERIAL_SHADING_RECORD_WGSL,
  STANDARD_PBR_FEATURE
} from "../gpu/GpuMaterialShadingAbi.js";
import { GPU_SURFACE_ABI_WGSL } from "../gpu/GpuSurfaceAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import {
  GPU_RASTER_WORK_SCHEMA,
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA
} from "../gpu/GpuWorkGenerationAbi.js";
import { GPU_VIEW_TYPE } from "../render/ViewManager.js";
import { GBUFFER_ENCODE_WGSL } from "./gbuffer_encode.js";

const MATERIAL_TEXTURE_BANK_NAMES = [
  "material_textures",
  "high_resolution_material_textures",
  "compressed_material_textures_0",
  "compressed_material_textures_1",
  "compressed_material_textures_2",
  "compressed_material_textures_3"
] as const;

const MATERIAL_TEXTURE_BANK_WGSL = MATERIAL_TEXTURE_BANK_NAMES.map((name, bank) => /* wgsl */ `
fn sample_material_bank_${bank}(
  layer: i32, sampler_class: u32, uv: vec2f, uv_dx: vec2f, uv_dy: vec2f
) -> vec4f {
  let address = sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK;
  let linear = (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) != 0u;
  if linear {
    if address == 0u { return textureSampleGrad(${name}, sampler_clamp_linear, uv, layer, uv_dx, uv_dy); }
    if address == 2u { return textureSampleGrad(${name}, sampler_mirror_linear, uv, layer, uv_dx, uv_dy); }
    return textureSampleGrad(${name}, sampler_repeat_linear, uv, layer, uv_dx, uv_dy);
  }
  if address == 0u { return textureSampleGrad(${name}, sampler_clamp_nearest, uv, layer, uv_dx, uv_dy); }
  if address == 2u { return textureSampleGrad(${name}, sampler_mirror_nearest, uv, layer, uv_dx, uv_dy); }
  return textureSampleGrad(${name}, sampler_repeat_nearest, uv, layer, uv_dx, uv_dy);
}
`).join("\n");

const PACKED_MATERIAL_RESOLVE_TEMPLATE = /* wgsl */ `
${GPU_VIEW_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_MATERIAL_SHADING_RECORD_WGSL}
${GPU_SURFACE_ABI_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.wgsl}
${GPU_RASTER_WORK_SCHEMA.wgsl}
${GBUFFER_ENCODE_WGSL}

const SEMANTIC_POSITION: u32 = 0x69736f70u;
const SEMANTIC_NORMAL: u32 = 0x6d726f6eu;
const SEMANTIC_TANGENT: u32 = 0x676e6174u;
const SEMANTIC_COLOR: u32 = 0x6f6c6f63u;
const SEMANTIC_UV0: u32 = 0x00307675u;
const SEMANTIC_UV1: u32 = 0x00317675u;
const SEMANTIC_UV2: u32 = 0x00327675u;
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

struct R4ResolveVisibleClusterQueue {
  header: R4ResolveQueueHeaderRead,
  elements: array<OEngineVisibleClusterRecord>,
}

struct R4ResolveRasterWorkQueue {
  header: R4ResolveQueueHeaderRead,
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

@group(2) @binding(0) var<storage, read> material_shading: array<OEngineMaterialShadingRecord>;
@group(2) @binding(1) var compressed_material_textures_0: texture_2d_array<f32>;
@group(2) @binding(2) var compressed_material_textures_1: texture_2d_array<f32>;
@group(2) @binding(3) var compressed_material_textures_2: texture_2d_array<f32>;
@group(2) @binding(4) var compressed_material_textures_3: texture_2d_array<f32>;


@group(1) @binding(0) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(1) @binding(1) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(1) @binding(2) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(1) @binding(3) var<storage, read> meshlet_vertices: array<u32>;
@group(1) @binding(4) var<storage, read> meshlet_triangles: array<u32>;
@group(1) @binding(5) var<storage, read> stream_descriptors: array<u32>;
@group(1) @binding(6) var<storage, read> vertex_data: array<u32>;
@group(1) @binding(7) var<storage, read> visible_clusters: R4ResolveVisibleClusterQueue;
@group(1) @binding(8) var<storage, read> raster_work: R4ResolveRasterWorkQueue;

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

const FULLSCREEN = array<vec2f, 3>(
  vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
);

@vertex
fn packed_material_vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(FULLSCREEN[vertex_index], 0.0, 1.0);
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
  if texture_ref == OENGINE_MATERIAL_SHADING_INVALID_TEXTURE { return fallback; }
  let bank = (texture_ref >> OENGINE_MATERIAL_SHADING_BANK_SHIFT) & 0x0fu;
  let layer = i32(texture_ref & OENGINE_MATERIAL_SHADING_LAYER_MASK);
  switch bank {
    case 0u: { return sample_material_bank_0(layer, sampler_class, uv, uv_dx, uv_dy); }
    case 1u: { return sample_material_bank_1(layer, sampler_class, uv, uv_dx, uv_dy); }
    case 2u: { return sample_material_bank_2(layer, sampler_class, uv, uv_dx, uv_dy); }
    case 3u: { return sample_material_bank_3(layer, sampler_class, uv, uv_dx, uv_dy); }
    case 4u: { return sample_material_bank_4(layer, sampler_class, uv, uv_dx, uv_dy); }
    case 5u: { return sample_material_bank_5(layer, sampler_class, uv, uv_dx, uv_dy); }
    default: { return fallback; }
  }
}

${MATERIAL_TEXTURE_BANK_WGSL}

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
  var uv_semantic = SEMANTIC_UV0;
  if uv_set == 1u { uv_semantic = SEMANTIC_UV1; }
  if uv_set == 2u { uv_semantic = SEMANTIC_UV2; }
  let descriptor = find_stream(geometry, uv_semantic);
  let value0 = read_stream4_from_descriptor(descriptor, vertices.x, vec4f(0.0)).xy;
  let value1 = read_stream4_from_descriptor(descriptor, vertices.y, vec4f(0.0)).xy;
  let value2 = read_stream4_from_descriptor(descriptor, vertices.z, vec4f(0.0)).xy;
  let reconstructed = value0 * bary.weights.x + value1 * bary.weights.y + value2 * bary.weights.z;
  let reconstructed_dx = (value0 * bary.ddx.x + value1 * bary.ddx.y + value2 * bary.ddx.z) / view.upscale_ratio.x;
  let reconstructed_dy = (value0 * bary.ddy.x + value1 * bary.ddy.y + value2 * bary.ddy.z) / view.upscale_ratio.y;
  return ReconstructedMaterialUv(
    transform_material_uv(material, slot, reconstructed),
    transform_material_gradient(material, slot, reconstructed_dx),
    transform_material_gradient(material, slot, reconstructed_dy)
  );
}

__OENGINE_MATERIAL_SPECIALIZATIONS__

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
  if raster_slot >= min(raster_work.header.written, raster_work.header.capacity) { discard; }
  let work = raster_work.elements[raster_slot];
  if work.visible_cluster_slot >= min(visible_clusters.header.written, visible_clusters.header.capacity) { discard; }
  let visible = visible_clusters.elements[work.visible_cluster_slot];
  if visible.instance_record_index >= arrayLength(&instances) ||
    visible.geometry_record_index >= arrayLength(&geometries) ||
    work.meshlet_record_index >= arrayLength(&meshlets) ||
    visible.material_handle >= arrayLength(&materials) ||
    visible.material_handle >= arrayLength(&material_shading) {
    discard;
  }
  let instance = instances[visible.instance_record_index];
  let geometry = geometries[visible.geometry_record_index];
  let meshlet = meshlets[work.meshlet_record_index];
  if !oengine_instance_active(instance) ||
    instance.geometry_record_index != visible.geometry_record_index ||
    instance.material_handle != visible.material_handle ||
    visible.cluster_record_index < geometry.cluster_begin ||
    visible.cluster_record_index - geometry.cluster_begin >= geometry.cluster_count ||
    work.meshlet_record_index < geometry.meshlet_begin ||
    work.meshlet_record_index - geometry.meshlet_begin >= geometry.meshlet_count {
    discard;
  }
  let triangle_index = oengine_visibility_key_local_triangle(key);
  if triangle_index >= meshlet.triangle_count { discard; }
  let material_info = materials[visible.material_handle];
  let shading_info = material_shading[visible.material_handle];
  if (material_info.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u ||
    material_info.material_id != visible.material_handle {
    discard;
  }
  let vertices = triangle_source_vertices(meshlet, triangle_index);
  let position_descriptor = find_stream(geometry, SEMANTIC_POSITION);
  let normal_descriptor = find_stream(geometry, SEMANTIC_NORMAL);
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
  let color0 = read_stream4_from_descriptor(color_descriptor, vertices.x, vec4f(1.0)).rgb;
  let color1 = read_stream4_from_descriptor(color_descriptor, vertices.y, vec4f(1.0)).rgb;
  let color2 = read_stream4_from_descriptor(color_descriptor, vertices.z, vec4f(1.0)).rgb;
  let material_samples = sample_material_specialized(
    material_info, shading_info, geometry, vertices, bary
  );
  let vertex_color = color0 * bary.weights.x + color1 * bary.weights.y + color2 * bary.weights.z;
  let local_normal = safe_normalize(
    normal0 * bary.weights.x + normal1 * bary.weights.y + normal2 * bary.weights.z,
    face_local
  );
  let frame = object_transform_frame(instance.current_object_to_world);
  let shading_normal = safe_normalize(frame.normal_matrix * local_normal, face_local);
  let geometric_normal = safe_normalize(frame.normal_matrix * face_local, shading_normal);
  var mapped_normal = shading_normal;
  if (shading_info.feature_key & OENGINE_STANDARD_PBR_NORMAL_TEXTURE) != 0u {
    let tangent_descriptor = find_stream(geometry, SEMANTIC_TANGENT);
    let tangent0 = read_stream4_from_descriptor(tangent_descriptor, vertices.x, vec4f(1.0, 0.0, 0.0, 1.0));
    let tangent1 = read_stream4_from_descriptor(tangent_descriptor, vertices.y, vec4f(1.0, 0.0, 0.0, 1.0));
    let tangent2 = read_stream4_from_descriptor(tangent_descriptor, vertices.z, vec4f(1.0, 0.0, 0.0, 1.0));
    let local_tangent4 = tangent0 * bary.weights.x + tangent1 * bary.weights.y + tangent2 * bary.weights.z;
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
    var sampled_normal = material_samples.normal.xyz * 2.0 - 1.0;
    sampled_normal = vec3f(sampled_normal.xy * material_info.pbr_factors.z, sampled_normal.z);
    mapped_normal = safe_normalize(
      mat3x3f(tangent, bitangent, shading_normal) * sampled_normal,
      shading_normal
    );
  }
  let orm = material_samples.orm;
  let albedo = material_samples.albedo.rgb * vertex_color * material_info.base_color_factor.rgb;
  let is_unlit = (shading_info.feature_key & OENGINE_STANDARD_PBR_UNLIT) != 0u;
  let ambient = select(
    1.0,
    mix(1.0, orm.r, material_info.pbr_factors.w),
    (shading_info.feature_key & OENGINE_STANDARD_PBR_ORM_TEXTURE) != 0u
  );
  let metallic_sample = select(1.0, orm.b, (shading_info.feature_key & OENGINE_STANDARD_PBR_ORM_TEXTURE) != 0u);
  let roughness_sample = select(1.0, orm.g, (shading_info.feature_key & OENGINE_STANDARD_PBR_ORM_TEXTURE) != 0u);
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
  output.emissive = rgbe9995_encode(material_samples.emissive.rgb * material_info.emissive_factor.rgb);
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
  if (shading_info.feature_key & OENGINE_STANDARD_PBR_NORMAL_TEXTURE) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_NORMAL_TEXTURE;
  }
  if (shading_info.feature_key & OENGINE_STANDARD_PBR_ORM_TEXTURE) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_ORM_TEXTURE;
  }
  if (shading_info.feature_key & OENGINE_STANDARD_PBR_EMISSIVE_TEXTURE) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE;
  }
  if (shading_info.feature_key & OENGINE_STANDARD_PBR_UNLIT) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_UNLIT;
  }
  if bary.valid == 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK | OENGINE_SURFACE_FLAG_REACTIVE;
  }
  if oengine_instance_motion_valid(instance) && bary.valid != 0u {
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
  output.metadata = oengine_surface_pack(visible.material_handle, surface_flags);
  return output;
}
`;

export const MAX_STANDARD_PBR_FEATURE_CLASSES = 16;

export function createPackedMaterialResolveWgsl(
  featureKeys: readonly number[]
): string {
  const keys = [...new Set(featureKeys.map((key) => key >>> 0))]
    .sort((left, right) => left - right)
    .slice(0, MAX_STANDARD_PBR_FEATURE_CLASSES);
  return PACKED_MATERIAL_RESOLVE_TEMPLATE.replace(
    "__OENGINE_MATERIAL_SPECIALIZATIONS__",
    materialSpecializationWgsl(keys)
  );
}

export const PACKED_MATERIAL_RESOLVE_WGSL = createPackedMaterialResolveWgsl([]);

function materialSpecializationWgsl(featureKeys: readonly number[]): string {
  const functions = featureKeys.map((featureKey) =>
    specializedMaterialSampleFunction(featureKey)
  ).join("\n");
  const cases = featureKeys.map((featureKey) =>
    `case ${featureKey}u: { return sample_material_class_${featureKey.toString(16)}(material, shading, geometry, vertices, bary); }`
  ).join("\n    ");
  return /* wgsl */ `
struct SpecializedMaterialSamples {
  albedo: vec4f,
  normal: vec4f,
  orm: vec4f,
  emissive: vec4f,
}

fn default_material_samples() -> SpecializedMaterialSamples {
  return SpecializedMaterialSamples(
    vec4f(1.0),
    vec4f(0.5, 0.5, 1.0, 1.0),
    vec4f(1.0),
    vec4f(1.0)
  );
}

fn sample_material_generic(
  material: OEngineMaterialVisibilityRecord,
  shading: OEngineMaterialShadingRecord,
  geometry: GpuGeometryRecord,
  vertices: vec3u,
  bary: PerspectiveBarycentric
) -> SpecializedMaterialSamples {
  var result = default_material_samples();
  if (shading.feature_key & OENGINE_STANDARD_PBR_ALBEDO_TEXTURE) != 0u {
    let uv = reconstruct_material_uv(material, 0u, geometry, vertices, bary);
    result.albedo = sample_material_texture(shading.base_color_texture_ref,
      material_sampler_class(material, 0u), uv.uv, uv.ddx, uv.ddy, result.albedo);
  }
  if (shading.feature_key & OENGINE_STANDARD_PBR_NORMAL_TEXTURE) != 0u {
    let uv = reconstruct_material_uv(material, 1u, geometry, vertices, bary);
    result.normal = sample_material_texture(shading.normal_texture_ref,
      material_sampler_class(material, 1u), uv.uv, uv.ddx, uv.ddy, result.normal);
  }
  if (shading.feature_key & OENGINE_STANDARD_PBR_ORM_TEXTURE) != 0u {
    let uv = reconstruct_material_uv(material, 2u, geometry, vertices, bary);
    result.orm = sample_material_texture(shading.orm_texture_ref,
      material_sampler_class(material, 2u), uv.uv, uv.ddx, uv.ddy, result.orm);
  }
  if (shading.feature_key & OENGINE_STANDARD_PBR_EMISSIVE_TEXTURE) != 0u {
    let uv = reconstruct_material_uv(material, 3u, geometry, vertices, bary);
    result.emissive = sample_material_texture(shading.emissive_texture_ref,
      material_sampler_class(material, 3u), uv.uv, uv.ddx, uv.ddy, result.emissive);
  }
  return result;
}

${functions}

fn sample_material_specialized(
  material: OEngineMaterialVisibilityRecord,
  shading: OEngineMaterialShadingRecord,
  geometry: GpuGeometryRecord,
  vertices: vec3u,
  bary: PerspectiveBarycentric
) -> SpecializedMaterialSamples {
  switch shading.feature_key {
    ${cases}
    default: { return sample_material_generic(material, shading, geometry, vertices, bary); }
  }
}
`;
}

function specializedMaterialSampleFunction(featureKey: number): string {
  const sample = (
    feature: number,
    slot: number,
    field: "albedo" | "normal" | "orm" | "emissive",
    ref: string
  ): string => (featureKey & feature) === 0 ? "" : /* wgsl */ `
  let ${field}_uv = reconstruct_material_uv(material, ${slot}u, geometry, vertices, bary);
  result.${field} = sample_material_texture(
    shading.${ref}, material_sampler_class(material, ${slot}u),
    ${field}_uv.uv, ${field}_uv.ddx, ${field}_uv.ddy, result.${field}
  );`;
  return /* wgsl */ `
fn sample_material_class_${featureKey.toString(16)}(
  material: OEngineMaterialVisibilityRecord,
  shading: OEngineMaterialShadingRecord,
  geometry: GpuGeometryRecord,
  vertices: vec3u,
  bary: PerspectiveBarycentric
) -> SpecializedMaterialSamples {
  var result = default_material_samples();
  ${sample(STANDARD_PBR_FEATURE.AlbedoTexture, 0, "albedo", "base_color_texture_ref")}
  ${sample(STANDARD_PBR_FEATURE.NormalTexture, 1, "normal", "normal_texture_ref")}
  ${sample(STANDARD_PBR_FEATURE.OrmTexture, 2, "orm", "orm_texture_ref")}
  ${sample(STANDARD_PBR_FEATURE.EmissiveTexture, 3, "emissive", "emissive_texture_ref")}
  return result;
}
`;
}
