import type { NativeMaterialProgram } from "./native_material.js";
import { GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";
import {
  selectAppearanceProductProgram,
  type CompiledAppearanceGraph,
} from "../material/AppearanceGraphCompiler.js";
import type { AppearanceProgramDescriptor } from "../gpu/AppearanceProgramRegistry.js";
import { NATIVE_MATERIAL_DIRECTORY_WGSL } from "../gpu/GpuNativeMaterialPublication.js";
import { surfaceGeometryCompletionWgsl } from "./surface_geometry_completion.js";
import { NATIVE_LOCAL_LIGHTING } from "./native_local_lighting.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "./environment_ibl.js";
import { ENVIRONMENT_BRDF_WGSL } from "./native_environment_brdf.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "./working_color.js";
import { nativeSurfaceAuxWgsl } from "./native_surface_aux.js";
import {
  nativeSurfacePhysicalSunLayoutEntries,
  nativeSurfacePhysicalSunWgsl,
} from "./native_surface_lighting.js";

export interface NativeSurfaceShaderProfile {
  readonly compact: boolean;
  readonly productGeometry: boolean;
  readonly unlit: boolean;
  readonly reactive: boolean;
  readonly physicalSun?: boolean;
  /** Resource-limit continuation: recompute native inputs, then add shadowed sun. */
  readonly additiveSun?: boolean;
}

export const NATIVE_SURFACE_SETTINGS_BYTES = 144;
const SURFACE_GRAPHS = new WeakMap<CompiledAppearanceGraph, Map<boolean, CompiledAppearanceGraph>>();

/** Native Surface consumes radiance inputs only. Alpha belongs to the independent
 * coverage raster program; retaining it here would issue samples with no consumer. */
export function nativeSurfaceMaterialGraph(
  graph: CompiledAppearanceGraph,
  unlit: boolean,
): CompiledAppearanceGraph {
  let variants = SURFACE_GRAPHS.get(graph);
  const cached = variants?.get(unlit);
  if (cached) return cached;
  const consumed = new Set(
    unlit
      ? ["baseColor"]
      : [
          "baseColor",
          "metallic",
          "roughness",
          "occlusion",
          "ior",
          "specularWeight",
          "specularColor",
          "emissive",
          "coatWeight",
          "coatRoughness",
          "coatNormalTS",
          "coatNormalTSValidity",
          "normalTS",
          "normalTSValidity",
        ],
  );
  const selected = selectAppearanceProductProgram(
    graph,
    Object.fromEntries(Object.entries(graph.outputs).filter(([name]) => consumed.has(name))),
  );
  if (!variants) {
    variants = new Map();
    SURFACE_GRAPHS.set(graph, variants);
  }
  variants.set(unlit, selected);
  return selected;
}

const COMPUTE = 4;
const read = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: COMPUTE,
  buffer: { type: "read-only-storage" },
});
const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: COMPUTE,
  buffer: { type: "uniform" },
});
const texture = (binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: COMPUTE,
  texture: { sampleType },
});

/** Full physical profile, including providers. No auto layout or material-count specialization. */
export function nativeSurfaceDescriptor(
  program: NativeMaterialProgram,
  materialLayout: readonly GPUBindGroupLayoutEntry[],
  profile: NativeSurfaceShaderProfile,
): AppearanceProgramDescriptor {
  return {
    source: nativeSurfaceWgsl(program, profile),
    entryPoint: "main",
    workgroupSize: 64,
    groups: nativeSurfaceBindingGroups(materialLayout, profile),
  };
}

