import type { NativeMaterialProgram } from "./native_material.js";
import type { NativeVisibilityShader } from "./native_visibility.js";
import { nativeCoverageEvaluationWgsl } from "./native_visibility.js";
import { vsmGeometryWgsl } from "../gpu/GpuVsmGeometryAbi.js";
import { VSM_PROJECTION_CONSTANT_BYTES } from "../gpu/GpuVsmProjectionAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import {
  VSM_GEOMETRY_CONSTANTS_WGSL,
  VSM_TRIANGLE_PAGE_MATH_WGSL,
  VSM_POLYGON_CLIP_WGSL,
  type VsmAttributeLayout
} from "./vsm_geometry.js";

export function vsmCoverageAttributes(program: NativeMaterialProgram | null): number {
  if (program === null) {
    return 0;
  }
  let mask = 0;
  const names = new Set(
    program.inputs
      .filter((input) => input.domain !== "dynamic" && input.domain !== "nonlocal")
      .map((input) => input.name)
  );
  if (
    ["normal", "worldNormal", "viewNormal", "tangent", "worldTangent", "viewDirection"].some((name) =>
      names.has(name)
    )
  ) {
    mask |= 3;
  }
  if (["position", "worldPosition", "viewPosition"].some((name) => names.has(name))) {
    mask |= 1;
  }
  if (names.has("tangent") || names.has("worldTangent")) {
    mask |= 4;
  }
  if (names.has("uv0") || names.has("uv1")) {
    mask |= 8;
  }
  if (names.has("uv2")) {
    mask |= 16;
  }
  if (names.has("vertexColor")) {
    mask |= 32;
  }
  return mask;
}

export function vsmAttributeLayout(mask: number): VsmAttributeLayout {
  let vectors = 1;
  const field = (bit: number) => ((mask & bit) !== 0 ? vectors++ : -1);
  return Object.freeze({
    world: field(1),
    normal: field(2),
    tangent: field(4),
    uv01: field(8),
    uv2: field(16),
    color: field(32),
    get vectors() {
      return vectors;
    }
  });
}

/** Page clipping happens before rasterization. MASK reconstructs all attributes
 * on the ORIGINAL triangle plane, so generated fan edges cannot introduce new
 * material-gradient seams. No interpolated nonlinear material result is cached. */
