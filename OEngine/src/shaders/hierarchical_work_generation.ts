import {
  GPU_CLUSTER_RECORD_WGSL,
  GPU_GEOMETRY_RECORD_WGSL
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_WORK_GENERATION_WGSL } from "../gpu/GpuWorkGenerationAbi.js";

export const HIERARCHICAL_WORKGROUP_SIZE = 64;
export const HIERARCHICAL_VIEW_UNIFORM_SIZE = 176;

export const HIERARCHICAL_VIEW_OFFSETS = Object.freeze({
  cameraPosition: 0,
  frustumPlanes: 16,
  sse: 112,
  orthographic: 128,
  scene: 144,
  limits: 160
} as const);

/**
 * Production R3-B source of truth.
 *
 * Scheduling and SSE provenance:
 * Bevy 5f8270f2e049f90139a503d1e930070d926f9427
 * - cull_instances.wgsl::cull_instances
 * - cull_bvh.wgsl::cull_bvh (wavefront scheduling invariant only)
 * - meshlet_cull_shared.wgsl::lod_error_is_imperceptible
 *
 * Sphere/Frustum provenance:
 * Niagara eefec2794681a1f8416e1fcc2771c1cdc11a86cb
 * - src/shaders/drawcull.comp.glsl:73-82
 *
 * OEngine replaces the upstream queue/BVH layouts with its bounded Cluster
 * hierarchy ABI and all-or-nothing reservation. Cone, HZB, SW raster,
 * subgroup, 64-bit atomics and native command features are intentionally
 * absent from this R3-B shader.
 */
export const HIERARCHICAL_WORK_GENERATION_WGSL = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_CLUSTER_RECORD_WGSL}
${GPU_WORK_GENERATION_WGSL}

struct OEngineHierarchyView {
  camera_position: vec4f,
  frustum_planes: array<vec4f, 6>,
  // threshold, viewport height, perspective projection scale Y, near plane
  sse: vec4f,
  // orthographic vertical world size; remaining lanes are reserved
  orthographic: vec4f,
  // instance begin, instance count, encoded hierarchy rounds, reserved
  scene: vec4u,
  // maxComputeWorkgroupsPerDimension; remaining lanes are reserved
  limits: vec4u,
};

struct OEngineWorkQueueHeaderRead {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  _pad0: u32,
  _pad1: u32,
};

struct OEngineTraversalQueueRead {
  header: OEngineWorkQueueHeaderRead,
  elements: array<OEngineTraversalWork>,
};

struct OEngineTraversalQueueWrite {
  header: OEngineWorkQueueHeader,
  elements: array<OEngineTraversalWork>,
};

struct OEngineVisibleClusterQueue {
  header: OEngineWorkQueueHeader,
  elements: array<OEngineVisibleClusterRecord>,
};

struct OEngineVisibleClusterQueueRead {
  header: OEngineWorkQueueHeaderRead,
  elements: array<OEngineVisibleClusterRecord>,
};

struct OEngineRasterWorkQueue {
  header: OEngineWorkQueueHeader,
  elements: array<OEngineRasterWork>,
};

struct OEngineDispatchIndirectArgs {
  workgroup_count_x: atomic<u32>,
  workgroup_count_y: atomic<u32>,
  workgroup_count_z: atomic<u32>,
};

struct OEngineDrawIndirectArgs {
  vertex_count: u32,
  instance_count: atomic<u32>,
  first_vertex: u32,
  first_instance: u32,
};

const R3_COUNTER_CANDIDATE_INSTANCES: u32 = 0u;
const R3_COUNTER_VISIBLE_INSTANCES: u32 = 1u;
const R3_COUNTER_CANDIDATE_CLUSTERS: u32 = 3u;
const R3_COUNTER_SELECTED_CLUSTERS: u32 = 4u;
const R3_COUNTER_REJECTED_FRUSTUM: u32 = 5u;
const R3_COUNTER_HW_CLUSTERS: u32 = 9u;
const R3_COUNTER_HW_TRIANGLES: u32 = 12u;
const R3_COUNTER_OVERFLOW_MASK: u32 = 17u;
const R3_SCENE_QUEUE_OVERFLOW_BIT: u32 = 1u;
const R3_MESHLET_QUEUE_OVERFLOW_BIT: u32 = 2u;

struct OEngineWorldSphere {
  center: vec3f,
  radius: f32,
};

