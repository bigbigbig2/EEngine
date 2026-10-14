import { SSSR_RECEIVER_WGSL } from "../render/reflections/SssrAbi.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "./working_color.js";

// FidelityFX SDK c6efa6bf7f2027b3ec94f28578bb5965eabb9e55, MIT.
// Full notices and source/asset manifest: render/assets/sssr.
// Keep the permission notice INSIDE generated shader strings so production
// bundling cannot strip it with ordinary TypeScript comments.
export const SSSR_LICENSE_WGSL = /* wgsl */ `
// Copyright (C) 2024 Advanced Micro Devices, Inc.
// Copyright (c) 2015 Playdead (ClipAABB).
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
`;
export const SSSR_FRAME_WGSL = /* wgsl */ `
${SSSR_LICENSE_WGSL}
struct SssrFrame {
  dimensions: vec4u, // width, height, last depth mip, lobe
  settings: vec4f, // alpha threshold, world thickness, stability, strength
  state: vec4u, // submitted phase, samples/quad, history valid, diagnostic mode
  capacity: vec4u, // tiles X, max groups/axis, traversal limit, diagnostic lobe
  physical: vec4f, // metres per world unit; source depth sigma assumes metres
  inv_projection: mat4x4f,
  projection: mat4x4f,
  view: mat4x4f,
  inv_view: mat4x4f,
  inv_view_projection: mat4x4f,
  previous_view_projection: mat4x4f,
  previous_inv_projection: mat4x4f,
}
`;

export const SSSR_COLOR_WGSL = /* wgsl */ `
${LINEAR_REC709_TO_REC2020_WGSL}
fn sssr_to709(c: vec3f) -> vec3f {
  return mat3x3f(
    vec3f(1.660490394, -0.124549970, -0.018151119),
    vec3f(-0.587639093, 1.132899880, -0.100578725),
    vec3f(-0.072851598, -0.008347965, 1.118729830)) * c;
}
fn sssr_to2020(c: vec3f) -> vec3f {
  return oengine_linear_rec709_to_rec2020(c);
}
`;

export const SSSR_COMMON_WGSL = /* wgsl */ `
${SSSR_FRAME_WGSL}
@group(0) @binding(0) var<uniform> frame: SssrFrame;
@group(0) @binding(1) var<storage, read> receivers: array<u32>;
@group(0) @binding(2) var depth_hierarchy: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> current_exposure: array<f32>;
@group(0) @binding(4) var<storage, read> previous_exposure: array<f32>;
${SSSR_RECEIVER_WGSL}
${SSSR_COLOR_WGSL}

fn sssr_finite3(value: vec3f) -> bool {
  return all(abs(value) <= vec3f(3.402823466e38));
}
fn sssr_inside(uv: vec2f) -> bool {
  return all(uv > vec2f(0.0)) && all(uv < vec2f(1.0));
}
fn sssr_valid_pixel(pixel: vec2u) -> bool {
  return all(pixel < frame.dimensions.xy);
}
fn sssr_clamp(pixel: vec2i) -> vec2i {
  return clamp(pixel, vec2i(0), vec2i(frame.dimensions.xy) - vec2i(1));
}
fn sssr_index(pixel: vec2u) -> u32 {
  return pixel.y * frame.dimensions.x + pixel.x;
}
fn sssr_normalize(value: vec3f) -> vec3f {
  return value * inverseSqrt(max(dot(value, value), 1e-20));
}
fn sssr_lobe(receiver: SssrReceiver) -> vec4f {
  return select(receiver.base, receiver.coat, frame.dimensions.w == 1u);
}
fn sssr_eligible(receiver: SssrReceiver) -> bool {
  let flags = u32(receiver.baseline.w);
  return (flags & 1u) != 0u && (flags & (2u << frame.dimensions.w)) != 0u &&
    sssr_lobe(receiver).w < frame.settings.x;
}
// Source ffxRemapForWaveReduction. Low two lane bits are the logical quad;
// workgroup memory, not subgroup operations, implements cross-quad access.
fn sssr_remap(lane: u32) -> vec2u {
  return vec2u((lane & 1u) | ((lane >> 2u) & 6u),
    ((lane >> 1u) & 3u) | ((lane >> 3u) & 4u));
}
fn sssr_lane(pixel: vec2u) -> u32 {
  return (pixel.x & 1u) | ((pixel.y & 3u) << 1u) |
    ((pixel.x & 6u) << 2u) | ((pixel.y & 4u) << 3u);
}
fn sssr_project(position: vec3f, matrix: mat4x4f) -> vec3f {
  let clip = matrix * vec4f(position, 1.0);
  let ndc = clip.xyz / clip.w;
  return vec3f(ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5), ndc.z);
}
fn sssr_unproject(position: vec3f, matrix: mat4x4f) -> vec3f {
  let clip = matrix * vec4f(position.xy * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), position.z, 1.0);
  return clip.xyz / clip.w;
}
fn sssr_linear_depth(uv: vec2f, depth: f32, inverse: mat4x4f) -> f32 {
  return abs(sssr_unproject(vec3f(uv, depth), inverse).z);
}
fn sssr_depth(pixel: vec2i) -> f32 {
  return textureLoad(depth_hierarchy, sssr_clamp(pixel), 0).x;
}
fn sssr_uv(pixel: vec2i) -> vec2f {
  return (vec2f(pixel) + vec2f(0.5)) / vec2f(frame.dimensions.xy);
}
fn sssr_luma(radiance: vec3f) -> f32 {
  return max(dot(radiance / current_exposure[0], vec3f(0.299, 0.587, 0.114)), 0.001);
}
fn sssr_temporal_variance(a: vec3f, b: vec3f) -> f32 {
  let la = sssr_luma(a);
  let lb = sssr_luma(b);
  let difference = abs(la - lb) / max(max(la, lb), 0.5);
  return difference * difference;
}
fn sssr_bilinear_weights(fraction: vec2f) -> vec4f {
  return vec4f((1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y), (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y);
}
`;
