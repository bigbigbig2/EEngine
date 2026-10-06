import { FRAME_GEOMETRY_ARENA_HEADER_WORDS as H, FRAME_GEOMETRY_ARENA_VERSION } from "../gpu/GpuFrameGeometryArenaAbi.js";
import { GPU_FRAME_VERTEX_ATTRIBUTE_VECTORS } from "../gpu/GpuFrameGeometryAttributesAbi.js";

/** Read the existing Geometry owner's committed frame directory. A real cache
 * capacity miss keeps the exact source path; no second owner or CPU control. */
export const SURFACE_FRAME_GEOMETRY_WGSL = /* wgsl */ `
struct SurfaceFrameGeometry {
  valid: bool,
  vertex_base: u32,
  triangle_base: u32,
  clip_base: u32,
  attribute_base: u32,
}
fn surface_frame_geometry(slot: u32, primitive: u32) -> SurfaceFrameGeometry {
  var result: SurfaceFrameGeometry;
  let header = settings.source_payload.w & 0x7fffffffu;
  if source_heap[header + ${H.version}u] != ${FRAME_GEOMETRY_ARENA_VERSION}u { return result; }
  let directory = source_heap[header + select(${H.sourceDirectory}u, ${H.filteredDirectory}u,
    (settings.source_payload.w & 0x80000000u) != 0u)];
  if source_heap[directory + 1u] != meshlet_work.header.generation || slot >= source_heap[directory] { return result; }
  let at = directory + 4u + slot * 4u;
  if source_heap[at + 2u] == 0u || primitive >= source_heap[at + 3u] { return result; }
  result.valid = true;
  result.vertex_base = source_heap[at];
  result.triangle_base = source_heap[header + ${H.triangles}u] + source_heap[at + 1u];
  result.clip_base = source_heap[header + ${H.clips}u];
  result.attribute_base = source_heap[header + ${H.attributes}u];
  return result;
}
fn surface_frame_corner(frame: SurfaceFrameGeometry, primitive: u32, corner: u32) -> u32 {
  return (source_heap[frame.triangle_base + primitive] >> (corner * 8u)) & 255u;
}
fn surface_frame_attribute(frame: SurfaceFrameGeometry, vertex: u32, field: u32) -> vec4f {
  let at = frame.attribute_base + ((frame.vertex_base + vertex) * ${GPU_FRAME_VERTEX_ATTRIBUTE_VECTORS}u + field) * 4u;
  return bitcast<vec4f>(vec4u(source_heap[at], source_heap[at + 1u], source_heap[at + 2u], source_heap[at + 3u]));
}
fn surface_frame_clip(frame: SurfaceFrameGeometry, vertex: u32) -> vec4f {
  let at = frame.clip_base + (frame.vertex_base + vertex) * 4u;
  return bitcast<vec4f>(vec4u(source_heap[at], source_heap[at + 1u], source_heap[at + 2u], source_heap[at + 3u]));
}
`;