/** Layout planning never generates the large shader. */
export function nativeSurfaceBindingGroups(
  materialLayout: readonly GPUBindGroupLayoutEntry[],
  profile: NativeSurfaceShaderProfile,
): readonly (readonly GPUBindGroupLayoutEntry[])[] {
  if (profile.additiveSun && (!profile.physicalSun || profile.unlit || profile.reactive)) {
    throw new RangeError("Native sun continuation requires a lit sun profile without a second Aux writer");
  }
  const geometry: GPUBindGroupLayoutEntry[] = [
    uniform(0),
    read(1),
    read(2),
    read(3),
    read(4),
    texture(5, "uint"),
    {
      binding: 7,
      visibility: COMPUTE,
      storageTexture: { format: "rgba16float", access: "write-only" },
    },
  ];
  if (profile.additiveSun) {
    geometry.push(texture(9, "unfilterable-float"));
  }
  if (profile.reactive) {
    geometry.push({
      binding: 8,
      visibility: COMPUTE,
      storageTexture: { format: "rgba8unorm", access: "write-only" },
    });
  }
  if (profile.productGeometry) {
    for (let binding = 10; binding < 15; binding++) {
      geometry.push(read(binding));
    }
  }
  const lighting: GPUBindGroupLayoutEntry[] = profile.unlit
    ? []
    : [
        read(0),
        uniform(1),
        read(2),
        read(3),
        uniform(4),
        texture(5, "unfilterable-float"),
        texture(6, "unfilterable-float"),
        texture(7, "unfilterable-float"),
        uniform(8),
        read(9),
        texture(10, "depth"),
        texture(11, "float"),
      ];
  const material: GPUBindGroupLayoutEntry[] = [read(0), read(1), uniform(3), uniform(4)];
  if (!profile.unlit && profile.physicalSun) {
    lighting.push(...nativeSurfacePhysicalSunLayoutEntries());
  }
  if (profile.compact) {
    material.push(read(2));
  }
  return [
    geometry,
    profile.additiveSun
      ? lighting.filter((entry) => [0, 8, 9, 10, 12, 13, 14].includes(entry.binding))
      : lighting,
    material,
    materialLayout,
  ];
}

/** Two finite physical plans, selected only by the complete negotiated binding
 * footprint. The sun continuation trades repeated Geometry/Material evaluation
 * +16B/screen pixel copy and +16B/affected pixel HDR traffic for keeping the
 * original legal resource domain. A second 8B/pixel HDR exists only for this plan.
 * No material record, caching or missing provider is hidden in this plan.
 * Ordinary profiles stay fused; this is a capability boundary, not a speed claim. */
export function nativeSurfacePublicationDescriptors(
  program: NativeMaterialProgram,
  materialLayout: readonly GPUBindGroupLayoutEntry[],
  profile: NativeSurfaceShaderProfile,
  limits: Pick<GPUSupportedLimits, "maxSampledTexturesPerShaderStage">,
): { descriptor: AppearanceProgramDescriptor; continuation?: AppearanceProgramDescriptor } {
  const descriptor = nativeSurfaceDescriptor(program, materialLayout, profile);
  const sampled = descriptor.groups.reduce(
    (sum, group) => sum + group.filter((entry) => entry.texture !== undefined).length,
    0,
  );
  if (sampled <= limits.maxSampledTexturesPerShaderStage || !profile.physicalSun || profile.unlit) {
    return { descriptor };
  }
  return {
    descriptor: nativeSurfaceDescriptor(program, materialLayout, { ...profile, physicalSun: false }),
    continuation: nativeSurfaceDescriptor(program, materialLayout, {
      ...profile,
      additiveSun: true,
      reactive: false,
    }),
  };
}

const GEOMETRY_INPUTS: Readonly<Record<string, number>> = Object.freeze({
  uv0: 1,
  uv1: 2,
  uv2: 3,
  vertexColor: 4,
  normal: 5,
  tangent: 6,
  position: 7,
  viewDirection: 8,
  cameraPosition: 9,
  worldPosition: 10,
  worldNormal: 11,
  worldTangent: 12,
  viewPosition: 13,
  viewNormal: 14,
});

