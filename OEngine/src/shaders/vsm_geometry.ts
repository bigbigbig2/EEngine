import { vsmGeometryWgsl } from "../gpu/GpuVsmGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL, GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { NATIVE_RASTER_DIRECTORY_WGSL } from "../gpu/GpuNativeMaterialPublication.js";
import { surfaceGeometryDecodeWgsl } from "./surface_geometry_reader.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import { SHADOW_BOUNDS_WGSL } from "../gpu/GpuShadowBoundsAbi.js";
import { VSM_MAX_CLIP_LEVELS } from "../gpu/GpuVsmProjectionAbi.js";

export interface VsmAttributeLayout {
  readonly world: number;
  readonly normal: number;
  readonly tangent: number;
  readonly uv01: number;
  readonly uv2: number;
  readonly color: number;
  readonly vectors: number;
}

export const VSM_GEOMETRY_CONSTANTS_WGSL = /* wgsl */ `
struct VsmGeometryConstants {
  light_view: mat4x4f,
  clips: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>,
  dimensions: vec4u,
  control: vec4u,
  parameters: vec4f,
  depth_range: vec4f,
  identity: vec4u,
  selector: vec4f,
  footprint: vec4f,
}
`;

/** Shared page projection and conservative triangle/page test. Z is left to
 * hardware primitive clipping, including triangles crossing the depth range. */
export const VSM_TRIANGLE_PAGE_MATH_WGSL = /* wgsl */ `
fn vsm_page_rect(page: VsmPageWork) -> vec4f {
  let coordinate = vsm_page_entry_coordinates(page.virtual_page, constants.dimensions.x);
  let cell = constants.clips[coordinate.x].z / f32(constants.dimensions.x >> coordinate.y);
  let gutter = cell * f32(constants.dimensions.z) / f32(constants.dimensions.y);
  return vec4f(vec2f(page.world) * cell - vec2f(gutter),
    vec2f(page.world + vec2i(1)) * cell + vec2f(gutter));
}
fn vsm_triangle_page(a: vec2f, b: vec2f, c: vec2f, rect: vec4f) -> bool {
  let lo = min(a, min(b, c));
  let hi = max(a, max(b, c));
  let margin = (max(abs(lo), abs(hi)) + vec2f(1.0)) * 0.000004;
  if any(hi + margin < rect.xy) || any(lo - margin > rect.zw) { return false; }
  let center = (rect.xy + rect.zw) * 0.5;
  let radius = (rect.zw - rect.xy) * 0.5 + margin;
  let edges = array<vec2f, 3>(b - a, c - b, a - c);
  for (var edge = 0u; edge < 3u; edge++) {
    let axis = vec2f(-edges[edge].y, edges[edge].x);
    let projections = vec3f(dot(a - center, axis), dot(b - center, axis), dot(c - center, axis));
    let reach = dot(abs(axis), radius);
    if min(projections.x, min(projections.y, projections.z)) > reach ||
       max(projections.x, max(projections.y, projections.z)) < -reach { return false; }
  }
  return true;
}
fn vsm_atlas_position(light: vec3f, page: VsmPageWork) -> vec4f {
  let coordinate = vsm_page_entry_coordinates(page.virtual_page, constants.dimensions.x);
  let cell = constants.clips[coordinate.x].z / f32(constants.dimensions.x >> coordinate.y);
  let pitch = constants.dimensions.y + constants.dimensions.z * 2u;
  let axis = constants.dimensions.w / pitch;
  let uv = light.xy / cell - vec2f(page.world);
  let texel = vec2f(vec2u(page.slot % axis, page.slot / axis) * pitch + vec2u(constants.dimensions.z)) +
    uv * f32(constants.dimensions.y);
  return vec4f(texel.x / f32(constants.dimensions.w) * 2.0 - 1.0,
    1.0 - texel.y / f32(constants.dimensions.w) * 2.0,
    (constants.depth_range.y - light.z) * constants.depth_range.z, 1.0);
}
`;

/** Colossus-style unique-vertex preparation, with the actual native coverage
 * dependencies. Triangle dirty/backface rejection follows Timberdoodle's
 * directional mesh stage; there is no micro-polygon/large-triangle cutoff. */
