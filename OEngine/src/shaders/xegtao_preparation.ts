/**
 * WGSL port of Intel XeGTAO a5b1686c7ea37788eeb3576b5be47f7c03db532c
 * GenerateNormals and PrefilterDepths16x16, MIT. Workgroups: 8x8.
 * Texture reads are point-clamped; no atomics or cross-workgroup barriers.
 */
import { XE_GTAO_PREP_UNIFORM_WGSL } from "../render/ao/XeGtaoPreparationAbi.js";

export const XE_GTAO_EDGES_WGSL = /* wgsl */ `
fn xe_edges(center: f32, left: f32, right: f32, top: f32, bottom: f32) -> vec4f {
  let delta = vec4f(left, right, top, bottom) - vec4f(center);
  let lr = (delta.y - delta.x) * 0.5;
  let tb = (delta.w - delta.z) * 0.5;
  let adjusted = delta + vec4f(lr, -lr, tb, -tb);
  return clamp(vec4f(1.25) - min(abs(delta), abs(adjusted)) /
    vec4f(max(center * 0.011, 1.0e-10)), vec4f(0.0), vec4f(1.0));
}
`;

const NORMAL_MATH = /* wgsl */ `
${XE_GTAO_EDGES_WGSL}
fn xe_normal(center: vec3f, left: vec3f, right: vec3f,
  top: vec3f, bottom: vec3f, edges: vec4f) -> vec3f {
  let accepted = clamp(vec4f(edges.x * edges.z, edges.z * edges.y,
    edges.y * edges.w, edges.w * edges.x) + vec4f(0.01),
    vec4f(0.0), vec4f(1.0));
  let l = normalize(left - center);
  let r = normalize(right - center);
  let t = normalize(top - center);
  let b = normalize(bottom - center);
  return normalize(accepted.x * cross(l, t) + accepted.y * cross(t, r) +
    accepted.z * cross(r, b) + accepted.w * cross(b, l));
}
fn xe_pack_normal(normal: vec3f) -> u32 {
  let value = clamp(normal * 0.5 + vec3f(0.5), vec3f(0.0), vec3f(1.0));
  return u32(value.x * 2047.0 + 0.5) |
    (u32(value.y * 2047.0 + 0.5) << 11u) |
    (u32(value.z * 1023.0 + 0.5) << 22u);
}
`;

export const XE_GTAO_NORMAL_WGSL = /* wgsl */ `
${XE_GTAO_PREP_UNIFORM_WGSL}
${NORMAL_MATH}
@group(0) @binding(1) var raw_depth: texture_depth_2d;
@group(0) @binding(2) var normal_output: texture_storage_2d<r32uint, write>;
fn xe_raw(coord: vec2i) -> f32 {
  let hi = vec2i(textureDimensions(raw_depth)) - vec2i(1);
  return textureLoad(raw_depth, clamp(coord, vec2i(0), hi), 0);
}
@compute @workgroup_size(8, 8)
fn generate_normals(@builtin(global_invocation_id) id: vec3u) {
  let pixel = id.xy;
  if (any(pixel >= textureDimensions(normal_output))) { return; }
  let pos = vec2i(pixel);
  if (xe_raw(pos) <= 0.0) {
    textureStore(normal_output, pos, vec4u(xe_pack_normal(vec3f(0.0, 0.0, -1.0))));
    return;
  }
  let z = xe_view_depth(xe_raw(pos));
  let zl = xe_view_depth(xe_raw(pos + vec2i(-1, 0)));
  let zr = xe_view_depth(xe_raw(pos + vec2i(1, 0)));
  let zt = xe_view_depth(xe_raw(pos + vec2i(0, -1)));
  let zb = xe_view_depth(xe_raw(pos + vec2i(0, 1)));
  let edges = xe_edges(z, zl, zr, zt, zb);
  let uv = (vec2f(pixel) + vec2f(0.5)) * xe.viewport.zw;
  let c = xe_view_position(uv, z);
  let l = xe_view_position(uv + vec2f(-xe.viewport.z, 0.0), zl);
  let r = xe_view_position(uv + vec2f(xe.viewport.z, 0.0), zr);
  let t = xe_view_position(uv + vec2f(0.0, -xe.viewport.w), zt);
  let b = xe_view_position(uv + vec2f(0.0, xe.viewport.w), zb);
  textureStore(normal_output, pos, vec4u(xe_pack_normal(xe_normal(c, l, r, t, b, edges))));
}
`;

