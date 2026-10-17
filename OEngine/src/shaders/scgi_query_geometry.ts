import type { ScgiBvhPlan } from "../render/gi/ScgiBvhLayout.js";
import { SCGI_ABI_WGSL, SCGI_QUERY_CONTINUATION } from "../render/gi/ScgiAbi.js";
import type { NativeMaterialProgram } from "./native_material.js";
import { nativeCoverageEvaluationWgsl } from "./native_visibility.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { nativeDiffuseHitEvaluationWgsl } from "./native_diffuse_hit.js";
import { VIRTUAL_TEXTURE_FEEDBACK_WGSL } from "./virtual_texture.js";
import { GEOMETRY_QUERY_DIRECTORY_CLUSTER_BYTES } from "../gpu/GeometryQueryDirectory.js";

/* Altered WGSL adaptation of RadeonRays
 * c8890b96b1f976bedd2cd280cc170dff5d655e0a,
 * src/core/src/dx/kernels/intersector_common.hlsl: triangle intersection.
 * Slabs use explicit zero-direction handling; traversal uses parent continuation.
 *
 * Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

function scgiCoverageWgsl(program: NativeMaterialProgram | null, diffuse = false, unlit = false): string {
  const expressions: Record<string, string> = {
    uv0: "vec4f(uv0, 0.0, 0.0)",
    uv1: "vec4f(uv1, 0.0, 0.0)",
    uv2: "vec4f(0.0)",
    vertexColor: "color",
    position: "vec4f(position, 1.0)",
    worldPosition: "vec4f(position, 1.0)",
    normal: "vec4f(normal, authored_normal.w)",
    worldNormal: "vec4f(normal, authored_normal.w)",
    tangent: "vec4f(tangent, authored_tangent.w * orientation)",
    worldTangent: "vec4f(tangent, authored_tangent.w * orientation)",
    cameraPosition: "vec4f(coverage_view.camera.xyz, 1.0)",
    viewDirection: "vec4f(query_safe_normal(coverage_view.camera.xyz - position, normal), 0.0)",
    viewPosition: "coverage_view.view * vec4f(position, 1.0)",
    viewNormal: "coverage_view.view * vec4f(normal, 0.0)"
  };
  const inputSource =
    program?.inputs
      .map((input, slot) => {
        const uniform = input.domain === "dynamic" || input.domain === "nonlocal";
        const value = uniform
          ? program.instanceInputs
            ? `vec4f(${[0, 1, 2, 3]
                .map(
                  (channel) =>
                    `native_material_constant(material_base, ${program.constants.length + 2 + slot * 4 + channel}u)`
                )
                .join(", ")})`
            : `coverage_frame_inputs[${slot}u]`
          : expressions[input.name];
        if (value === undefined) {
          throw new RangeError(`Query coverage input '${input.name}' requires a shared geometry semantic`);
        }
        return `inputs[point][${slot}u] = ${value};`;
      })
      .join("\n") ?? "";
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
struct CoverageView { view: mat4x4f, camera: vec4f, cone: vec4f, }
@group(1) @binding(0) var<storage, read> query_source: array<OEngineInstanceRecord>;
@group(1) @binding(1) var<storage, read> coverage_directory: array<vec4u>;
@group(1) @binding(2) var<uniform> coverage_route: vec4u;
${
  program === null
    ? ""
    : /* wgsl */ `
@group(1) @binding(3) var<storage, read> coverage_constants: array<f32>;
@group(1) @binding(4) var<uniform> coverage_view: CoverageView;
@group(1) @binding(5) var<uniform> coverage_frame_inputs: array<vec4f, ${Math.max(1, program.inputCount)}>;
fn native_material_constant(base: u32, slot: u32) -> f32 { return coverage_constants[base + slot]; }
fn query_safe_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let magnitude = max(max(abs(value.x), abs(value.y)), abs(value.z));
  if (magnitude == 0.0) { return fallback; }
  let scaled = value / magnitude;
  return scaled * inverseSqrt(dot(scaled, scaled));
}
${program.source}
${diffuse ? nativeDiffuseHitEvaluationWgsl(program, unlit) : nativeCoverageEvaluationWgsl(program)}
struct QueryMaterialInputs {
  inputs: NativeMaterialInputs,
  basis: mat3x3f,
}
fn query_material_inputs(instance_slot: u32, triangle: QueryTriangle, bary: vec2f, t: f32,
    ray_direction: vec3f) -> QueryMaterialInputs {
  let source = query_source[instance_slot];
  let material_base = coverage_directory[source.material_handle].x;
  let instance = instances[instance_slot];
  let weights = vec3f(1.0 - bary.x - bary.y, bary.x, bary.y);
  // query_triangle established the shared Product decoder's invocation state.
  let v0 = frame_triangle_corner(triangle.primitive, 0u);
  let v1 = frame_triangle_corner(triangle.primitive, 1u);
  let v2 = frame_triangle_corner(triangle.primitive, 2u);
  let p0 = affine_point(instance.objectToWorld, triangle.p0, 1.0);
  let p1 = affine_point(instance.objectToWorld, triangle.p1, 1.0);
  let p2 = affine_point(instance.objectToWorld, triangle.p2, 1.0);
  let e1 = p1 - p0;
  let e2 = p2 - p0;
  let geometric = normalize(cross(e1, e2));
  let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(geometric.z) < 0.9);
  let axis_x = normalize(cross(helper, geometric));
  let axis_y = cross(geometric, axis_x);
  let radius = max(0.0, coverage_view.cone.x + abs(t) * length(ray_direction) * coverage_view.cone.y);
  let a = dot(e1, e1);
  let b = dot(e1, e2);
  let c = dot(e2, e2);
  let determinant = a * c - b * b;
  var inputs: array<array<vec4f, ${Math.max(1, program.inputCount)}>, 3>;
  var basis: mat3x3f;
  let model = oengine_instance_current_object_to_world(source);
  let orientation = sign(dot(model[0].xyz, cross(model[1].xyz, model[2].xyz)));
  let inverse = instance.worldToObject;
  let normal_matrix = transpose(mat3x3f(vec3f(inverse[0], inverse[1], inverse[2]),
    vec3f(inverse[4], inverse[5], inverse[6]), vec3f(inverse[8], inverse[9], inverse[10])));
  for (var point = 0u; point < 3u; point++) {
    var displacement = vec3f(0.0);
    if (point == 1u) { displacement = axis_x * radius; }
    if (point == 2u) { displacement = axis_y * radius; }
    var w = weights;
    if (determinant > 0.0) {
      let d = dot(displacement, e1);
      let e = dot(displacement, e2);
      let du = (d * c - e * b) / determinant;
      let dv = (e * a - d * b) / determinant;
      w += vec3f(-du - dv, du, dv);
    }
    let position = p0 * w.x + p1 * w.y + p2 * w.z;
    let uv0 = frame_vertex_uv(v0, 0u) * w.x + frame_vertex_uv(v1, 0u) * w.y + frame_vertex_uv(v2, 0u) * w.z;
    let uv1 = frame_vertex_uv(v0, 1u) * w.x + frame_vertex_uv(v1, 1u) * w.y + frame_vertex_uv(v2, 1u) * w.z;
    let color = frame_vertex_color(v0) * w.x + frame_vertex_color(v1) * w.y + frame_vertex_color(v2) * w.z;
    let authored_normal = frame_vertex_normal(v0) * w.x + frame_vertex_normal(v1) * w.y + frame_vertex_normal(v2) * w.z;
    let authored_tangent = frame_vertex_tangent(v0) * w.x + frame_vertex_tangent(v1) * w.y + frame_vertex_tangent(v2) * w.z;
    let unflipped = query_safe_normal(normal_matrix * authored_normal.xyz, geometric);
    // Authored graph semantics match native visibility: double-sided normal
    // inputs face the actual camera, independently of transport direction.
    let flip = (source.flags & 16u) != 0u &&
      dot(unflipped, coverage_view.camera.xyz - position) < 0.0;
    let normal = select(unflipped, -unflipped, flip);
    let raw_tangent = (model * vec4f(authored_tangent.xyz, 0.0)).xyz;
    let tangent_fallback = query_safe_normal(cross(select(vec3f(0.0, 0.0, 1.0),
      vec3f(0.0, 1.0, 0.0), abs(unflipped.z) > 0.99), unflipped), vec3f(1.0, 0.0, 0.0));
    let unflipped_tangent = query_safe_normal(raw_tangent - unflipped * dot(unflipped, raw_tangent),
      tangent_fallback);
    let tangent = select(unflipped_tangent, -unflipped_tangent, flip);
    if (point == 0u) {
      basis = mat3x3f(tangent, cross(normal, tangent) * authored_tangent.w * orientation, normal);
    }
    ${inputSource}
  }
  return QueryMaterialInputs(NativeMaterialInputs(inputs[0], inputs[1], inputs[2]), basis);
}
${
  diffuse
    ? ""
    : /* wgsl */ `
