import { FRAME_GEOMETRY_MESHLET_STRIDE } from "../gpu/GpuWinnerInterpolationAbi.js";
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
import { NATIVE_RASTER_DIRECTORY_WGSL } from "../gpu/GpuNativeMaterialPublication.js";
import {
  FRAME_GEOMETRY_ARENA_HEADER_WORDS as H,
  FRAME_GEOMETRY_ARENA_VERSION,
} from "../gpu/GpuFrameGeometryArenaAbi.js";

export const NATIVE_VISIBILITY_VIEW_BYTES = 192;

export interface NativeVisibilityShader {
  readonly source: string;
  readonly groups: readonly (readonly GPUBindGroupLayoutEntry[])[];
  readonly vertexEntryPoint: "native_visibility_vertex";
  readonly fragmentEntryPoint: "native_visibility_fragment";
}

/** Main and VSM consume the same independently lowered coverage program and
 * its own constant offsets. Exact alpha resources are bound by residency. */
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
  }>,
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
    36,
  );
  new Uint32Array(bytes.buffer).set(view.source, 40);
  new Uint32Array(bytes.buffer).set(view.sourcePayload, 44);
  return bytes;
}

/** Universal OPAQUE has no material inputs, evaluator or texture bindings.
 * MASK supplies only its independently compiled coverage dependencies. Both
 * consume the minimal clip/triangle cache; capacity misses decode exact source.
 * Caster work always uses source geometry because its work namespace differs. */
