import type { ScgiBvhPlan } from "../render/gi/ScgiBvhLayout.js";
import { SCGI_ABI_WGSL } from "../render/gi/ScgiAbi.js";
import type { NativeMaterialProgram } from "./native_material.js";
import { nativeCoverageEvaluationWgsl } from "./native_visibility.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { nativeDiffuseHitEvaluationWgsl } from "./native_diffuse_hit.js";
import { GEOMETRY_QUERY_DIRECTORY_CLUSTER_BYTES } from "../gpu/GeometryQueryDirectory.js";
import { frameGeometrySourceWgsl, FRAME_ATTRIBUTE_OCT_DECODE_WGSL } from "./geometry_source_decode.js";

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
    viewNormal: "coverage_view.view * vec4f(normal, 0.0)",
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
                    `native_material_constant(material_base, ${program.constants.length + 2 + slot * 4 + channel}u)`,
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

/** Canonical Product attributes and Native graph inputs. Geometry is selected
 * from the immutable scene descriptor before calling query_triangle. */
export function scgiQuerySourceWgsl(
  coverage?: NativeMaterialProgram | null,
  diffuse = false,
  unlit = false,
): string {
  return /* wgsl */ `
${FRAME_ATTRIBUTE_OCT_DECODE_WGSL}
${frameGeometrySourceWgsl(true, true, true)}
${SCGI_ABI_WGSL}
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
  group_begin: u32,
  reserved0: u32,
  reserved1: u32,
  reserved2: u32,
}
var<private> geometry: GeometrySettings;
@group(0) @binding(4) var<storage, read> instances: array<ScgiInstance>;
struct QueryTriangle {
  valid: bool,
  cluster: u32,
  primitive: u32,
  source_primitive: u32,
  meshlet: u32,
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
  result.meshlet = (product_heap[at + 1u] - geometry.group_begin) * 128u + local_meshlet;
  result.p0 = frame_vertex_position(v0);
  result.p1 = frame_vertex_position(v1);
  result.p2 = frame_vertex_position(v2);
  return result;
}
fn affine_point(values: array<f32, 12>, point: vec3f, w: f32) -> vec3f {
  return vec3f(values[0], values[1], values[2]) * point.x +
    vec3f(values[4], values[5], values[6]) * point.y +
    vec3f(values[8], values[9], values[10]) * point.z + vec3f(values[3], values[7], values[11]) * w;
}
${coverage === undefined ? "" : scgiCoverageWgsl(coverage, diffuse, unlit)}
`;
}

/** Build-only projection. Exact f32 positions are derived once per content/cut
 * and shared across scene instances. No ray work is performed here. */
export function scgiQueryGeometryWgsl(plan: ScgiBvhPlan, writePositions = false): string {
  return /* wgsl */ `
${scgiQuerySourceWgsl()}
@group(0) @binding(0) var<uniform> source_geometry: GeometrySettings;
@group(0) @binding(1) var<storage, read_write> scratch: array<u32>;
${writePositions ? "@group(0) @binding(13) var<storage, read_write> intersection_positions: array<vec4u>;" : ""}
@compute @workgroup_size(128)
fn bounds(@builtin(global_invocation_id) id: vec3u) {
  geometry = source_geometry;
  if (id.x >= geometry.primitive_count) { return; }
  let triangle = query_triangle(id.x);
  ${
    writePositions
      ? `
  intersection_positions[id.x * 3u] = vec4u(bitcast<vec3u>(triangle.p0), select(0u, triangle.primitive + 1u, triangle.valid));
  intersection_positions[id.x * 3u + 1u] = vec4u(bitcast<vec3u>(triangle.p1), triangle.meshlet);
  intersection_positions[id.x * 3u + 2u] = vec4u(bitcast<vec3u>(triangle.p2), triangle.source_primitive);`
      : ""
  }
  var low = min(min(triangle.p0, triangle.p1), triangle.p2);
  var high = max(max(triangle.p0, triangle.p1), triangle.p2);
  if (!triangle.valid) { low = vec3f(1.0); high = vec3f(-1.0); }
  let at = ${plan.scratch.ranges.primitiveBounds!.offset / 4}u + id.x * 8u;
  for (var axis = 0u; axis < 3u; axis++) {
    scratch[at + axis] = bitcast<u32>(low[axis]);
    scratch[at + 4u + axis] = bitcast<u32>(high[axis]);
  }
  scratch[at + 3u] = id.x;
  scratch[at + 7u] = triangle.primitive;
}
`;
}

export const SCGI_QUERY_INTERSECTION_WGSL = /* wgsl */ `
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
`;