@group(0) @binding(0) var<uniform> hierarchy_view: OEngineHierarchyView;
@group(0) @binding(1) var<storage, read> hierarchy_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> hierarchy_geometries: array<GpuGeometryRecord>;
@group(0) @binding(3) var<storage, read_write> hierarchy_roots: OEngineTraversalQueueWrite;
@group(0) @binding(4) var<storage, read_write> hierarchy_root_dispatch: OEngineDispatchIndirectArgs;
@group(0) @binding(5) var<storage, read_write> hierarchy_init_draw_indirect: OEngineDrawIndirectArgs;

fn hierarchy_conservative_scale(transform: mat4x4f) -> f32 {
  let x_axis = transform[0].xyz;
  let y_axis = transform[1].xyz;
  let z_axis = transform[2].xyz;
  let x_length = length(x_axis);
  let y_length = length(y_axis);
  let z_length = length(z_axis);
  let safe_x = max(x_length, 1e-20);
  let safe_y = max(y_length, 1e-20);
  let safe_z = max(z_length, 1e-20);
  let shear = max(
    abs(dot(x_axis, y_axis) / (safe_x * safe_y)),
    max(
      abs(dot(x_axis, z_axis) / (safe_x * safe_z)),
      abs(dot(y_axis, z_axis) / (safe_y * safe_z))
    )
  );
  if shear <= 1e-5 {
    return max(x_length, max(y_length, z_length));
  }
  // Frobenius norm conservatively bounds the largest singular value.
  return sqrt(
    dot(x_axis, x_axis) + dot(y_axis, y_axis) + dot(z_axis, z_axis)
  );
}

fn hierarchy_transform_sphere(
  local: vec4f,
  transform: mat4x4f
) -> OEngineWorldSphere {
  return OEngineWorldSphere(
    (transform * vec4f(local.xyz, 1.0)).xyz,
    local.w * hierarchy_conservative_scale(transform)
  );
}

fn hierarchy_sphere_in_frustum(
  sphere: OEngineWorldSphere,
  view: ptr<uniform, OEngineHierarchyView>
) -> bool {
  for (var plane_index = 0u; plane_index < 6u; plane_index++) {
    let plane = (*view).frustum_planes[plane_index];
    let normal_length = length(plane.xyz);
    // A zero-normal plane with non-negative W is an explicit disabled plane,
    // used by infinite-far Perspective views.
    if normal_length > 0.0 &&
      dot(sphere.center, plane.xyz) + plane.w < -sphere.radius * normal_length {
      return false;
    }
  }
  return true;
}

fn hierarchy_projected_error_pixels(
  object_error: f32,
  sphere: OEngineWorldSphere,
  conservative_scale: f32,
  view: ptr<uniform, OEngineHierarchyView>
) -> f32 {
  let world_error = object_error * conservative_scale;
  if (*view).orthographic.y > 0.5 {
    return world_error / (*view).orthographic.x * (*view).sse.y;
  }
  let nearest_distance = max(
    distance(sphere.center, (*view).camera_position.xyz) - sphere.radius,
    (*view).sse.w
  );
  return world_error / nearest_distance * (*view).sse.z *
    0.5 * (*view).sse.y;
}

fn hierarchy_update_dispatch(
  args: ptr<storage, OEngineDispatchIndirectArgs, read_write>,
  published_end: u32,
  max_workgroups_per_dimension: u32
) {
  let linear_workgroups = (published_end + ${HIERARCHICAL_WORKGROUP_SIZE - 1}u) /
    ${HIERARCHICAL_WORKGROUP_SIZE}u;
  let workgroups_x = min(linear_workgroups, max_workgroups_per_dimension);
  let workgroups_y = max(
    (linear_workgroups + max_workgroups_per_dimension - 1u) /
      max_workgroups_per_dimension,
    1u
  );
  atomicMax(&(*args).workgroup_count_x, workgroups_x);
  atomicMax(&(*args).workgroup_count_y, workgroups_y);
  atomicMax(&(*args).workgroup_count_z, 1u);
}

fn hierarchy_linear_invocation_index(id: vec3u, grid: vec3u) -> u32 {
  return id.x + id.y * grid.x * ${HIERARCHICAL_WORKGROUP_SIZE}u;
}

fn hierarchy_try_reserve_root(
  header: ptr<storage, OEngineWorkQueueHeader, read_write>
) -> u32 {
  oengine_atomic_saturating_add_u32(&(*header).attempted, 1u);
  var observed = atomicLoad(&(*header).written);
  loop {
    if observed >= (*header).capacity {
      atomicOr(&(*header).overflow, 1u);
      return OENGINE_WORK_QUEUE_INVALID_OFFSET;
    }
    let next = observed + 1u;
    let result = atomicCompareExchangeWeak(&(*header).written, observed, next);
    if result.exchanged {
      atomicMax(&(*header).peak, next);
      return observed;
    }
    observed = result.old_value;
  }
}