export function vsmSourcePrepareWgsl(product: boolean, attributes: VsmAttributeLayout): string {
  const store = (field: keyof VsmAttributeLayout, bit: number, expression: string) =>
    attributes[field] < 0
      ? ""
      : `if (active_attributes & ${bit}u) != 0u { prepared.elements[local].vertices[vertex][${attributes[field]}u] = ${expression}; }`;
  return /* wgsl */ `requires unrestricted_pointer_parameters;
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${NATIVE_RASTER_DIRECTORY_WGSL}
${SHADOW_BOUNDS_WGSL}
${VSM_PAGE_TABLE_WGSL}
${vsmGeometryWgsl(attributes.vectors)}
${VSM_GEOMETRY_CONSTANTS_WGSL}
@group(0) @binding(0) var<uniform> settings: VsmChunkSettings;
@group(0) @binding(1) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(2) var<storage, read> source: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> asset_heap: array<u32>;
@group(0) @binding(7) var<storage, read> vertex_payload: array<u32>;
${
  product
    ? `@group(0) @binding(8) var<storage, read> product_heap: array<u32>;
${Array.from({ length: 4 }, (_, i) => `@group(0) @binding(${9 + i}) var<storage, read> product_bank_${i}: array<u32>;`).join("\n")}`
    : ""
}
struct PreparedSource { elements: array<VsmPreparedMeshlet>, }
@group(0) @binding(13) var<storage, read_write> prepared: PreparedSource;
@group(0) @binding(14) var<storage, read> directory: array<NativeRasterDirectoryEntry>;
@group(0) @binding(15) var<storage, read_write> status: VsmRasterStatus;
@group(0) @binding(16) var<uniform> constants: VsmGeometryConstants;
@group(1) @binding(0) var<storage, read> bin_attributes: array<u32>;
@group(1) @binding(1) var<storage, read> bounds: ShadowBoundsQueue;
@group(1) @binding(2) var<storage, read> allocation: VsmAllocation;
${VSM_TRIANGLE_PAGE_MATH_WGSL}
fn vsm_source_hits_dirty(slot: u32) -> bool {
  if bounds.header.invalid != 0u || bounds.header.generation != status.source_generation ||
    bounds.header.count != status.source_count || slot >= bounds.header.count || bounds.elements[slot].valid == 0u {
    atomicOr(&status.failure, 128u);
    return false;
  }
  let box = bounds.elements[slot].light_xy;
  for (var page = 0u; page < allocation.written; page++) {
    let rect = vsm_page_rect(allocation.records[page]);
    if all(box.zw >= rect.xy) && all(box.xy <= rect.zw) { return true; }
  }
  return false;
}
${surfaceGeometryDecodeWgsl(product, "asset_heap", false)}
var<workgroup> counts: vec2u;
var<workgroup> active_attributes: u32;
var<workgroup> source_transform: mat4x4f;
var<workgroup> source_normal: mat3x3f;
var<workgroup> determinant: f32;
@compute @workgroup_size(128)
fn prepare_source(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let local = group.x;
  let slot = settings.chunk.x + local;
  if lane == 0u {
    counts = vec2u(0u);
    prepared.elements[local].counts = vec2u(0u);
    prepared.elements[local].reserved = 0u;
    if slot < status.source_count && vsm_source_hits_dirty(slot) {
      let work = source.elements[slot];
      if work.instance_slot >= arrayLength(&frame_instances) || work.material_slot_or_range >= arrayLength(&directory) {
        atomicOr(&status.failure, 1u);
      } else {
        let instance = frame_instances[work.instance_slot];
        let material = directory[work.material_slot_or_range];
        if instance.generation != status.source_generation || material.valid == 0u ||
          material.raster_class * 2u >= settings.control.x ||
          (instance.source.flags & ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.Transparent}u) != ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.CastsShadow}u {
          atomicOr(&status.failure, 2u);
        } else {
          counts = surface_source_load(work);
          if any(counts == vec2u(0u)) || counts.x > 256u || counts.y > 128u {
            counts = vec2u(0u);
            atomicOr(&status.failure, 4u);
          }
          source_transform = oengine_instance_current_object_to_world(instance.source);
          determinant = sign(instance.normal_x.w);
          source_normal = mat3x3f(instance.normal_x.xyz, instance.normal_y, instance.normal_z.xyz) * determinant;
          active_attributes = bin_attributes[material.raster_class];
          prepared.elements[local].counts = counts;
          prepared.elements[local].material = work.material_slot_or_range;
          prepared.elements[local].raster_bin = material.raster_class * 2u + select(0u, 1u, (work.packed_raster_flags & 16u) != 0u);
          prepared.elements[local].flags = instance.source.flags;
          prepared.elements[local].attributes = active_attributes;
          prepared.elements[local].source_slot = slot;
          atomicAdd(&status.vertices, counts.x);
          atomicAdd(&status.triangles, counts.y);
        }
      }
    }
  }
  workgroupBarrier();
  if counts.x == 0u { return; }
  for (var vertex = lane; vertex < counts.x; vertex += 128u) {
    let world = source_transform * vec4f(surface_source_vertex_position(vertex), 1.0);
    let light = constants.light_view * world;
    if any(light != light) || any(abs(light) > vec4f(3.402823466e38)) { atomicOr(&status.failure, 8u); }
    prepared.elements[local].vertices[vertex][0] = light;
    ${store("world", 1, "world")}
    ${store("normal", 2, "vec4f(source_normal * surface_source_vertex_normal(vertex).xyz, surface_source_vertex_normal(vertex).w)")}
    ${store("tangent", 4, "vec4f((source_transform * vec4f(surface_source_vertex_tangent(vertex).xyz, 0.0)).xyz, surface_source_vertex_tangent(vertex).w * determinant)")}
    ${store("uv01", 8, "vec4f(surface_source_vertex_uv(vertex, 0u), surface_source_vertex_uv(vertex, 1u))")}
    ${store("uv2", 16, "vec4f(surface_source_vertex_uv(vertex, 2u), 0.0, 0.0)")}
    ${store("color", 32, "surface_source_vertex_color(vertex)")}
  }
  if lane < counts.y {
    var ids = vec3u(surface_source_triangle_corner(lane, 0u), surface_source_triangle_corner(lane, 1u), surface_source_triangle_corner(lane, 2u));
    if determinant >= 0.0 { ids = ids.xzy; }
    if any(ids >= vec3u(counts.x)) { atomicOr(&status.failure, 16u); }
    prepared.elements[local].triangles[lane] = ids.x | (ids.y << 8u) | (ids.z << 16u);
  }
}
`;
}

