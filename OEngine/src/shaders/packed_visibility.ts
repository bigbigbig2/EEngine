import { GPU_GEOMETRY_RECORD_WGSL, GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const PACKED_VISIBILITY_WORKGROUP_SIZE = 64;
export const PACKED_VISIBILITY_FIXED_VERTEX_COUNT = 384;

export const PACKED_VISIBILITY_COMPUTE_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}

const COUNTER_CANDIDATE_INSTANCES: u32 = 0u;
const COUNTER_VISIBLE_INSTANCES: u32 = 1u;
const COUNTER_CANDIDATE_CLUSTERS: u32 = 3u;
const COUNTER_SELECTED_CLUSTERS: u32 = 4u;
const COUNTER_REJECTED_FRUSTUM: u32 = 5u;
const COUNTER_HW_CLUSTERS: u32 = 9u;
const COUNTER_HW_TRIANGLES: u32 = 12u;
const COUNTER_OVERFLOW_MASK: u32 = 17u;
const MESHLET_OVERFLOW_BIT: u32 = 2u;

struct PackedVisibilityParams {
  instance_begin: u32,
  instance_count: u32,
  work_capacity: u32,
  counters_enabled: u32,
}

struct PackedMeshletWork {
  instance_record_index: u32,
  meshlet_record_index: u32,
}

struct PackedMeshletWorkQueue {
  written: atomic<u32>,
  attempted: atomic<u32>,
  visible_instances: atomic<u32>,
  rejected_instances: atomic<u32>,
  elements: array<PackedMeshletWork>,
}

struct DrawIndirectArgs {
  vertex_count: u32,
  instance_count: atomic<u32>,
  first_vertex: u32,
  first_instance: u32,
}

@group(0) @binding(0) var<uniform> packed_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> packed_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> packed_geometries: array<GpuGeometryRecord>;
@group(0) @binding(3) var<storage, read_write> packed_work: PackedMeshletWorkQueue;
@group(0) @binding(4) var<storage, read_write> packed_indirect: DrawIndirectArgs;
@group(0) @binding(5) var<storage, read_write> packed_counters: array<atomic<u32>>;
@group(0) @binding(6) var<uniform> packed_params: PackedVisibilityParams;

fn packed_counter_add(index: u32, value: u32) {
  if packed_params.counters_enabled != 0u {
    atomicAdd(&packed_counters[index], value);
  }
}

fn packed_instance_in_frustum(instance: OEngineInstanceRecord) -> bool {
  let local = instance.bounds_sphere;
  let center4 = instance.current_object_to_world * vec4f(local.xyz, 1.0);
  let center = center4.xyz / center4.w;
  let sx = length(instance.current_object_to_world[0].xyz);
  let sy = length(instance.current_object_to_world[1].xyz);
  let sz = length(instance.current_object_to_world[2].xyz);
  let radius = local.w * max(sx, max(sy, sz));
  for (var plane_index = 0u; plane_index < 6u; plane_index++) {
    let plane = packed_camera.frustum[plane_index];
    if dot(center, plane.xyz) + plane.w < -radius { return false; }
  }
  return true;
}

