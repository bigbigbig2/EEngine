import { VSM_MAX_CLIP_LEVELS, VSM_RECEIVER_DESCRIPTOR_REFERENCES } from "../gpu/GpuVsmProjectionAbi.js";
import { surfaceGeometryCompletionWgsl } from "./surface_geometry_completion.js";
import { NATIVE_RESOLVED_POSITION_WGSL } from "./native_resolved_position.js";
import { LOCAL_LIGHT_TYPES_WGSL } from "../gpu/GpuLocalLightWorkAbi.js";
import { VSM_SAMPLING_TYPES_WGSL } from "./vsm_sampling.js";

/** One receiver owns its lookup and bounded keyed page references. No hash table,
 * dedup races or page-count readback. PCF taps address the selected atlas page.
 * Borrow exactly Native's geometry decoder/receiver reconstruction. 64 lanes,
 * sequential outputs and bounded random reads, no atomics/workgroup barriers. */
export function scgiLightingGatherWgsl(product: boolean): string {
  return /* wgsl */ `
${surfaceGeometryCompletionWgsl(product, false, false, true)}
${NATIVE_RESOLVED_POSITION_WGSL}
${LOCAL_LIGHT_TYPES_WGSL}
${VSM_SAMPLING_TYPES_WGSL}
struct GatherSettings {
  source: vec4u,
  source_payload: vec4u,
  dimensions: vec4u,
  camera_position_exposure: vec4f,
  view_matrix: mat4x4f,
  background: vec4f,
  inverse_view_projection: mat4x4f,
  window: vec4u,
  source_ranges: vec4u,
  destination: vec4u,
}
@group(0) @binding(0) var<uniform> settings: GatherSettings;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> source_heap: array<u32>;
@group(0) @binding(3) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(4) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(5) var visibility: texture_2d<u32>;
@group(0) @binding(6) var<storage, read> source_directory: array<u32>;
@group(0) @binding(7) var<storage, read_write> destination: array<u32>;
@group(0) @binding(8) var<uniform> local_parameters: LocalLightParameters;
@group(0) @binding(9) var<uniform> vsm_constants: VsmSamplingConstants;
${
  product
    ? `
@group(1) @binding(0) var<storage, read> product_heap: array<u32>;
@group(1) @binding(1) var<storage, read> product_bank_0: array<u32>;
@group(1) @binding(2) var<storage, read> product_bank_1: array<u32>;
@group(1) @binding(3) var<storage, read> product_bank_2: array<u32>;
@group(1) @binding(4) var<storage, read> product_bank_3: array<u32>;`
    : ""
}
const geometry_needs: u32 = 1u << 7u;
fn gather_descriptor(record: u32, index: u32) {
  destination[record] = index;
  for (var word = 0u; word < 4u; word++) {
    destination[record + 1u + word] = 0u;
    if (index < settings.source_ranges.w) {
      destination[record + 1u + word] = source_directory[settings.source_ranges.z + index * 4u + word];
    }
  }
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let count = settings.window.y * settings.window.z;
  if (id.x >= count) {
    return;
  }
  let pixel = vec2u(settings.window.x + id.x % settings.window.y,
    settings.window.w + id.x / settings.window.y);
  let lookup = settings.destination.x + id.x * 2u;
  let descriptors = settings.destination.y + id.x * ${VSM_RECEIVER_DESCRIPTOR_REFERENCES * 5}u;
  destination[lookup] = 0u;
  destination[lookup + 1u] = 0u;
  for (var reference = 0u; reference < ${VSM_RECEIVER_DESCRIPTOR_REFERENCES}u; reference++) {
    gather_descriptor(descriptors + reference * 5u, 0xffffffffu);
  }
  let key = textureLoad(visibility, vec2i(pixel), 0).r;
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation,
    meshlet_work.header.written_count);
  if (decoded.valid == 0u) {
    return;
  }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  if (work.instance_slot >= arrayLength(&frame_instances)) {
    return;
  }
  let instance = frame_instances[work.instance_slot];
  let resolved = geometry_complete_resolved(decoded, work, instance);
  let interpolation = winner_interpolate(resolved.coefficients, vec2f(pixel) + vec2f(0.5), vec2f(settings.dimensions.xy));
  if ((interpolation.flags & WINNER_VALUE_VALID) == 0u) {
    return;
  }
  let position = native_resolved_position(resolved, pixel);
  let depth = -(settings.view_matrix * vec4f(position, 1.0)).z;
  let cluster = local_light_cluster(pixel, depth, local_parameters);
  if (cluster < settings.source_ranges.y) {
    destination[lookup] = source_directory[settings.source_ranges.x + cluster * 2u];
    destination[lookup + 1u] = source_directory[settings.source_ranges.x + cluster * 2u + 1u];
  }
  if (vsm_constants.depth_range.w == 0.0) {
    return;
  }
  let light = (vsm_constants.light_view * vec4f(position, 1.0)).xy;
  let selected = vsm_select_clip(length(position - vsm_constants.selector.xyz), vsm_constants.clip_origin_extent[0].z,
    vsm_constants.selector.w, vsm_constants.control.x, vsm_constants.dimensions.x);
  if (selected == VSM_INVALID_SLOT) {
    return;
  }
  for (var reference = 0u; reference < ${VSM_RECEIVER_DESCRIPTOR_REFERENCES}u; reference++) {
    let level = reference % ${VSM_MAX_CLIP_LEVELS}u;
    let mip = select(0u, 5u, reference >= ${VSM_MAX_CLIP_LEVELS}u);
    if (level >= vsm_constants.control.x || level < selected) {
      continue;
    }
    let clip = vsm_constants.clip_origin_extent[level];
    let world = vsm_world_page(light, clip, mip, vsm_constants.dimensions.x);
    if (vsm_world_in_window(world, clip, mip, vsm_constants.dimensions.x)) {
      gather_descriptor(descriptors + reference * 5u,
        vsm_sampling_index(level, mip, world, vsm_constants.dimensions.x));
    }
  }
}
`;
}
