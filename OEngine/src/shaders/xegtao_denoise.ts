/**
 * Scalar XeGTAO_Denoise / XeGTAO_Output port, GameTechDev/XeGTAO
 * a5b1686c7ea37788eeb3576b5be47f7c03db532c (MIT).
 * Point loads replace the HLSL gathers; each pixel retains the same center,
 * four cardinal and four diagonal samples and edge weights. 8x8 compute,
 * sampled r8 inputs and write-only r8 output, no atomics or workgroup state.
 */
import { XE_GTAO_OCCLUSION_TERM_SCALE, XE_GTAO_PREP_UNIFORM_WGSL
} from "../render/ao/XeGtaoPreparationAbi.js";

export function xeGtaoDenoiseWgsl(finalApply: boolean, beta: number): string {
  if (!Number.isFinite(beta) || beta <= 0) throw new RangeError("XeGTAO denoise beta must be positive");
  return /* wgsl */ `
${XE_GTAO_PREP_UNIFORM_WGSL}
const XE_BLUR_AMOUNT: f32 = ${finalApply ? beta : beta / 5};
const XE_FINAL_SCALE: f32 = ${finalApply ? XE_GTAO_OCCLUSION_TERM_SCALE : 1};
@group(0) @binding(1) var source_ao: texture_2d<f32>;
@group(0) @binding(2) var source_edges: texture_2d<f32>;
@group(0) @binding(3) var output_ao: texture_storage_2d<r8unorm, write>;

fn xe_clamp_coord(coord: vec2i) -> vec2i {
  return clamp(coord, vec2i(0), vec2i(xe.viewport.xy) - vec2i(1));
}
fn xe_byte(value: f32) -> u32 {
  return u32(round(clamp(value, 0.0, 1.0) * 255.0));
}
fn xe_ao_at(coord: vec2i) -> f32 {
  return f32(xe_byte(textureLoad(source_ao, xe_clamp_coord(coord), 0).x)) / 255.0;
}
fn xe_edges_at(coord: vec2i) -> vec4f {
  let packed = xe_byte(textureLoad(source_edges, xe_clamp_coord(coord), 0).x);
  return vec4f(f32((packed >> 6u) & 3u), f32((packed >> 4u) & 3u),
    f32((packed >> 2u) & 3u), f32(packed & 3u)) / 3.0;
}
@compute @workgroup_size(8, 8)
fn denoise(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(xe.viewport.xy))) { return; }
  let p = vec2i(id.xy);
  let left = p + vec2i(-1, 0);
  let right = p + vec2i(1, 0);
  let top = p + vec2i(0, -1);
  let bottom = p + vec2i(0, 1);
  let edges_l = xe_edges_at(left);
  let edges_r = xe_edges_at(right);
  let edges_t = xe_edges_at(top);
  let edges_b = xe_edges_at(bottom);
  // The donor enforces symmetric cardinal edges, then allows a small leak
  // only at pixels with three or four blocked sides.
  var edges = xe_edges_at(p) * vec4f(edges_l.y, edges_r.x, edges_t.w, edges_b.z);
  let edginess = clamp((1.5 - dot(edges, vec4f(1.0))) / 1.5, 0.0, 1.0) * 0.5;
  edges = clamp(edges + vec4f(edginess), vec4f(0.0), vec4f(1.0));
  let diagonal = 0.85 * 0.5;
  let weight_tl = diagonal * (edges.x * edges_l.z + edges.z * edges_t.x);
  let weight_tr = diagonal * (edges.z * edges_t.y + edges.y * edges_r.z);
  let weight_bl = diagonal * (edges.w * edges_b.x + edges.x * edges_l.w);
  let weight_br = diagonal * (edges.y * edges_r.w + edges.w * edges_b.y);
  let weights = vec4f(edges.x, edges.y, edges.z, edges.w);
  let diagonals = vec4f(weight_tl, weight_tr, weight_bl, weight_br);
  let sum_weight = XE_BLUR_AMOUNT + dot(weights, vec4f(1.0)) + dot(diagonals, vec4f(1.0));
  let sum = xe_ao_at(p) * XE_BLUR_AMOUNT +
    dot(weights, vec4f(xe_ao_at(left), xe_ao_at(right), xe_ao_at(top), xe_ao_at(bottom))) +
    dot(diagonals, vec4f(xe_ao_at(top + vec2i(-1, 0)),
      xe_ao_at(top + vec2i(1, 0)), xe_ao_at(bottom + vec2i(-1, 0)),
      xe_ao_at(bottom + vec2i(1, 0))));
  // XeGTAO_Output quantizes after filtering, not before the final 1.5 scale.
  let result = floor(clamp(sum / sum_weight * XE_FINAL_SCALE, 0.0, 1.0) * 255.0 + 0.5) / 255.0;
  textureStore(output_ao, p, vec4f(result, 0.0, 0.0, 0.0));
}
`;
}

/** Four consecutive raster pixels per word, including words spanning rows. */
export const XE_GTAO_PACK_WGSL = /* wgsl */ `
${XE_GTAO_PREP_UNIFORM_WGSL}
@group(0) @binding(1) var final_ao: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> packed_ao: array<u32>;
@compute @workgroup_size(64)
fn pack(@builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_index) lane: u32,
  @builtin(num_workgroups) groups: vec3u) {
  let width = u32(xe.viewport.x);
  let pixels = width * u32(xe.viewport.y);
  let word = (group.y * groups.x + group.x) * 64u + lane;
  if (word >= (pixels + 3u) / 4u) { return; }
  var bits = 0u;
  for (var byte = 0u; byte < 4u; byte++) {
    let index = word * 4u + byte;
    var visibility = 255u;
    if (index < pixels) {
      let value = textureLoad(final_ao,
        vec2i(i32(index % width), i32(index / width)), 0).x;
      visibility = u32(round(clamp(value, 0.0, 1.0) * 255.0));
    }
    bits |= visibility << (byte * 8u);
  }
  packed_ao[word] = bits;
}
`;
