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

fn mat4_inverse(m: mat4x4f) -> mat4x4f {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2]; let a03 = m[0][3];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2]; let a13 = m[1][3];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2]; let a23 = m[2][3];
  let a30 = m[3][0]; let a31 = m[3][1]; let a32 = m[3][2]; let a33 = m[3][3];
  let b00 = a00 * a11 - a01 * a10;
  let b01 = a00 * a12 - a02 * a10;
  let b02 = a00 * a13 - a03 * a10;
  let b03 = a01 * a12 - a02 * a11;
  let b04 = a01 * a13 - a03 * a11;
  let b05 = a02 * a13 - a03 * a12;
  let b06 = a20 * a31 - a21 * a30;
  let b07 = a20 * a32 - a22 * a30;
  let b08 = a20 * a33 - a23 * a30;
  let b09 = a21 * a32 - a22 * a31;
  let b10 = a21 * a33 - a23 * a31;
  let b11 = a22 * a33 - a23 * a32;
  let inv_det = 1.0 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  return mat4x4f(
    vec4f(a11*b11-a12*b10+a13*b09, a02*b10-a01*b11-a03*b09, a31*b05-a32*b04+a33*b03, a22*b04-a21*b05-a23*b03)*inv_det,
    vec4f(a12*b08-a10*b11-a13*b07, a00*b11-a02*b08+a03*b07, a32*b02-a30*b05-a33*b01, a20*b05-a22*b02+a23*b01)*inv_det,
    vec4f(a10*b10-a11*b08+a13*b06, a01*b08-a00*b10-a03*b06, a30*b04-a31*b02+a33*b00, a21*b02-a20*b04-a23*b00)*inv_det,
    vec4f(a11*b07-a10*b09-a12*b06, a00*b09-a01*b07+a02*b06, a31*b01-a30*b03-a32*b00, a20*b03-a21*b01+a22*b00)*inv_det
  );
}

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
  let resolution = vec2f(textureDimensions(depth_texture));
  let depth = textureLoad(depth_texture, pixel, 0).r;
  let current_ndc = vec3f(
    position.x / resolution.x * 2.0 - 1.0,
    1.0 - position.y / resolution.y * 2.0,
    depth
  );
  let world_h = inverse_current_view_projection * vec4f(current_ndc, 1.0);
  let current_world = world_h.xyz / world_h.w;
  let instance = instances[instance_index];
  let previous_from_current = instance.previous_object_to_world
    * mat4_inverse(instance.current_object_to_world);
  let previous_world_h = previous_from_current * vec4f(current_world, 1.0);
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