fn query_coverage_hit(instance_slot: u32, triangle: QueryTriangle, bary: vec2f, t: f32,
    ray_origin: vec3f, ray_direction: vec3f, ray_word: u32) -> bool {
  let source = query_source[instance_slot];
  let material_base = coverage_directory[source.material_handle].x;
  let evaluated = query_material_inputs(instance_slot, triangle, bary, t, ray_direction);
  return native_coverage_alpha(material_base, evaluated.inputs) >= native_coverage_cutoff(material_base);
}`
}`
}
fn query_coverage_instance(slot: u32) -> u32 {
  if (slot >= arrayLength(&query_source)) { return 2u; }
  let material = query_source[slot].material_handle;
  if (material >= arrayLength(&coverage_directory)) { return 2u; }
  let entry = coverage_directory[material];
  if (entry.w == 0u) { return 2u; }
  return select(0u, 1u, entry.y == coverage_route.x);
}
`;
}
import { frameGeometrySourceWgsl, FRAME_ATTRIBUTE_OCT_DECODE_WGSL } from "./geometry_source_decode.js";

/** Query geometry uses exactly the resident Product decoder used by raster.
 * The only additional persistent data is a triangle prefix over the exact cut.
 * No vertex/index/UV payload or camera-visible meshlet queue is materialized. */
export function scgiQueryGeometryWgsl(
  plan: ScgiBvhPlan,
  tlasPlan = plan,
  coverage?: NativeMaterialProgram | null,
  diffuse = false,
  unlit = false,
  coveredScene = false,
  hitListWord?: number,
  wavefront?: "candidate" | "coverage" | "tail",
  pendingWork = false,
  nodeQuantum = 256
): string {
  const cursor = SCGI_QUERY_CONTINUATION.candidate;
  const tail = SCGI_QUERY_CONTINUATION.tail;
  const coverageSource = coverage === undefined ? "" : scgiCoverageWgsl(coverage, diffuse, unlit);
  return /* wgsl */ `