export const VSM_POLYGON_CLIP_WGSL = /* wgsl */ `
struct VsmClipPolygon { count: u32, vertices: array<vec2f, 7>, }
fn vsm_plane_distance(point: vec3f, rect: vec4f, edge: u32) -> f32 {
  switch edge {
    case 0u: { return point.x - rect.x; }
    case 1u: { return rect.z - point.x; }
    case 2u: { return point.y - rect.y; }
    default: { return rect.w - point.y; }
  }
}
// Barycentric lineage survives every intersection. Seven vertices / five fan
// triangles is the exact upper bound of triangle intersect rectangle.
fn vsm_clip_triangle(a: vec3f, b: vec3f, c: vec3f, rect: vec4f) -> VsmClipPolygon {
  var polygon: VsmClipPolygon;
  polygon.count = 3u;
  polygon.vertices[0] = vec2f(0.0); polygon.vertices[1] = vec2f(1.0, 0.0); polygon.vertices[2] = vec2f(0.0, 1.0);
  for (var edge = 0u; edge < 4u; edge++) {
    var next: VsmClipPolygon;
    if polygon.count == 0u { return polygon; }
    var previous = polygon.vertices[polygon.count - 1u];
    var previous_distance = vsm_plane_distance(a * (1.0 - previous.x - previous.y) + b * previous.x + c * previous.y, rect, edge);
    for (var i = 0u; i < polygon.count; i++) {
      let current = polygon.vertices[i];
      let current_distance = vsm_plane_distance(a * (1.0 - current.x - current.y) + b * current.x + c * current.y, rect, edge);
      if (previous_distance < 0.0 && current_distance > 0.0) || (previous_distance > 0.0 && current_distance < 0.0) {
        let t = previous_distance / (previous_distance - current_distance);
        next.vertices[next.count] = mix(previous, current, t);
        next.count++;
      }
      if current_distance >= 0.0 {
        next.vertices[next.count] = current;
        next.count++;
      }
      previous = current;
      previous_distance = current_distance;
    }
    polygon = next;
  }
  return polygon;
}
`;
/** Lossless CSR triangle/page stream; no per-incidence allocation or atomics. */
export function vsmTriangleStreamWgsl(vectors: number, pageWords: number, clipDistances: boolean): string {
  return /* wgsl */ `
${GPU_MESHLET_RASTER_WORK_WGSL}
${VSM_PAGE_TABLE_WGSL}
${vsmGeometryWgsl(vectors, pageWords)}
${VSM_GEOMETRY_CONSTANTS_WGSL}
@group(0) @binding(0) var<uniform> settings: VsmChunkSettings;
@group(0) @binding(1) var<uniform> constants: VsmGeometryConstants;
@group(0) @binding(2) var<storage, read> source: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read_write> prepared: array<VsmPreparedMeshlet>;
@group(0) @binding(4) var<storage, read> allocation: VsmAllocation;
@group(0) @binding(5) var<storage, read_write> status: VsmRasterStatus;
@group(0) @binding(6) var<storage, read_write> records: array<VsmTrianglePages>;
@group(0) @binding(7) var<storage, read_write> states: array<vec4u>;
@group(0) @binding(8) var<storage, read_write> indices: array<VsmSourceRange>;
@group(1) @binding(0) var<storage, read_write> indirect: array<vec4u>;
${VSM_TRIANGLE_PAGE_MATH_WGSL}
var<workgroup> triangle_scan: array<u32, 128>;
var<workgroup> source_scan: array<vec2u, 64>;
var<workgroup> uniform_chunk_count: u32;
var<workgroup> uniform_triangle_count: u32;
fn vsm_chunk_count() -> u32 {
  return min(settings.chunk.y, status.source_count - min(settings.chunk.x, status.source_count));
}
@compute @workgroup_size(1)
fn begin_frame() {
  status.generation = constants.control.x;
  status.source_generation = source.header.generation;
  status.dirty_count = allocation.written;
  status.source_count = min(source.header.written_count, settings.control.y);
  status.expected_chunks = (status.source_count + settings.chunk.y - 1u) / settings.chunk.y;
  if source.header.invalid_count != 0u || source.header.overflow_count != 0u || source.header.written_count > settings.control.y ||
    source.header.written_count > source.header.capacity || allocation.written > settings.chunk.z ||
    allocation.overflow != 0u || allocation.generation != constants.control.x ||
    source.header.generation == 0u { atomicOr(&status.failure, 32u); }
  indirect[3] = vec4u(6u, select(allocation.written, 0u, atomicLoad(&status.failure) != 0u), 0u, 0u);
}
@compute @workgroup_size(1)
fn begin_chunk() {
  let active_count = select(vsm_chunk_count(), 0u, status.dirty_count == 0u || atomicLoad(&status.failure) != 0u);
  indirect[0] = vec4u(active_count, 1u, 1u, 0u);
  indirect[1] = vec4u(active_count, 1u, 1u, 0u);
  indirect[2] = vec4u(select(settings.control.x, 0u, active_count == 0u), 1u, 1u, 0u);
  for (var bin = 0u; bin < settings.control.x; bin++) {
    states[bin] = vec4u(0u);
    indirect[4u + bin] = vec4u(0u);
  }
}
@compute @workgroup_size(128)
fn emit_triangles(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) triangle: u32) {
  let meshlet = group.x;
  if triangle == 0u { uniform_triangle_count = prepared[meshlet].counts.y; }
  if workgroupUniformLoad(&uniform_triangle_count) == 0u { return; }
  let count = prepared[meshlet].counts;
  var record: VsmTrianglePages;
  var hits = 0u;
  if triangle < count.y {
    let packed = prepared[meshlet].triangles[triangle];
    let ids = vec3u(packed & 255u, (packed >> 8u) & 255u, (packed >> 16u) & 255u);
    if all(ids < vec3u(count.x)) {
      let a = prepared[meshlet].vertices[ids.x][0].xyz;
      let b = prepared[meshlet].vertices[ids.y][0].xyz;
      let c = prepared[meshlet].vertices[ids.z][0].xyz;
      let area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      let bin = prepared[meshlet].raster_bin;
      if area != 0.0 && !(bin == 0u && area >= 0.0) {
        for (var page = 0u; page < status.dirty_count; page++) {
          if vsm_triangle_page(a.xy, b.xy, c.xy, vsm_page_rect(allocation.records[page])) {
            record.bits[page / 32u] |= 1u << (page % 32u);
            hits++;
          }
        }
      }
    }
    if hits == 0u { atomicAdd(&status.rejected_triangles, 1u); }
  }
  triangle_scan[triangle] = hits;
  workgroupBarrier();
  for (var offset = 1u; offset < 128u; offset <<= 1u) {
    var prior = 0u;
    if triangle >= offset { prior = triangle_scan[triangle - offset]; }
    workgroupBarrier();
    triangle_scan[triangle] += prior;
    workgroupBarrier();
  }
  record.end = triangle_scan[triangle];
  records[meshlet * 128u + triangle] = record;
  if triangle == 127u {
    prepared[meshlet].reserved = record.end;
    let previous = atomicAdd(&status.incidences, record.end);
    if previous > 0xffffffffu - record.end { atomicAdd(&status.incidence_high, 1u); }
  }
}
@compute @workgroup_size(64)
fn count_bins(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let bin = group.x;
  var total = vec2u(0u);
  for (var meshlet = lane; meshlet < vsm_chunk_count(); meshlet += 64u) {
    if prepared[meshlet].raster_bin == bin && prepared[meshlet].reserved != 0u {
      total += vec2u(prepared[meshlet].reserved, 1u);
    }
  }
  source_scan[lane] = total;
  workgroupBarrier();
  for (var offset = 32u; offset > 0u; offset >>= 1u) {
    if lane < offset { source_scan[lane] += source_scan[lane + offset]; }
    workgroupBarrier();
  }
  if lane == 0u { states[bin] = vec4u(source_scan[0].x, 0u, source_scan[0].y, 0u); }
}
@compute @workgroup_size(1)
fn prefix_bins() {
  var offset = 0u;
  let failed = atomicLoad(&status.failure) != 0u;
  for (var bin = 0u; bin < settings.control.x; bin++) {
    states[bin].y = offset;
    indirect[4u + bin] = vec4u(${clipDistances ? 3 : 15}u, select(states[bin].x, 0u, failed), 0u, 0u);
    offset += states[bin].z;
  }
}
@compute @workgroup_size(64)
fn scatter_bins(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let bin = group.x;
  if lane == 0u { uniform_chunk_count = vsm_chunk_count(); }
  let count = workgroupUniformLoad(&uniform_chunk_count);
  var carry = vec2u(0u);
  for (var base = 0u; base < count; base += 64u) {
    let meshlet = base + lane;
    var item = vec2u(0u);
    if meshlet < vsm_chunk_count() {
      if prepared[meshlet].raster_bin == bin && prepared[meshlet].reserved != 0u {
        item = vec2u(prepared[meshlet].reserved, 1u);
      }
    }
    source_scan[lane] = item;
    workgroupBarrier();
    for (var offset = 1u; offset < 64u; offset <<= 1u) {
      var prior = vec2u(0u);
      if lane >= offset { prior = source_scan[lane - offset]; }
      workgroupBarrier();
      source_scan[lane] += prior;
      workgroupBarrier();
    }
    let inclusive = carry + source_scan[lane];
    if item.y != 0u {
      indices[states[bin].y + inclusive.y - 1u] = VsmSourceRange(meshlet, inclusive.x - item.x, inclusive.x, 0u);
    }
    carry += source_scan[63];
    workgroupBarrier();
  }
}
@compute @workgroup_size(1)
fn finish_chunk() {
  if settings.chunk.x < status.source_count { atomicAdd(&status.completed_chunks, 1u); }
}
`;
}
