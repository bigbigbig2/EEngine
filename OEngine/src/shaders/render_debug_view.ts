/**
 * 统一 Render Debug View 的 authored WGSL。
 *
 * 三个 shader 都只在 debug view 启用时执行一个全屏三角形。输入只读，
 * 输出为 rgba16float；输出尺寸可与内部渲染尺寸不同，坐标按整数比例映射。
 */

import { GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_SURFACE_LITE_WGSL } from "../gpu/GpuComputeMaterialAbi.js";
import { GPU_HDR_FORMAT } from "../gpu/GpuHdrAbi.js";
import { GPU_COMPUTE_MATERIAL_ABI_WGSL } from "../gpu/GpuComputeMaterialAbi.js";
import {
  GPU_VISIBILITY_DEBUG_COLORS,
  GPU_VISIBILITY_DEBUG_STATUS_WGSL
} from "../gpu/GpuVisibilityDebugResolve.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { VIS_MESH_CLEAR_SENTINEL } from "../render/VisibilityBufferContract.js";
import { SSR_FULLSCREEN_VERTEX_WGSL } from "./ssr_common.js";

export const LINEAR_HDR_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: vec4u;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = textureDimensions(source);
  let output_size = max(settings.xy, vec2u(1u));
  let uv = position.xy / vec2f(output_size);
  let coordinate = min(vec2i(uv * vec2f(dimensions)), vec2i(dimensions) - vec2i(1));
  return vec4f(textureLoad(source, coordinate, 0).rgb, 1.0);
}
`;

export const AMBIENT_OCCLUSION_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: vec4u;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = textureDimensions(source);
  let output_size = max(settings.xy, vec2u(1u));
  let uv = position.xy / vec2f(output_size);
  let coordinate = min(vec2i(uv * vec2f(dimensions)), vec2i(dimensions) - vec2i(1));
  let visibility = clamp(textureLoad(source, coordinate, 0).r, 0.0, 1.0);
  return vec4f(vec3f(visibility), 1.0);
}
`;

export const SSR_HIT_MISS_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var<uniform> settings: vec4u;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = textureDimensions(source);
  let output_size = max(settings.xy, vec2u(1u));
  let uv = position.xy / vec2f(output_size);
  let coordinate = min(vec2i(uv * vec2f(dimensions)), vec2i(dimensions) - vec2i(1));
  let confidence = f32(textureLoad(source, coordinate, 0).y & 0xffu) / 255.0;
  return vec4f(1.0 - confidence, confidence, 0.0, 1.0);
}
`;

export const SSR_HISTORY_CONFIDENCE_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: vec4u;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = textureDimensions(source);
  let output_size = max(settings.xy, vec2u(1u));
  let uv = position.xy / vec2f(output_size);
  let coordinate = min(vec2i(uv * vec2f(dimensions)), vec2i(dimensions) - vec2i(1));
  let confidence = clamp(textureLoad(source, coordinate, 0).a, 0.0, 1.0);
  return vec4f(confidence, confidence, confidence, 1.0);
}
`;
import { GBUFFER_ENCODE_WGSL } from "./gbuffer_encode.js";

export const RENDER_DEBUG_VIEW_FORMAT = GPU_HDR_FORMAT;

const DEBUG_VIEW_SETTINGS_WGSL = /* wgsl */ `
struct DebugViewSettings {
  output_size: vec2u,
  contract: vec2u,
};
`;

const DEBUG_HASH_WGSL = /* wgsl */ `
fn avalanche_hash(value_in: u32) -> u32 {
  var value = value_in;
  value ^= value >> 16u;
  value *= 0x7feb352du;
  value ^= value >> 15u;
  value *= 0x846ca68bu;
  value ^= value >> 16u;
  return value;
}
`;

const DEBUG_VIEW_COORDINATE_WGSL = /* wgsl */ `
fn source_coordinate(position: vec2f, source_size: vec2u) -> vec2i {
  let output_size = max(settings.output_size, vec2u(1u));
  let output_coordinate = vec2u(position);
  let source_coordinate_value = min(
    output_coordinate * source_size / output_size,
    source_size - vec2u(1u)
  );
  return vec2i(source_coordinate_value);
}
`;

export const VISIBILITY_KEY_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}

${DEBUG_VIEW_SETTINGS_WGSL}