${FRAME_ATTRIBUTE_OCT_DECODE_WGSL}
${frameGeometrySourceWgsl(true, true, true)}
${SCGI_ABI_WGSL}
${coverageSource}
${diffuse && coverage?.virtualTextures ? VIRTUAL_TEXTURE_FEEDBACK_WGSL : ""}
${diffuse ? "@group(2) @binding(0) var<storage, read_write> diffuse_hits: array<vec4f>;" : ""}
${hitListWord === undefined ? "" : "@group(2) @binding(2) var<storage, read> hit_work: array<u32>;"}
${wavefront === undefined ? "" : "@group(2) @binding(3) var<storage, read_write> continuation: array<u32>;"}
struct GeometrySettings {
  query_word: u32,
  prefix_word: u32,
  asset: u32,
  generation: u32,
  primitive_begin: u32,
  primitive_count: u32,
  cut_begin: u32,
  cut_count: u32,
  product_slot: u32,
  asset_reference: u32,
  instance_first: u32,
  instance_count: u32,
}
@group(0) @binding(0) var<uniform> geometry: GeometrySettings;
@group(0) @binding(1) var<storage, read_write> scratch: array<u32>;
@group(0) @binding(2) var<storage, read> blas: array<u32>;
@group(0) @binding(3) var<storage, read> tlas: array<u32>;
@group(0) @binding(4) var<storage, read> instances: array<ScgiInstance>;
@group(0) @binding(5) var<storage, read_write> batch: array<u32>;
struct TraceSettings { ray_count: u32, ray_word: u32, result_word: u32, query_kind: u32, }
@group(0) @binding(6) var<uniform> trace: TraceSettings;
${coveredScene ? "@group(0) @binding(7) var<storage, read> scene_coverage: array<u32>;" : ""}
const BOUNDS: u32 = ${plan.scratch.ranges.primitiveBounds!.offset / 4}u;
const CONTROL: u32 = ${plan.scratch.ranges.control!.offset / 4}u;
struct QueryTriangle {
  valid: bool,
  cluster: u32,
  primitive: u32,
  source_primitive: u32,
  p0: vec3f,
  p1: vec3f,
  p2: vec3f,
}
fn query_triangle(index: u32) -> QueryTriangle {
  var result: QueryTriangle;
  if (index >= geometry.primitive_count || geometry.cut_count == 0u) { return result; }
  let target_primitive = geometry.primitive_begin + index;
  var low = geometry.cut_begin;
  var high = low + geometry.cut_count;
  loop {
    if (low + 1u >= high) { break; }
    let middle = low + (high - low) / 2u;
    if (product_heap[geometry.prefix_word + middle] <= target_primitive) { low = middle; }
    else { high = middle; }
  }
  let at = geometry.query_word + low * ${GEOMETRY_QUERY_DIRECTORY_CLUSTER_BYTES / 4}u;
  let cluster = product_heap[at + 15u];
  let bank = product_heap[at + 20u];
  let group_byte = product_heap[at + 21u];
  let payload = product_heap[at + 22u];
  let local_meshlet = product_heap[at + 2u];
  if (bank >= 4u || product_heap[at + 23u] != geometry.generation ||
      product_heap[at + 7u] != geometry.asset || payload < 64u) { return result; }
  // The segment supplies an immutable physical address; header validation,
  // vertex format and attribute decode remain owned by the raster decoder.
  let location = OEngineGeometryPageLookupV1(true, bank, group_byte, 0u, payload);
  let group = OEngineVirtualGroupV1(true, product_heap[at], 0u, payload, 0u);
  let format = product_heap[at + 5u];
  let counts = frame_vertex_load_resident(location, group, local_meshlet,
    at + 24u, format + 1u, format);
  let stride = source_format0 & 0xffffu;
  let primitive = target_primitive - product_heap[geometry.prefix_word + low];
  if (counts.x == 0u || counts.x > 128u || primitive >= counts.y ||
      counts.y != product_heap[at + 3u] || stride == 0u ||
      (source_resident_address & 0x3fffffffu) < group_byte ||
      (source_resident_address & 0x3fffffffu) - group_byte > payload ||
      counts.x > (payload - ((source_resident_address & 0x3fffffffu) - group_byte)) / stride) {
    return result;
  }
  let v0 = frame_triangle_corner(primitive, 0u);
  let v1 = frame_triangle_corner(primitive, 1u);
  let v2 = frame_triangle_corner(primitive, 2u);
  if (max(max(v0, v1), v2) >= counts.x) { return result; }
  result.valid = true;
  result.cluster = cluster;
  result.primitive = primitive;
  result.source_primitive = product_heap[product_heap[at + 18u] + primitive];
  result.p0 = frame_vertex_position(v0);
  result.p1 = frame_vertex_position(v1);
  result.p2 = frame_vertex_position(v2);
  return result;
}
@compute @workgroup_size(128)
fn bounds(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= geometry.primitive_count) { return; }
  let triangle = query_triangle(id.x);
  var low = min(min(triangle.p0, triangle.p1), triangle.p2);
  var high = max(max(triangle.p0, triangle.p1), triangle.p2);
  if (!triangle.valid) {
    // The build's ordered-bounds validation publishes a hierarchy fault. Unknown
    // geometry must never become an empty primitive or a physical ray miss.
    low = vec3f(1.0);
    high = vec3f(-1.0);
  }
  let at = BOUNDS + id.x * 8u;
  for (var axis = 0u; axis < 3u; axis++) {
    scratch[at + axis] = bitcast<u32>(low[axis]);
    scratch[at + 4u + axis] = bitcast<u32>(high[axis]);
  }
  scratch[at + 3u] = id.x;
  scratch[at + 7u] = triangle.primitive;
}

