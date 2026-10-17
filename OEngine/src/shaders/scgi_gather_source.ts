import type { NativeMaterialProgram } from "./native_material.js";
import { surfaceGeometryCompletionWgsl } from "./surface_geometry_completion.js";
import { NATIVE_GEOMETRY_INPUTS_WGSL } from "./native_geometry_inputs.js";
import { GEOMETRY_INPUTS } from "./native_surface.js";
import { nativeDiffuseHitEvaluationWgsl } from "./native_diffuse_hit.js";
import { VIRTUAL_TEXTURE_FEEDBACK_WGSL } from "./virtual_texture.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";

export function scgiGatherClassifyWgsl(batch: number): string {
  return /* wgsl */ `
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
struct Settings { extent: vec4u, segment: vec4u, }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read> work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var visibility: texture_2d<u32>;
@group(0) @binding(3) var<storage, read> anchors: array<u32>;
@group(0) @binding(4) var<storage, read_write> rays: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${batch}u) { return; }
  let result = ${batch * 12}u + id.x * 8u;
  rays[result + 3u] = 1u;
  rays[result + 4u] = 0xffffffffu;
  if (id.x >= settings.segment.w) { return; }
  let at = (settings.segment.z + id.x - settings.segment.x) * 32u;
  if (bitcast<f32>(anchors[at + 3u]) == 0.0) { return; }
  let pixel = anchors[at + 7u];
  let key = textureLoad(visibility, vec2i(i32(pixel % settings.extent.x), i32(pixel / settings.extent.x)), 0).x;
  let decoded = oengine_visibility_key_resolve(key, work.header.generation, work.header.written_count);
  if (decoded.valid == 0u) { return; }
  rays[result + 3u] = 0u;
  rays[result + 4u] = work.elements[decoded.meshlet_work_slot].instance_slot;
}
`;
}

/** Exact raster projection of the already lowered diffuse Native graph. One
 * bounded source batch, no camera ray, approximate hit, HDR read or second scene. */