const PREFILTER_COMMON = /* wgsl */ `
${XE_GTAO_PREP_UNIFORM_WGSL}
@group(0) @binding(1) var raw_depth: texture_depth_2d;
@group(0) @binding(2) var out_mip0: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var out_mip1: texture_storage_2d<r32float, write>;
fn xe_raw_clamped(coord: vec2i) -> f32 {
  let hi = vec2i(textureDimensions(raw_depth)) - vec2i(1);
  return textureLoad(raw_depth, clamp(coord, vec2i(0), hi), 0);
}
fn xe_store0(coord: vec2u, value: f32) {
  if (all(coord < textureDimensions(out_mip0))) {
    textureStore(out_mip0, vec2i(coord), vec4f(value, 0.0, 0.0, 0.0));
  }
}
var<workgroup> xe_scratch: array<f32, 64>;
`;

const PREFILTER_BODY = /* wgsl */ `
  let base = id.xy;
  let pixel = base * 2u;
  let d0 = xe_view_depth(xe_raw_clamped(vec2i(pixel)));
  let d1 = xe_view_depth(xe_raw_clamped(vec2i(pixel + vec2u(1u, 0u))));
  let d2 = xe_view_depth(xe_raw_clamped(vec2i(pixel + vec2u(0u, 1u))));
  let d3 = xe_view_depth(xe_raw_clamped(vec2i(pixel + vec2u(1u, 1u))));
  xe_store0(pixel, d0);
  xe_store0(pixel + vec2u(1u, 0u), d1);
  xe_store0(pixel + vec2u(0u, 1u), d2);
  xe_store0(pixel + vec2u(1u, 1u), d3);
  let dm1 = xe_depth_mip_filter(vec4f(d0, d1, d2, d3));
  if (all(base < textureDimensions(out_mip1))) {
    textureStore(out_mip1, vec2i(base), vec4f(dm1, 0.0, 0.0, 0.0));
  }
  let index = local.y * 8u + local.x;
  xe_scratch[index] = dm1;
  workgroupBarrier();
`;

export const XE_GTAO_PREFILTER_2_WGSL = /* wgsl */ `
${PREFILTER_COMMON}
@compute @workgroup_size(8, 8)
fn prefilter(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_id) local: vec3u) {
${PREFILTER_BODY}
}
`;

export const XE_GTAO_PREFILTER_4_WGSL = /* wgsl */ `
${PREFILTER_COMMON}
@group(0) @binding(4) var out_mip2: texture_storage_2d<r32float, write>;
@group(0) @binding(5) var out_mip3: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn prefilter(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_id) local: vec3u) {
${PREFILTER_BODY}
  if (all((local.xy & vec2u(1u)) == vec2u(0u))) {
    let dm2 = xe_depth_mip_filter(vec4f(xe_scratch[index],
      xe_scratch[index + 1u], xe_scratch[index + 8u], xe_scratch[index + 9u]));
    if (all(base / 2u < textureDimensions(out_mip2))) {
      textureStore(out_mip2, vec2i(base / 2u), vec4f(dm2, 0.0, 0.0, 0.0));
    }
    xe_scratch[index] = dm2;
  }
  workgroupBarrier();
  if (all((local.xy & vec2u(3u)) == vec2u(0u))) {
    let dm3 = xe_depth_mip_filter(vec4f(xe_scratch[index],
      xe_scratch[index + 2u], xe_scratch[index + 16u], xe_scratch[index + 18u]));
    if (all(base / 4u < textureDimensions(out_mip3))) {
      textureStore(out_mip3, vec2i(base / 4u), vec4f(dm3, 0.0, 0.0, 0.0));
    }
  }
}
`;

/** The same XeGTAO_DepthMIPFilter for mips produced in another dispatch. */
export const XE_GTAO_PREFILTER_REDUCE_WGSL = /* wgsl */ `
${XE_GTAO_PREP_UNIFORM_WGSL}
@group(0) @binding(1) var source_mip: texture_2d<f32>;
@group(0) @binding(2) var output_mip: texture_storage_2d<r32float, write>;
fn xe_source(coord: vec2i) -> f32 {
  let hi = vec2i(textureDimensions(source_mip, 0)) - vec2i(1);
  return textureLoad(source_mip, clamp(coord, vec2i(0), hi), 0).x;
}
@compute @workgroup_size(8, 8)
fn reduce_mip(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(output_mip))) { return; }
  let base = vec2i(id.xy * 2u);
  let value = xe_depth_mip_filter(vec4f(xe_source(base),
    xe_source(base + vec2i(1, 0)), xe_source(base + vec2i(0, 1)),
    xe_source(base + vec2i(1, 1))));
  textureStore(output_mip, vec2i(id.xy), vec4f(value, 0.0, 0.0, 0.0));
}
`;
