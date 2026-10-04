import { surfaceCellWorkspaceWgsl } from "../gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceDemandArenaWgsl, surfaceDemandLayout, SURFACE_DEMAND_PROBE_LIMIT } from "../gpu/GpuSurfaceDemandAbi.js";
import { SURFACE_FIELD_REQUEST_WGSL } from "./surface_field_request.js";
import { SURFACE_SIGNAL_REQUEST_WGSL } from "./surface_signal_request.js";
import { SURFACE_GEOMETRY_HOT_DEMAND_BIT } from "../gpu/GpuSurfaceGeometryRecordAbi.js";

/** Local task/indirect integration of the pinned OSS occupancy/task boundary.
 * Tables hold request IDs only. Request inputs are immutable during nomination;
 * aliases are published separately, so no workgroup reads a partial reservation.
 * Hash exhaustion retains an independent transient destination. Persistent
 * identity never uses a transient field slot, and no full request scan exists.
 * Dedup selects Store writers, never removes a mandatory transient closure. */
export function surfaceDemandWgsl(targets: number, programs: number): string {
  const layout = surfaceDemandLayout(targets, programs);
  const fieldGetter = SURFACE_FIELD_REQUEST_WGSL.replaceAll("field_request_settings", "demand_settings")
    .replaceAll("field_request_workspace", "demand_workspace")
    .replaceAll("field_request_metadata", "demand_metadata")
    .replaceAll("field_request_versions", "demand_versions");
  const signalGetter = SURFACE_SIGNAL_REQUEST_WGSL.replaceAll("signal_request_settings", "demand_settings")
    .replaceAll("signal_request_workspace", "demand_workspace")
    .replaceAll("signal_request_metadata", "demand_metadata")
    .replaceAll("signal_request_versions", "demand_versions")
    .replaceAll("signal_request_sun", "demand_sun")
    .replaceAll("signal_request_shadow", "demand_shadow");
  return /* wgsl */ `
${surfaceCellWorkspaceWgsl(targets / 64)}
${surfaceDemandArenaWgsl(targets, programs)}
struct DemandSettings {
  identities: u32, constants: u32, leaves: u32, store_entries: u32,
  epoch: u32, view_revision: u32, environment_revision: u32, light_revision: u32,
  shadow_revision: u32, sun_revision: u32, shadow_enabled: u32, sun_enabled: u32,
  store_enabled: u32, diagnostics: u32, reserved0: u32, reserved1: u32,
  directory: u32, program_count: u32, field_capacity: u32, signal_capacity: u32,
  first_tile: u32, tiles_x: u32, width: u32, height: u32,
}
@group(0) @binding(0) var<uniform> demand_settings: DemandSettings;
@group(0) @binding(1) var<storage, read_write> demand_workspace: SurfaceCellWorkspace;
@group(0) @binding(2) var<storage, read> demand_metadata: array<u32>;
@group(0) @binding(3) var<storage, read> demand_versions: array<u32>;
@group(0) @binding(4) var<storage, read_write> demand_arena: SurfaceDemandArena;
@group(0) @binding(5) var<uniform> demand_sun: array<vec4u, 3>;
@group(0) @binding(6) var<storage, read> demand_shadow: array<u32>;
${fieldGetter}
${signalGetter}
const DEMAND_PROBES: u32 = ${SURFACE_DEMAND_PROBE_LIMIT}u;
const DEMAND_FIELD_HASH_MASK: u32 = ${layout.fieldHashCapacity - 1}u;
const DEMAND_SIGNAL_HASH_MASK: u32 = ${layout.signalHashCapacity - 1}u;
var<workgroup> demand_counts: array<vec2u, 64>;
var<workgroup> demand_base: vec2u;

// Cooperative inclusive scan. Every lane reaches both barriers per step.
fn demand_scan(lane: u32, value: vec2u) -> vec2u {
  demand_counts[lane] = value;
  workgroupBarrier();
  for (var stride = 1u; stride < 64u; stride *= 2u) {
    var previous = vec2u(0u);
    if lane >= stride { previous = demand_counts[lane - stride]; }
    workgroupBarrier();
    demand_counts[lane] += previous;
    workgroupBarrier();
  }
  return demand_counts[lane] - value;
}

@compute @workgroup_size(64)
fn emit_surface_requests(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  let leaf = id.x;
  var fields = 0u;
  var signals = 0u;
  var admission_fields = 0u;
  var inputs = 0u;
  if leaf < demand_settings.leaves && demand_workspace.facts[leaf].x != 0xffffffffu &&
    demand_workspace.facts[leaf].z != 0xffffffffu {
    let publication = demand_metadata[demand_settings.constants + demand_workspace.facts[leaf].z * 64u];
    for (var field = 0u; field < 15u; field++) {
      if (publication & (1u << field)) != 0u { continue; }
      let reference = (leaf * 15u + field) * 3u;
      if reference_plan_leaf(leaf, field) != leaf ||
        demand_workspace.field_references[reference] != SURFACE_REFERENCE_INVALID { continue; }
      fields |= 1u << field;
      // Mandatory work has no queue reservation and no dictionary identity.
      demand_workspace.field_references[reference] = SURFACE_REFERENCE_TRANSIENT;
      demand_workspace.field_references[reference + 1u] = leaf * 15u + field;
      demand_workspace.field_references[reference + 2u] = demand_settings.epoch;
      inputs |= demand_metadata[field_request_descriptor(leaf, field) + 3u] >> 8u;
      if field_request_cacheable(leaf, field) { admission_fields |= 1u << field; }
    }
    for (var kind = 0u; kind < 6u; kind++) {
      let reference = (leaf * 6u + kind) * 3u;
      if reference_plan_leaf(leaf, 15u + kind) != leaf ||
        demand_workspace.signal_references[reference] != SURFACE_REFERENCE_INVALID { continue; }
      signals |= 1u << kind;
      demand_workspace.signal_references[reference] = SURFACE_REFERENCE_TRANSIENT;
      demand_workspace.signal_references[reference + 1u] = leaf * 6u + kind;
      demand_workspace.signal_references[reference + 2u] = demand_settings.epoch;
      inputs |= ${SURFACE_GEOMETRY_HOT_DEMAND_BIT}u;
    }
    atomicStore(&demand_arena.material_masks[leaf], fields);
    atomicStore(&demand_arena.lighting_masks[leaf], signals);
    if (inputs & ~1u) != 0u { atomicStore(&demand_arena.geometry_masks[leaf], inputs); }
  }
  if demand_settings.diagnostics != 0u {
    demand_scan(lane, vec2u(countOneBits(fields), countOneBits(signals)));
    if lane == 0u {
      atomicAdd(&demand_arena.control[49u], demand_counts[63u].x);
      atomicAdd(&demand_arena.control[50u], demand_counts[63u].y);
    }
    workgroupBarrier();
  }
  let counts = vec2u(countOneBits(admission_fields), 0u);
  let offset = demand_scan(lane, counts);
  if lane == 0u {
    demand_base = vec2u(atomicAdd(&demand_arena.control[1u], demand_counts[63u].x),
      atomicAdd(&demand_arena.control[2u], demand_counts[63u].y));
  }
  workgroupBarrier();
  var cursor = demand_base + offset;
  for (var field = 0u; field < 15u; field++) {
    if (admission_fields & (1u << field)) == 0u { continue; }
    let request = cursor.x;
    cursor.x++;
    if request >= demand_settings.field_capacity {
      atomicAdd(&demand_arena.control[47u], 1u);
      continue;
    }
    demand_arena.field_requests[request] = vec4u(leaf, field, 0u, 0u);
    demand_arena.field_aliases[request] = 0xffffffffu;
    demand_arena.field_results[request] = 0xffffffffu;
  }
}

// Field refs must be complete before selected-source Signal witnesses are
// read. A separate dispatch provides global visibility without cross-group
// synchronization or reading refs concurrently with their transient publisher.
@compute @workgroup_size(64)
fn emit_signal_cache_requests(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  let leaf = id.x;
  var eligible = 0u;
  if leaf < demand_settings.leaves {
    let dirty = atomicLoad(&demand_arena.lighting_masks[leaf]);
    for (var kind = 0u; kind < 6u; kind++) {
      if (dirty & (1u << kind)) != 0u &&
        signal_request_cacheable(leaf, signal_request_fields(leaf, kind), kind) {
        eligible |= 1u << kind;
      }
    }
  }
  let offset = demand_scan(lane, vec2u(0u, countOneBits(eligible)));
  if lane == 0u {
    demand_base.y = atomicAdd(&demand_arena.control[2u], demand_counts[63u].y);
  }
  workgroupBarrier();
  var cursor = demand_base.y + offset.y;
  for (var kind = 0u; kind < 6u; kind++) {
    if (eligible & (1u << kind)) == 0u { continue; }
    let request = cursor;
    cursor++;
    if request >= demand_settings.signal_capacity {
      atomicAdd(&demand_arena.control[48u], 1u);
      continue;
    }
    demand_arena.signal_requests[request] = vec4u(leaf, kind, 0u, 0u);
    demand_arena.signal_aliases[request] = 0xffffffffu;
    demand_arena.signal_results[request] = 0xffffffffu;
  }
}

fn demand_field_equal(a: u32, b: u32) -> bool {
  let x = demand_arena.field_requests[a];
  let y = demand_arena.field_requests[b];
  if !field_request_cacheable(x.x, x.y) || !field_request_cacheable(y.x, y.y) { return false; }
  for (var word = 0u; word < FIELD_REQUEST_KEY_WORDS; word++) {
    if field_request_word(x.x, x.y, word) != field_request_word(y.x, y.y, word) { return false; }
  }
  return true;
}
fn demand_field_hash(request: u32) -> u32 {
  let item = demand_arena.field_requests[request];
  var hash = 2166136261u;
  for (var word = 0u; word < FIELD_REQUEST_KEY_WORDS; word++) {
    hash = (hash ^ field_request_word(item.x, item.y, word)) * 16777619u;
  }
  return hash;
}
@compute @workgroup_size(64)
fn nominate_field_producers(@builtin(global_invocation_id) id: vec3u) {
  let request = id.x;
  if request >= atomicLoad(&demand_arena.control[1u]) { return; }
  let item = demand_arena.field_requests[request];
  if !field_request_cacheable(item.x, item.y) {
    return;
  }
  let hash = demand_field_hash(request);
  for (var probe = 0u; probe < DEMAND_PROBES; probe++) {
    if demand_settings.diagnostics != 0u { atomicAdd(&demand_arena.control[53u], 1u); }
    let slot = (hash + probe) & DEMAND_FIELD_HASH_MASK;
    for (var attempt = 0u; attempt < 4u; attempt++) {
      let claim = atomicCompareExchangeWeak(&demand_arena.field_hash[slot], 0u, request + 1u);
      if claim.exchanged { demand_arena.field_aliases[request] = request;return; }
      if claim.old_value != 0u {
        if demand_field_equal(request, claim.old_value - 1u) {
          demand_arena.field_aliases[request] = claim.old_value - 1u;
          return;
        }
        break;
      }
      if attempt == 3u { return; }
    }
  }
}
@compute @workgroup_size(64)
fn resolve_field_producers(@builtin(global_invocation_id) id: vec3u) {
  let request = id.x;
  let count = atomicLoad(&demand_arena.control[1u]);
  if request >= count { return; }
  var owner = demand_arena.field_aliases[request];
  if owner == 0xffffffffu {
    let hash = demand_field_hash(request);
    for (var probe = 0u; probe < DEMAND_PROBES; probe++) {
      if demand_settings.diagnostics != 0u { atomicAdd(&demand_arena.control[53u], 1u); }
      let occupied = atomicLoad(&demand_arena.field_hash[(hash + probe) & DEMAND_FIELD_HASH_MASK]);
      if occupied != 0u && demand_field_equal(request, occupied - 1u) { owner = occupied - 1u;break; }
    }
    if owner == 0xffffffffu {
      // Failed optional admission cannot authorize an independent Store writer.
      atomicAdd(&demand_arena.control[44u], 1u);
      return;
    }
    demand_arena.field_aliases[request] = owner;
  }
  // Dedup controls only Store writers. All mandatory values remain independent.
  if owner != request { return; }
  let unique = atomicAdd(&demand_arena.control[3u], 1u);
  demand_arena.unique_fields[unique] = request;
}
fn demand_signal_equal(a: u32, b: u32) -> bool {
  let x = demand_arena.signal_requests[a];
  let y = demand_arena.signal_requests[b];
  let x_fields = signal_request_fields(x.x, x.y);
  let y_fields = signal_request_fields(y.x, y.y);
  if !signal_request_cacheable(x.x, x_fields, x.y) || !signal_request_cacheable(y.x, y_fields, y.y) { return false; }
  for (var word = 0u; word < SIGNAL_REQUEST_KEY_WORDS; word++) {
    if signal_request_word(x.x, x.y, word, x_fields) != signal_request_word(y.x, y.y, word, y_fields) {
      return false;
    }
  }
  return true;
}
fn demand_signal_hash(request: u32) -> u32 {
  let item = demand_arena.signal_requests[request];
  return signal_request_hash(item.x, item.y, signal_request_fields(item.x, item.y));
}
@compute @workgroup_size(64)
fn nominate_signal_producers(@builtin(global_invocation_id) id: vec3u) {
  let request = id.x;
  if request >= atomicLoad(&demand_arena.control[2u]) { return; }
  let item = demand_arena.signal_requests[request];
  if !signal_request_cacheable(item.x, signal_request_fields(item.x, item.y), item.y) {
    return;
  }
  let hash = demand_signal_hash(request);
  for (var probe = 0u; probe < DEMAND_PROBES; probe++) {
    if demand_settings.diagnostics != 0u { atomicAdd(&demand_arena.control[54u], 1u); }
    let slot = (hash + probe) & DEMAND_SIGNAL_HASH_MASK;
    for (var attempt = 0u; attempt < 4u; attempt++) {
      let claim = atomicCompareExchangeWeak(&demand_arena.signal_hash[slot], 0u, request + 1u);
      if claim.exchanged { demand_arena.signal_aliases[request] = request; return; }
      if claim.old_value != 0u {
        if demand_signal_equal(request, claim.old_value - 1u) {
          demand_arena.signal_aliases[request] = claim.old_value - 1u;
          return;
        }
        break;
      }
      if attempt == 3u { return; }
    }
  }
}
@compute @workgroup_size(64)
fn resolve_signal_producers(@builtin(global_invocation_id) id: vec3u) {
  let request = id.x;
  let count = atomicLoad(&demand_arena.control[2u]);
  if request >= count { return; }
  var owner = demand_arena.signal_aliases[request];
  if owner == 0xffffffffu {
    let hash = demand_signal_hash(request);
    for (var probe = 0u; probe < DEMAND_PROBES; probe++) {
      if demand_settings.diagnostics != 0u { atomicAdd(&demand_arena.control[54u], 1u); }
      let occupied = atomicLoad(&demand_arena.signal_hash[(hash + probe) & DEMAND_SIGNAL_HASH_MASK]);
      if occupied != 0u && demand_signal_equal(request, occupied - 1u) { owner = occupied - 1u; break; }
    }
    if owner == 0xffffffffu {
      // Failed optional admission cannot authorize an independent Store writer.
      atomicAdd(&demand_arena.control[45u], 1u);
      return;
    }
    demand_arena.signal_aliases[request] = owner;
  }
  // Dedup controls only Store writers. All mandatory values remain independent.
  if owner != request { return; }
  let unique = atomicAdd(&demand_arena.control[4u], 1u);
  demand_arena.unique_signals[unique] = request;
}
@compute @workgroup_size(64)
fn compact_surface_groups(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  let leaf = id.x;
  var geometry = 0u;
  var material = 0u;
  var lighting = 0u;
  if leaf < demand_settings.leaves {
    geometry = select(0u, 1u, atomicLoad(&demand_arena.geometry_masks[leaf]) != 0u);
    material = select(0u, 1u, atomicLoad(&demand_arena.material_masks[leaf]) != 0u);
    lighting = select(0u, 1u, atomicLoad(&demand_arena.lighting_masks[leaf]) != 0u);
  }
  let offset = demand_scan(lane, vec2u(geometry, material));
  if lane == 0u {
    demand_base = vec2u(atomicAdd(&demand_arena.control[0u], demand_counts[63u].x),
      atomicAdd(&demand_arena.control[5u], demand_counts[63u].y));
  }
  workgroupBarrier();
  if geometry != 0u { demand_arena.geometry_queue[demand_base.x + offset.x] = leaf; }
  if material != 0u {
    demand_arena.material_queue[demand_base.y + offset.y] = leaf;
    let entry = demand_workspace.facts[leaf].z;
    let program = demand_metadata[demand_settings.directory + entry * 8u + 1u];
    atomicAdd(&demand_arena.programs[program * 8u + 4u], 1u);
  }
  workgroupBarrier();
  let lighting_offset = demand_scan(lane, vec2u(lighting, 0u));
  if lane == 0u { demand_base.x = atomicAdd(&demand_arena.control[6u], demand_counts[63u].x); }
  workgroupBarrier();
  if lighting != 0u { demand_arena.lighting_queue[demand_base.x + lighting_offset.x] = leaf; }
}
fn demand_dispatch(at: u32, count: u32) {
  atomicStore(&demand_arena.control[at], (count + 63u) / 64u);
  atomicStore(&demand_arena.control[at + 1u], 1u);
  atomicStore(&demand_arena.control[at + 2u], 1u);
  atomicStore(&demand_arena.control[at + 3u], count);
}
@compute @workgroup_size(1)
fn finalize_surface_requests() {
  atomicMin(&demand_arena.control[1u], demand_settings.field_capacity);
  atomicMin(&demand_arena.control[2u], demand_settings.signal_capacity);
  demand_dispatch(20u, atomicLoad(&demand_arena.control[1u]));
  demand_dispatch(24u, atomicLoad(&demand_arena.control[2u]));
}
@compute @workgroup_size(1)
fn finalize_surface_groups() {
  demand_dispatch(8u, atomicLoad(&demand_arena.control[0u]));
  demand_dispatch(12u, atomicLoad(&demand_arena.control[3u]));
  demand_dispatch(16u, atomicLoad(&demand_arena.control[4u]));
  demand_dispatch(28u, atomicLoad(&demand_arena.control[5u]));
  demand_dispatch(32u, atomicLoad(&demand_arena.control[6u]));
  demand_dispatch(36u, atomicLoad(&demand_arena.control[3u]));
  demand_dispatch(40u, atomicLoad(&demand_arena.control[4u]));
  var prefix = 0u;
  for (var program = 0u; program < demand_settings.program_count; program++) {
    let at = program * 8u;
    let count = atomicLoad(&demand_arena.programs[at + 4u]);
    atomicStore(&demand_arena.programs[at], (count + 63u) / 64u);
    atomicStore(&demand_arena.programs[at + 1u], 1u);
    atomicStore(&demand_arena.programs[at + 2u], 1u);
    atomicStore(&demand_arena.programs[at + 3u], count);
    atomicStore(&demand_arena.programs[at + 5u], prefix);
    atomicStore(&demand_arena.programs[at + 6u], 0u);
    prefix += count;
  }
}
@compute @workgroup_size(64)
fn order_material_groups(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= atomicLoad(&demand_arena.control[5u]) { return; }
  let leaf = demand_arena.material_queue[id.x];
  let entry = demand_workspace.facts[leaf].z;
  let program = demand_metadata[demand_settings.directory + entry * 8u + 1u];
  let at = program * 8u;
  demand_arena.material_entries[leaf] = entry;
  let local = atomicAdd(&demand_arena.programs[at + 6u], 1u);
  let base = atomicLoad(&demand_arena.programs[at + 5u]);
  demand_arena.ordered_material_queue[base + local] = leaf;
}
`;
}
