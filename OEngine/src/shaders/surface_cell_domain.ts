import { SURFACE_EXECUTION_WORDS, SURFACE_FIELD_EXECUTION_WORDS, SURFACE_SIGNAL_EXECUTION_WORDS } from "../gpu/GpuSurfaceExecutionProfileAbi.js";
import { SURFACE_REFERENCE_KIND } from "../gpu/GpuSurfaceReferenceAbi.js";

/** Complete dynamic DomainKey equality. Interned dependency tokens only allow
 * reuse of equality already established over the same immutable lane facts. */
export const SURFACE_CELL_DOMAIN_WGSL = /* wgsl */ `
fn cell_seam_compatible(mask: u32, a: SurfaceCellLane, b: SurfaceCellLane) -> bool {
  let left = cell_lane_geometry[a.source];
  let right = cell_lane_geometry[b.source];
  if (mask & 1u) != 0u && left.continuity0.y != right.continuity0.y { return false; }
  if (mask & 2u) != 0u && left.continuity0.z != right.continuity0.z { return false; }
  if (mask & 4u) != 0u && left.continuity0.w != right.continuity0.w { return false; }
  if (mask & 8u) != 0u && left.continuity1.x != right.continuity1.x { return false; }
  if (mask & 16u) != 0u && left.continuity1.y != right.continuity1.y { return false; }
  // UV2 has no published chart correspondence. Restrict only closures that
  // consume it to the exact representation-local primitive namespace.
  if (mask & 64u) != 0u && any(left.address.xyz != right.address.xyz) { return false; }
  return true;
}

fn surface_cell_compatible(plane: u32, a: SurfaceCellLane, b: SurfaceCellLane) -> bool {
  if a.identity.w == 0u || any(a.identity != b.identity) { return false; }
  let left = cell_lane_geometry[a.source];
  let right = cell_lane_geometry[b.source];
  if left.identity.w != right.identity.w || any(left.source.zw != right.source.zw) ||
    left.source.y != right.source.y { return false; }
  // Published continuous lineage remains authoritative across meshlets/LOD;
  // meshlet equality is not imposed on otherwise valid ordinary UV closures.
  if plane == 15u || plane == 17u || plane == 19u {
    let left_cluster = cell_workspace.facts[cell_local_tile * 64u + a.source].w;
    let right_cluster = cell_workspace.facts[cell_local_tile * 64u + b.source].w;
    if left_cluster == 0xffffffffu || left_cluster != right_cluster { return false; }
  }
  let entry = cell_material_entry(left.source.y);
  let base = settings.appearance2.w + entry * ${SURFACE_EXECUTION_WORDS}u + 8u;
  var seam = 0u;
  if plane < 15u {
    seam = appearance_metadata[base + plane * ${SURFACE_FIELD_EXECUTION_WORDS}u + 2u];
  } else {
    seam = appearance_metadata[base + 15u * ${SURFACE_FIELD_EXECUTION_WORDS}u +
      (plane - 15u) * ${SURFACE_SIGNAL_EXECUTION_WORDS}u + 3u];
  }
  return cell_seam_compatible(seam, a, b);
}

fn surface_cell_value_hit(plane: u32, lane: u32) -> bool {
  let leaf = cell_local_tile * 64u + lane;
  if (cell_facts[lane].publication & (1u << plane)) != 0u { return true; }
  if plane < 15u {
    return cell_workspace.field_references[(leaf * 15u + plane) * 3u] == ${SURFACE_REFERENCE_KIND.store}u;
  }
  return cell_workspace.signal_references[(leaf * 6u + plane - 15u) * 3u] == ${SURFACE_REFERENCE_KIND.store}u;
}

fn surface_cell_domain_token(plane: u32, lane: u32) -> u32 {
  let entry = cell_workspace.facts[cell_local_tile * 64u + lane].z;
  let base = settings.appearance2.w + entry * ${SURFACE_EXECUTION_WORDS}u + 8u;
  if plane < 15u {
    return appearance_metadata[base + plane * ${SURFACE_FIELD_EXECUTION_WORDS}u + 12u];
  }
  // A signal domain token can be equal across direct/environment kinds. Use
  // the full execution token, whose provider/kind semantics also agree.
  return appearance_metadata[base + 15u * ${SURFACE_FIELD_EXECUTION_WORDS}u +
    (plane - 15u) * ${SURFACE_SIGNAL_EXECUTION_WORDS}u];
}
`;