@group(0) @binding(0) var mesh_ids: texture_2d<u32>;
@group(0) @binding(1) var triangle_ids: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;

${DEBUG_VIEW_COORDINATE_WGSL}

${DEBUG_HASH_WGSL}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(mesh_ids));
  let mesh_id = textureLoad(mesh_ids, coordinate, 0).r;
  if (mesh_id == ${VIS_MESH_CLEAR_SENTINEL}u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let triangle_id = textureLoad(triangle_ids, coordinate, 0).r;
  let hash = avalanche_hash(mesh_id ^ avalanche_hash(triangle_id + 0x9e3779b9u));
  let color = vec3f(
    f32(hash & 255u),
    f32((hash >> 8u) & 255u),
    f32((hash >> 16u) & 255u)
  ) / 255.0;
  return vec4f(0.15 + color * 0.65, 1.0);
}
`;

const SURFACE_DEBUG_COMMON_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
${DEBUG_VIEW_SETTINGS_WGSL}
${DEBUG_VIEW_COORDINATE_WGSL}
${GPU_SHADING_SURFACE_LITE_WGSL}
${GPU_COMPUTE_MATERIAL_ABI_WGSL}
`;

export const SURFACE_COLOR_DEBUG_WGSL = /* wgsl */ `
${SURFACE_DEBUG_COMMON_WGSL}
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var surface_metadata: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(source));
  let metadata = textureLoad(surface_metadata, coordinate, 0).r;
  if (settings.contract.x == 1u && metadata == ${VIS_MESH_CLEAR_SENTINEL}u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (settings.contract.x == 0u && !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  return vec4f(textureLoad(source, coordinate, 0).rgb, 1.0);
}
`;

export const SURFACE_NORMAL_DEBUG_WGSL = /* wgsl */ `
${SURFACE_DEBUG_COMMON_WGSL}
${GBUFFER_ENCODE_WGSL}
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var surface_metadata: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(source));
  let metadata = textureLoad(surface_metadata, coordinate, 0).r;
  if (settings.contract.x == 1u && metadata == ${VIS_MESH_CLEAR_SENTINEL}u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (settings.contract.x == 0u && !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let encoded = textureLoad(source, coordinate, 0).xy;
  let normal = decode_g_buffer_normal(encoded);
  return vec4f(normal * 0.5 + 0.5, 1.0);
}
`;

export const SURFACE_PBR_DEBUG_WGSL = /* wgsl */ `
${SURFACE_DEBUG_COMMON_WGSL}
struct SurfaceDebugMode { value: vec4u, }
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var surface_metadata: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;
@group(0) @binding(3) var<uniform> mode: SurfaceDebugMode;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(source));
  let metadata = textureLoad(surface_metadata, coordinate, 0).r;
  if (settings.contract.x == 1u && metadata == ${VIS_MESH_CLEAR_SENTINEL}u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (settings.contract.x == 0u && !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let pbr = textureLoad(source, coordinate, 0);
  let value = select(
    oengine_surface_lite_metallic(pbr),
    oengine_surface_lite_roughness(pbr),
    mode.value.x == 1u
  );
  return vec4f(vec3f(value), 1.0);
}
`;

export const SURFACE_AO_DEBUG_WGSL = /* wgsl */ `
${SURFACE_DEBUG_COMMON_WGSL}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var surface_metadata: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(source));
  let metadata = textureLoad(surface_metadata, coordinate, 0).r;
  if (settings.contract.x == 1u && metadata == ${VIS_MESH_CLEAR_SENTINEL}u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (settings.contract.x == 0u && !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  return vec4f(vec3f(textureLoad(source, coordinate, 0).a), 1.0);
}
`;

export const SURFACE_EMISSIVE_DEBUG_WGSL = /* wgsl */ `
${SURFACE_DEBUG_COMMON_WGSL}
${GBUFFER_ENCODE_WGSL}
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var surface_metadata: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(source));
  let metadata = textureLoad(surface_metadata, coordinate, 0).r;
  if (settings.contract.x == 1u && metadata == ${VIS_MESH_CLEAR_SENTINEL}u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (settings.contract.x == 0u && !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  return vec4f(rgbe9995_decode(textureLoad(source, coordinate, 0).g), 1.0);
}
`;