@compute @workgroup_size(${HIERARCHICAL_WORKGROUP_SIZE})
fn r3_instance_cull(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  if id.x == 0u {
    hierarchy_init_draw_indirect.vertex_count = 384u;
    atomicStore(&hierarchy_init_draw_indirect.instance_count, 0u);
    hierarchy_init_draw_indirect.first_vertex = 0u;
    hierarchy_init_draw_indirect.first_instance = 0u;
  }
  let invocation_index = hierarchy_linear_invocation_index(id, grid);
  if invocation_index >= hierarchy_view.scene.y { return; }
  let instance_record_index = hierarchy_view.scene.x + invocation_index;
  let instance = hierarchy_instances[instance_record_index];
  if !oengine_instance_active(instance) {
    return;
  }
  let instance_sphere = hierarchy_transform_sphere(
    instance.bounds_sphere,
    instance.current_object_to_world
  );
  if !hierarchy_sphere_in_frustum(instance_sphere, &hierarchy_view) {
    return;
  }
  let geometry = hierarchy_geometries[instance.geometry_record_index];
  let slot = hierarchy_try_reserve_root(&hierarchy_roots.header);
  if slot == OENGINE_WORK_QUEUE_INVALID_OFFSET {
    return;
  }
  hierarchy_roots.elements[slot] = OEngineTraversalWork(
    instance_record_index,
    geometry.cluster_root
  );
  hierarchy_update_dispatch(
    &hierarchy_root_dispatch,
    slot + 1u,
    hierarchy_view.limits.x
  );
}

@group(1) @binding(0) var<uniform> traversal_view: OEngineHierarchyView;
@group(1) @binding(1) var<storage, read> traversal_instances: array<OEngineInstanceRecord>;
@group(1) @binding(2) var<storage, read> traversal_geometries: array<GpuGeometryRecord>;
@group(1) @binding(3) var<storage, read> traversal_clusters: array<GpuClusterRecord>;
@group(1) @binding(4) var<storage, read> traversal_children: array<u32>;
@group(1) @binding(5) var<storage, read> traversal_input: OEngineTraversalQueueRead;
@group(1) @binding(6) var<storage, read_write> traversal_output: OEngineTraversalQueueWrite;
@group(1) @binding(7) var<storage, read_write> traversal_selected: OEngineVisibleClusterQueue;
@group(1) @binding(8) var<storage, read_write> traversal_output_dispatch: OEngineDispatchIndirectArgs;

fn traversal_select_cluster(
  work: OEngineTraversalWork,
  instance: OEngineInstanceRecord
) {
  let slot = oengine_try_reserve_work_group(&traversal_selected.header, 1u);
  if slot == OENGINE_WORK_QUEUE_INVALID_OFFSET {
    return;
  }
  traversal_selected.elements[slot] = OEngineVisibleClusterRecord(
    work.instance_record_index,
    instance.geometry_record_index,
    work.cluster_record_index,
    instance.material_handle
  );
}

@compute @workgroup_size(${HIERARCHICAL_WORKGROUP_SIZE})
fn r3_traverse_clusters(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  let input_count = min(
    traversal_input.header.written,
    traversal_input.header.capacity
  );
  let invocation_index = hierarchy_linear_invocation_index(id, grid);
  if invocation_index >= input_count { return; }
  let work = traversal_input.elements[invocation_index];
  let instance = traversal_instances[work.instance_record_index];
  let cluster = traversal_clusters[work.cluster_record_index];
  let scale = hierarchy_conservative_scale(instance.current_object_to_world);
  let sphere = hierarchy_transform_sphere(
    cluster.bounds_sphere,
    instance.current_object_to_world
  );
  if !hierarchy_sphere_in_frustum(sphere, &traversal_view) { return; }
  let projected_error = hierarchy_projected_error_pixels(
    cluster.geometric_error,
    sphere,
    scale,
    &traversal_view
  );
  if cluster.child_count == 0u || projected_error <= traversal_view.sse.x {
    traversal_select_cluster(work, instance);
    return;
  }

  let base = oengine_try_reserve_work_group(
    &traversal_output.header,
    cluster.child_count
  );
  if base == OENGINE_WORK_QUEUE_INVALID_OFFSET {
    traversal_select_cluster(work, instance);
    return;
  }
  for (var child = 0u; child < cluster.child_count; child++) {
    traversal_output.elements[base + child] = OEngineTraversalWork(
      work.instance_record_index,
      traversal_children[cluster.child_begin + child]
    );
  }
  hierarchy_update_dispatch(
    &traversal_output_dispatch,
    base + cluster.child_count,
    traversal_view.limits.x
  );
}