export function nativeVisibilityShader(
  program: NativeMaterialProgram | null,
  materialLayout: readonly GPUBindGroupLayoutEntry[],
  {
    shadow = false,
    partitioned = false,
    productGeometry = false,
    vsmAtlas = false,
  }: Readonly<{
    shadow?: boolean;
    partitioned?: boolean;
    productGeometry?: boolean;
    vsmAtlas?: boolean;
  }> = {},
): NativeVisibilityShader {
  if (program === null && materialLayout.length !== 0)
    throw new RangeError("OPAQUE visibility cannot bind material textures");
  if (
    program !== null &&
    (program.outputs.alpha?.length !== 1 || Object.keys(program.outputs).length !== 1)
  ) {
    throw new RangeError("MASK visibility requires an independently lowered coverage-only program");
  }
  const dependencies = new Set(
    program?.inputs
      .filter((input) => input.domain !== "dynamic" && input.domain !== "nonlocal")
      .map((input) => input.name),
  );
  const needsNormal = [
    "normal",
    "worldNormal",
    "viewNormal",
    "tangent",
    "worldTangent",
    "viewDirection",
  ].some((name) => dependencies.has(name));
  const needsTangent = dependencies.has("tangent") || dependencies.has("worldTangent");
  const needsPosition =
    needsNormal || ["position", "worldPosition", "viewPosition"].some((name) => dependencies.has(name));
  const fields: string[] = [];
  const vertexInputs: string[] = [];
  const expressions: Record<string, string> = {
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
    viewNormal: "view.view_matrix * vec4f(normal, 0.0)",
  };
  for (const [index, name] of ["uv0", "uv1", "uv2"].entries()) {
    if (!dependencies.has(name)) continue;
    fields.push(`@location(${3 + index}) ${name}: vec2f,`);
    vertexInputs.push(`output.${name} = surface_source_vertex_uv(local_vertex, ${index}u);`);
    expressions[name] = `vec4f(fragment.${name}, 0.0, 0.0)`;
  }
  if (dependencies.has("vertexColor")) {
    fields.push("@location(6) color: vec4f,");
    vertexInputs.push("output.color = surface_source_vertex_color(local_vertex);");
    expressions.vertexColor = "fragment.color";
  }
  if (needsPosition) fields.push("@location(7) world_position: vec4f,");
  if (needsNormal) {
    fields.push("@location(8) normal: vec4f,", "@location(10) @interpolate(flat) flags: u32,");
    vertexInputs.push(`let authored_normal = surface_source_vertex_normal(local_vertex);
    let cofactor = mat3x3f(instance.normal_x.xyz, instance.normal_y, instance.normal_z.xyz) * sign(instance.normal_x.w);
    output.normal = vec4f(cofactor * authored_normal.xyz, authored_normal.w);
    output.flags = instance.source.flags;`);
  }
  if (needsTangent) {
    fields.push("@location(9) tangent: vec4f,");
    vertexInputs.push(`let authored_tangent = surface_source_vertex_tangent(local_vertex);
    output.tangent = vec4f((transform * vec4f(authored_tangent.xyz, 0.0)).xyz,
      authored_tangent.w * sign(instance.normal_x.w));`);
  }
  const inputs =
    program?.inputs
      .map((input, slot) => {
        const uniform = input.domain === "dynamic" || input.domain === "nonlocal";
        const uniformValue = program.instanceInputs
          ? `vec4f(${Array.from(
              { length: 4 },
              (_, channel) =>
                `native_material_constant(entry.constant_base, ${program.constants.length + 2 + slot * 4 + channel}u)`,
            ).join(", ")})`
          : `native_frame_inputs[${slot}u]`;
        const expression = uniform ? uniformValue : expressions[input.name];
        if (expression === undefined)
          throw new RangeError(`Native coverage input '${input.name}' requires a geometry semantic`);
        return `let input_${slot} = ${expression};
    inputs.center[${slot}u] = input_${slot};
    inputs.x[${slot}u] = input_${slot}${uniform ? "" : ` + dpdx(input_${slot})`};
    inputs.y[${slot}u] = input_${slot}${uniform ? "" : ` + dpdy(input_${slot})`};`;
      })
      .join("\n") ?? "";
  const source = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${vsmAtlas ? NATIVE_CASTER_QUEUE_WGSL : ""}
${GPU_VISIBILITY_KEY_WGSL}
${NATIVE_RASTER_DIRECTORY_WGSL}
struct NativeVisibilityView {
  clip_from_world: mat4x4f, view_matrix: mat4x4f, camera_position: vec4f,
  arena: vec4u, source: vec4u, source_payload: vec4u,
}
@group(0) @binding(0) var<storage, read> meshlet_work: ${vsmAtlas ? "NativeCasterQueue" : "OEngineMeshletWorkQueueRead"};
@group(0) @binding(1) var<storage, read> arena: array<u32>;
@group(0) @binding(2) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(3) var<uniform> view: NativeVisibilityView;
@group(0) @binding(4) var<storage, read> vertex_payload: array<u32>;
@group(2) @binding(1) var<storage, read> native_directory: array<NativeRasterDirectoryEntry>;
@group(2) @binding(3) var<uniform> route: vec4u;
${
  program === null
    ? ""
    : `@group(2) @binding(0) var<storage, read> native_constants: array<f32>;
@group(2) @binding(4) var<uniform> native_frame_inputs: array<vec4f, ${Math.max(program.inputCount, 1)}>;
fn native_material_constant(base: u32, slot: u32) -> f32 { return native_constants[base + slot]; }`
}
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
${Array.from({ length: 4 }, (_, index) => `@group(0) @binding(${index + 9}) var<storage, read> product_bank_${index}: array<u32>;`).join("\n")}`
    : ""
}
${surfaceGeometryDecodeWgsl(productGeometry, "arena").replaceAll("settings.source", "view.source")}
${
  vsmAtlas
    ? `${VSM_PAGE_TABLE_WGSL}
struct VsmAtlasConstants {
  light_view: mat4x4f, clip_origin_extent: array<vec4f, 6>, dimensions: vec4u, control: vec4u,
  parameters: vec4f, depth_range: vec4f, identity: vec4u,
}
struct VsmPageTableBuffer { entries: array<VsmPageEntry>, }
@group(0) @binding(13) var<uniform> constants: VsmAtlasConstants;
@group(0) @binding(14) var<storage, read> page_table: VsmPageTableBuffer;
${VSM_ATLAS_PAGE_MATH}`
    : ""
}
${program === null ? "" : program.source + nativeCoverageEvaluationWgsl(program)}
struct NativeVisibilityVertex {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) work: u32,
  @location(1) @interpolate(flat) primitive: u32,
  ${program === null ? "" : "@location(2) @interpolate(flat) material: u32,"}
  ${fields.join("\n")}
  ${vsmAtlas ? "@location(11) @interpolate(flat) page_bounds: vec4f," : ""}
}
fn native_visibility_vec4(at: u32) -> vec4f {
  return bitcast<vec4f>(vec4u(arena[at], arena[at + 1u], arena[at + 2u], arena[at + 3u]));
}
@vertex
fn native_visibility_vertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance_index: u32) -> NativeVisibilityVertex {
  var output: NativeVisibilityVertex;
  output.position = vec4f(2.0, 2.0, 2.0, 1.0);
  ${
    partitioned
      ? `let partition_state = native_raster_states[native_raster_partition.x];
  if instance_index >= partition_state.x { return output; }
  let work_index = native_raster_indices[partition_state.y + instance_index];`
      : "let work_index = instance_index;"
  }
  let generation = view.arena.z;
  if meshlet_work.header.generation != ${vsmAtlas ? "view.arena.w" : "generation"} ||
    work_index >= min(meshlet_work.header.written_count, ${vsmAtlas ? "arrayLength(&meshlet_work.elements)" : "min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements))"}) { return output; }
  ${
    vsmAtlas
      ? `let caster = meshlet_work.elements[work_index];
  let page = valid_page(caster);
  if (page.flags & 11u) != 11u || caster.virtual_page >= arrayLength(&page_table.entries) { return output; }
  let work = OEngineMeshletRasterWork(caster.instance_slot, caster.geometry_slot, caster.meshlet_slot,
    caster.material_slot_or_range, caster.packed_raster_flags, caster.packed_profile_lod);`
      : "let work = meshlet_work.elements[work_index];"
  }
  if work.instance_slot >= arrayLength(&frame_instances) || work.material_slot_or_range >= arrayLength(&native_directory) { return output; }
  let instance = frame_instances[work.instance_slot];
  let material = native_directory[work.material_slot_or_range];
  if instance.generation != generation || (instance.source.flags & 64u) != 0u ||
    material.raster_class != route.x || material.valid == 0u { return output; }
  let header = view.arena.x;
  if arena[header + ${H.version}u] != ${FRAME_GEOMETRY_ARENA_VERSION}u { return output; }
  let directory = arena[header + select(${H.sourceDirectory}u, ${H.filteredDirectory}u, view.arena.y != 0u)];
  let at = directory + 4u + work_index * ${FRAME_GEOMETRY_MESHLET_STRIDE / 4}u;
  let cached = ${vsmAtlas ? "false" : "arena[directory + 1u] == generation && work_index < arena[directory] && arena[at + 2u] != 0u"};
  let primitive = vertex / 3u;
  let input_corner = vertex % 3u;
  let corner = select(input_corner, 3u - input_corner, instance.normal_x.w < 0.0 && input_corner != 0u);
  if primitive > OENGINE_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE { return output; }
  var local_vertex: u32;
  if cached {
    if primitive >= arena[at + 3u] { return output; }
    let packed = arena[arena[header + ${H.triangles}u] + arena[at + 1u] + primitive];
    local_vertex = (packed >> (corner * 8u)) & 255u;
    if local_vertex >= arena[at + 2u] { return output; }
    output.position = native_visibility_vec4(arena[header + ${H.clips}u] + (arena[at] + local_vertex) * 4u);
  }
  // OPAQUE cache hits do not initialize the source decoder or load attributes.
  ${program !== null || shadow || vsmAtlas ? "{" : "if !cached {"}
    let count = surface_source_load(work);
    if primitive >= count.y { return output; }
    if !cached { local_vertex = surface_source_triangle_corner(primitive, corner); }
    if local_vertex >= count.x { return output; }
    ${shadow || vsmAtlas || needsPosition || needsTangent ? "let transform = oengine_instance_current_object_to_world(instance.source);" : ""}
    ${shadow || vsmAtlas || needsPosition ? "let world_position = transform * vec4f(surface_source_vertex_position(local_vertex), 1.0);" : ""}
    ${needsPosition ? "output.world_position = world_position;" : ""}
    ${
      vsmAtlas
        ? `let light = (constants.light_view * world_position).xyz;
    output.position = atlas_position(light, page, caster.virtual_page);
    let pitch = constants.dimensions.y + constants.dimensions.z * 2u;
    let origin = vec2f(vec2u(page.slot_x, page.slot_y)) * f32(pitch);
    output.page_bounds = vec4f(origin, origin + vec2f(f32(pitch)));`
        : shadow
          ? "output.position = view.clip_from_world * world_position;"
          : "if !cached { output.position = instance.object_to_clip * vec4f(surface_source_vertex_position(local_vertex), 1.0); }"
    }
    ${vertexInputs.join("\n")}
  }
  output.work = work_index;
  output.primitive = primitive;
  ${program === null ? "" : "output.material = work.material_slot_or_range;"}
  return output;
}
${
  needsNormal
    ? `fn native_visibility_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let squared = dot(value, value);
  if squared > 1e-20 { return value * inverseSqrt(squared); }
  return fallback;
}`
    : ""
}
@fragment
fn native_visibility_fragment(fragment: NativeVisibilityVertex) -> @location(0) u32 {
  ${program === null ? "" : "let entry = native_directory[fragment.material];"}
  ${
    needsNormal
      ? `let geometric = native_visibility_normal(cross(dpdx(fragment.world_position.xyz), dpdy(fragment.world_position.xyz)), vec3f(0.0, 0.0, 1.0));
  let unflipped = native_visibility_normal(fragment.normal.xyz, geometric);
  let flip = (fragment.flags & 16u) != 0u && dot(unflipped, view.camera_position.xyz - fragment.world_position.xyz) < 0.0;
  let normal = select(unflipped, -unflipped, flip);`
      : ""
  }
  ${
    needsTangent
      ? `let fallback = native_visibility_normal(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(unflipped.z) > 0.99), unflipped), vec3f(1.0, 0.0, 0.0));
  let unflipped_tangent = native_visibility_normal(fragment.tangent.xyz - unflipped * dot(unflipped, fragment.tangent.xyz), fallback);
  let tangent = select(unflipped_tangent, -unflipped_tangent, flip);`
      : ""
  }
  ${program === null ? "" : `var inputs: NativeMaterialInputs;\n${inputs}`}
  ${vsmAtlas ? "if any(fragment.position.xy < fragment.page_bounds.xy) || any(fragment.position.xy >= fragment.page_bounds.zw) { discard; }" : ""}
  ${
    program === null
      ? ""
      : `// Derivatives are evaluated before any coverage discard.
  let alpha = native_coverage_alpha(entry.constant_base, inputs);
  if alpha < native_coverage_cutoff(entry.constant_base) { discard; }`
  }
  let key = oengine_visibility_key_try_encode(fragment.work, fragment.primitive);
  if key.valid == 0u { discard; }
  return key.key;
}
`;
  const read = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility,
    buffer: { type: "read-only-storage" },
  });
  const uniform = (binding: number, visibility: number, size: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility,
    buffer: { type: "uniform", minBindingSize: size },
  });
  const groups = [
    [
      read(0, 1),
      read(1, 1),
      read(2, 1),
      read(4, 1),
      uniform(3, 3, NATIVE_VISIBILITY_VIEW_BYTES),
      ...(partitioned ? [read(5, 1), read(6, 1), uniform(7, 1, 16)] : []),
      ...(productGeometry ? [read(8, 1), read(9, 1), read(10, 1), read(11, 1), read(12, 1)] : []),
      ...(vsmAtlas ? [uniform(13, 1, 240), read(14, 1)] : [])
    ],
    [],
    [
      read(1, program === null ? 1 : 3),
      uniform(3, 1, 16),
      ...(program === null ? [] : [read(0, 2), uniform(4, 2, Math.max(program.inputCount, 1) * 16)]),
    ],
    materialLayout.map((entry) => ({ ...entry, visibility: 2 })),
  ];
  return Object.freeze({
    source,
    groups: Object.freeze(groups),
    vertexEntryPoint: "native_visibility_vertex",
    fragmentEntryPoint: "native_visibility_fragment",
  });
}
