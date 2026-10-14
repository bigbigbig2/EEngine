import { SSSR_COMMON_WGSL } from "./sssr_common.js";

export const SSSR_COMPOSITE_WGSL = /* wgsl */ `
${SSSR_COMMON_WGSL}
@group(1) @binding(0) var opaque_radiance: texture_2d<f32>;
@group(1) @binding(1) var base_signal: texture_2d<f32>;
@group(1) @binding(2) var coat_signal: texture_2d<f32>;
@group(1) @binding(3) var output_radiance: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (!sssr_valid_pixel(id.xy)) {
    return;
  }
  let pixel = vec2i(id.xy);
  let receiver = sssr_receiver(sssr_index(id.xy));
  let base = sssr_to709(textureLoad(base_signal, pixel, 0).rgb);
  let coat = sssr_to709(textureLoad(coat_signal, pixel, 0).rgb);
  let replacement = sssr_to2020(receiver.response.xyz * base + receiver.response.w * coat);
  let hdr = textureLoad(opaque_radiance, pixel, 0);
  textureStore(output_radiance, pixel, vec4f(hdr.rgb + frame.settings.w * (replacement - receiver.baseline.xyz), hdr.a));
}
`;

export const SSSR_SNAPSHOT_WGSL = /* wgsl */ `
${SSSR_COMMON_WGSL}
@group(1) @binding(0) var output_normal: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(1) var output_depth: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (!sssr_valid_pixel(id.xy)) {
    return;
  }
  let receiver = sssr_receiver(sssr_index(id.xy));
  let flags = u32(receiver.baseline.w);
  var base = receiver.base;
  var coat = receiver.coat;
  if ((flags & 2u) == 0u || base.w >= frame.settings.x) {
    base = vec4f(0.0, 0.0, 0.0, -1.0);
  }
  if ((flags & 4u) == 0u || coat.w >= frame.settings.x) {
    coat = vec4f(0.0, 0.0, 0.0, -1.0);
  }
  textureStore(output_normal, vec2i(id.xy), 0, base);
  textureStore(output_normal, vec2i(id.xy), 1, coat);
  textureStore(output_depth, vec2i(id.xy), vec4f(sssr_depth(vec2i(id.xy))));
}
`;
