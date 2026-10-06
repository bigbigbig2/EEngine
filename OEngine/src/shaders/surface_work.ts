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
  if id.x < 32u && (id.x & 1u) == 0u {
    let fixed_at = 320u + (id.x / 2u) * 4u;
    atomicStore(&work_control[fixed_at], (min(settings.lanes, count * 64u) + 63u) / 64u);
    atomicStore(&work_control[fixed_at + 1u], 1u);
    atomicStore(&work_control[fixed_at + 2u], 1u);
  }
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
${surfaceWorkReadWgsl(true)}
${surfaceWorkGeometryWgsl(product, common)}
fn dag_metadata_vec4(at: u32) -> vec4f {
  return bitcast<vec4f>(vec4u(dag_metadata[at], dag_metadata[at + 1u], dag_metadata[at + 2u], dag_metadata[at + 3u]));
}
fn appearance_dag_constant(index: u32) -> f32 {
  return bitcast<f32>(dag_metadata[settings.constants + dag_code[dag_entry + 5u] + index]);
}
fn appearance_dag_output(field: u32, channel: u32, value: f32) {
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
  let tile = ((pixel.y - settings.bank * settings.bank_rows) / 8u) * settings.tiles_x + pixel.x / 8u;
    if pixel.x >= settings.width || pixel.y >= settings.height { return; }
    dag_leaf = (pixel.y - settings.bank * settings.bank_rows) * settings.width + pixel.x;
    let entry = surface_work_entry(dag_leaf);
    if entry == 0xffffffffu { return; }
    dag_entry = entry * 16u;
    let palette = settings.palette + entry * 64u;
    surface_normal_ts = dag_metadata_vec4(palette + 4u + 6u * 4u);
    surface_coat_ts = dag_metadata_vec4(palette + 4u + 12u * 4u);
    surface_normal_validity = bitcast<f32>(dag_metadata[palette + 4u + 13u * 4u]);
    surface_coat_validity = bitcast<f32>(dag_metadata[palette + 4u + 14u * 4u]);
    if dag_code[dag_entry + 8u] * 2u + select(1u, 0u, (dag_code[dag_entry + 13u] & 0x80000000u) != 0u) != settings.texture_set { return; }
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
      if settings.diagnostics != 0u { atomicAdd(&work_control[240u], 1u); }
      ${
        common
          ? "fixed_surface_evaluate(lane, missing);"
          : /* wgsl */ `
      appearance_dag_evaluate(dag_code[dag_entry], dag_code[dag_entry + 1u], lane, missing, settings.lanes);
      `
      }
      if settings.diagnostics != 0u {
        atomicAdd(&work_control[230u], 1u);
        atomicAdd(&work_control[241u], countOneBits(missing));
      }
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
  let bin = settings.bank * 8u + settings.texture_set;
  let config = ${SURFACE_WORK_COHERENCE_HEADER}u + (settings.bank * 4u + settings.texture_set / 2u) * 8u;
  if (settings.texture_set & 1u) != 0u && atomicLoad(&work_control[config + 5u]) == 2u {
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
