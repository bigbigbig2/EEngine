import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { VELOCITY_FORMAT, VELOCITY_VIZ_INVALID } from "./velocity.js";

export { VELOCITY_FORMAT as PACKED_VELOCITY_FORMAT };

export const PACKED_VELOCITY_WGSL = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
const VIZ_INVALID: u32 = ${VELOCITY_VIZ_INVALID}u;

@group(0) @binding(0) var depth_texture: texture_2d<f32>;
@group(0) @binding(1) var instance_texture: texture_2d<u32>;
@group(0) @binding(2) var<uniform> inverse_current_view_projection: mat4x4f;
@group(0) @binding(3) var<uniform> previous_view_projection: mat4x4f;
@group(0) @binding(4) var<storage, read> instances: array<OEngineInstanceRecord>;

const FULLSCREEN = array<vec2f, 3>(
  vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
);

@vertex
fn packed_velocity_vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(FULLSCREEN[vertex_index], 0.0, 1.0);
}

@fragment
fn packed_velocity_fs(@builtin(position) position: vec4f) -> @location(0) vec2f {
  let pixel = vec2u(position.xy);
  let instance_index = textureLoad(instance_texture, pixel, 0).r;
  if instance_index == VIZ_INVALID { return vec2f(0.0); }
  let instance = instances[instance_index];
  if !oengine_instance_motion_valid(instance) { return vec2f(0.0); }
  let resolution = vec2f(textureDimensions(depth_texture));
  let depth = textureLoad(depth_texture, pixel, 0).r;
  let current_ndc = vec3f(
    position.x / resolution.x * 2.0 - 1.0,
    1.0 - position.y / resolution.y * 2.0,
    depth
  );
  let world_h = inverse_current_view_projection * vec4f(current_ndc, 1.0);
  let current_world = world_h.xyz / world_h.w;
  let previous_world_h = instance.previous_from_current * vec4f(current_world, 1.0);
  let previous_clip = previous_view_projection * vec4f(
    previous_world_h.xyz / previous_world_h.w,
    1.0
  );
  let previous_ndc = previous_clip.xyz / previous_clip.w;
  let previous_pixel = vec2f(
    (previous_ndc.x + 1.0) * 0.5 * resolution.x,
    (1.0 - previous_ndc.y) * 0.5 * resolution.y
  );
  return position.xy - previous_pixel;
}
`;
