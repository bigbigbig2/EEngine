import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_GEOMETRY_RECORD_WGSL, GPU_MESHLET_RECORD_WGSL, GPU_GEOMETRY_VERTEX_DECODE_WGSL, GPU_UV_FORMAT, GPU_NORMAL_FORMAT } from "../gpu/GpuGeometryAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { FRAME_GEOMETRY_WGSL } from "../gpu/GpuWinnerInterpolationAbi.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";

export const FRAME_VERTEX_SETTINGS_SIZE = 32;
export const FRAME_VERTEX_CONTROL_SIZE = 32;
export const FRAME_VERTEX_WORKGROUP_SIZE = 128;

/** Selected meshlet-local vertices once per frame; ordinary decode is the
 * published Geometry ABI, Product decode is the existing Nyx Float32 profile.
 * No persistent attributes/residency claim is implied by this frame product. */
export function frameGeometryVerticesWgsl(product: boolean, observe = false): string {
  const sources = product ? /* wgsl */ `
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}
@group(0) @binding(8) var<storage, read> product_heap: array<u32>;
${Array.from({ length: 4 }, (_, i) => `@group(0) @binding(${i + 9}) var<storage, read> product_bank_${i}: array<u32>;`).join("\n")}
fn frame_vertex_word(bank: u32, word: u32) -> u32 {
${Array.from({ length: 4 }, (_, i) => `  if bank == ${i}u { return product_bank_${i}[word]; }`).join("\n")}
  return 0u;
}
fn frame_vertex_group_header(location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1) -> OEngineVirtualGroupHeaderV1 {
${Array.from({ length: 4 }, (_, i) => `  if location.bank_index == ${i}u { return oengine_virtual_group_header_v1(&product_bank_${i}, location, group); }`).join("\n")}
  return oengine_virtual_invalid_group_header_v1();
}
fn frame_vertex_meshlet_header(location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1,
  header: OEngineVirtualGroupHeaderV1, local: u32) -> OEngineVirtualMeshletHeaderV1 {
${Array.from({ length: 4 }, (_, i) => `  if location.bank_index == ${i}u { return oengine_virtual_meshlet_header_v1(&product_bank_${i}, location, group, header, local); }`).join("\n")}
  return oengine_virtual_invalid_meshlet_header_v1();
}
var<workgroup> source_bank: u32;
var<workgroup> source_vertex_byte: u32;
var<workgroup> source_vertex_stride: u32;
var<workgroup> source_position_offset: u32;
var<workgroup> source_triangle_byte: u32;
fn frame_vertex_load_source(work: OEngineMeshletRasterWork) -> vec2u {
  let asset = oengine_geometry_product_resolve_asset_v1(&product_heap, work.geometry_slot,
    oengine_instance_geometry_generation(frame_instances[work.instance_slot].source));
  let group = oengine_virtual_group_v1(&product_heap, asset, work.meshlet_slot >> 7u);
  let location = oengine_geometry_product_lookup_page_heap_v1(&product_heap, asset, group.page_id);
  if !asset.valid || !group.valid || !location.valid || location.bank_index >= 4u { return vec2u(0u); }
  let header = frame_vertex_group_header(location, group);
  let meshlet = frame_vertex_meshlet_header(location, group, header, work.meshlet_slot & 127u);
  if !header.valid || !meshlet.valid || header.vertex_format_id >= asset.vertex_format_count { return vec2u(0u); }
  let at = asset.vertex_format_word_offset + header.vertex_format_id * 4u;
  source_bank = location.bank_index;
  source_vertex_byte = location.byte_offset + group.offset_in_page + meshlet.vertex_byte_offset;
  source_vertex_stride = product_heap[at] & 0xffffu;
  source_position_offset = product_heap[at + 1u] & 255u;
  source_triangle_byte = location.byte_offset + group.offset_in_page + meshlet.triangle_byte_offset;
  return vec2u(meshlet.vertex_count, meshlet.triangle_count);
}
fn frame_vertex_position(vertex: u32) -> vec3f {
  let at = (source_vertex_byte + vertex * source_vertex_stride + source_position_offset) >> 2u;
  return vec3f(bitcast<f32>(frame_vertex_word(source_bank, at)), bitcast<f32>(frame_vertex_word(source_bank, at + 1u)),
    bitcast<f32>(frame_vertex_word(source_bank, at + 2u)));
}
fn frame_vertex_normal(_vertex: u32) -> vec4f { return vec4f(0.0, 0.0, 1.0, 0.0); }
fn frame_vertex_tangent(_vertex: u32) -> vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }
fn frame_vertex_uv(_vertex: u32) -> vec4f { return vec4f(0.0); }
fn frame_vertex_color(_vertex: u32) -> vec4f { return vec4f(1.0); }
fn frame_vertex_joints(_vertex: u32) -> vec4f { return vec4f(0.0); }
fn frame_vertex_weights(_vertex: u32) -> vec4f { return vec4f(0.0); }
fn frame_triangle_corner(triangle: u32, corner: u32) -> u32 {
  let byte = source_triangle_byte + triangle * 3u + corner;
  return (frame_vertex_word(source_bank, byte >> 2u) >> ((byte & 3u) * 8u)) & 255u;
}` : /* wgsl */ `
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
@group(0) @binding(3) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(0) @binding(4) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(0) @binding(5) var<storage, read> meshlet_vertices: array<u32>;
@group(0) @binding(6) var<storage, read> meshlet_triangles: array<u32>;
@group(0) @binding(7) var<storage, read> vertex_payload: array<u32>;
var<workgroup> source_geometry: GpuGeometryRecord;
var<workgroup> source_meshlet: GpuMeshletRecord;
fn frame_vertex_load_source(work: OEngineMeshletRasterWork) -> vec2u {
  if work.geometry_slot >= arrayLength(&geometries) || work.meshlet_slot >= arrayLength(&meshlets) { return vec2u(0u); }
  source_geometry = geometries[work.geometry_slot]; source_meshlet = meshlets[work.meshlet_slot];
  return vec2u(source_meshlet.vertex_count, source_meshlet.triangle_count);
}
fn frame_vertex_position(vertex: u32) -> vec3f {
  return oengine_geometry_position(&vertex_payload, source_geometry, meshlet_vertices[source_meshlet.vertex_offset + vertex]);
}
fn frame_vertex_normal(vertex: u32) -> vec4f {
  let index = meshlet_vertices[source_meshlet.vertex_offset + vertex];
  if source_geometry.normal_format == ${GPU_NORMAL_FORMAT.OctSnorm16x2}u {
    let byte = source_geometry.normal_byte_offset + index * source_geometry.normal_stride;
    let encoded = unpack2x16snorm(vertex_payload[byte >> 2u]);
    var n = vec3f(encoded, 1.0 - abs(encoded.x) - abs(encoded.y));
    if n.z < 0.0 { n = vec3f((1.0 - abs(n.y)) * select(-1.0, 1.0, n.x >= 0.0), (1.0 - abs(n.x)) * select(-1.0, 1.0, n.y >= 0.0), n.z); }
    return vec4f(normalize(n), 0.0);
  }
  return vec4f(0.0, 0.0, 1.0, 0.0);
}
fn frame_vertex_tangent(_vertex: u32) -> vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }
fn frame_vertex_uv(vertex: u32) -> vec4f {
  let index = meshlet_vertices[source_meshlet.vertex_offset + vertex];
  let byte = source_geometry.uv0_byte_offset + index * source_geometry.uv0_stride;
  if source_geometry.uv0_format == ${GPU_UV_FORMAT.Float32x2}u { let at = byte >> 2u; return vec4f(bitcast<f32>(vertex_payload[at]), bitcast<f32>(vertex_payload[at + 1u]), 0.0, 0.0); }
  if source_geometry.uv0_format == ${GPU_UV_FORMAT.Float16x2}u { return vec4f(unpack2x16float(vertex_payload[byte >> 2u]), 0.0, 0.0); }
  return vec4f(0.0);
}
fn frame_vertex_color(_vertex: u32) -> vec4f { return vec4f(1.0); }
fn frame_vertex_joints(_vertex: u32) -> vec4f { return vec4f(0.0); }
fn frame_vertex_weights(_vertex: u32) -> vec4f { return vec4f(0.0); }
fn frame_triangle_corner(triangle: u32, corner: u32) -> u32 {
  let byte = source_meshlet.triangle_byte_offset + triangle * 3u + corner;
  return (meshlet_triangles[byte >> 2u] >> ((byte & 3u) * 8u)) & 255u;
}`;
  return /* wgsl */ `requires unrestricted_pointer_parameters;
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${FRAME_GEOMETRY_WGSL}
struct FrameVertexSettings { work_capacity: u32, vertex_capacity: u32, triangle_capacity: u32, max_workgroups: u32,
  reserved: vec4u, }
struct FrameVertexControl { vertices: atomic<u32>, triangles: atomic<u32>, committed: atomic<u32>, misses: atomic<u32>,
  grid_x: u32, grid_y: u32, generation: u32, reserved: u32, }
@group(0) @binding(0) var<uniform> settings: FrameVertexSettings;
@group(0) @binding(1) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(2) var<storage, read> work_queue: OEngineMeshletWorkQueueRead;
@group(0) @binding(13) var<storage, read_write> frame_directory: FrameGeometryDirectory;
@group(0) @binding(14) var<storage, read_write> frame_clips: array<vec4f>;
@group(0) @binding(15) var<storage, read_write> frame_triangles: array<u32>;
@group(0) @binding(16) var<storage, read_write> control: FrameVertexControl;
@group(0) @binding(17) var<storage, read_write> frame_attributes: array<vec4f>;
@group(1) @binding(0) var<storage, read_write> frame_indirect: vec4u;
${sources}
var<workgroup> vertex_base: u32;
var<workgroup> triangle_base: u32;
var<workgroup> source_counts: vec2u;
var<workgroup> source_clip_matrix: mat4x4f;

fn frame_vertex_reserve(counter: ptr<storage, atomic<u32>, read_write>, count: u32, capacity: u32) -> u32 {
  var observed = atomicLoad(counter);
  for (var retry = 0u; retry < 32u; retry++) {
    if count > capacity - min(observed, capacity) { return 0xffffffffu; }
    let result = atomicCompareExchangeWeak(counter, observed, observed + count);
    if result.exchanged { return observed; }
    observed = result.old_value;
  }
  return 0xffffffffu;
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
    frame_directory.meshlets[slot] = FrameGeometryMeshlet(0u, 0u, 0u, 0u);
    if work.instance_slot < arrayLength(&frame_instances) && frame_instances[work.instance_slot].generation == control.generation {
      source_counts = frame_vertex_load_source(work);
      source_clip_matrix = frame_instances[work.instance_slot].object_to_clip;
      if all(source_counts > vec2u(0u)) && all(source_counts <= vec2u(${FRAME_VERTEX_WORKGROUP_SIZE}u)) {
        vertex_base = frame_vertex_reserve(&control.vertices, source_counts.x, settings.vertex_capacity);
        if vertex_base != 0xffffffffu {
          triangle_base = frame_vertex_reserve(&control.triangles, source_counts.y, settings.triangle_capacity);
        }
      }
    }
    if vertex_base != 0xffffffffu && triangle_base != 0xffffffffu {
      frame_directory.meshlets[slot] = FrameGeometryMeshlet(vertex_base, triangle_base, source_counts.x, source_counts.y);
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
    frame_clips[at] = source_clip_matrix * vec4f(frame_vertex_position(lane), 1.0);
    let base = at * 4u;
    frame_attributes[base] = frame_vertex_normal(lane);
    frame_attributes[base + 1u] = frame_vertex_tangent(lane);
    frame_attributes[base + 2u] = frame_vertex_uv(lane);
    frame_attributes[base + 3u] = frame_vertex_color(lane);
    frame_attributes[base + 4u] = frame_vertex_joints(lane);
    frame_attributes[base + 5u] = frame_vertex_weights(lane);
    frame_attributes[base + 6u] = vec4f(0.0);
    frame_attributes[base + 7u] = vec4f(0.0);
  }
  if lane < source_counts.y {
    frame_triangles[triangle_base + lane] = frame_triangle_corner(lane, 0u) |
      (frame_triangle_corner(lane, 1u) << 8u) | (frame_triangle_corner(lane, 2u) << 16u);
  }
}
@compute @workgroup_size(1)
fn frame_vertices_finalize() {
  // Vertex reservation can leave an unreferenced hole if triangle reservation
  // fails. Published directory entries only reference complete paired storage.
  frame_directory.vertex_count = atomicLoad(&control.vertices);
  frame_directory.triangle_count = atomicLoad(&control.triangles);
}
`;
}
