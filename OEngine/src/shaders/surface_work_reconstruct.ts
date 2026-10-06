import { SURFACE_WORK_SETTINGS_WGSL } from "./surface_work.js";
import { surfaceWorkReadWgsl, SURFACE_WORK_SIGNAL_READ_WGSL } from "../gpu/GpuSurfaceWorkAbi.js";
import { SURFACE_WORK_SIGNAL_RECIPE_WGSL } from "./surface_work_rate.js";
import { SURFACE_PACKET_CONTRACT_WGSL } from "../gpu/GpuSurfaceSignalPacketAbi.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "./working_color.js";

/** Immutable values/signals + output-pixel factors only. No Geometry decode,
 * Appearance DAG or BRDF is present in this consumer. Background writes are
 * disjoint from covered writes by the final entry validity published at S5. */
export const SURFACE_WORK_RECONSTRUCT_WGSL = /* wgsl */ `
${SURFACE_WORK_SETTINGS_WGSL}
${SURFACE_PACKET_CONTRACT_WGSL}
${LINEAR_REC709_TO_REC2020_WGSL}
@group(0) @binding(0) var<uniform> settings: SurfaceWorkSettings;
@group(0) @binding(1) var<storage, read> work_heap: array<u32>;
@group(0) @binding(2) var<storage, read> dag_metadata: array<u32>;
@group(0) @binding(3) var<storage, read_write> work_control: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> signal_values: array<u32>;
@group(0) @binding(5) var source_facts: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> pre_exposure: array<f32>;
@group(0) @binding(7) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var reactive: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(9) var<storage, read> scalar_ao: array<u32>;
${surfaceWorkReadWgsl(false)}
${SURFACE_WORK_SIGNAL_RECIPE_WGSL}
${SURFACE_WORK_SIGNAL_READ_WGSL}
@compute @workgroup_size(8, 8)
fn reconstruct(@builtin(global_invocation_id) id: vec3u) {
  let coordinate = vec2u(id.x, settings.bank * settings.bank_rows + id.y);
  if coordinate.x >= settings.width || coordinate.y >= settings.height || id.y >= settings.bank_rows { return; }
  let pixel = id.y * settings.width + id.x;
  let entry = surface_work_entry(pixel);
  let valid = entry != 0xffffffffu;
  var value = vec3f(0.0);
  if valid {
    value = max(surface_field(pixel, 5u).xyz, vec3f(0.0));
    let base = max(surface_field(pixel, 0u).xyz, vec3f(0.0));
    if dag_metadata[settings.palette + entry * 64u + 3u] == 0u {
      value += base;
    } else {
      let metallic = clamp(surface_field(pixel, 2u).x, 0.0, 1.0);
      let factor = base * (1.0 - metallic);
      let direct = surface_signal_rgb(surface_signal_owner(pixel, 0u), 0u);
      if (surface_signal_state(pixel) & SURFACE_PACKET_DIFFUSE_TRANSPORT) != 0u { value += factor * direct; }
      else { value += direct; }
      let irradiance = surface_signal_rgb(surface_signal_owner(pixel, 1u), 1u);
      let occlusion = clamp(surface_field(pixel, 4u).x, 0.0, 1.0);
      var ao = 1.0;
      if settings.reserved != 0u {
        let index = coordinate.y * settings.width + coordinate.x;
        ao = f32((scalar_ao[index / 4u] >> ((index & 3u) * 8u)) & 255u) * (1.0 / 255.0);
      }
      value += factor * occlusion * ao * irradiance * 0.3183098861837907;
      for (var kind = 2u; kind < 6u; kind++) { value += surface_signal_rgb(surface_signal_owner(pixel, kind), kind); }
    }
  }
  let facts = textureLoad(source_facts, vec2i(coordinate), 0);
  textureStore(output, vec2i(coordinate), vec4f(oengine_linear_rec709_to_rec2020(value) * max(pre_exposure[0], 1e-4), f32(valid)));
  textureStore(reactive, vec2i(coordinate), vec4f(max(facts.x, select(0.35, 0.0, valid)), facts.yzw));
  if settings.diagnostics != 0u {
    atomicAdd(&work_control[233u], u32(valid));
    atomicAdd(&work_control[234u], u32(!valid));
  }
}
`;
