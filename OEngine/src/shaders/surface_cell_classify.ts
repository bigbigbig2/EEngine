import { surfaceCellGroupValidationWgsl } from "./surface_cell_group_validation.js";
import { SURFACE_CELL_PLANE_COUNT, SURFACE_CELL_TILE_PLAN_BYTES, SURFACE_CELL_PLANE_BYTES, surfaceCellWorkspaceWgsl } from "../gpu/GpuSurfaceCellPlanAbi.js";

/** Exactly 16 quads, four parents and one root. Each node merges four children;
 * rejected parents retain their children. No arbitrary domain subsets. */
export function surfaceCellClassifyStageWgsl(factLibrary: string, tileCapacity = 4096,
  stageIndex = 0, planeStart = 0, planeCount = SURFACE_CELL_PLANE_COUNT,
  entryPoint = "classify_cells", validateBounds: boolean | "field" | "field-geometry" | "full" | "single" = true): string {
  if (!factLibrary.includes("fn surface_cell_load(") || !factLibrary.includes("fn surface_cell_compatible(")) {
    throw new Error("Surface classifier requires complete fact producers");
  }
  const specialized = typeof validateBounds === "string";
  const valueHit = factLibrary.includes("fn surface_cell_value_hit(") ? "surface_cell_value_hit(plane, child)" : "false";
  const pointHit = factLibrary.includes("fn surface_cell_value_hit(") ? "surface_cell_value_hit(plane, lane)" : "false";
  const domainCache = factLibrary.includes("fn surface_cell_domain_token(");
  const genericPredicate = validateBounds === true
    ? "surface_cell_group_valid(plane, result.coverage, &cell_facts, origin)" : "true";
  const library = factLibrary.replaceAll("cell_counts[", "cell_workspace.counters[")
    .replaceAll("cell_plans[", "cell_workspace.plans[").replaceAll("cell_maps[", "cell_workspace.maps[");
  return /* wgsl */ `
struct CellSettings {
  width: u32, height: u32, tiles_x: u32, first_tile: u32,
  tile_count: u32, batch_target_capacity: u32, generation: u32, reserved: u32,
}
struct SurfaceCellLane {
  identity: vec4u,
  winner: u32, source: u32, enabled: u32, publication: u32,
}
struct CellTreeNode {
  coverage: vec2u,
  source: u32,
  homogeneous: u32,
  hits: u32,
  dependencies: u32,
  accepted: u32,
  reserved: u32,
}
${surfaceCellWorkspaceWgsl(tileCapacity)}
@group(0) @binding(0) var<uniform> cell_settings: CellSettings;
@group(0) @binding(1) var cell_visibility: texture_2d<u32>;
@group(0) @binding(2) var<storage, read_write> cell_workspace: SurfaceCellWorkspace;
var<private> cell_local_tile: u32;
var<workgroup> cell_facts: array<SurfaceCellLane, 64>;
var<workgroup> cell_tree: array<CellTreeNode, 21>;
var<workgroup> cell_owner: array<u32, 64>;
var<workgroup> cell_prefix: array<u32, 64>;
var<workgroup> cell_representatives: array<u32, 64>;
var<workgroup> cell_plane_bits: array<atomic<u32>, 6>;
var<workgroup> cell_plane_state: vec4u;
${domainCache ? "var<workgroup> cell_domain_cache: array<vec4u, 21>;" : ""}

fn cell_bit(lane: u32) -> vec2u {
  if lane < 32u { return vec2u(1u << lane, 0u); }
  return vec2u(0u, 1u << (lane - 32u));
}
fn cell_member(mask: vec2u, lane: u32) -> bool {
  return any((mask & cell_bit(lane)) != vec2u(0u));
}
fn cell_first(mask: vec2u) -> u32 {
  if mask.x != 0u { return firstTrailingBit(mask.x); }
  if mask.y != 0u { return 32u + firstTrailingBit(mask.y); }
  return 0xffffffffu;
}
fn cell_region(lane: u32, width: u32, height: u32) -> vec2u {
  let origin = vec2u((lane % 8u) / width * width, (lane / 8u) / height * height);
  var mask = vec2u(0u);
  for (var y = 0u; y < height; y++) {
    for (var x = 0u; x < width; x++) { mask |= cell_bit((origin.y + y) * 8u + origin.x + x); }
  }
  return mask;
}
fn cell_plan_at(tile: u32, plane: u32) -> u32 {
  return tile * ${SURFACE_CELL_TILE_PLAN_BYTES / 4}u + 16u + plane * ${SURFACE_CELL_PLANE_BYTES / 4}u;
}
fn cell_tree_child(node: u32, child: u32) -> u32 {
  if node < 16u { return (node / 4u) * 16u + (node % 4u) * 2u + (child / 2u) * 8u + child % 2u; }
  if node < 20u {
    let parent = node - 16u;
    return (parent / 2u) * 8u + (parent % 2u) * 2u + (child / 2u) * 4u + child % 2u;
  }
  return 16u + child;
}
fn cell_tree_quad(lane: u32) -> u32 { return (lane / 16u) * 4u + (lane % 8u) / 2u; }
fn cell_tree_parent(lane: u32) -> u32 { return 16u + (lane / 32u) * 2u + (lane % 8u) / 4u; }
fn cell_tree_rectangle(node: u32) -> vec2u {
  if node == 20u { return vec2u(0xffffffffu); }
  let first = cell_tree_child(node, 0u);
  if node < 16u {
    return select(vec2u(0x303u << (first & 31u), 0u), vec2u(0u, 0x303u << (first & 31u)), first >= 32u);
  }
  let parent = node - 16u;
  let bits = 0x0f0f0f0fu << ((parent % 2u) * 4u);
  return select(vec2u(bits, 0u), vec2u(0u, bits), parent >= 2u);
}
fn cell_tree_coverage(node: u32, child: u32) -> vec2u {
  let index = cell_tree_child(node, child);
  if node < 16u { return select(vec2u(0u), cell_bit(index), cell_member(cell_plane_state.xy, index)); }
  return cell_tree[index].coverage;
}
fn cell_pack_map_word(word: u32, representatives: bool) -> u32 {
  let begin = word * 32u;
  let first = begin / 6u;
  let last = min(63u, (begin + 31u) / 6u);
  var packed = 0u;
  for (var entry = first; entry <= last; entry++) {
    var value = cell_owner[entry];
    if representatives { value = cell_representatives[entry]; }
    let bit = entry * 6u;
    if bit >= begin { packed |= value << (bit - begin); }
    else { packed |= value >> (begin - bit); }
  }
  return packed;
}
${library}
${specialized ? surfaceCellGroupValidationWgsl(planeStart, planeCount, factLibrary.includes("fn surface_proof_admit(")) : ""}

@compute @workgroup_size(64)
fn ${entryPoint}(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let tile = group.x;
  cell_local_tile = tile;
  if tile >= cell_settings.tile_count { return; }
  let absolute = cell_workspace.plans[tile * ${SURFACE_CELL_TILE_PLAN_BYTES / 4}u + 4u];
  let origin = vec2u((absolute % cell_settings.tiles_x) * 8u, (absolute / cell_settings.tiles_x) * 8u);
  let pixel = origin + vec2u(lane % 8u, lane / 8u);
  var fact = SurfaceCellLane(vec4u(0u), 0xffffffffu, 0u, 0u, 0u);
  if pixel.x < cell_settings.width && pixel.y < cell_settings.height {
    let winner = textureLoad(cell_visibility, vec2i(pixel), 0).x;
    if winner != 0xffffffffu { fact = surface_cell_load(pixel, winner); }
  }
  cell_facts[lane] = fact;
  ${domainCache ? "if lane < 21u { cell_domain_cache[lane] = vec4u(0u); }" : ""}
  ${specialized && planeStart + planeCount > 15 ? "if lane < 21u { cell_provider_cache[lane] = vec4u(0u); }" : ""}
  workgroupBarrier();
  for (var plane = ${planeStart}u; plane < ${planeStart + planeCount}u; plane++) {
    if lane < 6u { atomicStore(&cell_plane_bits[lane], 0u); }
    cell_owner[lane] = lane;
    cell_representatives[lane] = 0u;
    workgroupBarrier();
    let covered = (fact.enabled & (1u << plane)) != 0u;
    if covered {
      let bit = cell_bit(lane);
      atomicOr(&cell_plane_bits[0u], bit.x);
      atomicOr(&cell_plane_bits[1u], bit.y);
      if (fact.publication & (1u << plane)) == 0u { atomicOr(&cell_plane_bits[2u], 1u); }
      if ${pointHit} { atomicAdd(&cell_plane_bits[3u], 1u); }
    }
    workgroupBarrier();
    if lane == 0u {
      let coverage = vec2u(atomicLoad(&cell_plane_bits[0u]), atomicLoad(&cell_plane_bits[1u]));
      let members = countOneBits(coverage.x) + countOneBits(coverage.y);
      var flags = atomicLoad(&cell_plane_bits[2u]);
      if flags != 0u && members != 0u && atomicLoad(&cell_plane_bits[3u]) == members { flags |= 2u; }
      atomicStore(&cell_plane_bits[3u], 0u);
      cell_plane_state = vec4u(coverage, members, flags);
    }
    workgroupBarrier();
    let state = workgroupUniformLoad(&cell_plane_state);
    // Empty/publication and complete point-hit templates need no spatial tree.
    // workgroupUniformLoad makes this branch uniform around all barriers.
    if state.w == 1u && state.z != 0u {
      for (var level = 0u; level < 3u; level++) {
        let start = select(select(0u, 16u, level == 1u), 20u, level == 2u);
        let count = select(select(16u, 4u, level == 1u), 1u, level == 2u);
        if lane < count {
          let node = start + lane;
          var result: CellTreeNode;
          result.source = 0xffffffffu;
          result.homogeneous = 1u;
          ${domainCache ? `let expected = cell_tree_rectangle(node) & state.xy;
          let anchor = cell_first(expected);
          var token = 0u;
          if anchor != 0xffffffffu { token = surface_cell_domain_token(plane, anchor); }
          let cached = cell_domain_cache[node];
          let reuse_domain = token != 0u && cached.z == token && all(cached.xy == expected);
          if reuse_domain { result.homogeneous = cached.w; }` : ""}
          for (var ordinal = 0u; ordinal < 4u; ordinal++) {
            let child = cell_tree_child(node, ordinal);
            let coverage = cell_tree_coverage(node, ordinal);
            if all(coverage == vec2u(0u)) { continue; }
            let source = cell_first(coverage);
            var homogeneous = 1u;
            if level != 0u {
              homogeneous = cell_tree[child].homogeneous;
              result.hits += cell_tree[child].hits;
            } else if ${valueHit} { result.hits++; }
            if ${domainCache ? "!reuse_domain && " : ""}result.source != 0xffffffffu && !surface_cell_compatible(plane, cell_facts[result.source], cell_facts[source]) {
              homogeneous = 0u;
            }
            result.coverage |= coverage;
            result.homogeneous &= homogeneous;
            result.source = cell_first(result.coverage);
          }
          ${domainCache ? "cell_domain_cache[node] = vec4u(result.coverage, token, result.homogeneous);" : ""}
          let members = countOneBits(result.coverage.x) + countOneBits(result.coverage.y);
          let eligible = level < 2u || plane == 15u || plane == 16u;
          result.accepted = select(0u, 1u, state.w != 0u && members > 1u && result.hits < members && result.homogeneous != 0u && eligible);
          ${specialized ? "" : `if result.accepted != 0u && !${genericPredicate} { result.accepted = 0u; }`}
          cell_tree[node] = result;
          ${specialized ? "cell_tree_prepare_geometry(node);" : ""}
        }
        workgroupBarrier();
      }
      ${specialized ? "cell_tree_validate_plane(plane, lane);" : ""}
    }
    if covered && state.w == 1u {
      let quad = cell_tree_quad(lane);
      let parent = cell_tree_parent(lane);
      if cell_tree[quad].accepted != 0u { cell_owner[lane] = cell_tree[quad].source; }
      if cell_tree[parent].accepted != 0u { cell_owner[lane] = cell_tree[parent].source; }
      if cell_tree[20u].accepted != 0u { cell_owner[lane] = cell_tree[20u].source; }
    }
    workgroupBarrier();
    // Rank directly maps each representative to its slot. Every prefix step
    // snapshots reads, then synchronizes before writes and again after writes.
    let representative = covered && state.w != 0u && cell_owner[lane] == lane;
    cell_prefix[lane] = select(0u, 1u, representative);
    workgroupBarrier();
    if state.w != 0u {
      for (var distance = 1u; distance < 64u; distance <<= 1u) {
        var sum = cell_prefix[lane];
        if lane >= distance { sum += cell_prefix[lane - distance]; }
        workgroupBarrier();
        cell_prefix[lane] = sum;
        workgroupBarrier();
      }
    }
    if representative { cell_representatives[cell_prefix[lane] - 1u] = lane; }
    if covered && state.w != 0u {
      let source = cell_owner[lane];
      // A formula grid must match the accepted tree, not identity alone.
      if state.w == 1u {
        if source != cell_first(cell_tree[cell_tree_quad(lane)].coverage) { atomicOr(&cell_plane_bits[3u], 1u); }
        if source != cell_first(cell_tree[cell_tree_parent(lane)].coverage) { atomicOr(&cell_plane_bits[4u], 1u); }
        if source != cell_first(state.xy) { atomicOr(&cell_plane_bits[5u], 1u); }
      }
      cell_owner[lane] = cell_prefix[source] - 1u;
    } else { cell_owner[lane] = 0u; }
    workgroupBarrier();
    if lane == 0u {
      var mode = 4u;
      var rate = 0u;
      var slots = cell_prefix[63u];
      if state.z == 0u { mode = 0u; slots = 0u; }
      else if state.w == 0u { mode = 1u; slots = 0u; }
      else if slots == state.z { mode = 2u; slots = 64u; }
      else {
        var exponent = 0u;
        if atomicLoad(&cell_plane_bits[3u]) == 0u { exponent = 1u; }
        if atomicLoad(&cell_plane_bits[4u]) == 0u { exponent = 2u; }
        if (plane == 15u || plane == 16u) && atomicLoad(&cell_plane_bits[5u]) == 0u { exponent = 3u; }
        if exponent != 0u {
          mode = 3u;
          rate = exponent | (exponent << 2u);
          slots = (8u >> exponent) * (8u >> exponent);
        }
      }
      var map = 0u;
      if mode == 4u {
        map = atomicAdd(&cell_workspace.counters[126u], 24u);
        if map + 24u > ${tileCapacity * SURFACE_CELL_PLANE_COUNT * 24}u { mode = 2u; slots = 64u; map = 0u; }
      }
      let at = cell_plan_at(tile, plane);
      cell_workspace.plans[at + 2u] = map;
      cell_workspace.plans[at + 3u] = slots;
      cell_workspace.plans[at + 4u] = state.x;
      cell_workspace.plans[at + 5u] = state.y;
      cell_plane_state = vec4u(mode, rate, map, slots);
    }
    workgroupBarrier();
    let output = workgroupUniformLoad(&cell_plane_state);
    if output.x == 4u && lane < 12u {
      cell_workspace.maps[output.z + lane] = cell_pack_map_word(lane, false);
      cell_workspace.maps[output.z + 12u + lane] = cell_pack_map_word(lane, true);
    }
    storageBarrier();
    if lane == 0u {
      let at = cell_plan_at(tile, plane);
      cell_workspace.plans[at + 1u] = select(select(0u, 4u, output.x == 3u), 1u, output.x == 1u);
      cell_workspace.plans[at] = output.x | (output.y << 8u);
      let template_at = tile * ${SURFACE_CELL_TILE_PLAN_BYTES / 4}u + 8u;
      if output.x == 4u { cell_workspace.plans[template_at] = 4u; }
      else if (output.x == 1u || output.x == 3u) && cell_workspace.plans[template_at] == 2u { cell_workspace.plans[template_at] = 3u; }
      if cell_settings.reserved != 0u { atomicAdd(&cell_workspace.counters[plane * 4u], output.w); }
    }
    workgroupBarrier();
  }
}
`;
}

/** Synthetic tests use the same tree/publisher with independently defined facts. */
export function surfaceCellClassifyWgsl(factLibrary: string, tileCapacity = 4096): string {
  return surfaceCellClassifyStageWgsl(factLibrary, tileCapacity);
}
