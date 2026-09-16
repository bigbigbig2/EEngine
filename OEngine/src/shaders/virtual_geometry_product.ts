import { OEGPACK_V3_PAGE_BYTES } from "../assets/GeometryAbiV3.js";
import { GEOMETRY_PRODUCT_GPU_WGSL_V1 } from "../gpu/GeometryProductGpuAbiV1.js";

/**
 * Geometry Product V1 hierarchy/address helpers shared by the production
 * hierarchy and MeshletWork specializations.
 *
 * Provenance: Nyx `MeshletStructs.h` and `DAGCull.slang` at the hashes frozen
 * by implementation/0016. The raw Product heap replaces Nyx bindless SRVs;
 * every lookup remains generation/range checked before a physical bank read.
 */
export const VIRTUAL_GEOMETRY_PRODUCT_WGSL = /* wgsl */ `
${GEOMETRY_PRODUCT_GPU_WGSL_V1}

const OENGINE_VIRTUAL_GEOMETRY_PAGE_BYTES_V1: u32 = ${OEGPACK_V3_PAGE_BYTES}u;
const OENGINE_VIRTUAL_GEOMETRY_GROUP_HEADER_BYTES_V1: u32 = 64u;
const OENGINE_VIRTUAL_GEOMETRY_MESHLET_HEADER_BYTES_V1: u32 = 48u;
const OENGINE_VIRTUAL_GEOMETRY_GROUP_FLAGS_MASK_V1: u32 = 0x3fu;

struct OEngineVirtualHierarchyNodeV1 {
  valid: bool,
  bounds_sphere: vec4f,
  bounds_min: vec3f,
  bounds_max: vec3f,
  max_parent_error: f32,
  packed_node_data: u32,
};

struct OEngineVirtualGroupV1 {
  valid: bool,
  page_id: u32,
  offset_in_page: u32,
  payload_bytes: u32,
  flags: u32,
};

struct OEngineVirtualGroupHeaderV1 {
  valid: bool,
  bounds_sphere: vec4f,
  parent_error: f32,
  meshlet_count: u32,
  lod_level: u32,
  vertex_format_id: u32,
  meshlet_header_offset: u32,
  triangle_data_offset: u32,
  vertex_data_offset: u32,
  payload_bytes: u32,
};

struct OEngineVirtualMeshletHeaderV1 {
  valid: bool,
  vertex_count: u32,
  triangle_count: u32,
  vertex_byte_offset: u32,
  triangle_byte_offset: u32,
  refine_group_id: u32,
  material_id: u32,
  flags: u32,
  bounds_min: vec3f,
  bounds_max: vec3f,
};

fn oengine_virtual_invalid_hierarchy_node_v1() -> OEngineVirtualHierarchyNodeV1 {
  return OEngineVirtualHierarchyNodeV1(
    false, vec4f(0.0), vec3f(0.0), vec3f(0.0), 0.0, 0u
  );
}

fn oengine_virtual_invalid_group_v1() -> OEngineVirtualGroupV1 {
  return OEngineVirtualGroupV1(false, 0u, 0u, 0u, 0u);
}

fn oengine_virtual_invalid_group_header_v1() -> OEngineVirtualGroupHeaderV1 {
  return OEngineVirtualGroupHeaderV1(
    false, vec4f(0.0), 0.0, 0u, 0u, 0u, 0u, 0u, 0u, 0u
  );
}

fn oengine_virtual_invalid_meshlet_header_v1() -> OEngineVirtualMeshletHeaderV1 {
  return OEngineVirtualMeshletHeaderV1(
    false, 0u, 0u, 0u, 0u, 0xffffffffu, 0u, 0u,
    vec3f(0.0), vec3f(0.0)
  );
}

fn oengine_virtual_hierarchy_node_v1(
  heap: ptr<storage, array<u32>, read>,
  asset: OEngineGeometryProductResolvedAssetV1,
  node_id: u32
) -> OEngineVirtualHierarchyNodeV1 {
  if (!asset.valid) { return oengine_virtual_invalid_hierarchy_node_v1(); }
  let hierarchy_begin = (*heap)[asset.asset_word_offset + 20u];
  if (node_id < hierarchy_begin) { return oengine_virtual_invalid_hierarchy_node_v1(); }
  let local_node = node_id - hierarchy_begin;
  if (local_node >= asset.hierarchy_count) {
    return oengine_virtual_invalid_hierarchy_node_v1();
  }
  let at = asset.hierarchy_word_offset + local_node * 12u;
  if (at > arrayLength(heap) || arrayLength(heap) - at < 12u) {
    return oengine_virtual_invalid_hierarchy_node_v1();
  }
  let sphere = vec4f(
    bitcast<f32>((*heap)[at]), bitcast<f32>((*heap)[at + 1u]),
    bitcast<f32>((*heap)[at + 2u]), bitcast<f32>((*heap)[at + 3u])
  );
  let bounds_min = vec3f(
    bitcast<f32>((*heap)[at + 4u]), bitcast<f32>((*heap)[at + 5u]),
    bitcast<f32>((*heap)[at + 6u])
  );
  let bounds_max = vec3f(
    bitcast<f32>((*heap)[at + 7u]), bitcast<f32>((*heap)[at + 8u]),
    bitcast<f32>((*heap)[at + 9u])
  );
  let parent_error = bitcast<f32>((*heap)[at + 10u]);
  let finite = all(sphere == sphere) && all(bounds_min == bounds_min) &&
    all(bounds_max == bounds_max) && parent_error == parent_error &&
    all(abs(sphere) <= vec4f(3.402823466e38)) &&
    all(abs(bounds_min) <= vec3f(3.402823466e38)) &&
    all(abs(bounds_max) <= vec3f(3.402823466e38)) &&
    abs(parent_error) <= 3.402823466e38 && sphere.w >= 0.0 &&
    all(bounds_min <= bounds_max) && parent_error >= 0.0;
  return OEngineVirtualHierarchyNodeV1(
    finite, sphere, bounds_min, bounds_max, parent_error, (*heap)[at + 11u]
  );
}

fn oengine_virtual_node_is_group_v1(node: OEngineVirtualHierarchyNodeV1) -> bool {
  return node.valid && (node.packed_node_data & 1u) != 0u;
}

fn oengine_virtual_node_child_begin_v1(node: OEngineVirtualHierarchyNodeV1) -> u32 {
  return (node.packed_node_data >> 1u) & 0x07ffffffu;
}

fn oengine_virtual_node_child_count_v1(node: OEngineVirtualHierarchyNodeV1) -> u32 {
  return node.packed_node_data >> 28u;
}

fn oengine_virtual_node_group_id_v1(node: OEngineVirtualHierarchyNodeV1) -> u32 {
  return (node.packed_node_data >> 1u) & 0x00ffffffu;
}

fn oengine_virtual_node_meshlet_count_v1(node: OEngineVirtualHierarchyNodeV1) -> u32 {
  return ((node.packed_node_data >> 25u) & 0x7fu) + 1u;
}

fn oengine_virtual_group_v1(
  heap: ptr<storage, array<u32>, read>,
  asset: OEngineGeometryProductResolvedAssetV1,
  group_id: u32
) -> OEngineVirtualGroupV1 {
  if (!asset.valid) { return oengine_virtual_invalid_group_v1(); }
  let group_begin = (*heap)[asset.asset_word_offset + 22u];
  if (group_id < group_begin) { return oengine_virtual_invalid_group_v1(); }
  let local_group = group_id - group_begin;
  if (local_group >= asset.group_count) { return oengine_virtual_invalid_group_v1(); }
  let at = asset.group_word_offset + local_group * 4u;
  if (at > arrayLength(heap) || arrayLength(heap) - at < 4u) {
    return oengine_virtual_invalid_group_v1();
  }
  let page_id = (*heap)[at];
  let offset_in_page = (*heap)[at + 1u];
  let payload_bytes = (*heap)[at + 2u];
  let flags = (*heap)[at + 3u];
  let valid = page_id < asset.page_count && (offset_in_page & 15u) == 0u &&
    payload_bytes >= OENGINE_VIRTUAL_GEOMETRY_GROUP_HEADER_BYTES_V1 &&
    payload_bytes <= OENGINE_VIRTUAL_GEOMETRY_PAGE_BYTES_V1 &&
    offset_in_page <= OENGINE_VIRTUAL_GEOMETRY_PAGE_BYTES_V1 - payload_bytes &&
    (flags & ~OENGINE_VIRTUAL_GEOMETRY_GROUP_FLAGS_MASK_V1) == 0u;
  return OEngineVirtualGroupV1(
    valid, page_id, offset_in_page, payload_bytes, flags
  );
}

fn oengine_virtual_group_header_v1(
  bank: ptr<storage, array<u32>, read>,
  location: OEngineGeometryPageLookupV1,
  group: OEngineVirtualGroupV1
) -> OEngineVirtualGroupHeaderV1 {
  if (!location.valid || !group.valid ||
    group.offset_in_page > OENGINE_VIRTUAL_GEOMETRY_PAGE_BYTES_V1 -
      OENGINE_VIRTUAL_GEOMETRY_GROUP_HEADER_BYTES_V1) {
    return oengine_virtual_invalid_group_header_v1();
  }
  let byte_at = location.byte_offset + group.offset_in_page;
  let at = byte_at >> 2u;
  if (at > arrayLength(bank) || arrayLength(bank) - at < 16u) {
    return oengine_virtual_invalid_group_header_v1();
  }
  let counts = (*bank)[at + 11u];
  let meshlet_count = counts & 0xffffu;
  let meshlet_offset = (*bank)[at + 12u];
  let triangle_offset = (*bank)[at + 13u];
  let vertex_offset = (*bank)[at + 14u];
  let payload_bytes = (*bank)[at + 15u];
  let parent_error = bitcast<f32>((*bank)[at + 10u]);
  let sphere = vec4f(
    bitcast<f32>((*bank)[at]), bitcast<f32>((*bank)[at + 1u]),
    bitcast<f32>((*bank)[at + 2u]), bitcast<f32>((*bank)[at + 3u])
  );
  let header_valid = payload_bytes == group.payload_bytes &&
    meshlet_count > 0u && meshlet_count <= 128u &&
    meshlet_offset >= OENGINE_VIRTUAL_GEOMETRY_GROUP_HEADER_BYTES_V1 &&
    (meshlet_offset & 3u) == 0u &&
    meshlet_offset <= payload_bytes &&
    meshlet_count <= (payload_bytes - meshlet_offset) /
      OENGINE_VIRTUAL_GEOMETRY_MESHLET_HEADER_BYTES_V1 &&
    triangle_offset >= meshlet_offset + meshlet_count *
      OENGINE_VIRTUAL_GEOMETRY_MESHLET_HEADER_BYTES_V1 &&
    triangle_offset <= vertex_offset && vertex_offset <= payload_bytes &&
    parent_error == parent_error &&
    abs(parent_error) <= 3.402823466e38 && parent_error >= 0.0 &&
    all(sphere == sphere) && all(abs(sphere) <= vec4f(3.402823466e38)) &&
    sphere.w >= 0.0;
  return OEngineVirtualGroupHeaderV1(
    header_valid, sphere, parent_error, meshlet_count,
    (counts >> 16u) & 0xffu, counts >> 24u, meshlet_offset,
    triangle_offset, vertex_offset, payload_bytes
  );
}

fn oengine_virtual_meshlet_header_v1(
  bank: ptr<storage, array<u32>, read>,
  location: OEngineGeometryPageLookupV1,
  group: OEngineVirtualGroupV1,
  header: OEngineVirtualGroupHeaderV1,
  local_meshlet: u32
) -> OEngineVirtualMeshletHeaderV1 {
  if (!header.valid || local_meshlet >= header.meshlet_count) {
    return oengine_virtual_invalid_meshlet_header_v1();
  }
  let byte_at = location.byte_offset + group.offset_in_page +
    header.meshlet_header_offset + local_meshlet *
      OENGINE_VIRTUAL_GEOMETRY_MESHLET_HEADER_BYTES_V1;
  let at = byte_at >> 2u;
  if (at > arrayLength(bank) || arrayLength(bank) - at < 12u) {
    return oengine_virtual_invalid_meshlet_header_v1();
  }
  let counts = (*bank)[at];
  let vertex_count = counts & 0xffffu;
  let triangle_count = counts >> 16u;
  let vertex_offset = (*bank)[at + 1u];
  let triangle_offset = (*bank)[at + 2u];
  let bounds_min = vec3f(
    bitcast<f32>((*bank)[at + 6u]), bitcast<f32>((*bank)[at + 7u]),
    bitcast<f32>((*bank)[at + 8u])
  );
  let bounds_max = vec3f(
    bitcast<f32>((*bank)[at + 9u]), bitcast<f32>((*bank)[at + 10u]),
    bitcast<f32>((*bank)[at + 11u])
  );
  let valid = vertex_count > 0u && vertex_count <= 128u &&
    triangle_count > 0u && triangle_count <= 128u &&
    vertex_offset >= header.vertex_data_offset &&
    vertex_offset <= header.payload_bytes &&
    triangle_offset >= header.triangle_data_offset &&
    triangle_offset <= header.vertex_data_offset &&
    triangle_count * 3u <= header.vertex_data_offset - triangle_offset &&
    all(bounds_min == bounds_min) && all(bounds_max == bounds_max) &&
    all(abs(bounds_min) <= vec3f(3.402823466e38)) &&
    all(abs(bounds_max) <= vec3f(3.402823466e38)) &&
    all(bounds_min <= bounds_max);
  return OEngineVirtualMeshletHeaderV1(
    valid, vertex_count, triangle_count, vertex_offset, triangle_offset,
    (*bank)[at + 3u], (*bank)[at + 4u], (*bank)[at + 5u],
    bounds_min, bounds_max
  );
}
`;