export function scgiGatherSourceWgsl(
  program: NativeMaterialProgram,
  product: boolean,
  unlit: boolean,
  workList: number
): string {
  let needs = (1 << 5) | (1 << 6) | (1 << 7);
  const inputs: string[] = [];
  program.inputs.forEach((input, index) => {
    const uniform = input.domain === "dynamic" || input.domain === "nonlocal";
    let expression: string;
    if (uniform) {
      expression = `vec4f(${[0, 1, 2, 3]
        .map(
          (channel) =>
            `native_material_constant(material_base, ${program.constants.length + 2 + index * 4 + channel}u)`
        )
        .join(", ")})`;
    } else {
      const kind = GEOMETRY_INPUTS[input.name];
      if (kind === undefined) {
        throw new RangeError(`SCGI source has no Native semantic '${input.name}'`);
      }
      needs |= 1 << kind;
      expression = `native_geometry_input(corners, WEIGHTS, ${kind}u)`;
    }
    for (const [point, weights] of [
      ["center", "interpolation.weights"],
      ["x", "interpolation.weights + interpolation.dx"],
      ["y", "interpolation.weights + interpolation.dy"]
    ]) {
      inputs.push(`  inputs.${point}[${index}u] = ${expression.replace("WEIGHTS", weights!)};`);
    }
  });
  return /* wgsl */ `
${surfaceGeometryCompletionWgsl(product, false, false, true)}
struct SourceSettings {
  source: vec4u,
  source_payload: vec4u,
  dimensions: vec4u,
  camera_position_exposure: vec4f,
  view_matrix: mat4x4f,
  background: vec4f,
  inverse_view_projection: mat4x4f,
  segment: vec4u, // first half pixel, segment count, batch first, batch count
  route: vec4u, // query bin
}
struct SourceAnchor {
  positionValid: vec4f,
  normal: vec3f,
  sourcePixel: u32,
  previousPositionValid: vec4f,
  motionDepth: vec4f,
  identity: array<u32, 16>,
}
@group(0) @binding(0) var<uniform> settings: SourceSettings;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> source_heap: array<u32>;
@group(0) @binding(3) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(4) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(5) var visibility: texture_2d<u32>;
@group(0) @binding(6) var<storage, read_write> source_hits: array<vec4f>;
@group(0) @binding(7) var<storage, read> anchors: array<SourceAnchor>;
@group(0) @binding(8) var<storage, read> source_directory: array<vec4u>;
@group(0) @binding(9) var<storage, read> source_constants: array<f32>;
${
  product
    ? ["product_heap", "product_bank_0", "product_bank_1", "product_bank_2", "product_bank_3"]
        .map((name, binding) => `@group(1) @binding(${binding}) var<storage, read> ${name}: array<u32>;`)
        .join("\n")
    : ""
}
${program.virtualTextures ? VIRTUAL_TEXTURE_FEEDBACK_WGSL : ""}
@group(2) @binding(2) var<storage, read> source_work: array<u32>;
const geometry_needs: u32 = ${needs}u;
fn native_material_constant(base: u32, slot: u32) -> f32 {
  return source_constants[base + slot];
}
${program.source}
${NATIVE_GEOMETRY_INPUTS_WGSL}
${nativeDiffuseHitEvaluationWgsl(program, unlit)}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let bin_at = settings.route.x * 8u;
  if (id.x >= source_work[bin_at]) { return; }
  let lane = source_work[${workList}u + source_work[bin_at + 1u] + id.x];
  if (lane >= settings.segment.w) { return; }
  let half_index = settings.segment.z + lane;
  if (half_index < settings.segment.x || half_index - settings.segment.x >= settings.segment.y) { return; }
  let anchor = anchors[half_index - settings.segment.x];
  if (anchor.positionValid.w == 0.0) { return; }
  let pixel = vec2u(anchor.sourcePixel % settings.dimensions.x, anchor.sourcePixel / settings.dimensions.x);
  let key = textureLoad(visibility, vec2i(pixel), 0).x;
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
  if (decoded.valid == 0u) { return; }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  if (work.instance_slot >= arrayLength(&frame_instances) || work.material_slot_or_range >= arrayLength(&source_directory)) { return; }
  let entry = source_directory[work.material_slot_or_range];
  if (entry.y != settings.route.x || entry.w == 0u) { return; }
  let instance = frame_instances[work.instance_slot];
  let resolved = geometry_complete_resolved(decoded, work, instance);
  let interpolation = winner_interpolate(resolved.coefficients, vec2f(pixel) + vec2f(0.5), vec2f(settings.dimensions.xy));
  if ((interpolation.flags & WINNER_VALUE_VALID) == 0u) { return; }
  let corners = geometry_complete_attributes(resolved, instance);
  let material_base = entry.x;
  var inputs: NativeMaterialInputs;
${inputs.join("\n")}
  let normal = native_geometry_input(corners, interpolation.weights, 5u).xyz;
  let tangent = native_geometry_input(corners, interpolation.weights, 6u);
  let basis = mat3x3f(tangent.xyz, cross(normal, tangent.xyz) * tangent.w, normal);
  let hit = native_diffuse_hit(material_base, inputs, basis, settings.camera_position_exposure.xyz - anchor.positionValid.xyz);
  let at = lane * 6u;
  source_hits[at] = vec4f(hit.diffuse, hit.occlusion);
  source_hits[at + 1u] = vec4f(hit.emission, hit.underlayer);
  source_hits[at + 2u] = vec4f(hit.normal, f32(hit.valid));
  source_hits[at + 3u] = vec4f(anchor.positionValid.xyz, bitcast<f32>(instance.source.flags));
  source_hits[at + 4u] = bitcast<vec4f>(vec4u(work.instance_slot, anchor.identity[6], anchor.identity[8], anchor.identity[12]));
  let error = max(0.00001, 32.0 * 1.1920928955078125e-7 * max(1.0, length(anchor.positionValid.xyz)));
  source_hits[at + 5u] = vec4f(anchor.normal, error);
}
`;
}
