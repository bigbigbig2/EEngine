/**
 * 统一 Render Debug View 的 authored WGSL。
 *
 * 三个 shader 都只在 debug view 启用时执行一个全屏三角形。输入只读，
 * 输出为 rgba16float；输出尺寸可与内部渲染尺寸不同，坐标按整数比例映射。
 */

import { GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import {
  GPU_SURFACE_ABI_WGSL,
  GPU_SURFACE_FORMATS
} from "../gpu/GpuSurfaceAbi.js";
import {
  GPU_VISIBILITY_DEBUG_COLORS,
  GPU_VISIBILITY_DEBUG_STATUS_WGSL
} from "../gpu/GpuVisibilityDebugResolve.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import {
  GPU_RASTER_WORK_SCHEMA,
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA
} from "../gpu/GpuWorkGenerationAbi.js";
import { VIS_MESH_CLEAR_SENTINEL } from "../render/VisibilityBufferContract.js";
import { SSR_FULLSCREEN_VERTEX_WGSL } from "./ssr_common.js";
import { GBUFFER_ENCODE_WGSL } from "./gbuffer_encode.js";

export const RENDER_DEBUG_VIEW_FORMAT = GPU_SURFACE_FORMATS.hdrColor;

const DEBUG_VIEW_SETTINGS_WGSL = /* wgsl */ `
struct DebugViewSettings {
  output_size: vec2u,
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
${GPU_SURFACE_ABI_WGSL}
`;

export const SURFACE_COLOR_DEBUG_WGSL = /* wgsl */ `
${SURFACE_DEBUG_COMMON_WGSL}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var surface_metadata: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(source));
  let metadata = textureLoad(surface_metadata, coordinate, 0).r;
  if !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID) {
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
  if !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID) {
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
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var surface_metadata: texture_2d<u32>;
@group(0) @binding(2) var<uniform> settings: DebugViewSettings;
@group(0) @binding(3) var<uniform> mode: SurfaceDebugMode;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(source));
  let metadata = textureLoad(surface_metadata, coordinate, 0).r;
  if !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let pbr = textureLoad(source, coordinate, 0);
  let value = select(pbr.x, pbr.y, mode.value.x == 1u);
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
  if !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID) {
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
  if !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  return vec4f(rgbe9995_decode(textureLoad(source, coordinate, 0).r), 1.0);
}
`;

export const SURFACE_FLAGS_DEBUG_WGSL = /* wgsl */ `
${SURFACE_DEBUG_COMMON_WGSL}
${DEBUG_HASH_WGSL}
struct SurfaceDebugMode { value: vec4u, }
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var<uniform> settings: DebugViewSettings;
@group(0) @binding(2) var<uniform> mode: SurfaceDebugMode;
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = source_coordinate(position.xy, textureDimensions(source));
  let packed = textureLoad(source, coordinate, 0).r;
  let material_slot = oengine_surface_material_slot(packed);
  let flags = oengine_surface_flags(packed);
  if (flags & OENGINE_SURFACE_FLAG_VALID) == 0u {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if mode.value.x == 0u {
    let hash = avalanche_hash(material_slot);
    return vec4f(0.15 + vec3f(
      f32(hash & 255u), f32((hash >> 8u) & 255u), f32((hash >> 16u) & 255u)
    ) / 255.0 * 0.65, 1.0);
  }
  if mode.value.x == 1u {
    return select(vec4f(1.0, 0.1, 0.05, 1.0), vec4f(0.1, 1.0, 0.2, 1.0), (flags & OENGINE_SURFACE_FLAG_MOTION_VALID) != 0u);
  }
  return select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(1.0, 0.1, 0.05, 1.0), (flags & OENGINE_SURFACE_FLAG_REACTIVE) != 0u);
}
`;

export const PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}

${GPU_VISIBILITY_KEY_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.wgsl}
${GPU_RASTER_WORK_SCHEMA.wgsl}
${GPU_VISIBILITY_DEBUG_STATUS_WGSL}

struct R4DebugQueueHeaderRead {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  rejected_cone: u32,
  rejected_hzb: u32,
}

struct R4DebugVisibleClusterQueue {
  header: R4DebugQueueHeaderRead,
  elements: array<OEngineVisibleClusterRecord>,
}

struct R4DebugRasterWorkQueue {
  header: R4DebugQueueHeaderRead,
  elements: array<OEngineRasterWork>,
}

