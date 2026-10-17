import type { planScgiGather } from "../render/gi/ScgiGatherLayout.js";

/** Source preparation is produced by Native's actual material invocation.
 * This stage only joins its compact result with immutable anchor geometry. */
export function scgiGatherPreparationWgsl(plan: ReturnType<typeof planScgiGather>): string {
  return /* wgsl */ `
struct Parameters {
  extent: vec4u,
  segment: vec4u,
}
struct Anchor {
  positionValid: vec4f,
  normal: vec3f,
  sourcePixel: u32,
  previous: vec4f,
  motion: vec4f,
  identity: array<u32, 16>,
}
@group(0) @binding(0) var<uniform> settings: Parameters;
@group(0) @binding(1) var<storage, read> work: array<u32>;
@group(0) @binding(2) var<storage, read> anchors: array<Anchor>;
@group(0) @binding(3) var<storage, read_write> hits: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let ticket = settings.segment.z + id.x;
  if (id.x >= ${plan.batch}u || ticket >= work[0u] || work[2u] != 0u) { return; }
  let index = work[${plan.work.ids}u + ticket];
  if (index < settings.segment.x || index - settings.segment.x >= settings.segment.y) { return; }
  let anchor = anchors[index - settings.segment.x];
  let at = ${plan.work.preparation}u + ticket * 12u;
  let diffuse = bitcast<vec4f>(vec4u(work[at], work[at + 1u], work[at + 2u], work[at + 3u]));
  let normal = bitcast<vec4f>(vec4u(work[at + 8u], work[at + 9u], work[at + 10u], work[at + 11u]));
  hits[id.x * 6u] = diffuse;
  hits[id.x * 6u + 1u] = vec4f(0.0, 0.0, 0.0, 1.0);
  hits[id.x * 6u + 2u] = normal;
  // Flags travel with the Native preparation, never inferred from lineage.
  hits[id.x * 6u + 3u] = vec4f(anchor.positionValid.xyz, diffuse.w);
  hits[id.x * 6u + 4u] = bitcast<vec4f>(vec4u(index, 0u, 0u, 0u));
  let error = max(0.00001, 32.0 * 1.1920928955078125e-7 * max(1.0, length(anchor.positionValid.xyz)));
  hits[id.x * 6u + 5u] = vec4f(anchor.normal, error);
}
`;
}

/** Only the owning window writes a preparation. Halo rows are read-only inputs;
 * exact sourcePixel rejects their duplicate appearances in adjacent windows. */
export function scgiGatherDrainWgsl(plan: ReturnType<typeof planScgiGather>): string {
  return /* wgsl */ `
struct Ranges {
  local_vsm: vec4u,
  segments: vec4u,
  gi: vec4u,
  window: vec4u,
  extent_debug: vec4u,
  remap: vec4u,
  residual: vec4u,
  source: vec4u,
}
@group(0) @binding(0) var<uniform> ranges: Ranges;
@group(0) @binding(1) var<storage, read> directory: array<u32>;
@group(0) @binding(2) var<storage, read_write> work: array<atomic<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (ranges.source.w == 0u || id.x >= ranges.source.z) { return; }
  let request = directory[ranges.source.x + id.x * 2u];
  if (request == 0u || request > ${plan.work.capacity}u) { return; }
  let pixel_id = directory[ranges.source.x + id.x * 2u + 1u] - 1u;
  let pixel = vec2u(pixel_id % ranges.extent_debug.x, pixel_id / ranges.extent_debug.x);
  let origin = ranges.window.xw;
  if (any(pixel < origin) || any(pixel - origin >= ranges.window.yz)) { return; }
  let src = ranges.source.y + id.x * 12u;
  let dst = ${plan.work.preparation}u + (request - 1u) * 12u;
  for (var word = 0u; word < 12u; word++) { atomicStore(&work[dst + word], directory[src + word]); }
  atomicAdd(&work[3u], u32(directory[src + 7u] == bitcast<u32>(1.0)));
}
`;
}
