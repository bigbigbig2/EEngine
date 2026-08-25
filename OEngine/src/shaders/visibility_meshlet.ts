/**
 * visibility_meshlet：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { MESHLET_ELEMENT_WGSL } from "../geometry/MeshletTypes.js";
import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const VISIBILITY_MESHLET_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${MESHLET_ELEMENT_WGSL}
${SCENE_DATABASE_READ_WGSL}

struct VisibilityGeometryMeta {
  bounding_sphere: vec4f,
  bounding_box: array<f32, 6>,
  index_count: u32,
  meshlets_address: u32,
  meshlets_count: u32,
};

struct VisibilityMeshletHeader {
  bounds_box: array<f32, 6>,
  address: u32,
  primitive_count: u32,
  vertex_count: u32,
  flags: u32,
};

struct VisibilityTriangleDef {
  mesh: u32,
  index: u32,
};

struct VisibilityVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) m_mesh: u32,
  @location(1) @interpolate(flat) m_triangle: u32,
};

@group(0) @binding(0) var<uniform> camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> scene_database: array<u32>;
@group(0) @binding(2) var<storage, read> geometries: array<VisibilityGeometryMeta>;
// Dg: 16-byte header followed by Cg {index, mesh} elements.
@group(0) @binding(3) var<storage, read> meshlets: array<u32>;
@group(0) @binding(4) var<storage, read> meshlet_headers: array<u32>;
@group(0) @binding(5) var<storage, read> meshlet_data: array<u32>;

fn visibility_read_meshlet_header(meshlet_id: u32) -> VisibilityMeshletHeader {
  let offset = meshlet_id * 10u;
  var header: VisibilityMeshletHeader;
  header.bounds_box = array<f32, 6>(
    bitcast<f32>(meshlet_headers[offset]),
    bitcast<f32>(meshlet_headers[offset + 1u]),
    bitcast<f32>(meshlet_headers[offset + 2u]),
    bitcast<f32>(meshlet_headers[offset + 3u]),
    bitcast<f32>(meshlet_headers[offset + 4u]),
    bitcast<f32>(meshlet_headers[offset + 5u])
  );
  header.address = meshlet_headers[offset + 6u];
  header.primitive_count = meshlet_headers[offset + 7u];
  header.vertex_count = meshlet_headers[offset + 8u];
  header.flags = meshlet_headers[offset + 9u];
  return header;
}

fn visibility_read_meshlet_element(instance_index: u32) -> VisibilityTriangleDef {
  let offset = 4u + instance_index * 2u;
  return VisibilityTriangleDef(meshlets[offset + 1u], meshlets[offset]);
}

fn visibility_meshlet_attribute_section_offset(
  header: VisibilityMeshletHeader
) -> u32 {
  return header.address + ((header.primitive_count * 3u + 3u) >> 2u);
}

fn visibility_read_meshlet_resolved_index(
  header: VisibilityMeshletHeader,
  draw_index: u32
) -> u32 {
  let word_offset = draw_index >> 2u;
  let bit_offset = (draw_index & 0x03u) << 3u;
  let packed = meshlet_data[header.address + word_offset];
  return (packed >> bit_offset) & 0xFFu;
}

fn visibility_read_meshlet_vertex_position(
  header: VisibilityMeshletHeader,
  vertex_id: u32
) -> vec3f {
  let offset = visibility_meshlet_attribute_section_offset(header)
    + vertex_id * 3u;
  return vec3f(
    bitcast<f32>(meshlet_data[offset]),
    bitcast<f32>(meshlet_data[offset + 1u]),
    bitcast<f32>(meshlet_data[offset + 2u])
  );
}

fn rasterize_triangle(
  meshlet_vertex_id: u32,
  meshlet_id: u32,
  mesh_index: u32,
  triangle_def: ptr<function, VisibilityTriangleDef>
) -> vec4f {
  let meshlet_header = visibility_read_meshlet_header(meshlet_id);
  let last_draw_index = meshlet_header.primitive_count * 3u - 1u;
  let clamped_vertex = min(meshlet_vertex_id, last_draw_index);
  let triangle_index = clamped_vertex / 3u;
  let meshlet_triangle_index = encode_meshlet_element(meshlet_id, triangle_index);
  let resolved_vertex_id = visibility_read_meshlet_resolved_index(
    meshlet_header,
    clamped_vertex
  );
  let geometry_position = visibility_read_meshlet_vertex_position(
    meshlet_header,
    resolved_vertex_id
  );
  *triangle_def = VisibilityTriangleDef(mesh_index, meshlet_triangle_index);
  let mesh = scene_read_mesh(&scene_database, mesh_index);
  let node = scene_read_node(&scene_database, mesh.node);
  return camera.view_projection_matrix
    * node.global
    * vec4f(geometry_position, 1.0);
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32
) -> VisibilityVertexOutput {
  var triangle_def: VisibilityTriangleDef;
  let element = visibility_read_meshlet_element(instance_index);
  let position = rasterize_triangle(
    vertex_index,
    element.index,
    element.mesh,
    &triangle_def
  );
  var output: VisibilityVertexOutput;
  output.position = position;
  output.m_mesh = triangle_def.mesh;
  output.m_triangle = triangle_def.index;
  return output;
}

struct VisibilityFragmentOutput {
  @location(0) m_triangle: u32,
  @location(1) m_mesh: u32,
};

@fragment
fn fs_main(
  @location(0) @interpolate(flat) m_mesh: u32,
  @location(1) @interpolate(flat) m_triangle: u32
) -> VisibilityFragmentOutput {
  var output: VisibilityFragmentOutput;
  output.m_triangle = m_triangle;
  output.m_mesh = m_mesh;
  return output;
}
`;
