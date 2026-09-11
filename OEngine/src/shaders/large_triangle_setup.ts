import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_GEOMETRY_VERTEX_DECODE_WGSL,
  GPU_MESHLET_RECORD_WGSL
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import {
  GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET,
  GPU_TRIANGLE_SETUP_RECORD_WGSL
} from "../gpu/GpuLargeTriangleSetupAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";

export const LARGE_TRIANGLE_SETUP_WORKGROUP_SIZE = 64;
export const LARGE_TRIANGLE_SETUP_SETTINGS_SIZE = 32;

const SETUP_ATTEMPTED = counterByteOffset("setupAttempted") / 4;
const SETUP_WRITTEN = counterByteOffset("setupWritten") / 4;
const SETUP_OVERFLOW = counterByteOffset("setupOverflow") / 4;

/** Optional, dense VisibilityKey V2 -> large-triangle shading setup builder. */
export const LARGE_TRIANGLE_SETUP_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_TRIANGLE_SETUP_RECORD_WGSL}

struct OEngineLargeTriangleSetupSettings {
  viewport: vec2u,
  work_capacity: u32,
  setup_capacity: u32,
  counters_enabled: u32,
  threshold_pixels: u32,
  dispatch_width: u32,
  reserved: u32,
};

@group(0) @binding(0) var<uniform> setup_camera: CommandEncoder;
@group(0) @binding(1) var<uniform> setup_settings: OEngineLargeTriangleSetupSettings;
@group(0) @binding(2) var<storage, read> setup_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> setup_instances: array<OEngineInstanceRecord>;
@group(0) @binding(4) var<storage, read> setup_geometries: array<GpuGeometryRecord>;
@group(0) @binding(5) var<storage, read> setup_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(6) var<storage, read> setup_meshlet_vertices: array<u32>;
@group(0) @binding(7) var<storage, read> setup_meshlet_triangles: array<u32>;
@group(0) @binding(8) var<storage, read> setup_vertex_data: array<u32>;
@group(0) @binding(9) var<storage, read_write> setup_records: array<OEngineTriangleSetupRecord>;
@group(0) @binding(10) var<storage, read_write> setup_counters: array<atomic<u32>>;

fn setup_empty() -> OEngineTriangleSetupRecord {
  return OEngineTriangleSetupRecord(0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0u);
}

