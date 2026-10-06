import { FRAME_GEOMETRY_MESHLET_STRIDE } from "../gpu/GpuWinnerInterpolationAbi.js";

export function frameGeometryRasterWgsl(heapBinding: number, settingsBinding: number): string {
  return /* wgsl */ `
struct FrameRasterAddressing { directory: u32, clips: u32, triangles: u32, attributes: u32, }
@group(0) @binding(${heapBinding}) var<storage, read> raster_frame_heap: array<u32>;
@group(0) @binding(${settingsBinding}) var<uniform> raster_frame_address: FrameRasterAddressing;
fn frame_raster_meshlet(slot: u32) -> vec4u {
  let at = raster_frame_address.directory + 4u + slot * ${FRAME_GEOMETRY_MESHLET_STRIDE / 4}u;
  return vec4u(raster_frame_heap[at], raster_frame_heap[at + 1u], raster_frame_heap[at + 2u], raster_frame_heap[at + 3u]);
}
fn frame_raster_corner(meshlet: vec4u, triangle: u32, corner: u32) -> u32 {
  let packed = raster_frame_heap[raster_frame_address.triangles + meshlet.y + triangle];
  return (packed >> (corner * 8u)) & 255u;
}
fn frame_raster_clip(meshlet: vec4u, vertex: u32) -> vec4f {
  let at = raster_frame_address.clips + (meshlet.x + vertex) * 4u;
  return bitcast<vec4f>(vec4u(raster_frame_heap[at], raster_frame_heap[at + 1u], raster_frame_heap[at + 2u], raster_frame_heap[at + 3u]));
}
`;
}
