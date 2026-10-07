import { NATIVE_CASTER_QUEUE_WGSL } from "./native_raster_partitions.js";
import { VSM_ATLAS_PAGE_MATH } from "./vsm_atlas_raster.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import type { NativeMaterialProgram } from "./native_material.js";
import { surfaceGeometryDecodeWgsl } from "./surface_geometry_reader.js";
import type { PreparedFrameGeometryArena } from "../render/FrameGeometryArena.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { NATIVE_MATERIAL_DIRECTORY_WGSL } from "../gpu/GpuNativeMaterialPublication.js";
import {
  FRAME_GEOMETRY_ARENA_HEADER_WORDS as H,
  FRAME_GEOMETRY_ARENA_VERSION
} from "../gpu/GpuFrameGeometryArenaAbi.js";
import { GPU_FRAME_VERTEX_ATTRIBUTE_VECTORS } from "../gpu/GpuFrameGeometryAttributesAbi.js";

export const NATIVE_VISIBILITY_VIEW_BYTES = 192;

export interface NativeVisibilityShader {
  readonly source: string;
  readonly groups: readonly (readonly GPUBindGroupLayoutEntry[])[];
  readonly vertexEntryPoint: "native_visibility_vertex";
  readonly fragmentEntryPoint: "native_visibility_fragment";
}

/** Shared by main visibility and VSM. Uses the original full program's constant
 * offsets, scalar alpha slot, and raster suffix; extracting/re-lowering an alpha
 * DAG here would change parameter offsets. Call after the consumer supplied CXY. */
export function nativeCoverageEvaluationWgsl(program: NativeMaterialProgram): string {
  const alpha = program.outputs.alpha;
  if (alpha === undefined || alpha.length !== 1) {
    throw new RangeError("Native raster coverage requires a scalar alpha output");
  }
  return /* wgsl */ `
fn native_coverage_alpha(material_base: u32, inputs: NativeMaterialInputs) -> f32 {
  return native_material_evaluate(material_base, inputs)[${alpha[0]}u];
}
fn native_coverage_cutoff(material_base: u32) -> f32 {
  return native_material_constant(material_base, ${program.constants.length}u);
}
fn native_coverage_flags(material_base: u32) -> u32 {
  return u32(native_material_constant(material_base, ${program.constants.length + 1}u));
}
`;
}

/** Concrete view snapshot over the Geometry owner. Capacity misses use the exact
 * resident/Product source decoder rather than dropping triangles. */
export function nativeVisibilityView(
  prepared: PreparedFrameGeometryArena,
  generation: number,
  view: Readonly<{
    clipFromWorld: ArrayLike<number>;
    viewMatrix: ArrayLike<number>;
    cameraPosition: ArrayLike<number>;
    filtered?: boolean;
    source: readonly [number, number, number, number];
    sourcePayload: readonly [number, number, number, number];
  }>
): Uint8Array<ArrayBuffer> {
  if (
    !Number.isInteger(generation) ||
    generation < 1 ||
    generation > 0xffffffff ||
    (view.filtered && (prepared.budget.filteredWorkCapacity ?? 0) === 0)
  ) {
    throw new RangeError("Native visibility requires a live queue generation and allocated directory");
  }
  if (view.clipFromWorld.length !== 16 || view.viewMatrix.length !== 16 || view.cameraPosition.length !== 3) {
    throw new RangeError("Native visibility requires two matrices and one camera position");
  }
  for (const source of [view.source, view.sourcePayload]) {
    if (
      source.length !== 4 ||
      !source.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
    ) {
      throw new RangeError("Native visibility source offsets must be complete u32 values");
    }
  }
  const bytes = new Uint8Array(NATIVE_VISIBILITY_VIEW_BYTES);
  const floats = new Float32Array(bytes.buffer);
  floats.set(view.clipFromWorld, 0);
  floats.set(view.viewMatrix, 16);
  floats.set(view.cameraPosition, 32);
  if (!floats.every(Number.isFinite)) {
    throw new RangeError("Native visibility view must be finite f32");
  }
  new Uint32Array(bytes.buffer).set(
    [prepared.layout.header.offset / 4, Number(view.filtered ?? false), generation, 0],
    36
  );
  new Uint32Array(bytes.buffer).set(view.source, 40);
  new Uint32Array(bytes.buffer).set(view.sourcePayload, 44);
  return bytes;
}

