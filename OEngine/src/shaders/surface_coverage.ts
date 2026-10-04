import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { SURFACE_EXECUTION_WORDS } from "../gpu/GpuSurfaceExecutionProfileAbi.js";
import { SURFACE_CELL_TILE_PLAN_BYTES } from "../gpu/GpuSurfaceCellPlanAbi.js";

/** Single extent coverage producer. One lane owns one visibility load. Tile
 * append has a mandatory T-entry reservation and cannot overflow: every tile
 * appends at most once. No payload is consumed until this dispatch completes. */
export const SURFACE_COVERAGE_SCAN_WGSL = /* wgsl */ `
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
struct CoverageSettings {
  width: u32, height: u32, tiles_x: u32, tiles: u32,
  lookup: u32, lookup_count: u32, profiles: u32, generation: u32,
}
@group(0) @binding(0) var<uniform> settings: CoverageSettings;
@group(0) @binding(1) var visibility: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> meshlets: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> metadata: array<u32>;
@group(0) @binding(4) var<storage, read_write> coverage: array<atomic<u32>>;
var<workgroup> coverage_lanes: array<vec3u, 64>;
@compute @workgroup_size(64)
fn scan_surface_coverage(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let tile = group.x;
  let pixel = vec2u((tile % settings.tiles_x) * 8u + lane % 8u, (tile / settings.tiles_x) * 8u + lane / 8u);
  var key = 0xffffffffu;
  var entry = 0xffffffffu;
  var enabled = 0u;
  if pixel.x < settings.width && pixel.y < settings.height {
    key = textureLoad(visibility, vec2i(pixel), 0).x;
    let decoded = oengine_visibility_key_resolve(key, meshlets.header.generation, meshlets.header.written_count);
    if decoded.valid != 0u {
      let material = meshlets.elements[decoded.meshlet_work_slot].material_slot_or_range;
      if material < settings.lookup_count { entry = metadata[settings.lookup + material]; }
      if entry != 0xffffffffu { enabled = metadata[settings.profiles + entry * ${SURFACE_EXECUTION_WORDS}u + 1u]; }
    }
  }
  coverage_lanes[lane] = vec3u(key, entry, enabled);
  workgroupBarrier();
  if lane == 0u {
    var mask = vec2u(0u);
    var enabled_union = 0u;
    var first_entry = 0xffffffffu;
    var same = true;
    var first = true;
    for (var member = 0u; member < 64u; member++) {
      let fact = coverage_lanes[member];
      if fact.x == 0xffffffffu { continue; }
      if member < 32u { mask.x |= 1u << member; } else { mask.y |= 1u << (member - 32u); }
      enabled_union |= fact.z;
      if first { first_entry = fact.y; first = false; } else { same = same && first_entry == fact.y; }
    }
    let at = 4u + tile * 8u;
    atomicStore(&coverage[at], tile);
    atomicStore(&coverage[at + 1u], mask.x);
    atomicStore(&coverage[at + 2u], mask.y);
    atomicStore(&coverage[at + 3u], enabled_union);
    atomicStore(&coverage[at + 4u], select(0xffffffffu, first_entry, same));
    // Fine is reserved for EVERY tile before any later optional plan publishes.
    atomicStore(&coverage[at + 5u], 2u);
    atomicStore(&coverage[at + 6u], settings.generation);
    var token = 0u;
    if same && first_entry != 0xffffffffu { token = metadata[settings.profiles + first_entry * ${SURFACE_EXECUTION_WORDS}u]; }
    atomicStore(&coverage[at + 7u], token);
    if any(mask != vec2u(0u)) {
      let active_index = atomicAdd(&coverage[0u], 1u);
      atomicStore(&coverage[4u + settings.tiles * 8u + active_index], tile);
    }
  }
}
`;

/** GPU range publication precedes setup and every consumer of the reusable
 * batch. Indirect arguments are copied to a distinct INDIRECT buffer outside
 * the pass, so writable storage and indirect usage never share a scope. */
export const SURFACE_ACTIVE_RANGE_WGSL = /* wgsl */ `
struct RangeSettings { first: u32, capacity: u32, tiles: u32, tiles_x: u32 }
@group(0) @binding(0) var<uniform> settings: RangeSettings;
@group(0) @binding(1) var<storage, read> coverage: array<u32>;
@group(0) @binding(2) var<storage, read_write> workspace: array<u32>;
@group(0) @binding(3) var<storage, read_write> arguments: array<u32>;
@compute @workgroup_size(64)
fn publish_surface_active_range(@builtin(global_invocation_id) id: vec3u) {
  let remaining = coverage[0u] - min(settings.first, coverage[0u]);
  let count = min(settings.capacity, remaining);
  if id.x == 0u {
    workspace[127u] = count;
    workspace[126u] = 0u;
    arguments[0u] = count;
    arguments[1u] = select(0u, 1u, count != 0u);
    arguments[2u] = select(0u, 1u, count != 0u);
    arguments[3u] = count;
    workspace[125u] = coverage[0u];
  }
  if id.x >= count { return; }
  let tile = coverage[4u + settings.tiles * 8u + settings.first + id.x];
  let source = 4u + tile * 8u;
  let at = 128u + id.x * ${SURFACE_CELL_TILE_PLAN_BYTES / 4}u;
  workspace[at] = (tile % settings.tiles_x) * 8u;
  workspace[at + 1u] = (tile / settings.tiles_x) * 8u;
  workspace[at + 2u] = coverage[source + 1u];
  workspace[at + 3u] = coverage[source + 2u];
  workspace[at + 4u] = tile;
  workspace[at + 5u] = coverage[source + 3u];
  workspace[at + 6u] = coverage[source + 4u];
  workspace[at + 7u] = coverage[source + 6u];
  workspace[at + 8u] = 2u;
  workspace[at + 9u] = coverage[source + 7u];
}
`;