export const SURFACE_FLAGS_DEBUG_WGSL = /* wgsl */ `
${SURFACE_DEBUG_COMMON_WGSL}
struct SurfaceDebugMode { value: vec4u, }
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var<uniform> settings: DebugViewSettings;
@group(0) @binding(2) var<uniform> mode: SurfaceDebugMode;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(source));
  let packed = textureLoad(source, coordinate, 0).r;
  if (settings.contract.x == 1u && packed == ${VIS_MESH_CLEAR_SENTINEL}u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let flags = select(oengine_surface_flags(packed), 0u, settings.contract.x == 1u);
  if (settings.contract.x == 0u && (flags & OENGINE_SURFACE_FLAG_VALID) == 0u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if mode.value.x == 1u {
    return select(vec4f(1.0, 0.1, 0.05, 1.0), vec4f(0.1, 1.0, 0.2, 1.0), settings.contract.x == 0u && (flags & OENGINE_SURFACE_FLAG_MOTION_VALID) != 0u);
  }
  return select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(1.0, 0.1, 0.05, 1.0), settings.contract.x == 0u && (flags & OENGINE_SURFACE_FLAG_REACTIVE) != 0u);
}
`;

export const PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}

${GPU_VISIBILITY_KEY_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_VISIBILITY_DEBUG_STATUS_WGSL}

struct R4DebugResolveSettings {
  output_size: vec2u,
  meshlet_record_count: u32,
  instance_record_count: u32,
  geometry_record_count: u32,
  material_capacity: u32,
  debug_mode: u32,
  _pad1: u32,
}

@group(0) @binding(0) var visibility_keys: texture_2d<u32>;
@group(0) @binding(1) var<storage, read> debug_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> debug_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> debug_meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(4) var<storage, read> debug_materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(5) var<uniform> settings: R4DebugResolveSettings;

${DEBUG_VIEW_COORDINATE_WGSL}
${DEBUG_HASH_WGSL}