@compute @workgroup_size(${PACKED_VISIBILITY_WORKGROUP_SIZE})
fn compact_packed_meshlets(@builtin(global_invocation_id) id: vec3u) {
  if id.x == 0u {
    packed_indirect.vertex_count = ${PACKED_VISIBILITY_FIXED_VERTEX_COUNT}u;
    packed_indirect.first_vertex = 0u;
    packed_indirect.first_instance = 0u;
    packed_counter_add(COUNTER_CANDIDATE_INSTANCES, packed_params.instance_count);
  }
  if id.x >= packed_params.instance_count { return; }
  let instance_index = packed_params.instance_begin + id.x;
  let instance = packed_instances[instance_index];
  if !oengine_instance_active(instance) || !packed_instance_in_frustum(instance) {
    atomicAdd(&packed_work.rejected_instances, 1u);
    packed_counter_add(COUNTER_REJECTED_FRUSTUM, 1u);
    return;
  }
  atomicAdd(&packed_work.visible_instances, 1u);
  packed_counter_add(COUNTER_VISIBLE_INSTANCES, 1u);
  let geometry = packed_geometries[instance.geometry_record_index];
  packed_counter_add(COUNTER_CANDIDATE_CLUSTERS, geometry.meshlet_count);
  for (var local_meshlet = 0u; local_meshlet < geometry.meshlet_count; local_meshlet++) {
    let output_index = atomicAdd(&packed_work.attempted, 1u);
    if output_index >= packed_params.work_capacity {
      if packed_params.counters_enabled != 0u {
        atomicOr(&packed_counters[COUNTER_OVERFLOW_MASK], MESHLET_OVERFLOW_BIT);
      }
      continue;
    }
    packed_work.elements[output_index] = PackedMeshletWork(
      instance_index,
      geometry.meshlet_begin + local_meshlet
    );
    atomicAdd(&packed_work.written, 1u);
    atomicAdd(&packed_indirect.instance_count, 1u);
    packed_counter_add(COUNTER_SELECTED_CLUSTERS, 1u);
    packed_counter_add(COUNTER_HW_CLUSTERS, 1u);
    packed_counter_add(COUNTER_HW_TRIANGLES, 128u);
  }
}
`;

export const PACKED_VISIBILITY_RASTER_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}

struct PackedMeshletWork {
  instance_record_index: u32,
  meshlet_record_index: u32,
}

struct PackedMeshletWorkQueueRead {
  written: u32,
  attempted: u32,
  visible_instances: u32,
  rejected_instances: u32,
  elements: array<PackedMeshletWork>,
}

struct PackedVisibilityVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) instance_record_index: u32,
  @location(1) @interpolate(flat) encoded_triangle: u32,
}

@group(0) @binding(0) var<uniform> raster_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> raster_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> raster_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> raster_meshlet_vertices: array<u32>;
@group(0) @binding(4) var<storage, read> raster_meshlet_triangles: array<u32>;
@group(0) @binding(5) var<storage, read> raster_vertex_data: array<u32>;
@group(0) @binding(6) var<storage, read> raster_geometries: array<GpuGeometryRecord>;
@group(0) @binding(7) var<storage, read> raster_work: PackedMeshletWorkQueueRead;

fn packed_read_u8(words: ptr<storage, array<u32>, read>, byte_offset: u32) -> u32 {
  let word = (*words)[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

@vertex
fn raster_packed_meshlets(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) work_index: u32
) -> PackedVisibilityVertexOutput {
  let work = raster_work.elements[work_index];
  let instance = raster_instances[work.instance_record_index];
  let geometry = raster_geometries[instance.geometry_record_index];
  let meshlet = raster_meshlets[work.meshlet_record_index];
  let last_corner = max(meshlet.triangle_count * 3u, 1u) - 1u;
  let corner = min(vertex_index, last_corner);
  let triangle_index = corner / 3u;
  let local_vertex = packed_read_u8(
    &raster_meshlet_triangles,
    meshlet.triangle_byte_offset + corner
  );
  let source_vertex = raster_meshlet_vertices[meshlet.vertex_offset + local_vertex];
  let position_word = geometry.position_byte_offset / 4u
    + source_vertex * (geometry.position_stride / 4u);
  let local_position = vec3f(
    bitcast<f32>(raster_vertex_data[position_word]),
    bitcast<f32>(raster_vertex_data[position_word + 1u]),
    bitcast<f32>(raster_vertex_data[position_word + 2u])
  );
  var output: PackedVisibilityVertexOutput;
  output.position = raster_camera.view_projection_matrix
    * instance.current_object_to_world
    * vec4f(local_position, 1.0);
  output.instance_record_index = work.instance_record_index;
  output.encoded_triangle = (work.meshlet_record_index << 8u) | triangle_index;
  return output;
}

struct PackedVisibilityFragmentOutput {
  @location(0) triangle_id: u32,
  @location(1) instance_id: u32,
}

@fragment
fn write_packed_visibility(
  @location(0) @interpolate(flat) instance_record_index: u32,
  @location(1) @interpolate(flat) encoded_triangle: u32
) -> PackedVisibilityFragmentOutput {
  return PackedVisibilityFragmentOutput(encoded_triangle, instance_record_index);
}
`;
