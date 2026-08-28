import { GPU_GEOMETRY_RECORD_WGSL, GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const PACKED_HIERARCHY_VISIBILITY_FIXED_VERTEX_COUNT = 384;

/** R3 Hardware Visibility consumer for VisibleCluster → RasterWork. */
export const PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_VISIBILITY_KEY_WGSL}

struct R3QueueHeaderRead {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  _pad0: u32,
  _pad1: u32,
}

struct R3VisibleClusterRecord {
  instance_record_index: u32,
  geometry_record_index: u32,
  cluster_record_index: u32,
  material_handle: u32,
}

struct R3VisibleClusterQueueRead {
  header: R3QueueHeaderRead,
  elements: array<R3VisibleClusterRecord>,
}

struct R3RasterWork {
  visible_cluster_slot: u32,
  meshlet_record_index: u32,
}

struct R3RasterWorkQueueRead {
  header: R3QueueHeaderRead,
  elements: array<R3RasterWork>,
}

struct R3VisibilityVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) instance_record_index: u32,
  @location(1) @interpolate(flat) encoded_triangle: u32,
  @location(2) @interpolate(flat) visibility_key: u32,
}

@group(0) @binding(0) var<uniform> r3_raster_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> r3_raster_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> r3_raster_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> r3_raster_meshlet_vertices: array<u32>;
@group(0) @binding(4) var<storage, read> r3_raster_meshlet_triangles: array<u32>;
@group(0) @binding(5) var<storage, read> r3_raster_vertex_data: array<u32>;
@group(0) @binding(6) var<storage, read> r3_raster_geometries: array<GpuGeometryRecord>;
@group(0) @binding(7) var<storage, read> r3_visible_clusters: R3VisibleClusterQueueRead;
@group(0) @binding(8) var<storage, read> r3_raster_work: R3RasterWorkQueueRead;

fn r3_read_u8(words: ptr<storage, array<u32>, read>, byte_offset: u32) -> u32 {
  let word = (*words)[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

@vertex
fn raster_hierarchy_meshlets(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) work_index: u32
) -> R3VisibilityVertexOutput {
  let work = r3_raster_work.elements[work_index];
  let visible = r3_visible_clusters.elements[work.visible_cluster_slot];
  let instance = r3_raster_instances[visible.instance_record_index];
  let geometry = r3_raster_geometries[visible.geometry_record_index];
  let meshlet = r3_raster_meshlets[work.meshlet_record_index];
  let last_corner = max(meshlet.triangle_count * 3u, 1u) - 1u;
  let corner = min(vertex_index, last_corner);
  let triangle_index = corner / 3u;
  let local_vertex = r3_read_u8(
    &r3_raster_meshlet_triangles,
    meshlet.triangle_byte_offset + corner
  );
  let source_vertex = r3_raster_meshlet_vertices[
    meshlet.vertex_offset + local_vertex
  ];
  let position_word = geometry.position_byte_offset / 4u
    + source_vertex * (geometry.position_stride / 4u);
  let local_position = vec3f(
    bitcast<f32>(r3_raster_vertex_data[position_word]),
    bitcast<f32>(r3_raster_vertex_data[position_word + 1u]),
    bitcast<f32>(r3_raster_vertex_data[position_word + 2u])
  );
  var output: R3VisibilityVertexOutput;
  output.position = r3_raster_camera.view_projection_matrix
    * instance.current_object_to_world
    * vec4f(local_position, 1.0);
  output.instance_record_index = visible.instance_record_index;
  output.encoded_triangle = (work.meshlet_record_index << 8u) | triangle_index;
  output.visibility_key = oengine_visibility_key_try_encode(
    work_index,
    triangle_index
  ).key;
  return output;
}

struct R3VisibilityFragmentOutput {
  @location(0) visibility_key: u32,
  @location(1) triangle_id: u32,
  @location(2) instance_id: u32,
}

@fragment
fn write_hierarchy_visibility(
  @location(0) @interpolate(flat) instance_record_index: u32,
  @location(1) @interpolate(flat) encoded_triangle: u32,
  @location(2) @interpolate(flat) visibility_key: u32
) -> R3VisibilityFragmentOutput {
  return R3VisibilityFragmentOutput(
    visibility_key,
    encoded_triangle,
    instance_record_index
  );
}
`;
