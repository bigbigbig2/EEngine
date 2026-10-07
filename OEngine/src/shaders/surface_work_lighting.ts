import { SURFACE_DIRECT_MATH, SURFACE_LIGHTING_FUNCTIONS_WGSL } from "./surface_work_lighting_math.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "./environment_ibl.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "./atmosphere/runtime.js";
import { SURFACE_PACKET_CONTRACT_WGSL } from "../gpu/GpuSurfaceSignalPacketAbi.js";
import { surfaceWorkReadWgsl } from "../gpu/GpuSurfaceWorkAbi.js";
import { SURFACE_WORK_SETTINGS_WGSL } from "./surface_work.js";
import { SURFACE_WORK_SIGNAL_RECIPE_WGSL, SURFACE_SIGNAL_RATE_ADMISSION_WGSL } from "./surface_work_rate.js";
import { SURFACE_WORK_SIGNAL_HISTORY_COUNTER_BASE } from "../gpu/GpuSurfaceWorkAbi.js";

/** All existing providers/BRDF/packet semantics, reading only closed Geometry,
 * Appearance and full-rate guides. No source vertex/triangle recovery here. */
export const SURFACE_WORK_LIGHTING_WGSL = /* wgsl */ `
${SURFACE_DIRECT_MATH}
${OCTAHEDRAL_SAMPLE_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
${ATMOSPHERE_RUNTIME_WGSL}
${SURFACE_PACKET_CONTRACT_WGSL}
${SURFACE_WORK_SETTINGS_WGSL}
struct SurfaceView { width: u32, height: u32, frame_index: u32, reserved: u32, }
@group(0) @binding(0) var<uniform> settings: SurfaceWorkSettings;
@group(0) @binding(1) var<storage, read> work_heap: array<u32>;
@group(0) @binding(2) var<storage, read> dag_metadata: array<u32>;
@group(0) @binding(3) var<storage, read_write> work_control: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> signal_values: array<u32>;
@group(0) @binding(5) var<storage, read> signal_history0: array<u32>;
@group(0) @binding(8) var<storage, read> signal_history1: array<u32>;
@group(0) @binding(9) var<storage, read> signal_history2: array<u32>;
@group(0) @binding(10) var<storage, read> signal_history3: array<u32>;
@group(0) @binding(11) var<storage, read> signal_history_recipes: array<u32>;
@group(0) @binding(6) var surface_facts: texture_2d<f32>;
@group(0) @binding(7) var surface_motion: texture_2d<f32>;
@group(0) @binding(12) var visibility: texture_2d<u32>;
@group(0) @binding(13) var environment_diffuse: texture_2d<f32>;
@group(0) @binding(14) var environment_specular: texture_2d<f32>;
@group(0) @binding(15) var environment_dfg: texture_2d<f32>;
@group(0) @binding(16) var<uniform> physical_sun: PhysicalEnvironmentParameters;
@group(0) @binding(17) var solar_transmittance: texture_2d<f32>;
@group(0) @binding(18) var solar_sampler: sampler;
@group(1) @binding(0) var<storage, read> node: array<u32>;
@group(1) @binding(2) var<uniform> cluster_parameters: vec3f;
@group(1) @binding(3) var<storage, read> cluster_lookup: array<ClusterMetadata>;
@group(1) @binding(4) var<storage, read> cluster_data: ClusterData;
@group(1) @binding(7) var<storage, read> active_light_list: LightList;
@group(2) @binding(0) var<uniform> shading_view: SurfaceView;
@group(2) @binding(1) var<uniform> camera: CommandEncoder;
@group(3) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(3) @binding(1) var<storage, read> vsm_page_table: array<VsmPageEntry>;
@group(3) @binding(2) var vsm_atlas_depth: texture_depth_2d;
${surfaceWorkReadWgsl(false)}
${SURFACE_WORK_SIGNAL_RECIPE_WGSL}
${SURFACE_SIGNAL_RATE_ADMISSION_WGSL}
fn diagnostic_add(index: u32, value: u32) {
  if settings.diagnostics != 0u { atomicAdd(&work_control[256u + index], value); }
}
fn setting(index: u32) -> u32 {
  switch index {
    case 0u: { return settings.width; }
    case 1u: { return settings.height; }
    case 7u: { return settings.reserved & 1u; }
    default: { return 0u; }
  }
}
var<workgroup> history_complete_lanes: array<u32, 64>;
var<workgroup> history_complete_tile: u32;
var<private> history_coordinate: vec2u;
var<private> history_accepted: bool;
fn signal_history_prepare(coordinate: vec2u) {
  history_accepted = false;
  if ((settings.reserved >> 2u) & 63u) == 0u {
    return;
  }
  let facts = textureLoad(surface_facts, vec2i(coordinate), 0);
  if facts.y < 0.5 || facts.z >= 0.5 {
    return;
  }
  let motion = textureLoad(surface_motion, vec2i(coordinate), 0).xy;
  if !all(motion == motion) || !all(abs(motion) < vec2f(65000.0)) {
    return;
  }
  let dimensions = vec2f(f32(settings.width), f32(settings.height));
  let previous = vec2f(coordinate) + vec2f(0.5) - motion * dimensions;
  if !all(previous >= vec2f(0.0)) || !all(previous < dimensions) {
    return;
  }
  history_coordinate = vec2u(previous);
  history_accepted = true;
}
fn signal_history_word(owner: vec2u, word: u32) -> u32 {
  let at = word * settings.pixels + owner.x;
  switch owner.y {
    case 0u: { return signal_history0[at]; }
    case 1u: { return signal_history1[at]; }
    case 2u: { return signal_history2[at]; }
    default: { return signal_history3[at]; }
  }
}
fn signal_history_owner(kind: u32) -> vec2u {
  let bank = history_coordinate.y / settings.bank_rows;
  let coordinate = vec2u(history_coordinate.x, history_coordinate.y - bank * settings.bank_rows);
  let tile = (coordinate.y / 8u) * settings.tiles_x + coordinate.x / 8u;
  let quad = ((coordinate.y % 8u) / 2u) * 4u + (coordinate.x % 8u) / 2u;
  let mask = signal_history_recipes[(bank * settings.bank_tiles + tile) * 4u + kind / 2u];
  let coarse = (mask & (1u << (quad + (kind & 1u) * 16u))) != 0u;
  let owner = select(coordinate, coordinate & vec2u(0xfffffffeu), coarse);
  return vec2u(owner.y * settings.width + owner.x, bank);
}
fn signal_history_valid(kind: u32) -> bool {
  if !history_accepted || ((settings.reserved >> 2u) & (1u << kind)) == 0u {
    return false;
  }
  let state = signal_history_word(signal_history_owner(kind), 18u);
  if (state & (1u << kind)) == 0u {
    return false;
  }
  // Diffuse transport and exceptional colored residual are different products.
  // The current authoritative guard must agree before reusing the old value.
  if kind == 0u && (((state & SURFACE_PACKET_DIFFUSE_TRANSPORT) != 0u) != direct_transport) {
    return false;
  }
  return true;
}
fn signal_history_sample(kind: u32) -> vec3f {
  let owner = signal_history_owner(kind);
  let word = kind * 3u;
  return bitcast<vec3f>(vec3u(signal_history_word(owner, word),
    signal_history_word(owner, word + 1u), signal_history_word(owner, word + 2u)));
}
var<private> direct_transport: bool;
var<private> direct_full: bool;
var<private> signal_state: u32;
${SURFACE_LIGHTING_FUNCTIONS_WGSL}
fn packet_store(pixel: u32, kind: u32, value: vec3f, semantic: u32) {
  let at = kind * 3u * settings.pixels + pixel;
  for (var channel = 0u; channel < 3u; channel++) {
    signal_values[at + channel * settings.pixels] = bitcast<u32>(value[channel]);
  }
  signal_state |= (1u << kind) | (semantic & (SURFACE_PACKET_DIFFUSE_TRANSPORT | SURFACE_PACKET_COLORED_RESIDUAL));
  diagnostic_add(20u + kind, 1u);
}
@compute @workgroup_size(64)
fn lighting(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let tile = atomicLoad(&work_control[settings.queue_base + (32u + settings.bank) * settings.bank_tiles + group.x]);
  let coordinate = vec2u((tile % settings.tiles_x) * 8u + lane % 8u,
    settings.bank * settings.bank_rows + (tile / settings.tiles_x) * 8u + lane / 8u);
  let pixel = (coordinate.y - settings.bank * settings.bank_rows) * settings.width + coordinate.x;
  var entry = 0xffffffffu;
  if coordinate.x < settings.width && coordinate.y < settings.height {
    entry = surface_work_entry(pixel);
  }
  var is_lit = false;
  if entry != 0xffffffffu {
    is_lit = dag_metadata[settings.palette + entry * 64u + 3u] != 0u;
  }
  var transport = false;
  var history_mask = 0u;
  if is_lit {
    transport = work_heap[pixel * settings.source_payload.y + 7u] != 0u && dag_metadata[settings.domain_base] != 0u;
    direct_transport = transport;
    signal_history_prepare(coordinate);
    for (var kind = 0u; kind < 6u; kind++) {
      history_mask |= u32(signal_history_valid(kind)) << kind;
    }
  }
  if settings.reuse != 0u {
    // Valid history is already the complete value for each target. It creates
    // no new spatial-sampling demand; coverage's zero owner recipe is correct.
    // Admission is needed only for tiles with an actual direct Lighting miss.
    history_complete_lanes[lane] = u32(!is_lit || history_mask == 63u);
    workgroupBarrier();
    if lane == 0u {
      var complete = 1u;
      for (var index = 0u; index < 64u; index++) {
        complete &= history_complete_lanes[index];
      }
      history_complete_tile = complete;
    }
    let complete = workgroupUniformLoad(&history_complete_tile);
    if complete == 0u {
      surface_prepare_rates(tile, lane);
    }
  }
  if !is_lit {
    return;
  }
  signal_state = 0u;
  direct_transport = transport;
  direct_full = true;
  let history_valid0 = (history_mask & 1u) != 0u;
  let history_valid1 = (history_mask & 2u) != 0u;
  let history_valid2 = (history_mask & 4u) != 0u;
  let history_valid3 = (history_mask & 8u) != 0u;
  let history_valid4 = (history_mask & 16u) != 0u;
  let history_valid5 = (history_mask & 32u) != 0u;
  let history_any = history_valid0 || history_valid1 || history_valid2 ||
    history_valid3 || history_valid4 || history_valid5;
  let history_owner = surface_signal_owner(pixel, 0u) == pixel ||
    surface_signal_owner(pixel, 1u) == pixel ||
    surface_signal_owner(pixel, 2u) == pixel ||
    surface_signal_owner(pixel, 3u) == pixel ||
    surface_signal_owner(pixel, 4u) == pixel ||
    surface_signal_owner(pixel, 5u) == pixel;
  if history_owner {
    diagnostic_add(37u, u32(history_any));
    diagnostic_add(38u, u32(!history_any));
    diagnostic_add(39u, u32(textureLoad(surface_facts, vec2i(coordinate), 0).z >= 0.5));
    diagnostic_add(${SURFACE_WORK_SIGNAL_HISTORY_COUNTER_BASE - 256}u, u32(history_valid0));
    diagnostic_add(${SURFACE_WORK_SIGNAL_HISTORY_COUNTER_BASE - 256 + 1}u, u32(history_valid1));
    diagnostic_add(${SURFACE_WORK_SIGNAL_HISTORY_COUNTER_BASE - 256 + 2}u, u32(history_valid2));
    diagnostic_add(${SURFACE_WORK_SIGNAL_HISTORY_COUNTER_BASE - 256 + 3}u, u32(history_valid3));
    diagnostic_add(${SURFACE_WORK_SIGNAL_HISTORY_COUNTER_BASE - 256 + 4}u, u32(history_valid4));
    diagnostic_add(${SURFACE_WORK_SIGNAL_HISTORY_COUNTER_BASE - 256 + 5}u, u32(history_valid5));
  }
  if history_valid0 && history_valid1 && history_valid2 && history_valid3 && history_valid4 && history_valid5 {
    // These values already include their original signal-specific computation.
    // Current fields/Geometry stay authoritative for Reconstruction; Lighting
    // need not reread material values or prepare a BRDF on an all-history hit.
    for (var kind = 0u; kind < 6u; kind++) {
      if surface_signal_owner(pixel, kind) == pixel {
        packet_store(pixel, kind, signal_history_sample(kind),
          select(SURFACE_PACKET_COLORED_RESIDUAL, SURFACE_PACKET_DIFFUSE_TRANSPORT, transport));
      }
    }
    signal_values[18u * settings.pixels + pixel] = signal_state;
    diagnostic_add(5u, 1u);
    return;
  }
  let position = surface_work_vec4(pixel, 0u);
  let basis = surface_work_vec4(pixel, 4u).xyz;
  let geometric = surface_work_vec4(pixel, 8u).xyz;
  let normal = surface_work_guide(pixel, false);
  let delta = camera.transform[3u].xyz - position.xyz;
  let length2 = dot(delta, delta);
  let view_direction = select(basis, delta * inverseSqrt(length2), length2 > 1e-20 && all(delta == delta));
  var material = surface_material(pixel, 63u, transport);
  material.coatNormal = surface_work_guide(pixel, true);
  let geometry = SurfaceGeometry(normal, geometric, position.xyz, view_direction);
  // Per-kind owners were finalized before this pass. Direct's three kinds
  // share an owner only when the full direct closure has equal dependencies.
  signal_state |= select(SURFACE_PACKET_COLORED_RESIDUAL, SURFACE_PACKET_DIFFUSE_TRANSPORT, transport);
  var direct = ReflectedLight(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  var direct_ready = false;
  if surface_signal_owner(pixel, 0u) == pixel {
    if !history_valid0 || !history_valid2 || !history_valid4 {
      direct = direct_surface(material, geometry, vec2f(coordinate) + vec2f(0.5), abs(position.w));
      direct_ready = true;
    }
    if history_valid0 {
      packet_store(pixel, 0u, signal_history_sample(0u),
        SURFACE_PACKET_DIFFUSE | select(SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COLORED_RESIDUAL, SURFACE_PACKET_DIFFUSE_TRANSPORT, transport));
    } else {
      packet_store(pixel, 0u, select(direct.diffuse, direct.transport, transport),
        SURFACE_PACKET_DIFFUSE | select(SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COLORED_RESIDUAL, SURFACE_PACKET_DIFFUSE_TRANSPORT, transport));
    }
    if history_valid2 {
      packet_store(pixel, 2u, signal_history_sample(2u), SURFACE_PACKET_RADIANCE | SURFACE_PACKET_SPECULAR);
    } else {
      packet_store(pixel, 2u, direct.specular, SURFACE_PACKET_RADIANCE | SURFACE_PACKET_SPECULAR);
    }
    if history_valid4 {
      packet_store(pixel, 4u, signal_history_sample(4u), SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COAT);
    } else {
      packet_store(pixel, 4u, direct.coat, SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COAT);
    }
    diagnostic_add(0u, 1u);
    diagnostic_add(1u, 1u);
    diagnostic_add(2u, u32(material.coatFactor > 0.0));
  }
  if surface_signal_owner(pixel, 2u) == pixel && surface_signal_owner(pixel, 0u) != pixel {
    if !history_valid2 || !direct_ready {
      if !history_valid2 {
        direct = direct_surface(material, geometry, vec2f(coordinate) + vec2f(0.5), abs(position.w));
        direct_ready = true;
      }
    }
    if !history_valid2 {
      packet_store(pixel, 2u, direct.specular, SURFACE_PACKET_RADIANCE | SURFACE_PACKET_SPECULAR);
    } else {
      packet_store(pixel, 2u, signal_history_sample(2u), SURFACE_PACKET_RADIANCE | SURFACE_PACKET_SPECULAR);
    }
  }
  if surface_signal_owner(pixel, 4u) == pixel && surface_signal_owner(pixel, 0u) != pixel {
    if !history_valid4 {
      if !direct_ready {
        direct = direct_surface(material, geometry, vec2f(coordinate) + vec2f(0.5), abs(position.w));
        direct_ready = true;
      }
      packet_store(pixel, 4u, direct.coat, SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COAT);
    } else {
      packet_store(pixel, 4u, signal_history_sample(4u), SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COAT);
    }
  }
  if surface_signal_owner(pixel, 1u) == pixel {
    var irradiance = vec3f(0.0);
    if history_valid1 {
      irradiance = signal_history_sample(1u);
    } else {
      irradiance = environment_diffuse_irradiance(normal);
    }
    packet_store(pixel, 1u, irradiance,
      SURFACE_PACKET_IRRADIANCE | SURFACE_PACKET_DIFFUSE | SURFACE_PACKET_ENVIRONMENT);
    diagnostic_add(3u, 1u);
  }
  if surface_signal_owner(pixel, 3u) == pixel {
    var specular = vec3f(0.0);
    if history_valid3 {
      specular = signal_history_sample(3u);
    } else {
      specular = environment_specular_surface(material, normal, view_direction);
    }
    packet_store(pixel, 3u, specular,
      SURFACE_PACKET_RADIANCE | SURFACE_PACKET_SPECULAR | SURFACE_PACKET_ENVIRONMENT);
    diagnostic_add(6u, 1u);
  }
  if surface_signal_owner(pixel, 5u) == pixel {
    var coat = vec3f(0.0);
    if history_valid5 {
      coat = signal_history_sample(5u);
    } else if material.coatFactor > 0.0 {
      coat = coat_environment(material, material.coatNormal, view_direction);
      diagnostic_add(4u, 1u);
    }
    packet_store(pixel, 5u, coat,
      SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COAT | SURFACE_PACKET_ENVIRONMENT);
  }
  signal_values[18u * settings.pixels + pixel] = signal_state;
  diagnostic_add(5u, 1u);
}
`;
