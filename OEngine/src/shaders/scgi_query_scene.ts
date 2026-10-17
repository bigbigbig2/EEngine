import type { ScgiBvhPlan } from "../render/gi/ScgiBvhLayout.js";
import type { NativeMaterialProgram } from "./native_material.js";
import { scgiQuerySourceWgsl, SCGI_QUERY_INTERSECTION_WGSL } from "./scgi_query_geometry.js";
import { VIRTUAL_TEXTURE_FEEDBACK_WGSL } from "./virtual_texture.js";

export function scgiQuerySceneWgsl(
  plan: ScgiBvhPlan,
  program: NativeMaterialProgram | null,
  mode: "trace" | "geometry" | "material",
  unlit: boolean,
  outputStride: number,
  listWord?: number,
  routed = false,
  diagnostics = false,
): string {
  const material = mode === "material";
  const attributes = material || (mode === "trace" && program !== null);
  return /* wgsl */ `
${scgiQuerySourceWgsl(program, material, unlit)}
${material && program?.virtualTextures ? VIRTUAL_TEXTURE_FEEDBACK_WGSL : ""}
@group(0) @binding(0) var<uniform> trace: TraceSettings;
@group(0) @binding(2) var<storage, read> arena: array<u32>;
@group(0) @binding(3) var<storage, read> tlas: array<u32>;
@group(0) @binding(5) var<storage, read_write> batch: array<u32>;
@group(0) @binding(7) var<storage, read> scene_coverage: array<u32>;
struct TraceSettings {
  ray_count: u32, result_word: u32, query_kind: u32, merge: u32,
  source_group: u32, bin: u32, reserved: vec2u,
}
${mode !== "trace" ? "@group(2) @binding(0) var<storage, read_write> diffuse_hits: array<vec4f>;" : ""}
${routed ? "@group(2) @binding(2) var<storage, read_write> ray_route: array<atomic<u32>>;" : ""}
${listWord === undefined ? "" : "@group(2) @binding(2) var<storage, read_write> hit_work: array<atomic<u32>>;"}
${
  routed && diagnostics
    ? `fn route_counter_add(word: u32, value: u32) {
  let previous = atomicAdd(&ray_route[word], value);
  // Dispatch arguments have already been copied before traversal. Their high
  // bit is available here as an explicit diagnostic overflow flag.
  if (value > 0xffffffffu - previous) { atomicOr(&ray_route[4], 0x80000000u); }
}`
    : ""
}
fn descriptor_for(slot: u32, primitive: u32, match_primitive: bool) -> u32 {
  if (slot >= arrayLength(&query_source)) { return 0xffffffffu; }
  let item = query_source[slot];
  var lo = 0u;
  var hi = arena[0];
  loop {
    if (lo >= hi) { break; }
    let mid = lo + (hi - lo) / 2u;
    let at = 4u + mid * 24u;
    let before = arena[at + 8u] < item.product_table_slot ||
      (arena[at + 8u] == item.product_table_slot && (arena[at + 3u] < oengine_instance_geometry_generation(item) ||
       (arena[at + 3u] == oengine_instance_geometry_generation(item) && arena[at + 9u] < item.geometry_record_index)));
    if (before) { lo = mid + 1u; } else { hi = mid; }
  }
  if (!match_primitive) { return lo; }
  for (var i = 0u; i < arena[1]; i++) {
    let index = lo + i;
    if (index >= arena[0]) { break; }
    let at = 4u + index * 24u;
    if (arena[at + 8u] != item.product_table_slot || arena[at + 3u] != oengine_instance_geometry_generation(item) ||
        arena[at + 9u] != item.geometry_record_index) { break; }
    if (primitive >= arena[at + 4u] && primitive - arena[at + 4u] < arena[at + 5u]) { return index; }
  }
  return 0xffffffffu;
}
fn select_geometry(index: u32) {
  let at = 4u + index * 24u;
  geometry = GeometrySettings(arena[at], arena[at + 1u], arena[at + 2u], arena[at + 3u],
    arena[at + 4u], arena[at + 5u], arena[at + 6u], arena[at + 7u],
    arena[at + 8u], arena[at + 9u], arena[at + 10u], arena[at + 11u],
    arena[at + 12u], arena[at + 13u], arena[at + 14u], arena[at + 15u]);
}
fn intersection_triangle(index: u32, primitive: u32) -> QueryTriangle {
  let at = 4u + index * 24u;
  let begin = arena[at + 19u] + primitive * 12u;
  var triangle: QueryTriangle;
  if (primitive >= arena[at + 5u] || begin + 12u > arrayLength(&arena)) { return triangle; }
  triangle.meshlet = arena[begin + 7u];
  triangle.source_primitive = arena[begin + 11u];
  triangle.primitive = arena[begin + 3u] - 1u;
  triangle.valid = arena[begin + 3u] != 0u;
  triangle.p0 = bitcast<vec3f>(vec3u(arena[begin], arena[begin + 1u], arena[begin + 2u]));
  triangle.p1 = bitcast<vec3f>(vec3u(arena[begin + 4u], arena[begin + 5u], arena[begin + 6u]));
  triangle.p2 = bitcast<vec3f>(vec3u(arena[begin + 8u], arena[begin + 9u], arena[begin + 10u]));
  return triangle;
}
${SCGI_QUERY_INTERSECTION_WGSL}
fn node_word(top: bool, base: u32, word: u32) -> u32 {
  if (top) { return tlas[word]; }
  return arena[base + word];
}
fn node_bounds(top: bool, base: u32, nodes: u32, node: u32) -> mat2x3f {
  let at = nodes + node * 16u;
  let a = bitcast<vec3f>(vec3u(node_word(top, base, at), node_word(top, base, at + 1u), node_word(top, base, at + 2u)));
  let b = bitcast<vec3f>(vec3u(node_word(top, base, at + 8u), node_word(top, base, at + 9u), node_word(top, base, at + 10u)));
  let c = bitcast<vec3f>(vec3u(node_word(top, base, at + 4u), node_word(top, base, at + 5u), node_word(top, base, at + 6u)));
  let d = bitcast<vec3f>(vec3u(node_word(top, base, at + 12u), node_word(top, base, at + 13u), node_word(top, base, at + 14u)));
  return mat2x3f(min(a, b), max(c, d));
}
fn finite3(value: vec3f) -> bool {
  return all((bitcast<vec3u>(value) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
}
${
  mode === "trace"
    ? /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  ${
    routed
      ? `if (id.x >= atomicLoad(&ray_route[0])) { return; }
  let ray_index = atomicLoad(&ray_route[8u + id.x]);`
      : "let ray_index = id.x;"
  }
  if (ray_index >= trace.ray_count) { return; }
  let ray = ray_index * 12u;
  let result = trace.result_word + ray_index * 8u;
  let world_origin = bitcast<vec3f>(vec3u(batch[ray], batch[ray + 1u], batch[ray + 2u]));
  let world_direction = bitcast<vec3f>(vec3u(batch[ray + 4u], batch[ray + 5u], batch[ray + 6u]));
  let t_min = bitcast<f32>(batch[ray + 3u]);
  let t_max = bitcast<f32>(batch[ray + 7u]);
  var status = 1u;
  var best = t_max;
  var best_slot = 0xffffffffu;
  var best_primitive = 0xffffffffu;
  var best_generation = 0u;
  var best_front = 0u;
  var best_bary = vec2f(0.0);
  if (trace.merge != 0u) {
    status = batch[result + 3u];
    if (status > 1u || (trace.query_kind == 1u && status == 0u)) { return; }
    best = bitcast<f32>(batch[result]);
    best_bary = bitcast<vec2f>(vec2u(batch[result + 1u], batch[result + 2u]));
    best_slot = batch[result + 4u]; best_primitive = batch[result + 5u];
    best_generation = batch[result + 6u]; best_front = batch[result + 7u];

  }
  let valid_max = (bitcast<u32>(t_max) & 0x7f800000u) != 0x7f800000u || bitcast<u32>(t_max) == 0x7f800000u;
  if (!finite3(world_origin) || !finite3(world_direction) || all(world_direction == vec3f(0.0)) ||
      (bitcast<u32>(t_min) & 0x7f800000u) == 0x7f800000u || !valid_max || !(t_min <= t_max)) {
    batch[result + 3u] = 5u; return;
  }
  if (scene_coverage[0] != 0u) { batch[result + 3u] = 2u; return; }
  if (scene_coverage[7] != 0u) {
    let low = bitcast<vec3f>(vec3u(scene_coverage[4], scene_coverage[5], scene_coverage[6]));
    let high = bitcast<vec3f>(vec3u(scene_coverage[8], scene_coverage[9], scene_coverage[10]));
    let start = world_origin + world_direction * t_min;
    let end = world_origin + world_direction * t_max;
    if (!finite3(start) || !finite3(end) || any(start < low) || any(start > high) || any(end < low) || any(end > high)) {
      batch[result + 3u] = 2u; return;
    }
  }
  var top = true;
  var node = tlas[1];
  var previous = 0xffffffffu;
  var return_node = 0xffffffffu;
  var slot = 0xffffffffu;
  var descriptor = 0u;
  var base = 0u;
  var nodes = ${plan.hierarchy.ranges.nodes!.offset / 4}u;
  var links = ${plan.hierarchy.ranges.links!.offset / 4}u;
  var count = tlas[0];
  var visits = 0u;
  var top_visits = 0u;
  var triangle_tests = 0u;
  var coverage_tests = 0u;
  var node_visits = 0u;
  var origin = world_origin;
  var direction = world_direction;
  if (tlas[2] != 0u) { status = 5u; node = 0xffffffffu; }
  loop {
    if (node == 0xffffffffu) {
      if (top) { break; }
      // One TLAS leaf per instance. All chunks of that Product asset are
      // traversed here, so an unrelated large asset never multiplies the
      // complete scene instance capacity.
      let next_descriptor = descriptor + 1u;
      if (next_descriptor < arena[0]) {
        let old = 4u + descriptor * 24u;
        let next = 4u + next_descriptor * 24u;
        if (arena[next + 8u] == arena[old + 8u] && arena[next + 3u] == arena[old + 3u] &&
            arena[next + 9u] == arena[old + 9u] &&
            (trace.source_group == 0xffffffffu || arena[next + 21u] == trace.source_group)) {
          descriptor = next_descriptor;
          base = arena[next + 16u]; nodes = arena[next + 17u]; links = arena[next + 18u];
          if (arena[base + 2u] != 0u) { status = 5u; break; }
          count = arena[base]; node = arena[base + 1u]; previous = 0xffffffffu; visits = 0u;
          continue;
        }
      }
      top = true;
      previous = return_node;
      node = tlas[${plan.hierarchy.ranges.links!.offset / 4}u + return_node * 2u];
      base = 0u; nodes = ${plan.hierarchy.ranges.nodes!.offset / 4}u;
      links = ${plan.hierarchy.ranges.links!.offset / 4}u; count = tlas[0];
      origin = world_origin; direction = world_direction;
      continue;
    }
    node_visits++;
    if (top) { top_visits++; } else { visits++; }
    if (count == 0u || node >= count * 2u - 1u ||
        (top && top_visits > (count * 2u - 1u) * 3u) ||
        (!top && visits > (count * 2u - 1u) * 3u)) { status = 5u; break; }
    let parent = node_word(top, base, links + node * 2u);
    let bounds = node_bounds(top, base, nodes, node);
    if (previous == parent && !box_hit(origin, direction, bounds[0], bounds[1], t_min, best)) {
      previous = node; node = parent; continue;
    }
    let at = nodes + node * 16u;
    if (node < count - 1u) {
      let left = node_word(top, base, at + 3u);
      let right = node_word(top, base, at + 11u);
      if (left >= count * 2u - 1u || right >= count * 2u - 1u || left == right) { status = 5u; break; }
      let l = node_bounds(top, base, nodes, left);
      let r = node_bounds(top, base, nodes, right);
      let ln = box_near(origin, direction, l[0], l[1], t_min);
      let rn = box_near(origin, direction, r[0], r[1], t_min);
      let right_first = rn < ln || (rn == ln && right < left);
      let first = select(left, right, right_first);
      let second = select(right, left, right_first);
      var next = parent;
      if (previous == parent) { next = first; }
      else if (previous == first) { next = second; }
      else if (previous != second) { status = 5u; break; }
      previous = node; node = next; continue;
    }
    let primitive = node_word(top, base, at + 3u);
    if (top) {
      if (primitive >= count) { status = 5u; break; }
      let pair = tlas[${plan.hierarchy.ranges.references!.offset / 4}u + primitive];
      slot = pair;
      if (slot >= arrayLength(&instances)) { status = 5u; break; }
      let instance = instances[slot];
      if ((instance.shardGenerationMaskFlags[3] & 0x80000000u) != 0u) { status = 3u; break; }
      if (((batch[ray + 10u] & 1u) != 0u && (instance.shardGenerationMaskFlags[3] & 2u) == 0u) ||
          (instance.shardGenerationMaskFlags[2] & batch[ray + 9u]) == 0u) {
        previous = node; node = parent; continue;
      }
      descriptor = descriptor_for(slot, 0u, false);
      if (trace.source_group != 0xffffffffu) {
        loop {
          if (descriptor >= arena[0]) { break; }
          let d = 4u + descriptor * 24u;
          if (arena[d + 8u] != query_source[slot].product_table_slot ||
              arena[d + 3u] != oengine_instance_geometry_generation(query_source[slot]) ||
              arena[d + 9u] != query_source[slot].geometry_record_index ||
              arena[d + 21u] == trace.source_group) { break; }
          descriptor++;
        }
      }
      if (descriptor >= arena[0]) { status = 5u; break; }
      let d = 4u + descriptor * 24u;
      base = arena[d + 16u]; nodes = arena[d + 17u]; links = arena[d + 18u];
      if (arena[base + 2u] != 0u) { status = 5u; break; }
      count = arena[base];
      return_node = node; top = false; node = arena[base + 1u]; previous = 0xffffffffu; visits = 0u;
      origin = affine_point(instance.worldToObject, world_origin, 1.0);
      direction = affine_point(instance.worldToObject, world_direction, 0.0);
      continue;
    }
    triangle_tests++;
    let triangle = intersection_triangle(descriptor, primitive);
    if (!triangle.valid) { status = 2u; break; }
    let hit = triangle_hit(origin, direction, triangle, t_min, best);
    var accepted = hit.accepted;
    ${
      attributes
        ? `if (accepted) {
      coverage_tests++;
      select_geometry(descriptor);
      let source_triangle = query_triangle(primitive);
      if (!source_triangle.valid) { status = 2u; break; }
      accepted = query_coverage_hit(slot, source_triangle, hit.bary, hit.t, world_origin, world_direction, ray);
    }`
        : ""
    }
    let d = 4u + descriptor * 24u;
    let stable = arena[d + 4u] + primitive;
    if (accepted && (hit.t < best || best_slot == 0xffffffffu ||
        (hit.t == best && (slot < best_slot || (slot == best_slot && stable < best_primitive))))) {
      best = hit.t; best_bary = hit.bary; best_slot = slot; best_primitive = stable;
      best_generation = arena[d + 3u];
      let affine = instances[slot].objectToWorld;
      let determinant = dot(vec3f(affine[0], affine[1], affine[2]), cross(vec3f(affine[4], affine[5], affine[6]), vec3f(affine[8], affine[9], affine[10])));
      best_front = hit.front ^ select(0u, 1u, determinant < 0.0); status = 0u;
      if (trace.query_kind == 1u) { break; }
    }
    previous = node; node = parent;
  }
  ${
    routed && diagnostics
      ? `route_counter_add(1u, node_visits);
  route_counter_add(2u, triangle_tests);
  route_counter_add(3u, coverage_tests);`
      : ""
  }
  batch[result] = bitcast<u32>(best); batch[result + 1u] = bitcast<u32>(best_bary.x);
  batch[result + 2u] = bitcast<u32>(best_bary.y); batch[result + 3u] = status;
  batch[result + 4u] = best_slot; batch[result + 5u] = best_primitive;
  batch[result + 6u] = best_generation; batch[result + 7u] = best_front;
}`
    : scgiAcceptedHitWgsl(material, outputStride, listWord, diagnostics)
}
`;
}

function scgiAcceptedHitWgsl(
  material: boolean,
  stride: number,
  listWord?: number,
  diagnostics = false,
): string {
  return /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  ${
    listWord === undefined
      ? "let ray_index = id.x;"
      : `
  let bin = trace.bin * 8u;
  if (id.x >= atomicLoad(&hit_work[bin])) { return; }
  let ray_index = atomicLoad(&hit_work[${listWord}u + atomicLoad(&hit_work[bin + 1u]) + id.x]);`
  }
  if (ray_index >= trace.ray_count) { return; }
  let result = trace.result_word + ray_index * 8u;
  if (batch[result + 3u] != 0u) { return; }
  let slot = batch[result + 4u];
  if (slot >= arrayLength(&query_source)) { batch[result + 3u] = 5u; return; }
  let primitive = batch[result + 5u];
  let descriptor = descriptor_for(slot, primitive, true);
  if (descriptor >= arena[0]) { return; }
  let at = 4u + descriptor * 24u;
  if (arena[at + 21u] != trace.source_group) { return; }
  select_geometry(descriptor);
  let source = query_source[slot];
  if (geometry.generation != batch[result + 6u]) { batch[result + 3u] = 2u; return; }
  let triangle = ${material ? "query_triangle(primitive - geometry.primitive_begin)" : "intersection_triangle(descriptor, primitive - geometry.primitive_begin)"};
  if (!triangle.valid) { batch[result + 3u] = 2u; return; }
  let bary = bitcast<vec2f>(vec2u(batch[result + 1u], batch[result + 2u]));
  let ray = ray_index * 12u;
  let direction = bitcast<vec3f>(vec3u(batch[ray + 4u], batch[ray + 5u], batch[ray + 6u]));
  let output = ray_index * ${stride / 16}u;
  let position = affine_point(instances[slot].objectToWorld,
    triangle.p0 * (1.0 - bary.x - bary.y) + triangle.p1 * bary.x + triangle.p2 * bary.y, 1.0);
  let world0 = affine_point(instances[slot].objectToWorld, triangle.p0, 1.0);
  let world1 = affine_point(instances[slot].objectToWorld, triangle.p1, 1.0);
  let world2 = affine_point(instances[slot].objectToWorld, triangle.p2, 1.0);
  var flat = normalize(cross(world1 - world0, world2 - world0));
  if (dot(flat, -direction) < 0.0) { flat = -flat; }
  let error = 32.0 * 1.1920928955078125e-7 * max(max(length(position), max(length(world1 - world0), length(world2 - world0))), 1.0);
  ${
    material
      ? `
  if (source.material_handle >= arrayLength(&coverage_directory)) { batch[result + 3u] = 2u; return; }
  let entry = coverage_directory[source.material_handle];
  if (entry.w == 0u || entry.y != trace.bin) { return; }
  let inputs = query_material_inputs(slot, triangle, bary, bitcast<f32>(batch[result]), direction);
  var basis = inputs.basis;
  if ((source.flags & 16u) != 0u && dot(basis[2], -direction) < 0.0) { basis[0] = -basis[0]; basis[2] = -basis[2]; }
  ${listWord === undefined || !diagnostics ? "" : "atomicAdd(&hit_work[bin + 3u], 1u);"}
  let hit = native_diffuse_hit(entry.x, inputs.inputs, basis, -direction);
  diffuse_hits[output] = vec4f(hit.diffuse, hit.occlusion);
  diffuse_hits[output + 1u] = vec4f(hit.emission, hit.underlayer);
  diffuse_hits[output + 2u] = vec4f(hit.normal, f32(hit.valid));`
      : `
  diffuse_hits[output] = vec4f(0.0);
  diffuse_hits[output + 1u] = vec4f(0.0);
  diffuse_hits[output + 2u] = vec4f(flat, 1.0);`
  }
  diffuse_hits[output + 3u] = vec4f(position, bitcast<f32>(source.flags));
  ${
    stride === 96
      ? `
  diffuse_hits[output + 4u] = bitcast<vec4f>(vec4u(geometry.asset, triangle.meshlet, triangle.primitive, triangle.source_primitive));
  diffuse_hits[output + 5u] = vec4f(flat, error);`
      : ""
  }
  if (!finite3(position) || !finite3(flat) || !((bitcast<u32>(error) & 0x7f800000u) != 0x7f800000u)) {
    batch[result + 3u] = 5u;
  }
}
`;
}