// Moller-Trumbore follows RadeonRays intersector_common.hlsl at the fixed
// revision in scgi_bvh_build.ts. Parallel and nonfinite cases are explicit;
// the donor's 1e-5 direction replacement is deliberately not used for slabs.
struct TriangleHit { accepted: bool, t: f32, bary: vec2f, front: u32, }
fn triangle_hit(origin: vec3f, direction: vec3f, triangle: QueryTriangle,
    t_min: f32, t_max: f32) -> TriangleHit {
  var result: TriangleHit;
  let e1 = triangle.p1 - triangle.p0;
  let e2 = triangle.p2 - triangle.p0;
  let p = cross(direction, e2);
  let determinant = dot(e1, p);
  if (determinant == 0.0) { return result; }
  let d = origin - triangle.p0;
  let q = cross(d, e1);
  let u = dot(d, p) / determinant;
  let v = dot(direction, q) / determinant;
  let t = dot(e2, q) / determinant;
  if (!(u >= 0.0 && v >= 0.0 && u + v <= 1.0 && t >= t_min && t <= t_max)) { return result; }
  result = TriangleHit(true, t, vec2f(u, v), select(0u, 1u, determinant > 0.0));
  return result;
}
fn box_hit(origin: vec3f, direction: vec3f, low: vec3f, high: vec3f,
    t_min: f32, t_max: f32) -> bool {
  var near = t_min;
  var far = t_max;
  for (var axis = 0u; axis < 3u; axis++) {
    if (direction[axis] == 0.0) {
      if (origin[axis] < low[axis] || origin[axis] > high[axis]) { return false; }
    } else {
      let a = (low[axis] - origin[axis]) / direction[axis];
      let b = (high[axis] - origin[axis]) / direction[axis];
      near = max(near, min(a, b));
      far = min(far, max(a, b));
      if (near > far) { return false; }
    }
  }
  return near <= far;
}
fn box_near(origin: vec3f, direction: vec3f, low: vec3f, high: vec3f, t_min: f32) -> f32 {
  var near = t_min;
  for (var axis = 0u; axis < 3u; axis++) {
    if (direction[axis] != 0.0) {
      near = max(near, min((low[axis] - origin[axis]) / direction[axis],
        (high[axis] - origin[axis]) / direction[axis]));
    }
  }
  return near;
}
fn as_word(top: bool, at: u32) -> u32 {
  if (top) { return tlas[at]; }
  return blas[at];
}
fn as_float(top: bool, at: u32) -> f32 { return bitcast<f32>(as_word(top, at)); }
fn as_bounds(top: bool, node: u32) -> mat2x3f {
  let at = select(${plan.hierarchy.ranges.nodes!.offset / 4}u,
    ${tlasPlan.hierarchy.ranges.nodes!.offset / 4}u, top) + node * 16u;
  let low = min(vec3f(as_float(top, at), as_float(top, at + 1u), as_float(top, at + 2u)),
    vec3f(as_float(top, at + 8u), as_float(top, at + 9u), as_float(top, at + 10u)));
  let high = max(vec3f(as_float(top, at + 4u), as_float(top, at + 5u), as_float(top, at + 6u)),
    vec3f(as_float(top, at + 12u), as_float(top, at + 13u), as_float(top, at + 14u)));
  return mat2x3f(low, high);
}
fn affine_point(values: array<f32, 12>, point: vec3f, w: f32) -> vec3f {
  return vec3f(values[0], values[1], values[2]) * point.x +
    vec3f(values[4], values[5], values[6]) * point.y +
    vec3f(values[8], values[9], values[10]) * point.z + vec3f(values[3], values[7], values[11]) * w;
}
@compute @workgroup_size(64)
fn trace_opaque(@builtin(global_invocation_id) id: vec3u) {
  ${
    pendingWork
      ? `if (id.x >= hit_work[0]) { return; }
  let ray_index = hit_work[${hitListWord}u + hit_work[1] + id.x];`
      : "let ray_index = id.x;"
  }
  if (ray_index >= trace.ray_count) { return; }
  let ray = trace.ray_word + ray_index * 12u;
  let result = trace.result_word + ray_index * 8u;
  ${
    wavefront === undefined
      ? ""
      : `let resume = ray_index * ${SCGI_QUERY_CONTINUATION.words}u;
  if (continuation[resume] ${wavefront === "tail" ? `== ${tail.done}u` : "!= 0u"}) { return; }`
  }
  ${
    coveredScene
      ? `if (scene_coverage[0] != 0u) {
    batch[result + 3u] = 2u;
    ${wavefront === "tail" ? "continuation[resume] = 2u;" : ""}
    return;
  }`
      : ""
  }
  let world_origin = vec3f(bitcast<f32>(batch[ray]), bitcast<f32>(batch[ray + 1u]), bitcast<f32>(batch[ray + 2u]));
  let t_min = bitcast<f32>(batch[ray + 3u]);
  let world_direction = vec3f(bitcast<f32>(batch[ray + 4u]), bitcast<f32>(batch[ray + 5u]), bitcast<f32>(batch[ray + 6u]));
  let input_max = bitcast<f32>(batch[ray + 7u]);
  let invalid_max = (bitcast<u32>(input_max) & 0x7f800000u) == 0x7f800000u &&
    bitcast<u32>(input_max) != 0x7f800000u;
  if ((bitcast<u32>(t_min) & 0x7f800000u) == 0x7f800000u || invalid_max || t_min > input_max ||
      any((bitcast<vec3u>(world_origin) & vec3u(0x7f800000u)) == vec3u(0x7f800000u)) ||
      any((bitcast<vec3u>(world_direction) & vec3u(0x7f800000u)) == vec3u(0x7f800000u)) ||
      all(world_direction == vec3f(0.0))) {
    batch[result + 3u] = 5u;
    ${wavefront === "tail" ? "continuation[resume] = 2u;" : ""}
    return;
  }
  ${
    coveredScene
      ? `// A domain certificate only covers finite ray segments entirely inside
  // its conservative cascade+guard envelope. Never clip and call the rest sky.
  if (scene_coverage[7] != 0u) {
    let domain_low = bitcast<vec3f>(vec3u(scene_coverage[4], scene_coverage[5], scene_coverage[6]));
    let domain_high = bitcast<vec3f>(vec3u(scene_coverage[8], scene_coverage[9], scene_coverage[10]));
    let t_max = bitcast<f32>(batch[ray + 7u]);
    let start = world_origin + world_direction * t_min;
    let end = world_origin + world_direction * t_max;
    let finite = all((bitcast<vec3u>(start) & vec3u(0x7f800000u)) != vec3u(0x7f800000u)) &&
      all((bitcast<vec3u>(end) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
    if (!finite || !(t_min <= t_max) || any(start < domain_low) || any(start > domain_high) ||
        any(end < domain_low) || any(end > domain_high)) {
      batch[result + 3u] = 2u;
      ${wavefront === "tail" ? "continuation[resume] = 2u;" : ""}
      return;
    }
  }`
      : ""
  }
  let merge = (trace.query_kind & 2u) != 0u${wavefront === "tail" ? " || continuation[resume] == 1u" : ""};
  var best = select(bitcast<f32>(batch[ray + 7u]), bitcast<f32>(batch[result]), merge);
  var status = select(1u, batch[result + 3u], merge);
  var best_instance = 0xffffffffu;
  var best_primitive = 0xffffffffu;
  var best_bary = vec2f(0.0);
  var best_front = 0u;
  var best_generation = 0u;
  if (merge) {
    best_instance = batch[result + 4u];
    best_primitive = batch[result + 5u];
    best_bary = vec2f(bitcast<f32>(batch[result + 1u]), bitcast<f32>(batch[result + 2u]));
    best_front = batch[result + 7u];
    best_generation = batch[result + 6u];
    if (status > 1u || ((trace.query_kind & 1u) != 0u && status == 0u)) {
      ${wavefront === "tail" ? "continuation[resume] = 2u;" : ""}
      return;
    }
  }
  var node = tlas[1];
  var previous = 0xffffffffu;
  var top = true;
  var instance_slot = 0xffffffffu;
  var return_node = 0xffffffffu;
  var origin = world_origin;
  var direction = world_direction;
  var tlas_visits = 0u;
  var blas_visits = 0u;
  ${
    wavefront === "tail"
      ? `if (continuation[resume] == 1u) {
    node = continuation[${tail.node}u + resume];
    previous = continuation[${tail.previousNode}u + resume];
    top = continuation[${tail.inTlas}u + resume] != 0u;
    instance_slot = continuation[${tail.instanceSlot}u + resume];
    return_node = continuation[${tail.tlasReturnNode}u + resume];
    tlas_visits = continuation[${tail.tlasVisits}u + resume];
    blas_visits = continuation[${tail.blasVisits}u + resume];
    if (!top) {
      origin = affine_point(instances[instance_slot].worldToObject, world_origin, 1.0);
      direction = affine_point(instances[instance_slot].worldToObject, world_direction, 0.0);
    }
  }
  var quantum_steps = 0u;
  var suspended = false;`
      : ""
  }
  // Separate counters avoid overflowing the mathematical instance*BLAS visit
  // bound. Each new instance resets BLAS visits; TLAS visits never reset.
  // Parent continuation encounters each internal node at most three times.
  // Admitted shard capacity makes these arithmetic bounds nonwrapping.
  let tlas_bound = (tlas[0] * 2u - min(tlas[0], 1u)) * 3u;
  let blas_bound = (blas[0] * 2u - min(blas[0], 1u)) * 3u;
  if (tlas[2] != 0u || blas[2] != 0u || t_min > best ||
      (bitcast<u32>(t_min) & 0x7f800000u) == 0x7f800000u ||
      ((bitcast<u32>(best) & 0x7f800000u) == 0x7f800000u &&
        (bitcast<u32>(best) != 0x7f800000u)) ||
      any((bitcast<vec3u>(world_origin) & vec3u(0x7f800000u)) == vec3u(0x7f800000u)) ||
      any((bitcast<vec3u>(world_direction) & vec3u(0x7f800000u)) == vec3u(0x7f800000u)) || all(world_direction == vec3f(0.0))) {
    status = 5u;
    node = 0xffffffffu;
  }
  loop {
    ${
      wavefront === "tail"
        ? `if (quantum_steps == ${nodeQuantum}u) {
      suspended = true;
      break;
    }
    quantum_steps++;`
        : ""
    }
    if (node == 0xffffffffu) {
      if (top) { break; }
      top = true;
      node = return_node;
      previous = node;
      node = tlas[${tlasPlan.hierarchy.ranges.links!.offset / 4}u + node * 2u];
      origin = world_origin;
      direction = world_direction;
      continue;
    }
    if (top) {
      if (tlas_visits >= tlas_bound) { status = 5u; break; }
      tlas_visits++;
    } else {
      if (blas_visits >= blas_bound) { status = 5u; break; }
      blas_visits++;
    }
    let count = as_word(top, 0u);
    if (count == 0u || node >= count * 2u - 1u) { status = 5u; break; }
    let links = select(${plan.hierarchy.ranges.links!.offset / 4}u,
      ${tlasPlan.hierarchy.ranges.links!.offset / 4}u, top);
    let parent = as_word(top, links + node * 2u);
    let bounds = as_bounds(top, node);
    if (previous == parent && !box_hit(origin, direction, bounds[0], bounds[1], t_min, best)) {
      previous = node;
      node = parent;
      continue;
    }
    let at = select(${plan.hierarchy.ranges.nodes!.offset / 4}u,
      ${tlasPlan.hierarchy.ranges.nodes!.offset / 4}u, top) + node * 16u;
    if (node < count - 1u) {
      let left = as_word(top, at + 3u);
      let right = as_word(top, at + 11u);
      if (left >= count * 2u - 1u || right >= count * 2u - 1u || left == right) {
        status = 5u;
        break;
      }
      let left_bounds = as_bounds(top, left);
      let right_bounds = as_bounds(top, right);
      // Ordering uses the original interval, so an accepted closer hit cannot
      // swap siblings while returning through parent pointers. Pruning still
      // uses the current best distance. No per-ray 64-entry global stack.
      let left_near = box_near(origin, direction, left_bounds[0], left_bounds[1], t_min);
      let right_near = box_near(origin, direction, right_bounds[0], right_bounds[1], t_min);
      let right_first = right_near < left_near || (right_near == left_near && right < left);
      let first = select(left, right, right_first);
      let second = select(right, left, right_first);
      var next = parent;
      if (previous == parent) {
        next = first;
      } else if (previous == first) {
        next = second;
      } else if (previous != second) {
        status = 5u;
        break;
      }
      previous = node;
      node = next;
      continue;
    }
    let primitive_index = as_word(top, at + 3u);
    var primitive = primitive_index;
    if (top) { primitive = tlas[${tlasPlan.hierarchy.ranges.references!.offset / 4}u + primitive_index]; }
    if (top) {
      if (primitive >= arrayLength(&instances)) { status = 5u; break; }
      let instance = instances[primitive];
      if ((instance.shardGenerationMaskFlags[3] & 0x80000000u) != 0u) { status = 3u; break; }
      if ((instance.shardGenerationMaskFlags[2] & batch[ray + 9u]) == 0u) {
        previous = node;
        node = parent;
        continue;
      }
      ${
        coverage === undefined
          ? ""
          : `let coverage_class = query_coverage_instance(primitive);
      if (coverage_class == 2u) { status = 2u; break; }
      if (coverage_class == 0u) {
        previous = node;
        node = parent;
        continue;
      }`
      }
      instance_slot = primitive;
      blas_visits = 0u;
      return_node = node;
      origin = affine_point(instance.worldToObject, world_origin, 1.0);
      direction = affine_point(instance.worldToObject, world_direction, 0.0);
      top = false;
      node = instance.slotSetLifetimeRoot[3];
      previous = 0xffffffffu;
      continue;
    }
    let triangle = query_triangle(primitive);
    if (!triangle.valid) { status = 2u; break; }
    let hit = triangle_hit(origin, direction, triangle, t_min, best);
    var accepted = hit.accepted;
    ${
      wavefront === "candidate"
        ? `if (accepted && continuation[${cursor.hasRejected}u + resume] != 0u) {
      let cursor_t = bitcast<f32>(continuation[${cursor.rejectedT}u + resume]);
      let cursor_instance = continuation[${cursor.rejectedInstance}u + resume];
      let cursor_primitive = continuation[${cursor.rejectedPrimitive}u + resume];
      let stable = geometry.primitive_begin + primitive;
      accepted = hit.t > cursor_t || (hit.t == cursor_t &&
        (instance_slot > cursor_instance || (instance_slot == cursor_instance && stable > cursor_primitive)));
    }`
        : ""
    }
    ${
      diffuse || coverage === undefined || coverage === null
        ? ""
        : `if (accepted) {
      accepted = query_coverage_hit(instance_slot, triangle, hit.bary, hit.t,
        world_origin, world_direction, ray);
    }`
    }
    let stable_primitive = geometry.primitive_begin + primitive;
    if (accepted && (hit.t < best || best_instance == 0xffffffffu ||
        (hit.t == best && (instance_slot < best_instance ||
          (instance_slot == best_instance && stable_primitive < best_primitive))))) {
      best = hit.t;
      best_bary = hit.bary;
      best_instance = instance_slot;
      best_primitive = stable_primitive;
      best_generation = geometry.generation;
      let affine = instances[instance_slot].objectToWorld;
      let determinant = dot(vec3f(affine[0], affine[1], affine[2]),
        cross(vec3f(affine[4], affine[5], affine[6]), vec3f(affine[8], affine[9], affine[10])));
      best_front = hit.front ^ select(0u, 1u, determinant < 0.0);
      status = 0u;
      if ((trace.query_kind & 1u) != 0u) { break; }
    }
    previous = node;
    node = parent;
  }
  batch[result] = bitcast<u32>(best);
  batch[result + 1u] = bitcast<u32>(best_bary.x);
  batch[result + 2u] = bitcast<u32>(best_bary.y);
  batch[result + 3u] = status;
  batch[result + 4u] = best_instance;
  batch[result + 5u] = best_primitive;
  batch[result + 6u] = best_generation;
  batch[result + 7u] = best_front;
  ${
    wavefront === "tail"
      ? `continuation[resume] = select(2u, 1u, suspended);
  continuation[${tail.node}u + resume] = node;
  continuation[${tail.previousNode}u + resume] = previous;
  continuation[${tail.inTlas}u + resume] = u32(top);
  continuation[${tail.instanceSlot}u + resume] = instance_slot;
  continuation[${tail.tlasReturnNode}u + resume] = return_node;
  continuation[${tail.tlasVisits}u + resume] = tlas_visits;
  continuation[${tail.blasVisits}u + resume] = blas_visits;`
      : ""
  }
}
${
  wavefront === "coverage"
    ? /* wgsl */ `
@compute @workgroup_size(64)
fn accept_candidate(@builtin(global_invocation_id) id: vec3u) {
  let bin = coverage_route.x * 8u;
  if (id.x >= hit_work[bin]) { return; }
  let ray_index = hit_work[${hitListWord}u + hit_work[bin + 1u] + id.x];
  if (ray_index >= trace.ray_count) { return; }
  let resume = ray_index * ${SCGI_QUERY_CONTINUATION.words}u;
  if (continuation[resume] != 0u) { return; }
  let result = trace.result_word + ray_index * 8u;
  if (batch[result + 3u] != 0u) { return; }
  let instance_slot = batch[result + 4u];
  if (instance_slot >= arrayLength(&instances) || instances[instance_slot].shardGenerationMaskFlags[2] == 0u ||
      batch[result + 6u] != geometry.generation) { return; }
  if (instance_slot < geometry.instance_first || instance_slot - geometry.instance_first >= geometry.instance_count ||
      query_source[instance_slot].product_table_slot != geometry.product_slot ||
      query_source[instance_slot].geometry_record_index != geometry.asset_reference) { return; }
  if (query_coverage_instance(instance_slot) != 1u) { return; }
  let primitive = batch[result + 5u];
  if (primitive < geometry.primitive_begin || primitive >= geometry.primitive_begin + geometry.primitive_count) { return; }
  var accepted = true;
  ${
    coverage === null
      ? ""
      : `let triangle = query_triangle(primitive - geometry.primitive_begin);
  if (!triangle.valid) { batch[result + 3u] = 2u; continuation[resume] = 1u; return; }
  let ray = trace.ray_word + ray_index * 12u;
  let origin = vec3f(bitcast<f32>(batch[ray]), bitcast<f32>(batch[ray + 1u]), bitcast<f32>(batch[ray + 2u]));
  let direction = vec3f(bitcast<f32>(batch[ray + 4u]), bitcast<f32>(batch[ray + 5u]), bitcast<f32>(batch[ray + 6u]));
  let bary = vec2f(bitcast<f32>(batch[result + 1u]), bitcast<f32>(batch[result + 2u]));
  accepted = query_coverage_hit(instance_slot, triangle, bary, bitcast<f32>(batch[result]), origin, direction, ray);`
  }
  if (accepted) {
    continuation[resume] = 1u;
  } else {
    // Strict lexicographic cursor preserves coplanar candidates. Advancing t
    // by epsilon here would silently skip equal-distance leaves/instances.
    continuation[${cursor.hasRejected}u + resume] = 1u;
    continuation[${cursor.rejectedT}u + resume] = batch[result];
    continuation[${cursor.rejectedInstance}u + resume] = instance_slot;
    continuation[${cursor.rejectedPrimitive}u + resume] = primitive;
    batch[result + 3u] = 4u;
  }
}
`
    : ""
}
${
  diffuse
    ? /* wgsl */ `
@compute @workgroup_size(64)
fn shade_hit(@builtin(global_invocation_id) id: vec3u) {
  ${
    hitListWord === undefined
      ? "let ray_index = id.x;"
      : `let bin = coverage_route.x * 8u;
  if (id.x >= hit_work[bin]) { return; }
  let ray_index = hit_work[${hitListWord}u + hit_work[bin + 1u] + id.x];`
  }
  if (ray_index >= trace.ray_count) { return; }
  ${coveredScene ? "if (scene_coverage[0] != 0u) { return; }" : ""}
  let result = trace.result_word + ray_index * 8u;
  if (batch[result + 3u] != 0u) { return; }
  let instance_slot = batch[result + 4u];
  if (instance_slot >= arrayLength(&instances) || instance_slot >= arrayLength(&query_source)) { return; }
  // Every shard's instance view masks all other Products/assets. Generation
  // alone is insufficient: different Product slots can share a generation.
  if (instances[instance_slot].shardGenerationMaskFlags[2] == 0u ||
      (instances[instance_slot].shardGenerationMaskFlags[3] & 0x80000000u) != 0u) { return; }
  let source = query_source[instance_slot];
  if (instance_slot < geometry.instance_first || instance_slot - geometry.instance_first >= geometry.instance_count ||
      source.product_table_slot != geometry.product_slot || source.geometry_record_index != geometry.asset_reference) { return; }
  if (source.material_handle >= arrayLength(&coverage_directory)) { return; }
  let entry = coverage_directory[source.material_handle];
  if (entry.w == 0u || entry.y != coverage_route.x || batch[result + 6u] != geometry.generation) { return; }
  let primitive = batch[result + 5u];
  if (primitive < geometry.primitive_begin || primitive >= geometry.primitive_begin + geometry.primitive_count) { return; }
  let triangle = query_triangle(primitive - geometry.primitive_begin);
  if (!triangle.valid) { return; }
  let ray = trace.ray_word + ray_index * 12u;
  let direction = vec3f(bitcast<f32>(batch[ray + 4u]), bitcast<f32>(batch[ray + 5u]),
    bitcast<f32>(batch[ray + 6u]));
  let bary = vec2f(bitcast<f32>(batch[result + 1u]), bitcast<f32>(batch[result + 2u]));
  let inputs = query_material_inputs(instance_slot, triangle, bary, bitcast<f32>(batch[result]), direction);
  // Graph inputs retain authored camera semantics. The physical two-sided
  // response instead faces the receiving transport direction at this hit.
  var transport_basis = inputs.basis;
  if ((source.flags & 16u) != 0u && dot(transport_basis[2], -direction) < 0.0) {
    transport_basis[0] = -transport_basis[0];
    transport_basis[2] = -transport_basis[2];
  }
  let hit = native_diffuse_hit(entry.x, inputs.inputs, transport_basis, -direction);
  let output = ray_index * 4u;
  diffuse_hits[output] = vec4f(hit.diffuse, hit.occlusion);
  diffuse_hits[output + 1u] = vec4f(hit.emission, hit.underlayer);
  diffuse_hits[output + 2u] = vec4f(hit.normal, f32(hit.valid));
  let position = affine_point(instances[instance_slot].objectToWorld,
    triangle.p0 * (1.0 - bary.x - bary.y) + triangle.p1 * bary.x + triangle.p2 * bary.y, 1.0);
  diffuse_hits[output + 3u] = vec4f(position, bitcast<f32>(source.flags));
}`
    : ""
}
`;
}