fn setup_read_u8(byte_offset: u32) -> u32 {
  let word = setup_meshlet_triangles[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

fn setup_finite(value: vec4f) -> bool {
  return all(value == value) && all(abs(value) <= vec4f(3.402823466e+38));
}

fn build_large_triangle_setup(
  work: OEngineMeshletRasterWork,
  triangle: u32
) -> OEngineTriangleSetupRecord {
  if work.instance_slot >= arrayLength(&setup_instances) ||
      work.geometry_slot >= arrayLength(&setup_geometries) ||
      work.meshlet_slot >= arrayLength(&setup_meshlets) { return setup_empty(); }
  let instance = setup_instances[work.instance_slot];
  let geometry = setup_geometries[work.geometry_slot];
  let meshlet = setup_meshlets[work.meshlet_slot];
  if triangle >= meshlet.triangle_count { return setup_empty(); }
  let triangle_byte = meshlet.triangle_byte_offset + triangle * 3u;
  let local0 = setup_read_u8(triangle_byte);
  let local1 = setup_read_u8(triangle_byte + 1u);
  let local2 = setup_read_u8(triangle_byte + 2u);
  if local0 >= meshlet.vertex_count || local1 >= meshlet.vertex_count ||
      local2 >= meshlet.vertex_count { return setup_empty(); }
  let source0 = setup_meshlet_vertices[meshlet.vertex_offset + local0];
  let source1 = setup_meshlet_vertices[meshlet.vertex_offset + local1];
  let source2 = setup_meshlet_vertices[meshlet.vertex_offset + local2];
  if source0 >= geometry.vertex_count || source1 >= geometry.vertex_count ||
      source2 >= geometry.vertex_count { return setup_empty(); }
  let transform = setup_camera.view_projection_matrix *
    oengine_instance_current_object_to_world(instance);
  let a = transform * vec4f(oengine_geometry_position(&setup_vertex_data, geometry, source0), 1.0);
  let b = transform * vec4f(oengine_geometry_position(&setup_vertex_data, geometry, source1), 1.0);
  let c = transform * vec4f(oengine_geometry_position(&setup_vertex_data, geometry, source2), 1.0);
  if !setup_finite(a) || !setup_finite(b) || !setup_finite(c) ||
      a.w <= 0.0 || b.w <= 0.0 || c.w <= 0.0 ||
      a.z < 0.0 || b.z < 0.0 || c.z < 0.0 { return setup_empty(); }
  let viewport = vec2f(setup_settings.viewport);
  let p0 = vec2f(a.x / a.w * 0.5 + 0.5, 0.5 - a.y / a.w * 0.5) * viewport;
  let p1 = vec2f(b.x / b.w * 0.5 + 0.5, 0.5 - b.y / b.w * 0.5) * viewport;
  let p2 = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5) * viewport;
  let denominator = (p1.y - p2.y) * (p0.x - p2.x) +
    (p2.x - p1.x) * (p0.y - p2.y);
  if abs(denominator) < 1e-8 ||
      abs(denominator) * 0.5 < f32(setup_settings.threshold_pixels) {
    return setup_empty();
  }
  let center = viewport * 0.5;
  let lambda0 = ((p1.y - p2.y) * (center.x - p2.x) +
    (p2.x - p1.x) * (center.y - p2.y)) / denominator;
  let lambda1 = ((p2.y - p0.y) * (center.x - p2.x) +
    (p0.x - p2.x) * (center.y - p2.y)) / denominator;
  let reciprocal_w = vec3f(1.0 / a.w, 1.0 / b.w, 1.0 / c.w);
  let q = vec3f(lambda0, lambda1, 1.0 - lambda0 - lambda1) * reciprocal_w;
  return OEngineTriangleSetupRecord(
    q.x, q.y, q.z,
    (p1.y - p2.y) / denominator * reciprocal_w.x,
    (p2.y - p0.y) / denominator * reciprocal_w.y,
    (p0.y - p1.y) / denominator * reciprocal_w.z,
    (p2.x - p1.x) / denominator * reciprocal_w.x,
    (p0.x - p2.x) / denominator * reciprocal_w.y,
    (p1.x - p0.x) / denominator * reciprocal_w.z,
    1u
  );
}

@compute @workgroup_size(${LARGE_TRIANGLE_SETUP_WORKGROUP_SIZE})
fn build_large_triangle_setups(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  let group_linear = id.y * grid.x + id.x / ${LARGE_TRIANGLE_SETUP_WORKGROUP_SIZE}u;
  let linear = group_linear * ${LARGE_TRIANGLE_SETUP_WORKGROUP_SIZE}u +
    id.x % ${LARGE_TRIANGLE_SETUP_WORKGROUP_SIZE}u;
  let work_slot = linear / ${GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET}u;
  let local_primitive = linear % ${GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET}u;
  let written = min(setup_work.header.written_count,
    min(setup_work.header.capacity, setup_settings.work_capacity));
  if work_slot >= written || work_slot >= arrayLength(&setup_work.elements) { return; }
  let record = build_large_triangle_setup(setup_work.elements[work_slot], local_primitive);
  if record.flags == 0u { return; }
  if setup_settings.counters_enabled != 0u {
    atomicAdd(&setup_counters[${SETUP_ATTEMPTED}u], 1u);
  }
  if linear >= setup_settings.setup_capacity || linear >= arrayLength(&setup_records) {
    if setup_settings.counters_enabled != 0u {
      atomicAdd(&setup_counters[${SETUP_OVERFLOW}u], 1u);
    }
    return;
  }
  setup_records[linear] = record;
  if setup_settings.counters_enabled != 0u {
    atomicAdd(&setup_counters[${SETUP_WRITTEN}u], 1u);
  }
}
`;
