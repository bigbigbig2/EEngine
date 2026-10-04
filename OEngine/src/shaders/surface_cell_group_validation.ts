export const SURFACE_CELL_CLASSIFY_STAGES = Object.freeze([
  { first: 0, count: 15 },
  { first: 15, count: 6 }
] as const);

export const SURFACE_CELL_CERTIFICATE_FAMILIES = Object.freeze([
  Object.freeze([0, 1, 5]),
  Object.freeze([2, 3, 4, 7, 8, 9]),
  Object.freeze([6, 10, 11, 12, 13, 14])
]);

/** Bounds stay in the current plane's 21-node tree. Each level merges exactly
 * four children; the original interval arithmetic supplies outward rounding.
 * Provider risk is cached by node + exact coverage across direct lobes. */
export function surfaceCellGroupValidationWgsl(planeStart: number, planeCount: number, admitProvider = true): string {
  const signals = planeStart + planeCount > 15;
  return /* wgsl */ `
struct CellTreeGeometry {
  world_low: vec3f, flags: u32,
  world_high: vec3f, scale: f32,
  ${signals ? `normal_low: vec3f, reserved0: u32,
  normal_high: vec3f, reserved1: u32,
  tangent_low: vec3f, reserved2: u32,
  tangent_high: vec3f, reserved3: u32,
  view_low: vec3f, reserved4: u32,
  view_high: vec3f, reserved5: u32,` : ""}
  residual: vec2f,
  reserved6: vec2u,
}
var<workgroup> cell_tree_geometry: array<CellTreeGeometry, 21>;
var<workgroup> cell_tree_fields: array<AppearanceBound4, 21>;
var<workgroup> cell_tree_dependencies: u32;
${signals ? "var<workgroup> cell_provider_cache: array<vec4u, 21>;\nvar<workgroup> cell_provider_reservation: vec2u;" : ""}

fn cell_tree_empty_bound() -> AppearanceBound4 {
  return AppearanceBound4(vec4f(3.402823466e38), vec4f(-3.402823466e38), vec4u(1u));
}
fn cell_tree_prepare_geometry(node: u32) {
  let metadata = cell_tree[node];
  var result: CellTreeGeometry;
  result.world_low = vec3f(3.402823466e38);
  result.world_high = vec3f(-3.402823466e38);
  result.scale = 3.402823466e38;
  result.residual = vec2f(3.402823466e38, -3.402823466e38);
  result.flags = 31u;
  ${signals ? `result.normal_low = result.world_low;
  result.normal_high = result.world_high;
  result.tangent_low = result.world_low;
  result.tangent_high = result.world_high;
  result.view_low = result.world_low;
  result.view_high = result.world_high;` : ""}
  if metadata.source == 0xffffffffu {
    result.flags = 0u;
    cell_tree_geometry[node] = result;
    return;
  }
  let plane = cell_lane_geometry[metadata.source].plane;
  for (var ordinal = 0u; ordinal < 4u; ordinal++) {
    let coverage = cell_tree_coverage(node, ordinal);
    if all(coverage == vec2u(0u)) { continue; }
    let child = cell_tree_child(node, ordinal);
    var low: vec3f;
    var high: vec3f;
    var residual: vec2f;
    var scale: f32;
    var child_plane: vec4f;
    var flags: u32;
    ${signals ? `var normal: AppearanceBound4;
    var tangent: AppearanceBound4;
    var view: AppearanceBound4;` : ""}
    if node < 16u {
      let certificate = cell_leaf_certificate(cell_local_tile, child);
      let at = (cell_local_tile * 64u + certificate) * CELL_CERTIFICATE_GEOMETRY_WORDS;
      let world = cell_certificate_box(cell_local_tile, certificate, 0u);
      low = world.low.xyz;
      high = world.high.xyz;
      flags = cell_workspace.geometry_certificates[at + 31u];
      residual = bitcast<vec2f>(vec2u(cell_workspace.geometry_certificates[at + 24u], cell_workspace.geometry_certificates[at + 25u]));
      scale = bitcast<f32>(cell_workspace.geometry_certificates[at + 30u]);
      child_plane = bitcast<vec4f>(vec4u(cell_workspace.geometry_certificates[at + 26u], cell_workspace.geometry_certificates[at + 27u],
        cell_workspace.geometry_certificates[at + 28u], cell_workspace.geometry_certificates[at + 29u]));
      ${signals ? `normal = cell_certificate_box(cell_local_tile, certificate, 1u);
      tangent = cell_certificate_box(cell_local_tile, certificate, 2u);
      view = cell_certificate_box(cell_local_tile, certificate, 3u);` : ""}
    } else {
      let geometry = cell_tree_geometry[child];
      low = geometry.world_low;
      high = geometry.world_high;
      flags = geometry.flags;
      residual = geometry.residual;
      scale = geometry.scale;
      child_plane = cell_lane_geometry[cell_tree[child].source].plane;
      ${signals ? `normal = AppearanceBound4(vec4f(geometry.normal_low, 0.0), vec4f(geometry.normal_high, 0.0), vec4u(select(0u, 1u, (flags & 2u) != 0u)));
      tangent = AppearanceBound4(vec4f(geometry.tangent_low, 0.0), vec4f(geometry.tangent_high, 0.0), vec4u(select(0u, 1u, (flags & 4u) != 0u)));
      view = AppearanceBound4(vec4f(geometry.view_low, 0.0), vec4f(geometry.view_high, 0.0), vec4u(select(0u, 1u, (flags & 8u) != 0u)));` : ""}
    }
    result.flags &= flags;
    result.world_low = min(result.world_low, low);
    result.world_high = max(result.world_high, high);
    result.scale = min(result.scale, scale);
    // A child's interval is correlated to its own anchor plane. Move it to
    // this node's actual covered anchor before combining residual envelopes.
    var distance = AppearanceBound(residual.x, residual.y, select(0u, 1u, (flags & 17u) == 17u));
    let delta = plane - child_plane;
    distance = ab_add(distance, ab_exact(delta.w));
    for (var channel = 0u; channel < 3u; channel++) {
      distance = ab_add(distance, ab_multiply(ab_exact(delta[channel]), AppearanceBound(low[channel], high[channel], select(0u, 1u, (flags & 1u) != 0u))));
    }
    if !ab_valid(distance) || !(scale > 0.0) { result.flags &= ~16u; }
    result.residual.x = min(result.residual.x, distance.low);
    result.residual.y = max(result.residual.y, distance.high);
    ${signals ? `result.normal_low = min(result.normal_low, normal.low.xyz);
    result.normal_high = max(result.normal_high, normal.high.xyz);
    result.tangent_low = min(result.tangent_low, tangent.low.xyz);
    result.tangent_high = max(result.tangent_high, tangent.high.xyz);
    result.view_low = min(result.view_low, view.low.xyz);
    result.view_high = max(result.view_high, view.high.xyz);` : ""}
  }
  cell_tree_geometry[node] = result;
}

fn cell_tree_prepare_field(node: u32, field: u32) {
  var result = cell_tree_empty_bound();
  for (var ordinal = 0u; ordinal < 4u; ordinal++) {
    if all(cell_tree_coverage(node, ordinal) == vec2u(0u)) { continue; }
    let child = cell_tree_child(node, ordinal);
    var value: AppearanceBound4;
    if node < 16u { value = cell_certificate_field(cell_local_tile, cell_leaf_certificate(cell_local_tile, child), field); }
    else { value = cell_tree_fields[child]; }
    result = cell_merge_bound(result, value);
  }
  cell_tree_fields[node] = result;
}

fn cell_tree_apply_field(node: u32, plane: u32, field: u32) {
  if (cell_tree[node].dependencies & (1u << field)) == 0u { return; }
  let value = cell_tree_fields[node];
  var valid = cell_field_budget(field, value);
  ${signals ? `
  if plane >= 15u {
    let geometry = cell_tree_geometry[node];
    let mapped_field = select(6u, 12u, plane >= 19u);
    if field == mapped_field {
      let normal = cell_normal_box_cone(geometry.normal_low, geometry.normal_high);
      let mapped = cell_normal_box_cone(value.low.xyz, value.high.xyz);
      var tangent = vec4f(1.0, 0.0, 0.0, 1.0);
      if any(value.low.xy != vec2f(0.0)) || any(value.high.xy != vec2f(0.0)) {
        if (geometry.flags & 4u) == 0u { valid = false; }
        tangent = cell_normal_box_cone(geometry.tangent_low, geometry.tangent_high);
      }
      if min(min(normal.w, mapped.w), tangent.w) < 0.0 { valid = false; }
      if acos(clamp(normal.w, -1.0, 1.0)) + acos(clamp(mapped.w, -1.0, 1.0)) + acos(clamp(tangent.w, -1.0, 1.0)) > 0.02617993878 { valid = false; }
    }
    if plane == 19u && field == 6u && cell_normal_box_cone(value.low.xyz, value.high.xyz).w < 0.9986295348 { valid = false; }
    if field == 3u && (plane == 17u || plane == 18u || plane == 19u) && value.low.x < 0.35 { valid = false; }
    if field == 11u && plane >= 19u && value.low.x < 0.35 { valid = false; }
    if field == 10u && plane == 15u && value.high.x > 0.0 {
      if (geometry.flags & 8u) == 0u || cell_normal_box_cone(geometry.view_low, geometry.view_high).w < 0.9986295348 { valid = false; }
    }
    // Direct base specular includes coat Fresnel/attenuation. An active coat
    // requires its own roughness guard as in the complete original predicate.
    if plane == 17u && field == 10u { cell_tree[node].reserved = select(0u, 1u, value.high.x > 0.0); }
    if plane == 17u && field == 11u && cell_tree[node].reserved != 0u && value.low.x < 0.35 { valid = false; }
  }` : ""}
  if !valid { cell_tree[node].accepted = 0u; }
}

fn cell_tree_validate_plane(plane: u32, lane: u32) {
  if lane == 0u { cell_tree_dependencies = 0u; }
  workgroupBarrier();
  if lane < 21u {
    let metadata = cell_tree[lane];
    var dependencies = 0u;
    if metadata.source != 0xffffffffu {
      dependencies = 1u << plane;
      ${signals ? `if plane >= 15u {
        let entry = cell_material_entry(cell_lane_geometry[metadata.source].source.y);
        dependencies = cell_material_signal_dependencies(plane, entry, cell_local_tile * 64u + metadata.source);
      }` : ""}
    }
    cell_tree[lane].dependencies = dependencies;
    let geometry = cell_tree_geometry[lane];
    var valid = (geometry.flags & 17u) == 17u && max(abs(geometry.residual.x), abs(geometry.residual.y)) <= geometry.scale * 0.5;
    ${signals ? `if plane >= 15u {
      valid = valid && (geometry.flags & 2u) != 0u;
      if plane >= 17u {
        valid = valid && (geometry.flags & 8u) != 0u && cell_normal_box_cone(geometry.view_low, geometry.view_high).w >= 0.9986295348;
      }
    }` : ""}
    if !valid { cell_tree[lane].accepted = 0u; }
  }
  workgroupBarrier();
  ${signals ? `
  if plane >= 15u && (plane & 1u) != 0u {
  // Prioritize root, parents, then quads by covered work. Prefix scratch is
  // reused later for representatives, never across live consumers.
  cell_prefix[lane] = 0u;
  workgroupBarrier();
  var needs_provider = false;
  var priority = 0u;
  if lane < 21u && plane >= 15u && (plane & 1u) != 0u && cell_tree[lane].accepted != 0u {
    let metadata = cell_tree[lane];
    let cached = cell_provider_cache[lane];
    needs_provider = cached.z == 0u || any(cached.xy != metadata.coverage);
    priority = select(select(lane + 5u, lane - 15u, lane >= 16u), 0u, lane == 20u);
    if needs_provider { cell_prefix[priority] = 1u; }
  }
  workgroupBarrier();
  for (var distance = 1u; distance < 64u; distance <<= 1u) {
    var sum = cell_prefix[lane];
    if lane >= distance { sum += cell_prefix[lane - distance]; }
    workgroupBarrier();
    cell_prefix[lane] = sum;
    workgroupBarrier();
  }
  if lane == 0u {
    ${admitProvider ? "cell_provider_reservation = surface_proof_reserve(cell_prefix[63u]);" : "cell_provider_reservation = vec2u(0u, cell_prefix[63u]);"}
  }
  workgroupBarrier();
  let reservation = workgroupUniformLoad(&cell_provider_reservation);
  if needs_provider {
    let metadata = cell_tree[lane];
    let rank = cell_prefix[priority] - 1u;
    var safe = false;
    if rank < reservation.y {
      let geometry = cell_tree_geometry[lane];
      let cluster = cell_workspace.facts[cell_local_tile * 64u + metadata.source].w;
      ${admitProvider ? `let proof = reservation.x + rank;
      cell_workspace.proof_requests[proof] = array<u32,8>(cell_local_tile * 64u + metadata.source, 4u, plane - 15u, cluster, 5u, 0u, 0u, 0u);` : ""}
      safe = (geometry.flags & 8u) != 0u && cell_direct_node_safe(cluster, geometry.world_low,
        geometry.world_high, geometry.view_low, geometry.view_high);
      ${admitProvider ? "cell_workspace.proof_requests[proof][4u] = select(0u, 4u, safe);" : ""}
    }
    cell_provider_cache[lane] = vec4u(metadata.coverage, 1u, select(0u, 1u, safe));
  }
  workgroupBarrier();
  if lane < 21u && plane >= 15u && (plane & 1u) != 0u && cell_provider_cache[lane].w == 0u {
    cell_tree[lane].accepted = 0u;
  }
  workgroupBarrier();
  }` : ""}
  if lane < 21u && cell_tree[lane].accepted != 0u {
    atomicOr(&cell_plane_bits[2u], cell_tree[lane].dependencies << 1u);
  }
  workgroupBarrier();
  if lane == 0u { cell_tree_dependencies = atomicLoad(&cell_plane_bits[2u]) >> 1u; }
  workgroupBarrier();
  let fields = workgroupUniformLoad(&cell_tree_dependencies);
  for (var field = 0u; field < 15u; field++) {
    if (fields & (1u << field)) == 0u { continue; }
    for (var level = 0u; level < 3u; level++) {
      let start = select(select(0u, 16u, level == 1u), 20u, level == 2u);
      let count = select(select(16u, 4u, level == 1u), 1u, level == 2u);
      if lane < count { cell_tree_prepare_field(start + lane, field); }
      workgroupBarrier();
    }
    if lane < 21u && cell_tree[lane].accepted != 0u { cell_tree_apply_field(lane, plane, field); }
    workgroupBarrier();
  }
}
`;
}
