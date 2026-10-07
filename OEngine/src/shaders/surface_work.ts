import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import {
  surfaceWorkReadWgsl,
  SURFACE_WORK_COHERENCE_HEADER,
  SURFACE_WORK_QUERY_COUNTERS as Q
} from "../gpu/GpuSurfaceWorkAbi.js";
import { surfaceWorkGeometryWgsl } from "./surface_work_geometry.js";
import {
  appearanceDagResidentSamplingWgsl,
  APPEARANCE_DAG_PRODUCT_SAMPLING_WGSL
} from "./appearance_dag_sampling.js";
import { surfaceFixedFormulasWgsl } from "./surface_fixed_formulas.js";
import { APPEARANCE_EXACT_DAG_WGSL } from "./appearance_exact_dag.js";
import { APPEARANCE_CLOSURE_KEY_WGSL } from "./appearance_closure_key.js";
import { APPEARANCE_CLOSURE_CACHE_ACCESS_WGSL } from "./appearance_closure_cache.js";
import { APPEARANCE_DAG_CACHE_CLOSURE } from "../gpu/GpuAppearanceDagAbi.js";
import {
  APPEARANCE_CACHE_HEADER as CACHE,
  APPEARANCE_CACHE_CONTINUATION_OFFSET as CONTINUATION,
  APPEARANCE_CACHE_KEY_WORDS as KEY_WORDS,
  APPEARANCE_CACHE_PROBES as CACHE_PROBES,
  APPEARANCE_CACHE_STORED_REF as STORED_REF
} from "../gpu/GpuAppearanceClosureCacheAbi.js";

export const SURFACE_WORK_SETTINGS_WGSL = /* wgsl */ `
struct SurfaceWorkSettings {
  width: u32, height: u32, bank: u32, bank_rows: u32,
  pixels: u32, tiles_x: u32, bank_tiles: u32, tile_base: u32,
  queue_base: u32, recipe_base: u32, texture_set: u32, field_offsets: u32,
  palette: u32, constants: u32, routes: u32, inputs: u32,
  lanes: u32, live_words: u32, diagnostics: u32, frame: u32,
  source: vec4u,
  source_payload: vec4u,
  overlay_capacity: u32, reuse: u32, domain_base: u32, reserved: u32,
}
`;

/** SF01 non-MSAA tile analysis/binning profile, with portable shared reduction.
 * One queue append per actual tile/set. Mandatory pixel destinations are indexed
 * and never rely on an exception append. Tail/background are explicitly owned. */