/** Native straight-line material + real winner recovery and provider math, invocation-private. */
export function nativeSurfaceWgsl(
  program: NativeMaterialProgram,
  profile: NativeSurfaceShaderProfile,
): string {
  let needs = profile.unlit ? 0 : (1 << 7) | (1 << 5) | (1 << 6);
  const inputs: string[] = [];
  program.inputs.forEach((input, index) => {
    let expression: string;
    if (input.domain === "dynamic" || input.domain === "nonlocal") {
      expression = program.instanceInputs
        ? `vec4f(${Array.from(
            { length: 4 },
            (_, channel) =>
              `native_material_constant(entry.constant_base, ${program.constants.length + 2 + index * 4 + channel}u)`,
          ).join(", ")})`
        : `native_frame_inputs[${index}u]`;
    } else {
      const kind = GEOMETRY_INPUTS[input.name];
      if (kind === undefined) {
        throw new Error(`Native Surface input '${input.name}' requires an explicit geometry semantic`);
      }
      needs |= 1 << kind;
      expression = `native_geometry_input(corners, weights, ${kind}u)`;
    }
    for (const [point, weights] of [
      ["center", "interpolation.weights"],
      ["x", "interpolation.weights + interpolation.dx"],
      ["y", "interpolation.weights + interpolation.dy"],
    ]) {
      inputs.push(
        `  inputs.${point}[${index}u] = ${expression.replace("corners, weights", `corners, ${weights}`)};`,
      );
    }
  });
  // Tangent orthogonalization, normal orientation and view-direction fallback
  // require normal/position even when only that derived input is authored.
  if ((needs & ((1 << 5) | (1 << 6) | (1 << 8) | (1 << 11) | (1 << 12) | (1 << 14))) !== 0) {
    needs |= (1 << 5) | (1 << 7);
  }
  const scalar = (name: string, fallback: string): string => {
    const output = program.outputs[name];
    return output === undefined ? fallback : `values[${output[0]}u]`;
  };
  const vector = (name: string, fallback: string): string => {
    const output = program.outputs[name];
    return output === undefined
      ? fallback
      : `vec3f(${output
          .slice(0, 3)
          .map((slot) => `values[${slot}u]`)
          .join(", ")})`;
  };
  const reactiveDeclaration = nativeSurfaceAuxWgsl(profile.reactive ? "Temporal" : "Base");
  const reactiveWrite = profile.reactive
    ? `native_surface_aux_write(vec2i(pixel), native_surface_aux_reactive((raster_flags & 1u) != 0u));`
    : "";
  const productBindings = profile.productGeometry
    ? `@group(0) @binding(10) var<storage, read> product_heap: array<u32>;\n${Array.from({ length: 4 }, (_, index) => `@group(0) @binding(${11 + index}) var<storage, read> product_bank_${index}: array<u32>;`).join("\n")}`
    : "";
  const lighting = profile.unlit
    ? ""
    : /* wgsl */ `
${NATIVE_LOCAL_LIGHTING.source}
${profile.physicalSun ? nativeSurfacePhysicalSunWgsl(true) : ""}
${OCTAHEDRAL_SAMPLE_WGSL}
${ENVIRONMENT_BRDF_WGSL}
struct NativeShadingView {
  width: u32,
  height: u32,
  frame_index: u32,
  reserved: u32,
}
@group(1) @binding(0) var<storage, read> node: array<u32>;
${NATIVE_LOCAL_LIGHTING.declarations}
@group(1) @binding(4) var<uniform> shading_view: NativeShadingView;
@group(1) @binding(5) var environment_diffuse: texture_2d<f32>;
@group(1) @binding(6) var environment_specular: texture_2d<f32>;
@group(1) @binding(7) var environment_dfg: texture_2d<f32>;
@group(1) @binding(8) var<uniform> vsm_constants: VsmSamplingConstants;
@group(1) @binding(9) var<storage, read> vsm_page_table: array<VsmPageEntry>;
@group(1) @binding(10) var vsm_atlas_depth: texture_depth_2d;
@group(1) @binding(11) var ambient_occlusion: texture_2d<f32>;
fn native_environment(material: StandardMaterial, normal: vec3f, direction: vec3f, pixel: vec2u) -> vec3f {
  ${
    profile.physicalSun
      ? `let lighting_mode = native_physical_sun.diagnostic_mode;
  if (lighting_mode == 1u || lighting_mode >= 4u) {
    return vec3f(0.0);
  }`
      : ""
  }
  let irradiance = sample_octahedral_bilinear(environment_diffuse, vec2u(0u), textureDimensions(environment_diffuse).x, normal, 0u).rgb;
  let reflection = reflect(-direction, normal);
  let radiance = sample_prefiltered_environment(environment_specular, reflection, material.roughness);
  let dfg = sample_environment_dfg(environment_dfg, saturate(dot(normal, direction)), material.roughness);
  var base_attenuation = 1.0;
  var coat_radiance = vec3f(0.0);
  if material.coatFactor > 0.0 {
    let coat_fresnel = environment_clearcoat_fresnel(dot(material.coatNormal, direction), material.coatFactor);
    base_attenuation = 1.0 - coat_fresnel;
    coat_radiance = sample_prefiltered_environment(environment_specular,
      reflect(-direction, material.coatNormal), material.coatRoughness) * coat_fresnel;
  }
  let ao = textureLoad(ambient_occlusion, vec2i(min(pixel, textureDimensions(ambient_occlusion) - vec2u(1u))), 0).r * material.occlusion;
  let diffuse = irradiance * material.diffuse * RECIPROCAL_PI * ao;
  let specular = radiance * environment_dfg_single_scatter(dfg, material.specularF0);
  ${
    profile.physicalSun
      ? `if (lighting_mode == 2u) {
    return diffuse * base_attenuation;
  }
  if (lighting_mode == 3u) {
    return specular * base_attenuation + coat_radiance;
  }`
      : ""
  }
  return (diffuse + specular) * base_attenuation + coat_radiance;
}
`;
  const sunLighting =
    "native_surface_physical_sun(material, geometry, frame_instances[work.instance_slot].source.flags)";
  const directLighting =
    "shade_standard_material_direct(material, geometry, vec2f(pixel) + vec2f(0.5), view_depth)" +
    (profile.physicalSun ? " + " + sunLighting : "");
  const directEnabled = profile.physicalSun
    ? "native_physical_sun.diagnostic_mode == 0u || native_physical_sun.diagnostic_mode == 4u"
    : "true";
  const materialLighting = profile.additiveSun
    ? `  var color = vec3f(0.0);
  if (${directEnabled}) {
    color = ${sunLighting};
  }`
    : `  var direct = vec3f(0.0);
  if (${directEnabled}) {
    direct = ${directLighting};
  }
  let color = direct + native_environment(material, mapped_normal, direction, pixel);`;
  const material = profile.unlit
    ? /* wgsl */ `
  let color = ${vector("baseColor", "vec3f(0.0)")};
`
    : /* wgsl */ `
  let base = max(${vector("baseColor", "vec3f(1.0)")}, vec3f(0.0));
  let metallic = clamp(${scalar("metallic", "0.0")}, 0.0, 1.0);
  var material: StandardMaterial;
  material.diffuse = base * (1.0 - metallic);
  material.roughness = clamp(${scalar("roughness", "1.0")}, 0.04, 1.0);
  material.occlusion = clamp(${scalar("occlusion", "1.0")}, 0.0, 1.0);
  let ior = max(${scalar("ior", "1.5")}, 1.0);
  let f0 = (ior - 1.0) / (ior + 1.0);
  material.specularF0 = mix(vec3f(f0 * f0), base, metallic) * clamp(${scalar("specularWeight", "1.0")}, 0.0, 1.0) * max(${vector("specularColor", "vec3f(1.0)")}, vec3f(0.0));
  material.specularF90 = 1.0;
  // Both direct and environment paths retain the existing single-scatter profile.
  material.energyCompensation = vec3f(1.0);
  material.emissive = ${vector("emissive", "vec3f(0.0)")};
  material.coatFactor = clamp(${scalar("coatWeight", "0.0")}, 0.0, 1.0);
  material.coatRoughness = clamp(${scalar("coatRoughness", "1.0")}, 0.04, 1.0);
  material.coatNormal = select(normal, native_safe_normal(basis * ${vector("coatNormalTS", "vec3f(0.0, 0.0, 1.0)")}, normal), ${scalar("coatNormalTSValidity", "1.0")} > 0.5);
  let mapped_normal = select(normal, native_safe_normal(basis * ${vector("normalTS", "vec3f(0.0, 0.0, 1.0)")}, normal), ${scalar("normalTSValidity", "1.0")} > 0.5);
  let direction = native_safe_normal(settings.camera_position_exposure.xyz - position, mapped_normal);
  let geometry = SurfaceGeometry(mapped_normal, native_safe_normal(corners.world_plane.xyz, normal), position, direction);
  let view_depth = max(-(settings.view_matrix * vec4f(position, 1.0)).z, 1e-4);
${materialLighting}
`;
  // Cost card: unchanged 256B VSM uniform/bindings, 8x8 workgroup and frame passes.
  // Normal mode adds one uniform branch, no samples/atomics/barriers/allocations.
  // Debug adds page-table queries and (mask only) <=16 depth loads per lit pixel;
  // its benefit is inspection only. Disable it for cost/quality measurements.
  const vsmDebug = profile.physicalSun && !profile.unlit
    ? /* wgsl */ `
  if (vsm_constants.identity.z != 0u) {
    let receives_shadow = (frame_instances[work.instance_slot].source.flags & ${GPU_INSTANCE_FLAGS.ReceivesShadow}u) != 0u;
    output_radiance = oengine_linear_rec709_to_rec2020(vsm_debug_color(position, mapped_normal,
      normalize(native_physical_sun.sun_direction_world), receives_shadow));
  }
`
    : "";
  const pixelSelection = profile.compact
    ? /* wgsl */ `
  let record = route.x * 8u;
  let work_index = group.y * groups.x + group.x;
  if work_index >= native_tiles[record + 1u] { return; }
  let address = native_tiles[record] + work_index * 3u;
  let mask = native_tiles[address + 1u + lane / 32u];
  if (mask & (1u << (lane % 32u))) == 0u { return; }
  let tile = native_tiles[address] & 0x7fffffffu;
  let tiles_x = (settings.dimensions.x + 7u) / 8u;
  let pixel = vec2u((tile % tiles_x) * 8u + lane % 8u, (tile / tiles_x) * 8u + lane / 8u);
`
    : "  let pixel = id.xy;";
  return /* wgsl */ `
${surfaceGeometryCompletionWgsl(profile.productGeometry, true, false)}
${lighting}
${LINEAR_REC709_TO_REC2020_WGSL}
${NATIVE_MATERIAL_DIRECTORY_WGSL}
struct NativeSurfaceSettings {
  source: vec4u,
  source_payload: vec4u,
  dimensions: vec4u,
  camera_position_exposure: vec4f,
  view_matrix: mat4x4f,
  background: vec4f,
}
@group(0) @binding(0) var<uniform> settings: NativeSurfaceSettings;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> source_heap: array<u32>;
@group(0) @binding(3) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(4) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(5) var visibility: texture_2d<u32>;
@group(0) @binding(7) var hdr: texture_storage_2d<rgba16float, write>;
${profile.additiveSun ? "@group(0) @binding(9) var prior_native_hdr: texture_2d<f32>;" : ""}
${reactiveDeclaration}
${productBindings}
@group(2) @binding(0) var<storage, read> native_constants: array<f32>;
@group(2) @binding(1) var<storage, read> native_directory: array<NativeMaterialDirectoryEntry>;
${profile.compact ? "@group(2) @binding(2) var<storage, read> native_tiles: array<u32>;" : ""}
@group(2) @binding(3) var<uniform> route: vec4u;
@group(2) @binding(4) var<uniform> native_frame_inputs: array<vec4f, ${Math.max(program.inputCount, 1)}>;
const geometry_needs: u32 = ${needs}u;
fn native_material_constant(base: u32, slot: u32) -> f32 { return native_constants[base + slot]; }
${program.source}
fn native_safe_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let length2 = dot(value, value);
  if length2 > 1e-20 {
    return value * inverseSqrt(length2);
  }
  return fallback;
}
fn native_attribute(corners: GeometryCorners, weights: vec3f) -> vec4f {
  return corners.p0 * weights.x + corners.p1 * weights.y + corners.p2 * weights.z;
}
fn native_geometry_input(corners: GeometryCompletion, weights: vec3f, kind: u32) -> vec4f {
  let position = native_attribute(corners.position, weights);
  let geometric = native_safe_normal(corners.world_plane.xyz, vec3f(0.0, 0.0, 1.0));
  let raw = native_attribute(corners.normal, weights);
  let unflipped = native_safe_normal(raw.xyz, geometric);
  let flip = (corners.flags & 16u) != 0u && dot(unflipped, settings.camera_position_exposure.xyz - position.xyz) < 0.0;
  let normal = select(unflipped, -unflipped, flip);
  let raw_tangent = native_attribute(corners.tangent, weights);
  let fallback = native_safe_normal(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(unflipped.z) > 0.99), unflipped), vec3f(1.0, 0.0, 0.0));
  let tangent = native_safe_normal(raw_tangent.xyz - unflipped * dot(unflipped, raw_tangent.xyz), fallback);
  switch kind {
    case 1u: { return vec4f(native_attribute(corners.uv, weights).xy, 0.0, 0.0); }
    case 2u: { return vec4f(native_attribute(corners.uv, weights).zw, 0.0, 0.0); }
    case 3u: { return native_attribute(corners.uv2, weights); }
    case 4u: { return native_attribute(corners.color, weights); }
    case 5u, 11u: { return vec4f(normal, raw.w); }
    case 6u, 12u: { return vec4f(select(tangent, -tangent, flip), raw_tangent.w); }
    case 7u, 10u: { return position; }
    case 8u: { return vec4f(native_safe_normal(settings.camera_position_exposure.xyz - position.xyz, normal), 0.0); }
    case 9u: { return vec4f(settings.camera_position_exposure.xyz, 1.0); }
    case 13u: { return settings.view_matrix * position; }
    case 14u: { return vec4f((settings.view_matrix * vec4f(normal, 0.0)).xyz, raw.w); }
    default: { return vec4f(0.0); }
  }
}
@compute @workgroup_size(${profile.compact ? "64" : "8, 8"})
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
${pixelSelection}
  if any(pixel >= settings.dimensions.xy) {
    return;
  }
  let key = textureLoad(visibility, vec2i(pixel), 0).r;
  if meshlet_work.header.generation != settings.dimensions.w {
    return;
  }
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
  if decoded.valid == 0u {
    return;
  }
  if decoded.meshlet_work_slot >= min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements)) {
    return;
  }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  if work.instance_slot >= arrayLength(&frame_instances) {
    return;
  }
  if frame_instances[work.instance_slot].generation != settings.dimensions.w {
    return;
  }
  let slot = work.material_slot_or_range;
  if slot >= arrayLength(&native_directory) {
    return;
  }
  let entry = native_directory[slot];
  if entry.execution_bin != route.x {
    return;
  }
  let corners = geometry_complete_resolved(decoded, work, frame_instances[work.instance_slot]);
  let interpolation = winner_interpolate(corners.coefficients, vec2f(pixel) + vec2f(0.5), vec2f(settings.dimensions.xy));
  if (interpolation.flags & WINNER_VALUE_VALID) == 0u {
    return;
  }
  var inputs: NativeMaterialInputs;
${inputs.join("\n")}
  let values = native_material_evaluate(entry.constant_base, inputs);
  let raster_flags = u32(native_material_constant(entry.constant_base, ${program.constants.length + 1}u));
  let position = native_attribute(corners.position, interpolation.weights).xyz;
  let normal = native_geometry_input(corners, interpolation.weights, 5u).xyz;
  let tangent = native_geometry_input(corners, interpolation.weights, 6u);
  let basis = mat3x3f(tangent.xyz, cross(normal, tangent.xyz) * tangent.w, normal);
${material}
  // P is the positive GPU exposure published by radiometry. An artistic lower
  // floor here would disagree with Sky/Aerial and HDR metering above L=1800.
  let contribution = oengine_linear_rec709_to_rec2020(color) * settings.camera_position_exposure.w;
  var output_radiance = ${profile.additiveSun ? "textureLoad(prior_native_hdr, vec2i(pixel), 0).rgb + contribution" : "contribution"};
${vsmDebug}
  textureStore(hdr, vec2i(pixel), vec4f(output_radiance, 1.0));
  ${reactiveWrite}
}
`;
}