export function vsmPreparedRasterShader(
  program: NativeMaterialProgram | null,
  materialLayout: readonly GPUBindGroupLayoutEntry[],
  attributes: VsmAttributeLayout,
  pageWords: number,
  clipDistances: boolean
): NativeVisibilityShader {
  const mask = vsmCoverageAttributes(program);
  const attribute = (slot: number) => `vsm_attribute(record.meshlet, ids, weights, ${slot}u)`;
  const world = (mask & 1) !== 0 ? attribute(attributes.world) : "vec4f(0.0)";
  const expressions: Record<string, string> = {
    position: "world",
    worldPosition: "world",
    viewPosition: "view_matrix * world",
    cameraPosition: "vec4f(camera_position.xyz, 1.0)",
    normal: "vec4f(normal, authored_normal.w)",
    worldNormal: "vec4f(normal, authored_normal.w)",
    viewNormal: "view_matrix * vec4f(normal, 0.0)",
    tangent: "vec4f(tangent, authored_tangent.w)",
    worldTangent: "vec4f(tangent, authored_tangent.w)",
    viewDirection: "vec4f(vsm_normal(camera_position.xyz - world.xyz, normal), 0.0)",
    uv0: attributes.uv01 < 0 ? "" : `vec4f(${attribute(attributes.uv01)}.xy, 0.0, 0.0)`,
    uv1: attributes.uv01 < 0 ? "" : `vec4f(${attribute(attributes.uv01)}.zw, 0.0, 0.0)`,
    uv2: attributes.uv2 < 0 ? "" : `vec4f(${attribute(attributes.uv2)}.xy, 0.0, 0.0)`,
    vertexColor: attributes.color < 0 ? "" : attribute(attributes.color)
  };
  const inputs =
    program?.inputs
      .map((input, slot) => {
        const uniform = input.domain === "dynamic" || input.domain === "nonlocal";
        const value = uniform
          ? program.instanceInputs
            ? `vec4f(${Array.from({ length: 4 }, (_, lane) => `native_material_constant(entry.x, ${program.constants.length + 2 + slot * 4 + lane}u)`).join(", ")})`
            : `frame_inputs[${slot}u]`
          : expressions[input.name];
        if (!value) {
          throw new RangeError(`Unsupported VSM coverage input '${input.name}'`);
        }
        return `let input_${slot} = ${value};
  inputs.center[${slot}u] = input_${slot};
  inputs.x[${slot}u] = input_${slot}${uniform ? "" : ` + dpdx(input_${slot})`};
  inputs.y[${slot}u] = input_${slot}${uniform ? "" : ` + dpdy(input_${slot})`};`;
      })
      .join("\n") ?? "";
  const source = /* wgsl */ `${clipDistances ? "enable clip_distances;" : ""}
${VSM_PAGE_TABLE_WGSL}
${vsmGeometryWgsl(attributes.vectors, pageWords)}
${VSM_GEOMETRY_CONSTANTS_WGSL}
@group(0) @binding(0) var<storage, read> prepared: array<VsmPreparedMeshlet>;
@group(0) @binding(1) var<storage, read> records: array<VsmTrianglePages>;
@group(0) @binding(2) var<storage, read> indices: array<VsmSourceRange>;
@group(0) @binding(3) var<storage, read> states: array<vec4u>;
@group(0) @binding(4) var<storage, read> allocation: VsmAllocation;
@group(0) @binding(5) var<uniform> constants: VsmGeometryConstants;
@group(0) @binding(6) var<uniform> route: vec4u;
${VSM_TRIANGLE_PAGE_MATH_WGSL}
${clipDistances ? "" : VSM_POLYGON_CLIP_WGSL}
// Compact source ranges, triangle prefixes, then rank/select in the page mask.
// Each indirect instance is a real triangle/page hit, not a padded candidate.
fn vsm_resolve_incidence(instance: u32, state: vec4u) -> VsmTrianglePage {
  var lo = 0u;
  var hi = state.z;
  while lo < hi {
    let middle = lo + (hi - lo) / 2u;
    if indices[state.y + middle].end <= instance { lo = middle + 1u; } else { hi = middle; }
  }
  let source_range = indices[state.y + lo];
  let local = instance - source_range.begin;
  lo = 0u;
  hi = prepared[source_range.meshlet].counts.y;
  while lo < hi {
    let middle = lo + (hi - lo) / 2u;
    if records[source_range.meshlet * 128u + middle].end <= local { lo = middle + 1u; } else { hi = middle; }
  }
  let triangle = lo;
  var prior = 0u;
  if triangle != 0u { prior = records[source_range.meshlet * 128u + triangle - 1u].end; }
  var rank = local - prior;
  let mask = records[source_range.meshlet * 128u + triangle];
  var page = 0u;
  for (var word = 0u; word < ${pageWords}u; word++) {
    var bits = mask.bits[word];
    let count = countOneBits(bits);
    if rank >= count { rank -= count; continue; }
    for (var skip = 0u; skip < rank; skip++) { bits &= bits - 1u; }
    page = word * 32u + firstTrailingBit(bits);
    break;
  }
  return VsmTrianglePage(source_range.meshlet, prepared[source_range.meshlet].triangles[triangle], page);
}
struct Vertex {
  @builtin(position) position: vec4f,
  ${clipDistances ? "@builtin(clip_distances) planes: array<f32, 4>," : ""}
  ${program === null ? "" : "@location(0) @interpolate(flat) record: vec3u,"}
}
@vertex
fn native_visibility_vertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Vertex {
  var output: Vertex;
  output.position = vec4f(2.0, 2.0, 2.0, 1.0);
  ${clipDistances ? "output.planes = array<f32, 4>(-1.0, -1.0, -1.0, -1.0);" : ""}
  let state = states[route.x];
  if instance >= state.x { return output; }
  let record = vsm_resolve_incidence(instance, state);
  let ids = vec3u(record.triangle & 255u, (record.triangle >> 8u) & 255u, (record.triangle >> 16u) & 255u);
  let a = prepared[record.meshlet].vertices[ids.x][0].xyz;
  let b = prepared[record.meshlet].vertices[ids.y][0].xyz;
  let c = prepared[record.meshlet].vertices[ids.z][0].xyz;
  let page = allocation.records[record.page];
  let rect = vsm_page_rect(page);
  var light: vec3f;
  ${
    clipDistances
      ? `light = array<vec3f, 3>(a, b, c)[vertex];
  output.planes = array<f32, 4>(light.x - rect.x, rect.z - light.x, light.y - rect.y, rect.w - light.y);`
      : `let fan = vertex / 3u;
  let polygon = vsm_clip_triangle(a, b, c, rect);
  if polygon.count < 3u || fan + 2u >= polygon.count { return output; }
  let corner = vertex % 3u;
  let point = select(fan + corner, 0u, corner == 0u);
  let bary = polygon.vertices[point];
  light = a * (1.0 - bary.x - bary.y) + b * bary.x + c * bary.y;`
  }
  output.position = vsm_atlas_position(light, page);
  ${program === null ? "" : "output.record = vec3u(record.meshlet, record.triangle, record.page);"}
  return output;
}
${
  program === null
    ? ""
    : `
@group(1) @binding(0) var<storage, read> material_constants: array<f32>;
@group(1) @binding(1) var<storage, read> directory: array<vec4u>;
@group(1) @binding(2) var<uniform> frame_inputs: array<vec4f, ${Math.max(1, program.inputCount)}>;
struct CoverageView { view_matrix: mat4x4f, camera_position: vec4f, }
@group(1) @binding(3) var<uniform> coverage_view: CoverageView;
fn native_material_constant(base: u32, slot: u32) -> f32 { return material_constants[base + slot]; }
${program.source.replaceAll("@group(3)", "@group(2)")}
${nativeCoverageEvaluationWgsl(program)}
fn vsm_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let squared = dot(value, value);
  if squared > 1e-20 { return value * inverseSqrt(squared); }
  return fallback;
}
fn vsm_attribute(meshlet: u32, ids: vec3u, weights: vec3f, slot: u32) -> vec4f {
  return prepared[meshlet].vertices[ids.x][slot] * weights.x +
    prepared[meshlet].vertices[ids.y][slot] * weights.y + prepared[meshlet].vertices[ids.z][slot] * weights.z;
}
struct Fragment { @builtin(position) position: vec4f, @location(0) @interpolate(flat) record: vec3u, }
@fragment
fn native_visibility_fragment(fragment: Fragment) {
  let record = VsmTrianglePage(fragment.record.x, fragment.record.y, fragment.record.z);
  let ids = vec3u(record.triangle & 255u, (record.triangle >> 8u) & 255u, (record.triangle >> 16u) & 255u);
  let a = vsm_atlas_position(prepared[record.meshlet].vertices[ids.x][0].xyz, allocation.records[record.page]);
  let b = vsm_atlas_position(prepared[record.meshlet].vertices[ids.y][0].xyz, allocation.records[record.page]);
  let c = vsm_atlas_position(prepared[record.meshlet].vertices[ids.z][0].xyz, allocation.records[record.page]);
  let extent = f32(constants.dimensions.w);
  let p = vec2f(fragment.position.x / extent * 2.0 - 1.0, 1.0 - fragment.position.y / extent * 2.0);
  let ab = b.xy - a.xy;
  let ac = c.xy - a.xy;
  let ap = p - a.xy;
  let determinant = ab.x * ac.y - ab.y * ac.x;
  let uv = vec2f(ap.x * ac.y - ap.y * ac.x, ab.x * ap.y - ab.y * ap.x) / determinant;
  let weights = vec3f(1.0 - uv.x - uv.y, uv);
  let entry = directory[prepared[record.meshlet].material];
  let world = ${world};
  let view_matrix = coverage_view.view_matrix;
  let camera_position = coverage_view.camera_position;
  ${
    (mask & 2) === 0
      ? ""
      : `let authored_normal = ${attribute(attributes.normal)};
  let geometric = vsm_normal(cross(dpdx(world.xyz), dpdy(world.xyz)), vec3f(0.0, 0.0, 1.0));
  let unflipped = vsm_normal(authored_normal.xyz, geometric);
  let flip = (prepared[record.meshlet].flags & 16u) != 0u && dot(unflipped, camera_position.xyz - world.xyz) < 0.0;
  let normal = select(unflipped, -unflipped, flip);`
  }
  ${
    (mask & 4) === 0
      ? ""
      : `let authored_tangent = ${attribute(attributes.tangent)};
  let fallback = vsm_normal(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(unflipped.z) > 0.99), unflipped), vec3f(1.0, 0.0, 0.0));
  let tangent_base = vsm_normal(authored_tangent.xyz - unflipped * dot(unflipped, authored_tangent.xyz), fallback);
  let tangent = select(tangent_base, -tangent_base, flip);`
  }
  var inputs: NativeMaterialInputs;
  ${inputs}
  let alpha = native_coverage_alpha(entry.x, inputs);
  if alpha < native_coverage_cutoff(entry.x) { discard; }
}
`
}
`;
  const read = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility,
    buffer: { type: "read-only-storage" }
  });
  const uniform = (binding: number, visibility: number, minBindingSize: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility,
    buffer: { type: "uniform", minBindingSize }
  });
  return {
    source,
    groups: [
      [
        read(0, program ? 3 : 1),
        read(1, program ? 3 : 1),
        read(2, 1),
        read(3, 1),
        read(4, program ? 3 : 1),
        uniform(5, program ? 3 : 1, VSM_PROJECTION_CONSTANT_BYTES),
        uniform(6, 1, 16)
      ],
      program
        ? [read(0, 2), read(1, 2), uniform(2, 2, Math.max(1, program.inputCount) * 16), uniform(3, 2, 80)]
        : [],
      materialLayout.map((entry) => ({ ...entry, visibility: 2 }))
    ],
    vertexEntryPoint: "native_visibility_vertex",
    fragmentEntryPoint: "native_visibility_fragment"
  };
}