/** Native winner raster. The partitioned profile consumes GPU work indices and
 * drawIndirect counts; unpartitioned is available only for independent oracles.
 * Each valid route writes the existing packed key and hardware depth once;
 * hardware perspective interpolation supplies fragment inputs. No storage writes,
 * barriers, atomics, resource allocation, queue submit, Tape, or Surface runtime.
 * VSM may use shadow=true and the same native alpha with its own clipFromWorld.
 */
export function nativeVisibilityShader(
  program: NativeMaterialProgram,
  materialLayout: readonly GPUBindGroupLayoutEntry[],
  {
    shadow = false,
    partitioned = false,
    productGeometry = false,
    vsmAtlas = false
  }: Readonly<{ shadow?: boolean; partitioned?: boolean; productGeometry?: boolean; vsmAtlas?: boolean }> = {}
): NativeVisibilityShader {
  const expressions: Readonly<Record<string, string>> = {
    uv0: "vec4f(fragment.uv01.xy, 0.0, 0.0)",
    uv1: "vec4f(fragment.uv01.zw, 0.0, 0.0)",
    uv2: "vec4f(fragment.uv2.xy, 0.0, 0.0)",
    vertexColor: "fragment.color",
    normal: "vec4f(normal, fragment.normal.w)",
    worldNormal: "vec4f(normal, fragment.normal.w)",
    tangent: "vec4f(tangent, fragment.tangent.w)",
    worldTangent: "vec4f(tangent, fragment.tangent.w)",
    position: "fragment.world_position",
    worldPosition: "fragment.world_position",
    viewDirection:
      "vec4f(native_visibility_normal(view.camera_position.xyz - fragment.world_position.xyz, normal), 0.0)",
    cameraPosition: "vec4f(view.camera_position.xyz, 1.0)",
    viewPosition: "view.view_matrix * fragment.world_position",
    viewNormal: "view.view_matrix * vec4f(normal, 0.0)"
  };
  const inputs: string[] = [];
  program.inputs.forEach((input, slot) => {
    const uniform = input.domain === "dynamic" || input.domain === "nonlocal";
    const materialInput = program.instanceInputs
      ? `vec4f(${Array.from(
          { length: 4 },
          (_, channel) =>
            `native_material_constant(entry.constant_base, ${program.constants.length + 2 + slot * 4 + channel}u)`
        ).join(", ")})`
      : `native_frame_inputs[${slot}u]`;
    const expression = uniform ? materialInput : expressions[input.name];
    if (expression === undefined) {
      throw new RangeError(`Native visibility input '${input.name}' requires a geometry semantic`);
    }
    inputs.push(/* wgsl */ `
  let input_${slot} = ${expression};
  inputs.center[${slot}u] = input_${slot};
  inputs.x[${slot}u] = input_${slot}${uniform ? "" : ` + dpdx(input_${slot})`};
  inputs.y[${slot}u] = input_${slot}${uniform ? "" : ` + dpdy(input_${slot})`};`);
  });
  const source = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${vsmAtlas ? NATIVE_CASTER_QUEUE_WGSL : ""}
${GPU_VISIBILITY_KEY_WGSL}
${NATIVE_MATERIAL_DIRECTORY_WGSL}
struct NativeVisibilityView {
  clip_from_world: mat4x4f,
  view_matrix: mat4x4f,
  camera_position: vec4f,
  arena: vec4u,
  source: vec4u,
  source_payload: vec4u,
}
@group(0) @binding(0) var<storage, read> meshlet_work: ${vsmAtlas ? "NativeCasterQueue" : "OEngineMeshletWorkQueueRead"};
@group(0) @binding(1) var<storage, read> arena: array<u32>;
@group(0) @binding(2) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(3) var<uniform> view: NativeVisibilityView;
@group(2) @binding(0) var<storage, read> native_constants: array<f32>;
@group(2) @binding(1) var<storage, read> native_directory: array<NativeMaterialDirectoryEntry>;
@group(2) @binding(3) var<uniform> route: vec4u;
@group(2) @binding(4) var<uniform> native_frame_inputs: array<vec4f, ${Math.max(program.inputCount, 1)}>;
fn native_material_constant(base: u32, slot: u32) -> f32 { return native_constants[base + slot]; }
${surfaceGeometryDecodeWgsl(productGeometry, "arena").replaceAll("settings.source", "view.source")}
@group(0) @binding(4) var<storage, read> vertex_payload: array<u32>;
${
  partitioned
    ? `@group(0) @binding(5) var<storage, read> native_raster_indices: array<u32>;
@group(0) @binding(6) var<storage, read> native_raster_states: array<vec4u>;
@group(0) @binding(7) var<uniform> native_raster_partition: vec4u;`
    : ""
}
${
  productGeometry
    ? `@group(0) @binding(8) var<storage, read> product_heap: array<u32>;
${Array.from({ length: 4 }, (_, index) => `@group(0) @binding(${index + 9}) var<storage,read> product_bank_${index}: array<u32>;`).join("\n")}`
    : ""
}
${
  vsmAtlas
    ? `${VSM_PAGE_TABLE_WGSL}
struct VsmAtlasConstants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f,
  6>,
  dimensions: vec4u,
  control: vec4u,
}
struct VsmPageTableBuffer {
  entries: array<VsmPageEntry>,
}
@group(0) @binding(13) var<uniform> constants: VsmAtlasConstants;
@group(0) @binding(14) var<storage,read> page_table: VsmPageTableBuffer;
${VSM_ATLAS_PAGE_MATH}`
    : ""
}
${program.source}
${nativeCoverageEvaluationWgsl(program)}
struct NativeVisibilityVertex {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) work: u32,
  @location(1) @interpolate(flat) primitive: u32,
  @location(2) @interpolate(flat) material: u32,
  @location(3) uv01: vec4f,
  @location(4) uv2: vec4f,
  @location(5) color: vec4f,
  @location(6) normal: vec4f,
  @location(7) tangent: vec4f,
  @location(8) world_position: vec4f,
  @location(9) @interpolate(flat) flags: u32,
  ${vsmAtlas ? "@location(10) @interpolate(flat) page_bounds: vec4f," : ""}
}
fn native_visibility_vec4(at: u32) -> vec4f {
  return bitcast<vec4f>(vec4u(arena[at], arena[at + 1u], arena[at + 2u], arena[at + 3u]));
}
fn native_visibility_attribute(base: u32, vertex: u32, field: u32) -> vec4f {
  return native_visibility_vec4(base + (vertex * ${GPU_FRAME_VERTEX_ATTRIBUTE_VECTORS}u + field) * 4u);
}
@vertex
fn native_visibility_vertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance_index: u32) -> NativeVisibilityVertex {
  var output: NativeVisibilityVertex;
  output.position = vec4f(2.0, 2.0, 2.0, 1.0);
  ${
    partitioned
      ? `let partition_state = native_raster_states[native_raster_partition.x];
  if instance_index >= partition_state.x {
    return output;
  }
  let work_index = native_raster_indices[partition_state.y + instance_index];`
      : "let work_index = instance_index;"
  }
  let generation = view.arena.z;
  if meshlet_work.header.generation != ${vsmAtlas ? "view.arena.w" : "generation"} ||
    work_index >= min(meshlet_work.header.written_count, ${vsmAtlas ? "arrayLength(&meshlet_work.elements)" : "min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements))"}) {
    return output;
  }
  ${
    vsmAtlas
      ? `let caster = meshlet_work.elements[work_index];
  let page = valid_page(caster);
  if (page.flags & 11u) != 11u || caster.virtual_page >= arrayLength(&page_table.entries) {
    return output;
  }
  let work = OEngineMeshletRasterWork(caster.instance_slot, caster.geometry_slot, caster.meshlet_slot,
    caster.material_slot_or_range, caster.packed_raster_flags, caster.packed_profile_lod);`
      : "let work = meshlet_work.elements[work_index];"
  }
  if work.instance_slot >= arrayLength(&frame_instances) || work.material_slot_or_range >= arrayLength(&native_directory) {
    return output;
  }
  let instance = frame_instances[work.instance_slot];
  if (instance.source.flags & 64u) != 0u {
    return output;
  }
  let material = native_directory[work.material_slot_or_range];
  if instance.generation != generation || material.execution_bin != route.x || material.program_index == 0xffffffffu {
    return output;
  }
  let header = view.arena.x;
  if arena[header + ${H.version}u] != ${FRAME_GEOMETRY_ARENA_VERSION}u { return output; }
  let directory = arena[header + select(${H.sourceDirectory}u, ${H.filteredDirectory}u, view.arena.y != 0u)];
  let cached = ${vsmAtlas ? "false" : "arena[directory + 1u] == generation && work_index < arena[directory]"};
  let primitive = vertex / 3u;
  let input_corner = vertex % 3u;
  let corner = select(input_corner, 3u - input_corner, instance.normal_x.w < 0.0 && input_corner != 0u);
  let at = directory + 4u + work_index * 4u;
  let vertex_base = arena[at];
  let triangle_base = arena[at + 1u];
  let vertex_count = arena[at + 2u];
  let triangle_count = arena[at + 3u];
  if !cached || vertex_count == 0u {
    let count = surface_source_load(work);
    if primitive >= count.y || primitive > OENGINE_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE {
      return output;
    }
    let local_vertex = surface_source_triangle_corner(primitive, corner);
    if local_vertex >= count.x {
      return output;
    }
    let transform = oengine_instance_current_object_to_world(instance.source);
    let position = surface_source_vertex_position(local_vertex);
    output.world_position = transform * vec4f(position, 1.0);
    output.position = ${shadow ? "view.clip_from_world * output.world_position" : "instance.object_to_clip * vec4f(position, 1.0)"};
    let normal = surface_source_vertex_normal(local_vertex);
    let cofactor = mat3x3f(instance.normal_x.xyz, instance.normal_y, instance.normal_z.xyz) * sign(instance.normal_x.w);
    output.normal = vec4f(cofactor * normal.xyz, normal.w);
    let tangent = surface_source_vertex_tangent(local_vertex);
    output.tangent = vec4f((transform * vec4f(tangent.xyz, 0.0)).xyz, tangent.w * sign(instance.normal_x.w));
    output.uv01 = vec4f(surface_source_vertex_uv(local_vertex, 0u), surface_source_vertex_uv(local_vertex, 1u));
    output.uv2 = vec4f(surface_source_vertex_uv(local_vertex, 2u), 0.0, 0.0);
    output.color = surface_source_vertex_color(local_vertex);
  } else {
  if primitive >= triangle_count || primitive > OENGINE_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE {
    return output;
  }
  let packed = arena[arena[header + ${H.triangles}u] + triangle_base + primitive];
  let local_vertex = (packed >> (corner * 8u)) & 255u;
  if local_vertex >= vertex_count {
    return output;
  }
  let absolute_vertex = vertex_base + local_vertex;
  let attributes = arena[header + ${H.attributes}u];
  output.world_position = native_visibility_attribute(attributes, absolute_vertex, 8u);
  output.position = ${shadow ? "view.clip_from_world * output.world_position" : "native_visibility_vec4(arena[header + " + H.clips + "u] + absolute_vertex * 4u)"};
  output.uv01 = native_visibility_attribute(attributes, absolute_vertex, 2u);
  output.uv2 = native_visibility_attribute(attributes, absolute_vertex, 4u);
  output.color = native_visibility_attribute(attributes, absolute_vertex, 3u);
  output.normal = native_visibility_attribute(attributes, absolute_vertex, 6u);
  output.tangent = native_visibility_attribute(attributes, absolute_vertex, 7u);
  }
  ${
    vsmAtlas
      ? `let light = (constants.light_view * output.world_position).xyz;
  output.position = atlas_position(light, page, caster.virtual_page);
  let pitch = constants.dimensions.y + constants.dimensions.z * 2u;
  let origin = vec2f(vec2u(page.slot_x, page.slot_y)) * f32(pitch);
  output.page_bounds = vec4f(origin, origin + vec2f(f32(pitch)));`
      : ""
  }
  output.flags = instance.source.flags;
  output.work = work_index;
  output.primitive = primitive;
  output.material = work.material_slot_or_range;
  return output;
}
fn native_visibility_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let squared = dot(value, value);
  if squared > 1e-20 {
    return value * inverseSqrt(squared);
  }
  return fallback;
}
@fragment
fn native_visibility_fragment(fragment: NativeVisibilityVertex) -> @location(0) u32 {
  let entry = native_directory[fragment.material];
  let geometric = native_visibility_normal(cross(dpdx(fragment.world_position.xyz), dpdy(fragment.world_position.xyz)), vec3f(0.0, 0.0, 1.0));
  let unflipped = native_visibility_normal(fragment.normal.xyz, geometric);
  let flip = (fragment.flags & 16u) != 0u && dot(unflipped, view.camera_position.xyz - fragment.world_position.xyz) < 0.0;
  let normal = select(unflipped, -unflipped, flip);
  let fallback = native_visibility_normal(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(unflipped.z) > 0.99), unflipped), vec3f(1.0, 0.0, 0.0));
  let unflipped_tangent = native_visibility_normal(fragment.tangent.xyz - unflipped * dot(unflipped, fragment.tangent.xyz), fallback);
  let tangent = select(unflipped_tangent, -unflipped_tangent, flip);
  var inputs: NativeMaterialInputs;
