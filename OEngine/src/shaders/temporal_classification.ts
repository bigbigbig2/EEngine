import { GPU_SHADING_SURFACE_LITE_WGSL } from "../gpu/GpuComputeMaterialAbi.js";

export const TEMPORAL_CLASSIFICATION_FORMAT = "rg8unorm" as const;

export const TEMPORAL_CLASSIFICATION_WGSL = /* wgsl */ `
${GPU_SHADING_SURFACE_LITE_WGSL}
struct ClassificationSettings {
  metadata_available: u32,
  transparency_available: u32,
  _padding0: u32,
  _padding1: u32,
}
@group(0) @binding(0) var surface_metadata: texture_2d<u32>;
@group(0) @binding(1) var transparent_reactive: texture_2d<f32>;
@group(0) @binding(2) var<uniform> settings: ClassificationSettings;

@fragment
fn main(@builtin(position) position: vec4f) -> @location(0) vec2f {
  let pixel = vec2i(position.xy);
  var reactive = 0.0;
  var motion_valid = 1.0;
  if settings.metadata_available != 0u {
    let metadata = textureLoad(surface_metadata, pixel, 0).r;
    let valid = oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_VALID);
    let valid_motion = oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_MOTION_VALID);
    let surface_reactive = oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_REACTIVE);
    motion_valid = select(0.0, 1.0, valid && valid_motion);
    reactive = select(0.0, 1.0, !valid || surface_reactive);
  }
  if settings.transparency_available != 0u {
    let transparent = clamp(textureLoad(transparent_reactive, pixel, 0).r, 0.0, 1.0);
    reactive = max(reactive, transparent);
  }
  return vec2f(reactive, motion_valid);
}
`;

export function temporalEvidenceWgsl(
  reactiveIndex: number,
  disoccludedIndex: number,
  rejectedIndex: number
): string {
  return /* wgsl */ `
struct EvidenceSettings {
  history_valid: u32,
  reconstruction_owner: u32,
  internal_resolution: vec2u,
  output_resolution: vec2u,
  reactive_threshold: f32,
  disocclusion_threshold: f32,
}
@group(0) @binding(0) var classification: texture_2d<f32>;
@group(0) @binding(1) var disocclusion_confidence: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> settings: EvidenceSettings;
@group(0) @binding(4) var current_depth: texture_depth_2d;
@group(0) @binding(5) var velocity_texture: texture_2d<f32>;

fn inside_taa_history(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}

fn inside_nss_history(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}

fn closest_taa_depth_pixel(center: vec2i, maximum: vec2i) -> vec2i {
  var closest = clamp(center, vec2i(0), maximum);
  var closest_depth = textureLoad(current_depth, closest, 0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let candidate = clamp(center + vec2i(x, y), vec2i(0), maximum);
      let depth = textureLoad(current_depth, candidate, 0);
      if (depth > closest_depth) {
        closest = candidate;
        closest_depth = depth;
      }
    }
  }
  return closest;
}

fn closest_nss_depth_pixel(center: vec2i, maximum: vec2i) -> vec2i {
  const offsets = array<vec2i, 9>(
    vec2i(0, 0), vec2i(1, 0), vec2i(0, 1),
    vec2i(0, -1), vec2i(-1, 0), vec2i(-1, 1),
    vec2i(1, 1), vec2i(-1, -1), vec2i(1, -1)
  );
  var closest = clamp(center, vec2i(0), maximum);
  var closest_depth = textureLoad(current_depth, closest, 0);
  for (var index = 1; index < 9; index++) {
    let candidate = center + offsets[index];
    if (all(candidate >= vec2i(0)) && all(candidate <= maximum)) {
      let depth = textureLoad(current_depth, candidate, 0);
      if (depth > closest_depth) {
        closest = candidate;
        closest_depth = depth;
      }
    }
  }
  return closest;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let is_nss = settings.reconstruction_owner == 1u;
  let evidence_size = select(settings.output_resolution, settings.internal_resolution, is_nss);
  if any(id.xy >= evidence_size) { return; }
  let internal_size = max(settings.internal_resolution, vec2u(1));
  let internal_maximum = vec2i(internal_size) - vec2i(1);
  let evidence_uv = (vec2f(id.xy) + 0.5) / vec2f(evidence_size);
  let current_pixel_f = evidence_uv * vec2f(internal_size);
  let current_pixel = clamp(vec2i(current_pixel_f), vec2i(0), internal_maximum);
  var selected_pixel = closest_taa_depth_pixel(current_pixel, internal_maximum);
  if is_nss {
    selected_pixel = closest_nss_depth_pixel(current_pixel, internal_maximum);
  }
  let selected_value = textureLoad(classification, selected_pixel, 0).rg;
  let current_reactive = textureLoad(classification, current_pixel, 0).r;
  let reactive_value = clamp(max(selected_value.r, current_reactive), 0.0, 1.0);
  let confidence = clamp(
    textureLoad(disocclusion_confidence, selected_pixel, 0).r,
    0.0,
    1.0
  );
  let velocity = textureLoad(velocity_texture, selected_pixel, 0).rg;
  let taa_history_uv = (current_pixel_f - velocity) / vec2f(internal_size);
  let nss_history_uv = (vec2f(current_pixel) + 0.5 - velocity) /
    vec2f(internal_size);
  let history_inside = select(
    inside_taa_history(taa_history_uv),
    inside_nss_history(nss_history_uv),
    is_nss
  );
  let reactive = reactive_value >= settings.reactive_threshold;
  let disoccluded = confidence < settings.disocclusion_threshold;
  let taa_rejected = settings.history_valid == 0u || selected_value.g < 0.5 ||
    reactive || disoccluded || !history_inside;
  // NSS has continuous confidence/reactive weighting. Its hard-zero boundary is
  // the quantized rg8unorm validity consumed by resolve, not the TAA thresholds.
  let nss_validity = confidence * select(0.0, 1.0, selected_value.g >= 0.5) *
    (1.0 - reactive_value) * select(0.0, 1.0, settings.history_valid != 0u) *
    select(0.0, 1.0, history_inside);
  let nss_rejected = nss_validity <= (0.5 / 255.0);
  let rejected = select(taa_rejected, nss_rejected, is_nss);
  if reactive { atomicAdd(&counters[${reactiveIndex}u], 1u); }
  if disoccluded { atomicAdd(&counters[${disoccludedIndex}u], 1u); }
  if rejected { atomicAdd(&counters[${rejectedIndex}u], 1u); }
}
`;
}