struct R4DebugResolveSettings {
  output_size: vec2u,
  meshlet_record_count: u32,
  cluster_record_count: u32,
  instance_record_count: u32,
  geometry_record_count: u32,
  material_capacity: u32,
  _pad0: u32,
}

@group(0) @binding(0) var visibility_keys: texture_2d<u32>;
@group(0) @binding(1) var<storage, read> debug_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> debug_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> debug_visible_clusters: R4DebugVisibleClusterQueue;
@group(0) @binding(4) var<storage, read> debug_raster_work: R4DebugRasterWorkQueue;
@group(0) @binding(5) var<storage, read> debug_materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(6) var<uniform> settings: R4DebugResolveSettings;

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
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.RasterWorkOutOfRange.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_VISIBLE_CLUSTER_OOB {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.VisibleClusterOutOfRange.join(", ")});
  }
  if status == OENGINE_VIS_DEBUG_CLUSTER_RECORD_OOB {
    return vec3f(${GPU_VISIBILITY_DEBUG_COLORS.ClusterRecordOutOfRange.join(", ")});
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

  let raster_work_slot = oengine_visibility_key_raster_work_slot(key);
  let local_triangle = oengine_visibility_key_local_triangle(key);
  let raster_work_count = min(
    debug_raster_work.header.written,
    arrayLength(&debug_raster_work.elements)
  );
  if raster_work_slot >= raster_work_count {
    return fail(OENGINE_VIS_DEBUG_RASTER_WORK_OOB);
  }
  let work = debug_raster_work.elements[raster_work_slot];

  let visible_cluster_count = min(
    debug_visible_clusters.header.written,
    arrayLength(&debug_visible_clusters.elements)
  );
  if work.visible_cluster_slot >= visible_cluster_count {
    return fail(OENGINE_VIS_DEBUG_VISIBLE_CLUSTER_OOB);
  }
  let visible = debug_visible_clusters.elements[work.visible_cluster_slot];
  if visible.cluster_record_index >= settings.cluster_record_count {
    return fail(OENGINE_VIS_DEBUG_CLUSTER_RECORD_OOB);
  }
  if work.meshlet_record_index >= min(
    settings.meshlet_record_count,
    arrayLength(&debug_meshlets)
  ) {
    return fail(OENGINE_VIS_DEBUG_MESHLET_OOB);
  }
  let meshlet = debug_meshlets[work.meshlet_record_index];
  if local_triangle >= meshlet.triangle_count {
    return fail(OENGINE_VIS_DEBUG_TRIANGLE_OOB);
  }
  if visible.instance_record_index >= min(
    settings.instance_record_count,
    arrayLength(&debug_instances)
  ) {
    return fail(OENGINE_VIS_DEBUG_INSTANCE_OOB);
  }
  let instance = debug_instances[visible.instance_record_index];
  if !oengine_instance_active(instance) {
    return fail(OENGINE_VIS_DEBUG_INACTIVE_INSTANCE);
  }
  if visible.geometry_record_index >= settings.geometry_record_count {
    return fail(OENGINE_VIS_DEBUG_GEOMETRY_OOB);
  }
  if instance.geometry_record_index != visible.geometry_record_index ||
    instance.material_handle != visible.material_handle {
    return fail(OENGINE_VIS_DEBUG_IDENTITY_MISMATCH);
  }
  if visible.material_handle >= min(
    settings.material_capacity,
    arrayLength(&debug_materials)
  ) {
    return fail(OENGINE_VIS_DEBUG_MATERIAL_OOB);
  }
  let material = debug_materials[visible.material_handle];
  if (material.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u ||
    material.material_id != visible.material_handle {
    return fail(OENGINE_VIS_DEBUG_MATERIAL_INVALID);
  }
  if material.alpha_mode == OENGINE_MATERIAL_ALPHA_BLEND {
    return fail(OENGINE_VIS_DEBUG_BLEND_MATERIAL);
  }

  let identity_hash = avalanche_hash(
    raster_work_slot ^
    avalanche_hash(work.visible_cluster_slot + 0x9e3779b9u) ^
    avalanche_hash(work.meshlet_record_index + local_triangle * 0x85ebca6bu) ^
    avalanche_hash(instance.debug_id + visible.geometry_record_index * 0xc2b2ae35u) ^
    avalanche_hash(visible.material_handle + visible.cluster_record_index)
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
${GPU_SURFACE_ABI_WGSL}

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
  if !oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID) {
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
