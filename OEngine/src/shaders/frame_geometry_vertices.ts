import { surfaceGeometryDecodeWgsl } from "./surface_geometry_reader.js";
export { frameGeometrySourceWgsl, FRAME_ATTRIBUTE_OCT_DECODE_WGSL } from "./geometry_source_decode.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import {
  GPU_MESHLET_RASTER_WORK_WGSL,
  GPU_MESHLET_RASTER_FLAGS as F,
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import { FRAME_GEOMETRY_WGSL } from "../gpu/GpuWinnerInterpolationAbi.js";

export const FRAME_VERTEX_SETTINGS_SIZE = 64;
export const FRAME_VERTEX_CONTROL_SIZE = 32;
export const FRAME_VERTEX_WORKGROUP_SIZE = 128;

export function frameGeometryVerticesWgsl(product: boolean, observe = false): string {
  const sources = surfaceGeometryDecodeWgsl(product, "asset_heap", false);
  return /* wgsl */ `requires unrestricted_pointer_parameters;
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${FRAME_GEOMETRY_WGSL}
struct FrameVertexSettings { work_capacity: u32, vertex_capacity: u32, triangle_capacity: u32, max_workgroups: u32,
  reserved: vec4u, source: vec4u, source_payload: vec4u, }
struct FrameVertexControl { vertices: atomic<u32>, triangles: atomic<u32>, committed: atomic<u32>, misses: atomic<u32>,
  grid_x: u32, grid_y: u32, generation: u32, reserved: u32, }
@group(0) @binding(0) var<uniform> settings: FrameVertexSettings;
@group(0) @binding(1) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(2) var<storage, read> work_queue: OEngineMeshletWorkQueueRead;
@group(0) @binding(13) var<storage, read_write> frame_directory: FrameGeometryDirectory;
@group(0) @binding(14) var<storage, read_write> frame_clips: array<vec4f>;
@group(0) @binding(15) var<storage, read_write> frame_triangles: array<u32>;
@group(0) @binding(16) var<storage, read_write> control: FrameVertexControl;
@group(1) @binding(0) var<storage, read_write> frame_indirect: vec4u;
@group(2) @binding(0) var<storage, read> recovery_indices: array<u32>;
@group(0) @binding(3) var<storage, read> asset_heap: array<u32>;
@group(0) @binding(7) var<storage, read> vertex_payload: array<u32>;
${
  product
    ? `@group(0) @binding(8) var<storage, read> product_heap: array<u32>;
${Array.from({ length: 4 }, (_, i) => `@group(0) @binding(${9 + i}) var<storage, read> product_bank_${i}: array<u32>;`).join("\n")}`
    : ""
}
${sources}
var<workgroup> vertex_base: u32;
var<workgroup> triangle_base: u32;
var<workgroup> source_counts: vec2u;
var<workgroup> source_clip_matrix: mat4x4f;
var<workgroup> recovery_valid: u32;

fn frame_vertex_reserve(counter: ptr<storage, atomic<u32>, read_write>, count: u32, capacity: u32) -> u32 {
  // A reservation cannot fail because another workgroup won a CAS race.
  // Each admitted work contributes at most 128 vertices/triangles, so the
  // request sum fits u32; only a real capacity miss leaves a directory empty.
  let base = atomicAdd(counter, count);
  if count > capacity - min(base, capacity) { return 0xffffffffu; }
  return base;
}
@compute @workgroup_size(1)
fn frame_vertices_begin() {
  let count = select(min(work_queue.header.written_count, min(work_queue.header.capacity, settings.work_capacity)), 0u,
    work_queue.header.generation == 0u);
  let x = min(count, settings.max_workgroups);
  control.grid_x = x; control.grid_y = select((count + max(x, 1u) - 1u) / max(x, 1u), 1u, count == 0u);
  control.generation = work_queue.header.generation; control.reserved = 0u;
  atomicStore(&control.vertices, 0u); atomicStore(&control.triangles, 0u);
  atomicStore(&control.committed, 0u); atomicStore(&control.misses, 0u);
  frame_directory.work_count = count; frame_directory.generation = work_queue.header.generation;
  frame_directory.vertex_count = 0u; frame_directory.triangle_count = 0u;
  frame_indirect = vec4u(x, control.grid_y, 1u, 0u);
}
fn frame_vertices_setup(slot: u32) {
    source_counts = vec2u(0u); vertex_base = 0xffffffffu; triangle_base = 0xffffffffu;
    if slot >= frame_directory.work_count { return; }
    let work = work_queue.elements[slot];
    frame_directory.meshlets[slot] = FrameGeometryMeshlet(0u, 0u, 0u, 0u, 0u, 0u);
    if (work.packed_raster_flags & ${F.OcclusionDeferred}u) != 0u { return; }
    if work.instance_slot < arrayLength(&frame_instances) && frame_instances[work.instance_slot].generation == control.generation {
      source_counts = surface_source_load(work);
      source_clip_matrix = frame_instances[work.instance_slot].object_to_clip;
      if all(source_counts > vec2u(0u)) && all(source_counts <= vec2u(${FRAME_VERTEX_WORKGROUP_SIZE}u)) {
        vertex_base = frame_vertex_reserve(&control.vertices, source_counts.x, settings.vertex_capacity);
        if vertex_base != 0xffffffffu {
          triangle_base = frame_vertex_reserve(&control.triangles, source_counts.y, settings.triangle_capacity);
        }
      }
    }
    if vertex_base != 0xffffffffu && triangle_base != 0xffffffffu {
      var resident_address = settings.source_payload.x + source_geometry.resident_attribute_word_offset;
      var vertex_indices = settings.source.z + source_meshlet.vertex_offset;
      ${
        product
          ? `if surface_source_product {
        resident_address = product_source_resident_address;
        vertex_indices = 0xffffffffu;
      }`
          : ""
      }
      frame_directory.meshlets[slot] = FrameGeometryMeshlet(vertex_base, triangle_base, source_counts.x, source_counts.y, resident_address, vertex_indices);
      ${observe ? "atomicAdd(&control.committed, 1u);" : ""}
    } else { ${observe ? "atomicAdd(&control.misses, 1u);" : ""} }
}
@compute @workgroup_size(${FRAME_VERTEX_WORKGROUP_SIZE})
fn frame_vertices_build(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let slot = group.y * control.grid_x + group.x;
  if lane == 0u { frame_vertices_setup(slot); }
  workgroupBarrier();
  if vertex_base == 0xffffffffu || triangle_base == 0xffffffffu { return; }
  if lane < source_counts.x {
    let at = vertex_base + lane;
    let position = surface_source_vertex_position(lane);
    frame_clips[at] = source_clip_matrix * vec4f(position, 1.0);
  }
  if lane < source_counts.y {
    frame_triangles[triangle_base + lane] = surface_source_triangle_corner(lane, 0u) |
      (surface_source_triangle_corner(lane, 1u) << 8u) | (surface_source_triangle_corner(lane, 2u) << 16u);
  }
}
@compute @workgroup_size(1)
fn frame_vertices_finalize() {
  // Vertex reservation can leave an unreferenced hole if triangle reservation
  // fails. Published directory entries only reference complete paired storage.
  frame_directory.vertex_count = min(atomicLoad(&control.vertices), settings.vertex_capacity);
  frame_directory.triangle_count = min(atomicLoad(&control.triangles), settings.triangle_capacity);
}
@compute @workgroup_size(1)
fn frame_vertices_recovery_begin() {
  let count = recovery_indices[0];
  let x = min(count, settings.max_workgroups);
  control.grid_x = x; control.grid_y = max(1u, (count + max(x, 1u) - 1u) / max(x, 1u));
  frame_indirect = vec4u(x, control.grid_y, 1u, 0u);
}
@compute @workgroup_size(${FRAME_VERTEX_WORKGROUP_SIZE})
fn frame_vertices_recovery_build(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let index = group.y * control.grid_x + group.x;
  if lane == 0u {
    recovery_valid = 0u;
    if index < recovery_indices[0] {
      let slot = recovery_indices[8u + index];
      if (work_queue.elements[slot].packed_raster_flags & ${F.OcclusionRecovered}u) != 0u {
        recovery_valid = 1u;
        frame_vertices_setup(slot);
      }
    }
  }
  if workgroupUniformLoad(&recovery_valid) == 0u { return; }
  if vertex_base == 0xffffffffu || triangle_base == 0xffffffffu { return; }
  if lane < source_counts.x {
    frame_clips[vertex_base + lane] = source_clip_matrix * vec4f(surface_source_vertex_position(lane), 1.0);
  }
  if lane < source_counts.y {
    frame_triangles[triangle_base + lane] = surface_source_triangle_corner(lane, 0u) |
      (surface_source_triangle_corner(lane, 1u) << 8u) | (surface_source_triangle_corner(lane, 2u) << 16u);
  }
}
`;
}
