import { GPU_SURFACE_ABI_WGSL } from "../gpu/GpuSurfaceAbi.js";
import { TEMPORAL_DISOCCLUSION_REJECT_THRESHOLD } from "../render/TemporalResolveContract.js";

export const TEMPORAL_CLASSIFICATION_FORMAT = "rg8unorm" as const;

export const TEMPORAL_CLASSIFICATION_WGSL = /* wgsl */ `
${GPU_SURFACE_ABI_WGSL}
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
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}
@group(0) @binding(0) var classification: texture_2d<f32>;
@group(0) @binding(1) var disocclusion_confidence: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> settings: EvidenceSettings;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(classification);
  if any(id.xy >= size) { return; }
  let pixel = vec2i(id.xy);
  let value = textureLoad(classification, pixel, 0).rg;
  let confidence = textureLoad(disocclusion_confidence, pixel, 0).r;
  let reactive = value.r >= 0.5;
  let disoccluded = confidence < ${TEMPORAL_DISOCCLUSION_REJECT_THRESHOLD};
  let rejected = settings.history_valid == 0u || value.g < 0.5 || reactive || disoccluded;
  if reactive { atomicAdd(&counters[${reactiveIndex}u], 1u); }
  if disoccluded { atomicAdd(&counters[${disoccludedIndex}u], 1u); }
  if rejected { atomicAdd(&counters[${rejectedIndex}u], 1u); }
}
`;
}