@group(2) @binding(0) var<uniform> raster_work_view: OEngineHierarchyView;
@group(2) @binding(1) var<storage, read> raster_work_clusters: array<GpuClusterRecord>;
@group(2) @binding(2) var<storage, read> raster_work_selected: OEngineVisibleClusterQueueRead;
@group(2) @binding(3) var<storage, read_write> raster_work_output: OEngineRasterWorkQueue;
@group(2) @binding(4) var<storage, read_write> hierarchy_draw_indirect: OEngineDrawIndirectArgs;
@group(2) @binding(5) var<storage, read_write> raster_work_dispatch: OEngineDispatchIndirectArgs;
@group(2) @binding(6) var<storage, read> raster_work_evidence: array<u32>;
@group(2) @binding(7) var<storage, read_write> raster_work_counters: array<atomic<u32>>;

@compute @workgroup_size(1)
fn r3_prepare_raster_dispatch() {
  let visible_count = min(
    raster_work_selected.header.written,
    raster_work_selected.header.capacity
  );
  hierarchy_update_dispatch(
    &raster_work_dispatch,
    visible_count,
    raster_work_view.limits.x
  );
}

@compute @workgroup_size(${HIERARCHICAL_WORKGROUP_SIZE})
fn r3_expand_raster_work(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  let visible_count = min(
    raster_work_selected.header.written,
    raster_work_selected.header.capacity
  );
  let invocation_index = hierarchy_linear_invocation_index(id, grid);
  if invocation_index >= visible_count { return; }
  let visible = raster_work_selected.elements[invocation_index];
  let cluster = raster_work_clusters[visible.cluster_record_index];
  let base = oengine_try_reserve_work_group(
    &raster_work_output.header,
    cluster.meshlet_count
  );
  if base == OENGINE_WORK_QUEUE_INVALID_OFFSET {
    return;
  }
  for (var local_meshlet = 0u; local_meshlet < cluster.meshlet_count; local_meshlet++) {
    raster_work_output.elements[base + local_meshlet] = OEngineRasterWork(
      invocation_index,
      cluster.meshlet_begin + local_meshlet
    );
  }
  let published_end = base + cluster.meshlet_count;
  atomicMax(&hierarchy_draw_indirect.instance_count, published_end);
}

@compute @workgroup_size(1)
fn r3_write_work_counters() {
  if raster_work_view.scene.w == 0u { return; }
  let round_count = raster_work_view.scene.z;
  var candidate_clusters = 0u;
  var scene_overflow = 0u;
  // Root plus every traversal input queue. The final encoded round output is
  // intentionally excluded because no subsequent round consumes it.
  for (var header_index = 0u; header_index < round_count; header_index++) {
    let word = header_index * 8u;
    candidate_clusters += raster_work_evidence[word];
    scene_overflow |= raster_work_evidence[word + 3u];
  }
  let selected_word = (round_count + 1u) * 8u;
  scene_overflow |= raster_work_evidence[selected_word + 3u];
  let root_visible = raster_work_evidence[0u];
  let selected_cluster_count = min(
    raster_work_evidence[selected_word],
    raster_work_evidence[selected_word + 5u]
  );
  let raster_count = atomicLoad(&raster_work_output.header.written);
  atomicAdd(
    &raster_work_counters[R3_COUNTER_CANDIDATE_INSTANCES],
    raster_work_view.scene.y
  );
  atomicAdd(&raster_work_counters[R3_COUNTER_VISIBLE_INSTANCES], root_visible);
  atomicAdd(
    &raster_work_counters[R3_COUNTER_REJECTED_FRUSTUM],
    raster_work_view.scene.y - min(root_visible, raster_work_view.scene.y)
  );
  atomicAdd(
    &raster_work_counters[R3_COUNTER_CANDIDATE_CLUSTERS],
    candidate_clusters
  );
  atomicAdd(
    &raster_work_counters[R3_COUNTER_SELECTED_CLUSTERS],
    selected_cluster_count
  );
  atomicAdd(&raster_work_counters[R3_COUNTER_HW_CLUSTERS], raster_count);
  atomicAdd(&raster_work_counters[R3_COUNTER_HW_TRIANGLES], raster_count * 128u);
  if scene_overflow != 0u {
    atomicOr(
      &raster_work_counters[R3_COUNTER_OVERFLOW_MASK],
      R3_SCENE_QUEUE_OVERFLOW_BIT
    );
  }
  if atomicLoad(&raster_work_output.header.overflow) != 0u {
    atomicOr(
      &raster_work_counters[R3_COUNTER_OVERFLOW_MASK],
      R3_MESHLET_QUEUE_OVERFLOW_BIT
    );
  }
}
`;
