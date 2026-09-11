import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../assets/GeometryAssetPackage.js";
import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_GEOMETRY_VERTEX_DECODE_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_NORMAL_FORMAT,
  GPU_UV_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_TEXTURE_BANK_SAMPLE_WGSL } from "../gpu/GpuTextureRefAbi.js";
import { GPU_SURFACE_ABI_WGSL } from "../gpu/GpuSurfaceAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_VIEW_TYPE } from "../render/ViewManager.js";
import { GBUFFER_ENCODE_WGSL } from "./gbuffer_encode.js";

export const PACKED_MATERIAL_SHARED_WGSL = /* wgsl */ `
${GPU_VIEW_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SURFACE_ABI_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GBUFFER_ENCODE_WGSL}

@group(0) @binding(0) var visibility_keys: texture_2d<u32>;
@group(0) @binding(1) var<uniform> view: PipelineCacheKey;
@group(0) @binding(2) var<uniform> previous_view_projection: mat4x4f;
@group(0) @binding(3) var oengine_texture_bank_0: texture_2d_array<f32>;
@group(0) @binding(4) var sampler_repeat_linear: sampler;
@group(0) @binding(5) var sampler_clamp_linear: sampler;
@group(0) @binding(6) var sampler_mirror_linear: sampler;
@group(0) @binding(7) var sampler_repeat_nearest: sampler;
@group(0) @binding(8) var sampler_clamp_nearest: sampler;
@group(0) @binding(9) var sampler_mirror_nearest: sampler;
@group(0) @binding(10) var<storage, read> materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(11) var oengine_texture_bank_1: texture_2d_array<f32>;
@group(0) @binding(12) var oengine_texture_bank_2: texture_2d_array<f32>;
@group(0) @binding(13) var oengine_texture_bank_3: texture_2d_array<f32>;
@group(0) @binding(14) var oengine_texture_bank_4: texture_2d_array<f32>;
@group(0) @binding(15) var oengine_texture_bank_5: texture_2d_array<f32>;
@group(0) @binding(16) var oengine_texture_bank_6: texture_2d_array<f32>;
@group(0) @binding(17) var oengine_texture_bank_7: texture_2d_array<f32>;
@group(0) @binding(18) var oengine_texture_bank_8: texture_2d_array<f32>;

@group(1) @binding(0) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(1) @binding(1) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(1) @binding(2) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(1) @binding(3) var<storage, read> meshlet_vertices: array<u32>;
@group(1) @binding(4) var<storage, read> meshlet_triangles: array<u32>;
@group(1) @binding(6) var<storage, read> vertex_data: array<u32>;
@group(1) @binding(7) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;

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

fn read_position_direct(geometry: GpuGeometryRecord, vertex: u32) -> vec3f {
  return oengine_geometry_position(&vertex_data, geometry, vertex);
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
    return vec2f(f32(read_u8(offset)), f32(read_u8(offset + 1u))) / 255.0;
  }
  if format == ${GPU_UV_FORMAT.Unorm16x2}u {
    return vec2f(f32(read_u16(offset)), f32(read_u16(offset + 2u))) / 65535.0;
  }
  if format == ${GPU_UV_FORMAT.Float16x2}u {
    return unpack2x16float(vertex_data[offset >> 2u]);
  }
  return vec2f(0.0);
}

fn read_stream_direct(
  byte_offset: u32,
  stride: u32,
  format: u32,
  normalized_flag: u32,
  component_count: u32,
  vertex: u32,
  fallback: vec4f
) -> vec4f {
  if format == 0u { return fallback; }
  let offset = byte_offset + vertex * stride;
  var result = fallback;
  if format == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.float32}u {
    for (var component = 0u; component < min(component_count, 4u); component++) {
      result[component] = bitcast<f32>(vertex_data[(offset >> 2u) + component]);
    }
  } else {
    let bytes = component_bytes(format);
    let normalized = normalized_flag != 0u;
    for (var component = 0u; component < min(component_count, 4u); component++) {
      result[component] = stream_component(offset + component * bytes, format, normalized);
    }
  }
  return result;
}

fn read_normal_direct(geometry: GpuGeometryRecord, vertex: u32, fallback: vec4f) -> vec3f {
  if geometry.normal_format == ${GPU_NORMAL_FORMAT.OctSnorm16x2}u {
    let offset = geometry.normal_byte_offset + vertex * geometry.normal_stride;
    let encoded = unpack2x16snorm(vertex_data[offset >> 2u]);
    var result = vec3f(encoded, 1.0 - abs(encoded.x) - abs(encoded.y));
    if result.z < 0.0 {
      result = vec3f(
        (1.0 - abs(result.y)) * select(-1.0, 1.0, result.x >= 0.0),
        (1.0 - abs(result.x)) * select(-1.0, 1.0, result.y >= 0.0),
        result.z
      );
    }
    return normalize(result);
  }
  return read_stream_direct(
    geometry.normal_byte_offset,
    geometry.normal_stride,
    geometry.normal_format,
    geometry.normal_normalized,
    3u,
    vertex,
    fallback
  ).xyz;
}

fn read_tangent_direct(geometry: GpuGeometryRecord, vertex: u32, fallback: vec4f) -> vec4f {
  return read_stream_direct(
    geometry.tangent_byte_offset,
    geometry.tangent_stride,
    geometry.tangent_format,
    geometry.tangent_normalized,
    4u,
    vertex,
    fallback
  );
}

fn read_color_direct(geometry: GpuGeometryRecord, vertex: u32, fallback: vec4f) -> vec3f {
  return read_stream_direct(
    geometry.color_byte_offset,
    geometry.color_stride,
    geometry.color_format,
    geometry.color_normalized,
    3u,
    vertex,
    fallback
  ).xyz;
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
`;

/**
 * Canonical material texture/UV reconstruction shared by the retired raster
 * oracle and the production compute evaluator. Keeping one WGSL body prevents
 * the Step 2 cutover from silently drifting in sampler, transform or gradient
 * semantics while the raster oracle still exists for parity validation.
 */
export const PACKED_MATERIAL_TEXTURE_SAMPLING_WGSL = /* wgsl */ `
fn material_sampler_class(material: OEngineMaterialVisibilityRecord, slot: u32) -> u32 {
  if slot == 0u { return material.sampler_class; }
  return (material.texture_sampler_classes >> ((slot - 1u) * 8u)) & 0xffu;
}

${GPU_TEXTURE_BANK_SAMPLE_WGSL}

fn sample_material_texture(
  texture_ref: u32, sampler_class: u32, uv: vec2f,
  uv_dx: vec2f, uv_dy: vec2f, gradient_valid: bool, fallback: vec4f
) -> vec4f {
  if !gradient_valid {
    return oengine_sample_texture_bank_level_zero(
      texture_ref, sampler_class, uv, fallback
    );
  }
  return oengine_sample_texture_bank(texture_ref, sampler_class, uv, uv_dx, uv_dy, fallback);
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
`;
