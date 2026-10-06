import { SURFACE_DIRECT_MATH, SURFACE_LIGHTING_FUNCTIONS_WGSL } from "./surface_work_lighting_math.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "./environment_ibl.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "./atmosphere/runtime.js";
import { SURFACE_PACKET_CONTRACT_WGSL } from "../gpu/GpuSurfaceSignalPacketAbi.js";
import { surfaceWorkReadWgsl } from "../gpu/GpuSurfaceWorkAbi.js";
import { SURFACE_WORK_SETTINGS_WGSL } from "./surface_work.js";
import { SURFACE_WORK_SIGNAL_RECIPE_WGSL } from "./surface_work_rate.js";

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
  if coordinate.x >= settings.width || coordinate.y >= settings.height { return; }
  let pixel = (coordinate.y - settings.bank * settings.bank_rows) * settings.width + coordinate.x;
  let entry = surface_work_entry(pixel);
  if entry == 0xffffffffu || dag_metadata[settings.palette + entry * 64u + 3u] == 0u { return; }
  signal_state = 0u;
  let position = surface_work_vec4(pixel, 0u);
  let basis = surface_work_vec4(pixel, 4u).xyz;
  let geometric = surface_work_vec4(pixel, 8u).xyz;
  let normal = surface_work_guide(pixel, false);
  let delta = camera.transform[3u].xyz - position.xyz;
  let length2 = dot(delta, delta);
  let view_direction = select(basis, delta * inverseSqrt(length2), length2 > 1e-20 && all(delta == delta));
  let transport = work_heap[pixel * settings.source_payload.y + 7u] != 0u && dag_metadata[settings.domain_base] != 0u;
  var material = surface_material(pixel, 63u, transport);
  material.coatNormal = surface_work_guide(pixel, true);
  direct_transport = transport;
  direct_full = true;
  let geometry = SurfaceGeometry(normal, geometric, position.xyz, view_direction);
  // Per-kind owners were finalized before this pass. Direct's three kinds
  // share an owner only when the full direct closure has equal dependencies.
  signal_state |= select(SURFACE_PACKET_COLORED_RESIDUAL, SURFACE_PACKET_DIFFUSE_TRANSPORT, transport);
  if surface_signal_owner(pixel, 0u) == pixel {
    let direct = direct_surface(material, geometry, vec2f(coordinate) + vec2f(0.5), abs(position.w));
    diagnostic_add(0u, 1u);
    diagnostic_add(1u, 1u);
    diagnostic_add(2u, u32(material.coatFactor > 0.0));
    packet_store(pixel, 0u, select(direct.diffuse, direct.transport, transport),
      SURFACE_PACKET_DIFFUSE | select(SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COLORED_RESIDUAL, SURFACE_PACKET_DIFFUSE_TRANSPORT, transport));
    packet_store(pixel, 2u, direct.specular, SURFACE_PACKET_RADIANCE | SURFACE_PACKET_SPECULAR);
    packet_store(pixel, 4u, direct.coat, SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COAT);
  }
  if surface_signal_owner(pixel, 1u) == pixel {
    packet_store(pixel, 1u, environment_diffuse_irradiance(normal), SURFACE_PACKET_IRRADIANCE | SURFACE_PACKET_DIFFUSE | SURFACE_PACKET_ENVIRONMENT);
    diagnostic_add(3u, 1u);
  }
  if surface_signal_owner(pixel, 3u) == pixel {
    packet_store(pixel, 3u, environment_specular_surface(material, normal, view_direction),
      SURFACE_PACKET_RADIANCE | SURFACE_PACKET_SPECULAR | SURFACE_PACKET_ENVIRONMENT);
    diagnostic_add(6u, 1u);
  }
  if surface_signal_owner(pixel, 5u) == pixel {
    var coat = vec3f(0.0);
    if material.coatFactor > 0.0 {
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