fn debug_failure_color(status: u32) -> vec3f {
  if status == OENGINE_VIS_DEBUG_EMPTY {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.Empty.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_INVALID_KEY {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.InvalidKey.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_RASTER_WORK_OOB {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.MeshletWorkOutOfRange.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_MESHLET_OOB {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.MeshletOutOfRange.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_TRIANGLE_OOB {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.TriangleOutOfRange.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_INSTANCE_OOB {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.InstanceOutOfRange.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_GEOMETRY_OOB {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.GeometryOutOfRange.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_MATERIAL_OOB {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.MaterialOutOfRange.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_MATERIAL_INVALID {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.MaterialRecordInvalid.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_INACTIVE_INSTANCE {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.InactiveInstance.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_IDENTITY_MISMATCH {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.IdentityMismatch.join(", ")});
  }
  return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.BlendMaterial.join(", ")});
}

fn fail(status: u32) -> vec4f {
  return vec4f(debug_failure_color(status), 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(visibility_keys));
  let key = textureLoad(visibility_keys, coordinate, 0).r;
  if oengine_visibility_key_is_empty(key) {
    return fail(OENGINE_VIS_DEBUG_EMPTY);
  }
  if !oengine_visibility_key_is_valid(key) {
    return fail(OENGINE_VIS_DEBUG_INVALID_KEY);
  }

  let decoded = oengine_visibility_key_decode(key);
  let meshlet_work_slot = decoded.meshlet_work_slot;
  if debug_meshlet_work.header.generation == 0u ||
    meshlet_work_slot >= min(debug_meshlet_work.header.written_count,
      debug_meshlet_work.header.capacity) ||
    meshlet_work_slot >= arrayLength(&debug_meshlet_work.elements) {
    return fail(OENGINE_VIS_DEBUG_RASTER_WORK_OOB);
  }
  let work = debug_meshlet_work.elements[meshlet_work_slot];
  if (work.packed_profile_lod >> 24u) != OENGINE_VISIBILITY_KEY_PARTITION {
    return fail(OENGINE_VIS_DEBUG_INVALID_KEY);
  }
  if work.meshlet_slot >= min(
    settings.meshlet_record_count,
    arrayLength(&debug_meshlets)
  ) {
    return fail(OENGINE_VIS_DEBUG_MESHLET_OOB);
  }
  let meshlet = debug_meshlets[work.meshlet_slot];
  if decoded.local_primitive >= meshlet.triangle_count {
    return fail(OENGINE_VIS_DEBUG_TRIANGLE_OOB);
  }
  if work.instance_slot >= min(
    settings.instance_record_count,
    arrayLength(&debug_instances)
  ) {
    return fail(OENGINE_VIS_DEBUG_INSTANCE_OOB);
  }
  let instance = debug_instances[work.instance_slot];
  if !oengine_instance_active(instance) {
    return fail(OENGINE_VIS_DEBUG_INACTIVE_INSTANCE);
  }
  if work.geometry_slot >= settings.geometry_record_count {
    return fail(OENGINE_VIS_DEBUG_GEOMETRY_OOB);
  }
  if instance.geometry_record_index != work.geometry_slot ||
    instance.material_handle != work.material_slot_or_range {
    return fail(OENGINE_VIS_DEBUG_IDENTITY_MISMATCH);
  }
  if work.material_slot_or_range >= min(
    settings.material_capacity,
    arrayLength(&debug_materials)
  ) {
    return fail(OENGINE_VIS_DEBUG_MATERIAL_OOB);
  }
  let material = debug_materials[work.material_slot_or_range];
  if (material.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u {
    return fail(OENGINE_VIS_DEBUG_MATERIAL_INVALID);
  }
  if material.alpha_mode == OENGINE_MATERIAL_ALPHA_BLEND {
    return fail(OENGINE_VIS_DEBUG_BLEND_MATERIAL);
  }

  let full_identity_hash = avalanche_hash(
    meshlet_work_slot ^
    avalanche_hash(work.instance_slot + 0x9e3779b9u) ^
    avalanche_hash(work.meshlet_slot + decoded.local_primitive * 0x85ebca6bu) ^
    avalanche_hash(instance.debug_id + work.geometry_slot * 0xc2b2ae35u) ^
    avalanche_hash(work.material_slot_or_range)
  );
  let identity_hash = select(
    full_identity_hash,
    avalanche_hash(work.material_slot_or_range),
    settings.debug_mode == 1u
  );
  var color = 0.15 + vec3f(
    f32(identity_hash & 255u),
    f32((identity_hash >> 8u) & 255u),
    f32((identity_hash >> 16u) & 255u)
  ) / 255.0 * 0.65;
  if material.alpha_mode == OENGINE_MATERIAL_ALPHA_MASK {
    color = mix(color, vec3f(0.1, 0.95, 0.65), 0.38);
  }
  if (material.flags & OENGINE_MATERIAL_VISIBILITY_DOUBLE_SIDED) != 0u {
    color = min(color + vec3f(0.12, 0.08, 0.0), vec3f(1.0));
  }
  return vec4f(color, 1.0);
}
`;

export const DEPTH_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}

${DEBUG_VIEW_SETTINGS_WGSL}

@group(0) @binding(0) var reverse_z_depth: texture_depth_2d;
@group(0) @binding(1) var<uniform> settings: DebugViewSettings;

${DEBUG_VIEW_COORDINATE_WGSL}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(reverse_z_depth));
  let depth = textureLoad(reverse_z_depth, coordinate, 0);
  let enhanced = select(0.0, pow(clamp(depth, 0.0, 1.0), 0.25), depth > 0.0);
  return vec4f(vec3f(enhanced), 1.0);
}
`;

export const VELOCITY_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}

const PI: f32 = 3.141592653589793;

${DEBUG_VIEW_SETTINGS_WGSL}
${GPU_SHADING_SURFACE_LITE_WGSL}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var surface_metadata: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;

${DEBUG_VIEW_COORDINATE_WGSL}

fn hue_to_rgb(hue: f32) -> vec3f {
  let phase = fract(hue + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0));
  return clamp(abs(phase * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = textureDimensions(source);
  let coordinate = source_coordinate(position.xy, dimensions);
  let metadata = textureLoad(surface_metadata, coordinate, 0).r;
  if (settings.contract.x == 1u && metadata == ${VIS_MESH_CLEAR_SENTINEL}u) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (settings.contract.x == 0u && !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let velocity = textureLoad(source, coordinate, 0).rg /
    vec2f(max(dimensions, vec2u(1u)));
  let magnitude = clamp(length(velocity) * 100.0, 0.0, 1.0);
  let hue = (atan2(velocity.y, velocity.x) + PI) / (2.0 * PI);
  let direction_color = hue_to_rgb(hue);
  let background = vec3f(0.08);
  return vec4f(mix(background, direction_color, magnitude), 1.0);
}
`;
