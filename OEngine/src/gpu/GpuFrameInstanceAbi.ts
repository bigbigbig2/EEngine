import { GPU_INSTANCE_RECORD_STRIDE } from "./GpuInstanceAbi.js";

/** Frame-only instance snapshot. Source scene identity/motion remains unchanged;
 * camera and inverse-transpose work is produced once per demanded instance. */
export const GPU_FRAME_INSTANCE_STRIDE = GPU_INSTANCE_RECORD_STRIDE + 64 + 48;
export const GPU_FRAME_INSTANCE_OFFSETS = Object.freeze({ source: 0, objectToClip: GPU_INSTANCE_RECORD_STRIDE,
  normalX: GPU_INSTANCE_RECORD_STRIDE + 64, normalY: GPU_INSTANCE_RECORD_STRIDE + 80,
  generation: GPU_INSTANCE_RECORD_STRIDE + 92, normalZ: GPU_INSTANCE_RECORD_STRIDE + 96 });

/** Requires GPU_INSTANCE_RECORD_WGSL. Generation occupies a typed u32 lane,
 * preserving all bit patterns. Cofactors stay unnormalized. */
export const GPU_FRAME_INSTANCE_WGSL = /* wgsl */ `
struct OEngineFrameInstanceRecord {
  source: OEngineInstanceRecord,
  object_to_clip: mat4x4f,
  normal_x: vec4f,
  normal_y: vec3f,
  generation: u32,
  normal_z: vec4f,
}
fn oengine_frame_instance_normal(normal_x: vec4f, normal_y: vec3f, normal_z: vec3f, local: vec3f, geometric: vec3f) -> vec3f {
  let determinant = normal_x.w;
  if abs(determinant) < 1e-8 { return geometric; }
  return normalize((mat3x3f(normal_x.xyz, normal_y, normal_z) * local) * sign(determinant));
}
`;

/** Same instance binding replaces the original record in the single Surface
 * consumer. Temporal/scene selection retain their authoritative scene input. */
export const SURFACE_FRAME_INSTANCE_WGSL = /* wgsl */ `
${GPU_FRAME_INSTANCE_WGSL}
fn surface_instance_record(slot: u32) -> OEngineInstanceRecord { return instance_records[slot].source; }
fn surface_object_to_clip(slot: u32) -> mat4x4f { return instance_records[slot].object_to_clip; }
fn surface_world_normal(slot: u32, local: vec3f, geometric: vec3f) -> vec3f {
  return oengine_frame_instance_normal(instance_records[slot].normal_x,
    instance_records[slot].normal_y.xyz, instance_records[slot].normal_z.xyz, local, geometric);
}
`;