export const SURFACE_WORK_COVERAGE_WGSL = /* wgsl */ `
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${SURFACE_WORK_SETTINGS_WGSL}
@group(0) @binding(0) var<uniform> settings: SurfaceWorkSettings;
@group(0) @binding(1) var visibility: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> dag_metadata: array<u32>;
@group(0) @binding(4) var<storage, read> dag_code: array<u32>;
@group(0) @binding(5) var<storage, read_write> work_heap: array<u32>;
@group(0) @binding(6) var<storage, read_write> work_control: array<atomic<u32>>;
var<workgroup> entries: array<u32, 64>;
var<workgroup> families: array<u32, 64>;
@compute @workgroup_size(64)
fn coverage(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let tile = group.x;
  let pixel = vec2u((tile % settings.tiles_x) * 8u + lane % 8u,
    settings.bank * settings.bank_rows + (tile / settings.tiles_x) * 8u + lane / 8u);
  var entry = 0xffffffffu;
  var key = 0xffffffffu;
  var family = 0u;
  if pixel.x < settings.width && pixel.y < settings.height {
    key = textureLoad(visibility, vec2i(pixel), 0).x;
    let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
    if decoded.valid != 0u {
      let material = meshlet_work.elements[decoded.meshlet_work_slot].material_slot_or_range;
      if material < settings.source.x {
        entry = dag_metadata[settings.source.y + material];
        if entry != 0xffffffffu {
          let execution_family = select(1u, 0u, (dag_code[entry * 16u + 13u] & 0x80000000u) != 0u);
          family = 1u << (dag_code[entry * 16u + 8u] * 2u + execution_family);
          if execution_family == 1u {
            let bin = settings.bank * 4u + dag_code[entry * 16u + 8u];
            let config = ${SURFACE_WORK_COHERENCE_HEADER}u + bin * 8u;
            if atomicLoad(&work_control[config + 5u]) != 0u {
              let plan = dag_code[entry * 16u + 2u];
              let bucket = atomicLoad(&work_control[config]) + dag_code[plan + 3u] * 3u;
              atomicAdd(&work_control[bucket], 1u);
            }
          }
        }
      }
    }
    let index = (pixel.y - settings.bank * settings.bank_rows) * settings.width + pixel.x;
    work_heap[index * settings.source_payload.y] = key;
    work_heap[index * settings.source_payload.y + settings.source_payload.y - 1u] = entry;
    if atomicLoad(&work_control[${CACHE}u]) != 0u {
      let map = atomicLoad(&work_control[${CACHE + 2}u]);
      atomicStore(&work_control[map + settings.bank * settings.pixels + index], 0u);
    }
  }
  entries[lane] = entry;
  families[lane] = family;
  workgroupBarrier();
  if lane == 0u {
    let recipe = settings.recipe_base + (settings.bank * settings.bank_tiles + tile) * 4u;
    for (var word = 0u; word < 3u; word++) {
      atomicStore(&work_control[recipe + word], 0u);
    }
    atomicStore(&work_control[recipe + 3u], settings.frame);
    var mask = 0u;
    var coverage = vec2u(0u);
    var first = 0xffffffffu;
    var same_domain = true;
    var visible = 0u;
    for (var index = 0u; index < 64u; index++) {
      mask |= families[index];
      if entries[index] != 0xffffffffu {
        coverage[index / 32u] |= 1u << (index & 31u);
        visible++;
        if first == 0xffffffffu { first = entries[index]; }
        same_domain = same_domain && first == entries[index];
      }
    }
    let at = settings.tile_base + (settings.bank * settings.bank_tiles + tile) * 8u;
    atomicStore(&work_control[at], select(0xffffffffu, first, same_domain));
    atomicStore(&work_control[at + 1u], mask);
    atomicStore(&work_control[at + 2u], coverage.x);
    atomicStore(&work_control[at + 3u], coverage.y);
    var domain = 0xffffffffu;
    if same_domain && first != 0xffffffffu { domain = dag_code[first * 16u + 14u]; }
    atomicStore(&work_control[at + 4u], domain);
    atomicStore(&work_control[at + 5u], visible);
    atomicStore(&work_control[at + 6u], settings.frame);
    atomicStore(&work_control[at + 7u], 0u);
    for (var family = 0u; family < 8u; family++) {
      if (mask & (1u << family)) != 0u {
        let bin = settings.bank * 8u + family;
        let index = atomicAdd(&work_control[bin], 1u);
        atomicStore(&work_control[settings.queue_base + bin * settings.bank_tiles + index], tile);
      }
    }
    if mask != 0u {
      let index = atomicAdd(&work_control[32u + settings.bank], 1u);
      atomicStore(&work_control[settings.queue_base + (32u + settings.bank) * settings.bank_tiles + index], tile);
    }
    if settings.diagnostics != 0u {
      atomicAdd(&work_control[224u], visible);
      atomicAdd(&work_control[225u], u32(visible == 0u));
      atomicAdd(&work_control[226u], u32(visible != 0u && same_domain));
      atomicAdd(&work_control[227u], u32(visible != 0u && !same_domain));
    }
  }
}
@compute @workgroup_size(64)
fn finalize(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= 36u { return; }
  let count = atomicLoad(&work_control[id.x]);
  let at = select(64u + id.x * 4u, 192u + (id.x - 32u) * 4u, id.x >= 32u);
  var work_count = count * 64u;
  if id.x < 32u && (id.x & 1u) != 0u {
    let bin = (id.x / 8u) * 4u + (id.x % 8u) / 2u;
    let config = ${SURFACE_WORK_COHERENCE_HEADER}u + bin * 8u;
    if atomicLoad(&work_control[config + 5u]) == 2u {
      work_count = atomicLoad(&work_control[config + 4u]);
    }
  }
  let groups = select((min(settings.lanes, work_count) + 63u) / 64u, count, id.x >= 32u);
  atomicStore(&work_control[at], groups);
  atomicStore(&work_control[at + 1u], 1u);
  atomicStore(&work_control[at + 2u], 1u);
}
`;