${inputs.join("\n")}
  ${vsmAtlas ? `if any(fragment.position.xy < fragment.page_bounds.xy) || any(fragment.position.xy >= fragment.page_bounds.zw) { discard; }` : ""}
  // All fragment derivatives have been produced before any coverage discard.
  let alpha = native_coverage_alpha(entry.constant_base, inputs);
  let flags = native_coverage_flags(entry.constant_base);
  if (flags & 1u) != 0u && alpha < native_coverage_cutoff(entry.constant_base) {
    discard;
  }
  let key = oengine_visibility_key_try_encode(fragment.work, fragment.primitive);
  if key.valid == 0u {
    discard;
  }
  return key.key;
}
`;
  const read = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility,
    buffer: { type: "read-only-storage" }
  });
  const groups = [
    [
      read(0, 1),
      read(1, 1),
      read(2, 1),
      read(4, 1),
      ...(partitioned
        ? [
            read(5, 1),
            read(6, 1),
            { binding: 7, visibility: 1, buffer: { type: "uniform" as const, minBindingSize: 16 } }
          ]
        : []),
      ...(productGeometry ? [read(8, 1), read(9, 1), read(10, 1), read(11, 1), read(12, 1)] : []),
      ...(vsmAtlas
        ? [
            { binding: 13, visibility: 1, buffer: { type: "uniform" as const, minBindingSize: 192 } },
            read(14, 1)
          ]
        : []),
      {
        binding: 3,
        visibility: 3,
        buffer: { type: "uniform" as const, minBindingSize: NATIVE_VISIBILITY_VIEW_BYTES }
      }
    ],
    [],
    [
      read(0, 2),
      read(1, 3),
      { binding: 3, visibility: 1, buffer: { type: "uniform" as const, minBindingSize: 16 } },
      {
        binding: 4,
        visibility: 2,
        buffer: { type: "uniform" as const, minBindingSize: Math.max(program.inputCount, 1) * 16 }
      }
    ],
    materialLayout.map((entry) => ({ ...entry, visibility: 2 }))
  ];
  return Object.freeze({
    source,
    groups: Object.freeze(groups),
    vertexEntryPoint: "native_visibility_vertex",
    fragmentEntryPoint: "native_visibility_fragment"
  });
}