export function surfaceWorkAppearanceWgsl(product: boolean, common = false): string {
  return /* wgsl */ `
${SURFACE_WORK_SETTINGS_WGSL}
@group(0) @binding(10) var<uniform> settings: SurfaceWorkSettings;
@group(1) @binding(0) var<storage, read> dag_code: array<u32>;
@group(1) @binding(1) var<storage, read> dag_metadata: array<u32>;
@group(1) @binding(2) var<storage, read_write> dag_values: array<f32>;
@group(1) @binding(3) var<storage, read_write> work_heap: array<u32>;
@group(1) @binding(4) var<storage, read> dag_product_0: array<u32>;
@group(1) @binding(5) var<storage, read> dag_product_1: array<u32>;
@group(1) @binding(6) var<storage, read_write> work_control: array<atomic<u32>>;
var<private> dag_entry: u32;
var<private> dag_leaf: u32;
var<private> dag_routes_base: u32;
var<private> dag_product_bank_words: u32;
var<private> surface_normal_ts: vec4f;
var<private> surface_coat_ts: vec4f;
var<private> surface_normal_validity: f32;
var<private> surface_coat_validity: f32;
var<private> closure_read_at: u32;
var<private> closure_output_at: u32;
var<private> closure_plan: u32;
${surfaceWorkReadWgsl(true)}
${surfaceWorkGeometryWgsl(product, common).replaceAll("fn geometry_input(", "fn geometry_produced_input(")}
${APPEARANCE_CLOSURE_CACHE_ACCESS_WGSL}
fn geometry_input(kind: u32, point: u32) -> vec4f {
  if closure_read_at == 0u {
    return geometry_produced_input(kind, point);
  }
  let reads = dag_code[closure_plan + 8u] + kind * 12u + point;
  var value = vec4u(0u);
  for (var channel = 0u; channel < 4u; channel++) {
    let word = dag_code[reads + channel * 3u];
    if word != 0u {
      value[channel] = atomicLoad(&work_control[closure_read_at + 8u + word]);
    }
  }
  return bitcast<vec4f>(value);
}
${APPEARANCE_CLOSURE_KEY_WGSL}
fn dag_metadata_vec4(at: u32) -> vec4f {
  return bitcast<vec4f>(vec4u(dag_metadata[at], dag_metadata[at + 1u], dag_metadata[at + 2u], dag_metadata[at + 3u]));
}
fn appearance_dag_constant(index: u32) -> f32 {
  return bitcast<f32>(dag_metadata[settings.constants + dag_code[dag_entry + 5u] + index]);
}
fn appearance_dag_output(field: u32, channel: u32, value: f32) {
  if closure_output_at != 0u {
    atomicStore(&work_control[closure_output_at + (8u + closure_cache_config(24u)) + channel], bitcast<u32>(value));
    return;
  }
  switch field {
    case 1u: {}
    case 6u: { surface_normal_ts[channel] = value; }
    case 12u: { surface_coat_ts[channel] = value; }
    case 13u: { surface_normal_validity = value; }
    case 14u: { surface_coat_validity = value; }
    default: {
      surface_field_store(dag_leaf, field, channel, value);
      if settings.diagnostics != 0u {
        atomicAdd(&work_control[242u], 1u);
      }
    }
  }
}
fn surface_producer_field(pixel: u32, field: u32) -> vec4f {
  switch field {
    case 6u: { return surface_normal_ts; }
    case 12u: { return surface_coat_ts; }
    case 13u: { return vec4f(surface_normal_validity, 0.0, 0.0, 0.0); }
    case 14u: { return vec4f(surface_coat_validity, 0.0, 0.0, 0.0); }
    default: { return surface_field(pixel, field); }
  }
}
fn appearance_dag_uniform(index: u32) -> f32 {
  if settings.diagnostics != 0u { atomicAdd(&work_control[${Q.uniformRead}u], 1u); }
  let plan = dag_code[dag_entry + 2u];
  return bitcast<f32>(dag_metadata[dag_code[plan + 4u] + index]);
}
fn appearance_dag_publish_uniform(index: u32, value: f32) {
  // Update opcodes are illegal in the sample plan. Mark an authority failure;
  // never mutate immutable publication metadata from a hot consumer.
  atomicAdd(&work_control[228u], 1u);
  work_heap[dag_leaf * settings.source_payload.y + settings.source_payload.y - 1u] = 0xffffffffu;
}
fn appearance_dag_input(index: u32, semantic: u32, channel: u32, neighbors: bool) -> vec3f {
  if semantic == 0u {
    return vec3f(bitcast<f32>(dag_metadata[settings.inputs + (dag_code[dag_entry + 7u] + index) * 4u + channel]));
  }
  let center = geometry_input(semantic, 0u)[channel];
  if !neighbors { return vec3f(center); }
  return vec3f(center, geometry_input(semantic, 1u)[channel], geometry_input(semantic, 2u)[channel]);
}
${appearanceDagResidentSamplingWgsl(2).replace("fn appearance_dag_sample(", "fn surface_sample_value(")}
${APPEARANCE_DAG_PRODUCT_SAMPLING_WGSL.replace("fn appearance_dag_product(", "fn surface_product_value(")}
fn appearance_dag_sample(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  if settings.diagnostics != 0u { atomicAdd(&work_control[${Q.texture}u], 1u); }
  return surface_sample_value(index, uv, dx, dy);
}
fn appearance_dag_product(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  if settings.diagnostics != 0u { atomicAdd(&work_control[${Q.product}u], 1u); }
  return surface_product_value(index, uv, dx, dy);
}
${common ? surfaceFixedFormulasWgsl() : APPEARANCE_EXACT_DAG_WGSL}
fn surface_evaluate_fields(lane: u32, missing: u32) {
  ${common ? "fixed_surface_evaluate(lane, missing);" : "appearance_dag_evaluate(dag_code[dag_entry], dag_code[dag_entry + 1u], lane, missing, settings.lanes);"}
  if settings.diagnostics != 0u {
    atomicAdd(&work_control[240u], 1u);
    atomicAdd(&work_control[230u], 1u);
    atomicAdd(&work_control[241u], countOneBits(missing));
  }
}
fn surface_initialize_local_fields() {
  let palette = settings.palette + (dag_entry / 16u) * 64u;
  surface_normal_ts = dag_metadata_vec4(palette + 4u + 6u * 4u);
  surface_coat_ts = dag_metadata_vec4(palette + 4u + 12u * 4u);
  surface_normal_validity = bitcast<f32>(dag_metadata[palette + 4u + 13u * 4u]);
  surface_coat_validity = bitcast<f32>(dag_metadata[palette + 4u + 14u * 4u]);
}
fn closure_save_guides(at: u32) {
  let normal = vec4f(surface_normal_ts.xyz, surface_normal_validity);
  let coat = vec4f(surface_coat_ts.xyz, surface_coat_validity);
  for (var channel = 0u; channel < 4u; channel++) {
    atomicStore(&work_control[at + (12u + closure_cache_config(24u)) + channel], bitcast<u32>(geometry_center.tangent[channel]));
    atomicStore(&work_control[at + (16u + closure_cache_config(24u)) + channel], bitcast<u32>(normal[channel]));
    atomicStore(&work_control[at + (20u + closure_cache_config(24u)) + channel], bitcast<u32>(coat[channel]));
  }
}
fn closure_restore_guides(at: u32) {
  geometry_center.normal = surface_work_vec4(dag_leaf, 4u);
  for (var channel = 0u; channel < 4u; channel++) {
    geometry_center.tangent[channel] = bitcast<f32>(atomicLoad(&work_control[at + (12u + closure_cache_config(24u)) + channel]));
    surface_normal_ts[channel] = bitcast<f32>(atomicLoad(&work_control[at + (16u + closure_cache_config(24u)) + channel]));
    surface_coat_ts[channel] = bitcast<f32>(atomicLoad(&work_control[at + (20u + closure_cache_config(24u)) + channel]));
  }
  surface_normal_validity = surface_normal_ts.w;
  surface_coat_validity = surface_coat_ts.w;
  surface_normal_ts.w = 0.0;
  surface_coat_ts.w = 0.0;
}
fn surface_closure_request(pixel: vec2u, lane: u32) {
  if pixel.x >= settings.width || pixel.y >= settings.height {
    return;
  }
  dag_leaf = (pixel.y - settings.bank * settings.bank_rows) * settings.width + pixel.x;
  let entry = surface_work_entry(dag_leaf);
  if entry == 0xffffffffu {
    return;
  }
  dag_entry = entry * 16u;
  let family = dag_code[dag_entry + 8u] * 2u + select(1u, 0u, (dag_code[dag_entry + 13u] & 0x80000000u) != 0u);
  if family != settings.texture_set {
    return;
  }
  let closure = dag_code[dag_code[dag_entry + 2u] + ${APPEARANCE_DAG_CACHE_CLOSURE}u];
  if closure == 0u {
    return;
  }
  surface_initialize_local_fields();
  let domain = surface_closure_domain();
  if dag_code[domain + 3u] != 0u || dag_code[domain + 5u] != 0u {
    if !geometry_produce(work_heap[dag_leaf * settings.source_payload.y], pixel,
      dag_code[domain + 4u], dag_code[domain + 3u], dag_code[domain + 5u] != 0u) {
      work_heap[dag_leaf * settings.source_payload.y + settings.source_payload.y - 1u] = 0xffffffffu;
      atomicAdd(&work_control[228u], 1u);
      return;
    }
    if settings.diagnostics != 0u {
      atomicAdd(&work_control[239u], 1u);
      atomicAdd(&work_control[229u], 1u);
    }
  }
  let map = closure_cache_config(2u) + settings.bank * settings.pixels + dag_leaf;
  let words = dag_code[closure + 2u];
  let namespace_id = closure_cache_config(9u);
  var hash = 2166136261u;
  for (var word = 0u; word < words; word++) {
    hash = (hash ^ appearance_closure_key_word(namespace_id, closure, word)) * 16777619u;
  }
  // Immutable cells remain pinned through the last value reader. Lookup has no
  // request allocation or key write on a hit; only true misses publish payloads.
  for (var probe = 0u; probe < ${CACHE_PROBES}u; probe++) {
    let slot = (hash + probe) & (closure_cache_config(1u) - 1u);
    let cell = closure_cell_address(slot);
    if atomicLoad(&work_control[cell]) == 0u || atomicLoad(&work_control[cell + 1u]) != words {
      continue;
    }
    var equal = true;
    for (var word = 0u; word < words; word++) {
      if atomicLoad(&work_control[cell + 4u + word]) != appearance_closure_key_word(namespace_id, closure, word) {
        equal = false;
        break;
      }
    }
    if equal {
      for (var channel = 0u; channel < dag_code[closure + 3u]; channel++) {
        appearance_dag_output(firstTrailingBit(dag_code[closure + 1u]), channel,
          bitcast<f32>(atomicLoad(&work_control[cell + (4u + closure_cache_config(24u)) + channel])));
      }
      let residual = surface_closure_missing_mask() & ~dag_code[closure + 1u];
      if residual != 0u { surface_evaluate_fields(lane, residual); }
      if dag_code[domain + 5u] != 0u { geometry_publish_guides(); }
      atomicStore(&work_control[map], 0xffffffffu);
      if settings.diagnostics != 0u {
        atomicAdd(&work_control[${CACHE + 12}u], 1u);
      }
      return;
    }
  }
  let bin = settings.bank * 8u + settings.texture_set;
  let index = atomicAdd(&work_control[closure_cache_config(6u) + bin * 2u], 1u);
  if index >= closure_cache_config(0u) {
    // Complete the direct recipe and its local guide sinks while Geometry is
    // live. The later resolve dispatch must not rebuild this product.
    surface_evaluate_fields(lane, surface_closure_missing_mask());
    if dag_code[domain + 5u] != 0u { geometry_publish_guides(); }
    atomicStore(&work_control[map], 0xffffffffu);
    if settings.diagnostics != 0u {
      atomicAdd(&work_control[${CACHE + 14}u], 1u);
    }
    return;
  }
  let request = bin * closure_cache_config(0u) + index;
  let at = closure_request_address(request);
  atomicStore(&work_control[at], entry);
  atomicStore(&work_control[at + 1u], closure);
  atomicStore(&work_control[at + 2u], dag_code[closure + 2u]);
  atomicStore(&work_control[at + 3u], 0u);
  for (var word = 0u; word < dag_code[closure + 2u]; word++) {
    atomicStore(&work_control[at + 8u + word], appearance_closure_key_word(closure_cache_config(9u), closure, word));
  }
  for (var channel = 0u; channel < 4u; channel++) {
    atomicStore(&work_control[at + (8u + closure_cache_config(24u)) + channel], 0u);
  }
  let residual = surface_closure_missing_mask() & ~dag_code[closure + 1u];
  if residual != 0u { surface_evaluate_fields(lane, residual); }
  if dag_code[domain + 5u] != 0u { closure_save_guides(at); }
  atomicStore(&work_control[map], request + 1u);
  if settings.diagnostics != 0u {
    atomicAdd(&work_control[${CACHE + 15}u], 1u);
  }
}
fn surface_closure_domain() -> u32 {
  let tile = ((dag_leaf / settings.width) / 8u) * settings.tiles_x + (dag_leaf % settings.width) / 8u;
  let tile_at = settings.tile_base + (settings.bank * settings.bank_tiles + tile) * 8u;
  var domain = atomicLoad(&work_control[tile_at + 4u]);
  if domain == 0xffffffffu { domain = dag_code[dag_entry + 14u]; }
  return domain;
}
fn surface_closure_missing_mask() -> u32 {
  let domain = surface_closure_domain();
  return dag_code[domain + 1u] & ~dag_code[domain + 2u];
}
fn surface_closure_misses(lane: u32) {
  let bin = settings.bank * 8u + settings.texture_set;
  let count = atomicLoad(&work_control[closure_cache_config(6u) + bin * 2u + 1u]);
  let queue = closure_cache_config(7u) + bin * closure_cache_config(0u);
  for (var index = lane; index < count; index += settings.lanes) {
    let request = atomicLoad(&work_control[queue + index]);
    closure_read_at = closure_request_address(request);
    closure_output_at = closure_read_at;
    dag_entry = atomicLoad(&work_control[closure_read_at]) * 16u;
    closure_plan = atomicLoad(&work_control[closure_read_at + 1u]);
    surface_evaluate_fields(lane, dag_code[closure_plan + 1u]);
  }
}
fn surface_closure_resolve(lane: u32) -> bool {
  if closure_cache_config(0u) == 0u {
    return false;
  }
  let request = atomicLoad(&work_control[closure_cache_config(2u) + settings.bank * settings.pixels + dag_leaf]);
  if request == 0u {
    return false;
  }
  if request == 0xffffffffu {
    return true;
  }
  closure_plan = dag_code[dag_code[dag_entry + 2u] + ${APPEARANCE_DAG_CACHE_CLOSURE}u];
  // Request/miss work owns Geometry completion. Resolve only consumes that
  // published record; rebuilding it here duplicated setup on every hit and
  // could overwrite the authoritative completion before Lighting/Reconstruct.
  let fields = dag_code[closure_plan + 1u];
  let at = closure_request_address(request - 1u);
  let lit = dag_code[surface_closure_domain() + 5u] != 0u;
  if lit { closure_restore_guides(at); }
  let reference = atomicLoad(&work_control[at + 3u]);
  if reference == 0u {
    // Residual fields already consumed the complete Geometry inputs. Only the
    // rejected cached field reads its exact key; sibling inputs are not in it.
    closure_read_at = at;
    surface_evaluate_fields(lane, fields);
  } else {
    var values: u32;
    if (reference & ${STORED_REF}u) != 0u {
      values = closure_cell_address(reference & 0x7fffffffu) + (4u + closure_cache_config(24u));
    } else {
      values = closure_request_address(reference - 1u) + (8u + closure_cache_config(24u));
    }
    for (var channel = 0u; channel < dag_code[closure_plan + 3u]; channel++) {
      appearance_dag_output(firstTrailingBit(fields), channel, bitcast<f32>(atomicLoad(&work_control[values + channel])));
    }
  }
  if lit { geometry_publish_guides(); }
  return true;
}
fn geometry_publish_guides() {
  let basis = vec4f(geometry_center.normal.xyz, geometry_center.tangent.w);
  let tangent = geometry_center.tangent.xyz;
  let bitangent = normalize(cross(basis.xyz, tangent) * basis.w);
  var normal = basis.xyz;
  if surface_producer_field(dag_leaf, 13u).x > 0.5 {
    let value = normalize(surface_producer_field(dag_leaf, 6u).xyz);
    normal = normalize(tangent * value.x + bitangent * value.y + basis.xyz * value.z);
  }
  var coat_ts = vec3f(0.0, 0.0, 1.0);
  if surface_producer_field(dag_leaf, 14u).x > 0.5 {
    let raw = surface_producer_field(dag_leaf, 12u).xyz;
    coat_ts = select(vec3f(0.0, 0.0, 1.0), normalize(raw), dot(raw, raw) > 1e-8);
  }
  let coat = normalize(tangent * coat_ts.x + bitangent * coat_ts.y + basis.xyz * coat_ts.z);
  let channels = dag_metadata[settings.field_offsets + 15u];
  for (var channel = 0u; channel < 3u; channel++) {
    let at = settings.pixels * settings.source_payload.y + (channels + channel) * settings.pixels + dag_leaf;
    work_heap[at] = bitcast<u32>(normal[channel]);
    work_heap[at + settings.pixels * 3u] = bitcast<u32>(coat[channel]);
  }
  var safe = true;
  {
    let value = surface_producer_field(dag_leaf, 0u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 2u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 3u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 6u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 7u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 8u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 9u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 10u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 11u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 12u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  {
    let value = surface_producer_field(dag_leaf, 14u);
    safe = safe && all(value == value) && all(abs(value) <= vec4f(131072.0));
  }
  // Final value boundary proves the same numeric envelope as the old material
  // interval owner; no guessed range or repeated guard in the hot consumer.
  work_heap[dag_leaf * settings.source_payload.y + 7u] = u32(safe);
}
fn surface_appearance_item(pixel: vec2u, lane: u32) {
  closure_read_at = 0u;
  closure_output_at = 0u;
  if (settings.reuse >> 30u) == 1u {
    surface_closure_request(pixel, lane);
    return;
  }
  let tile = ((pixel.y - settings.bank * settings.bank_rows) / 8u) * settings.tiles_x + pixel.x / 8u;
    if pixel.x >= settings.width || pixel.y >= settings.height { return; }
    dag_leaf = (pixel.y - settings.bank * settings.bank_rows) * settings.width + pixel.x;
    let entry = surface_work_entry(dag_leaf);
    if entry == 0xffffffffu { return; }
    dag_entry = entry * 16u;
    surface_initialize_local_fields();
    if dag_code[dag_entry + 8u] * 2u + select(1u, 0u, (dag_code[dag_entry + 13u] & 0x80000000u) != 0u) != settings.texture_set { return; }
    if surface_closure_resolve(lane) {
      return;
    }
    let tile_at = settings.tile_base + (settings.bank * settings.bank_tiles + tile) * 8u;
    var domain = atomicLoad(&work_control[tile_at + 4u]);
    if domain == 0xffffffffu { domain = dag_code[dag_entry + 14u]; }
    let missing = dag_code[domain + 1u] & ~dag_code[domain + 2u];
    if dag_code[domain + 3u] != 0u || dag_code[domain + 5u] != 0u {
      if settings.diagnostics != 0u { atomicAdd(&work_control[239u], 1u); }
      if !geometry_produce(work_heap[dag_leaf * settings.source_payload.y], pixel, dag_code[domain + 4u], dag_code[domain + 3u], dag_code[domain + 5u] != 0u) {
        // Malformed visible source is an authority failure, never an unwritten
        // destination masquerading as valid geometry. Mandatory consumers see background.
        work_heap[dag_leaf * settings.source_payload.y + settings.source_payload.y - 1u] = 0xffffffffu;
        atomicAdd(&work_control[228u], 1u);
        return;
      }
      if settings.diagnostics != 0u { atomicAdd(&work_control[229u], 1u); }
    }
    if missing != 0u {
      surface_evaluate_fields(lane, missing);
    }
    if dag_code[domain + 5u] != 0u { geometry_publish_guides(); }
}
@compute @workgroup_size(64)
fn appearance(@builtin(global_invocation_id) id: vec3u,
  @builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) local_lane: u32) {
  if id.x >= settings.lanes {
    return;
  }
  dag_routes_base = settings.routes;
  dag_product_bank_words = settings.reserved;
  if (settings.reuse >> 30u) == 2u {
    surface_closure_misses(id.x);
    return;
  }
  let bin = settings.bank * 8u + settings.texture_set;
  let config = ${SURFACE_WORK_COHERENCE_HEADER}u + (settings.bank * 4u + settings.texture_set / 2u) * 8u;
  if (settings.reuse >> 30u) != 2u && (settings.texture_set & 1u) != 0u && atomicLoad(&work_control[config + 5u]) == 2u {
    let index_base = atomicLoad(&work_control[config + 1u]);
    let packets = atomicLoad(&work_control[config + 4u]) / 64u;
    let context_groups = (settings.lanes + 63u) / 64u;
    let local_contexts = min(64u, settings.lanes - group.x * 64u);
    for (var packet = group.x; packet < packets; packet += context_groups) {
      // A partial final context group iterates within the same 64-item packet.
      // Thus Q=1/7 remains complete without mixing tapes or sharing scratch.
      for (var item = local_lane; item < 64u; item += local_contexts) {
        let pixel = atomicLoad(&work_control[index_base + packet * 64u + item]);
        if pixel != 0xffffffffu {
          surface_appearance_item(vec2u(pixel % settings.width,
            settings.bank * settings.bank_rows + pixel / settings.width), id.x);
        }
      }
    }
    return;
  }
  // Complete indexed recipe when coherence is disabled or cannot reserve a run.
  let count = atomicLoad(&work_control[bin]) * 64u;
  for (var item = id.x; item < count; item += settings.lanes) {
    let tile = atomicLoad(&work_control[settings.queue_base + bin * settings.bank_tiles + item / 64u]);
    let pixel = vec2u((tile % settings.tiles_x) * 8u + item % 8u,
      settings.bank * settings.bank_rows + (tile / settings.tiles_x) * 8u + (item % 64u) / 8u);
    surface_appearance_item(pixel, id.x);
  }
}
`;
}
