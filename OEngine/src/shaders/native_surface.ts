import { SCGI_NATIVE_WGSL } from "./scgi_native.js";
import { nativePublicationAccessors } from "../gpu/NativePublicationAbi.js";
import { VIRTUAL_TEXTURE_FEEDBACK_WGSL } from "./virtual_texture.js";
import { VT_FEEDBACK_MAILBOX_WORDS } from "../gpu/VirtualTextureAbi.js";
import type { NativeMaterialProgram } from "./native_material.js";
import { SSSR_RECEIVER_WRITE_WGSL } from "../render/reflections/SssrAbi.js";
import { GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";
import {
  selectAppearanceProductProgram,
  type CompiledAppearanceGraph,
} from "../material/AppearanceGraphCompiler.js";
import type { AppearanceProgramDescriptor } from "../gpu/AppearanceProgramRegistry.js";
import { NATIVE_MATERIAL_DIRECTORY_WGSL } from "../gpu/GpuNativeMaterialPublication.js";
import { surfaceGeometryCompletionWgsl } from "./surface_geometry_completion.js";
import { NATIVE_RESOLVED_POSITION_WGSL } from "./native_resolved_position.js";
import { nativeLocalLighting } from "./native_local_lighting.js";
import {
  FINAL_PIXEL_DIRECTORY_WGSL,
  FINAL_PIXEL_LIGHTING_DIRECTORY_WGSL,
  NATIVE_TEMPORAL_SEED_VIEW_BYTES,
} from "../gpu/FinalPixelAbi.js";
import { nativeTemporalSeedWgsl, nativeResponseWgsl } from "./native_temporal_seed.js";
import { vsmSamplingWgsl, vsmFilterNoiseWgsl } from "./vsm_sampling.js";
import { NATIVE_ENVIRONMENT_SAMPLE_WGSL } from "./native_environment_sample.js";
import { ENVIRONMENT_BRDF_WGSL } from "./native_environment_brdf.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "./working_color.js";

import {
  nativeSurfacePhysicalSunLayoutEntries,
  nativeSurfacePhysicalSunWgsl,
} from "./native_surface_lighting.js";

/** Diagnostic shader specialization only; G is byte-for-byte the normal source. */
export type NativeSurfaceCostSlice = "A" | "B0" | "B" | "C" | "D" | "E" | "F" | "G" | "Q0" | "K";

export interface NativeSurfaceShaderProfile {
  readonly virtualTextures?: boolean;
  readonly reflections?: "off" | "sssr-base-coat";
  readonly compact: boolean;
  readonly productGeometry: boolean;
  readonly unlit: boolean;
  readonly reactive: boolean;
  readonly physicalSun?: boolean;
  readonly costSlice?: NativeSurfaceCostSlice;
  /** Production Final Pixel profile; smaller profiles serve isolated fixtures. */
  readonly finalPixel?: boolean;
}

export const NATIVE_SURFACE_SETTINGS_BYTES = 208;
export const FINAL_PIXEL_SURFACE_SETTINGS_BYTES =
  NATIVE_SURFACE_SETTINGS_BYTES + NATIVE_TEMPORAL_SEED_VIEW_BYTES;
const SURFACE_GRAPHS = new WeakMap<CompiledAppearanceGraph, Map<boolean, CompiledAppearanceGraph>>();

/** Native Surface consumes radiance inputs only. Alpha belongs to the independent
 * coverage raster program; retaining it here would issue samples with no consumer. */
export function nativeSurfaceMaterialGraph(
  graph: CompiledAppearanceGraph,
  unlit: boolean,
): CompiledAppearanceGraph {
  let variants = SURFACE_GRAPHS.get(graph);
  const cached = variants?.get(unlit);
  if (cached) {
    return cached;
  }
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
    // Shared tile: u32 + aligned 24B work, 32B entry, 176B instance,
    // 368B GeometryCompletion; dense adds 64 keys and one atomic word.
    // Each independent workgroup variable rounds to at least 16 bytes.
    workgroupStorageBytes:
      16 +
      32 +
      32 +
      176 +
      368 +
      (profile.compact ? 0 : 256 + 16) +
      (program.virtualTextures ? VT_FEEDBACK_MAILBOX_WORDS * 4 : 0),
    groups: nativeSurfaceBindingGroups(materialLayout, {
      ...profile,
      virtualTextures: !!program.virtualTextures,
    }),
  };
}

/** Layout planning never generates the large shader. */
export function nativeSurfaceBindingGroups(
  materialLayout: readonly GPUBindGroupLayoutEntry[],
  profile: NativeSurfaceShaderProfile,
): readonly (readonly GPUBindGroupLayoutEntry[])[] {
  const fusedSun = true;
  if (profile.finalPixel && !profile.reactive) {
    throw new RangeError("Final Pixel requires all three Temporal outputs");
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
  if (profile.reactive) {
    geometry.push({
      binding: 8,
      visibility: COMPUTE,
      storageTexture: { format: "rgba8unorm", access: "write-only" },
    });
  }
  if (profile.finalPixel) {
    geometry.push(
      { binding: 6, visibility: COMPUTE, storageTexture: { format: "rgba32float", access: "write-only" } },
      { binding: 9, visibility: COMPUTE, storageTexture: { format: "rgba32uint", access: "write-only" } },
    );
  }
  if (profile.productGeometry) {
    for (let binding = 10; binding < 15; binding++) {
      geometry.push(read(binding));
    }
  }
  if (profile.reflections === "sssr-base-coat") {
    geometry.push({ binding: 15, visibility: COMPUTE, buffer: { type: "storage" } });
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
        texture(7, "float"),
        uniform(8),
        texture(10, "depth"),
        texture(11, "float"),
      ];
  if (!profile.unlit) {
    // Both IBL owners publish linear rgba16float. Only DFG uses hardware
    // filtering; oct radiance keeps exact f32 interpolation and seam support.
    lighting.push({ binding: 15, visibility: COMPUTE, sampler: { type: "filtering" } });
    if (fusedSun) {
      lighting.push(uniform(9), { binding: 16, visibility: COMPUTE, sampler: { type: "non-filtering" } });
    }
  }
  const material: GPUBindGroupLayoutEntry[] = [read(0), uniform(3), uniform(4)];
  if (profile.virtualTextures) {
    material.push({ binding: 1, visibility: COMPUTE, buffer: { type: "storage" } });
  }
  if (!profile.unlit && profile.physicalSun) {
    lighting.push(...nativeSurfacePhysicalSunLayoutEntries());
  }
  if (profile.compact) {
    material.push(read(2));
  }
  return [geometry, lighting, material, materialLayout];
}

/** One complete physical Sun profile. No resource-limit reconstruction continuation. */
export function nativeSurfacePublicationDescriptors(
  program: NativeMaterialProgram,
  materialLayout: readonly GPUBindGroupLayoutEntry[],
  profile: NativeSurfaceShaderProfile,
  limits: Pick<GPUSupportedLimits, "maxSampledTexturesPerShaderStage">,
): { descriptor: AppearanceProgramDescriptor } {
  const descriptor = nativeSurfaceDescriptor(program, materialLayout, profile);
  const sampled = descriptor.groups.reduce(
    (sum, group) => sum + group.filter((entry) => entry.texture !== undefined).length,
    0,
  );
  if (sampled > limits.maxSampledTexturesPerShaderStage) {
    throw new RangeError("Complete Final Pixel sampled footprint exceeds the negotiated limit");
  }
  return { descriptor };
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
  const costSlice = profile.costSlice ?? "G";
  const fusedSun = true;
  const lateSun =
    profile.physicalSun && !profile.unlit && (costSlice === "F" || costSlice === "G" || costSlice === "K");
  if (costSlice === "Q0") {
    throw new RangeError("Q0 embedded VSM query slice is retired; use the Native Sun consumer timing");
  }
  if (!/^(?:[A-G]|B0|Q0|K)$/.test(costSlice)) {
    throw new RangeError("Native cost slice must be A through G, B0 or K (Resolve query keys)");
  }
  let needs = profile.unlit ? (profile.finalPixel ? 1 << 7 : 0) : (1 << 7) | (1 << 5) | (1 << 6);
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
  const reflections = profile.reflections === "sssr-base-coat";
  const reactiveDeclaration = profile.finalPixel
    ? nativeTemporalSeedWgsl(0, 6, 8, 9).replace(
        "primary_motion.valid && entry.value_revision != 0u, 0.0, alpha_mask",
        `primary_motion.valid && entry.value_revision != 0u, ${profile.unlit ? "0.0" : "scgi_reactivity"}, alpha_mask`,
      )
    : nativeResponseWgsl(!!profile.reactive);
  const reactiveWrite =
    profile.reactive && !profile.finalPixel
      ? `native_response_write(vec2i(pixel), (raster_flags & 1u) != 0u);`
      : "";
  const productBindings = profile.productGeometry
    ? `@group(0) @binding(10) var<storage, read> product_heap: array<u32>;\n${Array.from({ length: 4 }, (_, index) => `@group(0) @binding(${11 + index}) var<storage, read> product_bank_${index}: array<u32>;`).join("\n")}`
    : "";
  const localLighting = nativeLocalLighting(fusedSun);
  const lighting = profile.unlit
    ? ""
    : /* wgsl */ `
${localLighting.source}
${vsmSamplingWgsl(true)}
${profile.physicalSun ? nativeSurfacePhysicalSunWgsl(costSlice === "G" || costSlice === "K") : ""}
${NATIVE_ENVIRONMENT_SAMPLE_WGSL}
${ENVIRONMENT_BRDF_WGSL}
struct NativeShadingView {
  width: u32,
  height: u32,
  frame_index: u32,
  reserved: u32,
}
@group(1) @binding(0) var<storage, read> node: array<u32>;
${localLighting.declarations}
${
  fusedSun
    ? `${FINAL_PIXEL_LIGHTING_DIRECTORY_WGSL}
${vsmFilterNoiseWgsl("lighting_ranges.segments.y")}
@group(1) @binding(8) var<uniform> vsm_constants: VsmSamplingConstants;
@group(1) @binding(10) var vsm_atlas_depth: texture_depth_2d;
@group(1) @binding(16) var vsm_atlas_sampler: sampler;`
    : ""
}
@group(1) @binding(4) var<uniform> shading_view: NativeShadingView;
@group(1) @binding(5) var environment_diffuse: texture_2d<f32>;
@group(1) @binding(6) var environment_specular: texture_2d<f32>;
@group(1) @binding(7) var environment_dfg: texture_2d<f32>;
@group(1) @binding(15) var environment_sampler: sampler;
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
  let irradiance = sample_native_environment_mip(environment_diffuse, normal, 0u);
  ${profile.finalPixel ? "let gi = scgi_native_irradiance(normal, pixel);" : ""}
  let reflection = reflect(-direction, normal);
  let radiance = sample_native_environment(environment_specular, reflection, material.roughness);
  let dfg = sample_environment_dfg(environment_dfg, environment_sampler, saturate(dot(normal, direction)), material.roughness);
  var base_attenuation = 1.0;
  var coat_radiance = vec3f(0.0);
  var coat_response = 0.0;
  if material.coatFactor > 0.0 {
    let coat_fresnel = environment_clearcoat_fresnel(dot(material.coatNormal, direction), material.coatFactor);
    base_attenuation = 1.0 - coat_fresnel;
    coat_response = coat_fresnel;
    coat_radiance = sample_native_environment(environment_specular,
      reflect(-direction, material.coatNormal), material.coatRoughness) * coat_fresnel;
  }
  let ao = textureLoad(ambient_occlusion, vec2i(min(pixel, textureDimensions(ambient_occlusion) - vec2u(1u))), 0).r * material.occlusion;
  ${
    profile.finalPixel
      ? `let indirect = mix(irradiance * ao, gi.xyz * material.occlusion, gi.w);
  let diffuse = indirect * material.diffuse * RECIPROCAL_PI;`
      : "let diffuse = irradiance * material.diffuse * RECIPROCAL_PI * ao;"
  }
  let specular = radiance * environment_dfg_single_scatter(dfg, material.specularF0);
  ${
    reflections
      ? `let alpha = unpack2x16float(pack2x16float(vec2f(material.roughness * material.roughness, material.coatRoughness * material.coatRoughness)));
  let selected_base = alpha.x < bitcast<f32>(route.w);
  let selected_coat = alpha.y < bitcast<f32>(route.w) && material.coatFactor > 0.0;
  let base_response = environment_dfg_single_scatter(dfg, material.specularF0) * base_attenuation;
  reflection_response = vec4f(select(vec3f(0.0), base_response, selected_base), select(0.0, coat_response, selected_coat));
  reflection_baseline = select(vec3f(0.0), radiance * base_response, selected_base) + select(vec3f(0.0), coat_radiance, selected_coat);
  reflection_flags = 1u | select(0u, 2u, selected_base) | select(0u, 4u, selected_coat);
  ${
    profile.physicalSun
      ? `if (lighting_mode == 2u) {
    reflection_response = vec4f(0.0);
    reflection_baseline = vec3f(0.0);
    reflection_flags = 1u;
  }`
      : ""
  }`
      : ""
  }
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
    "native_surface_physical_sun(prepare_direct_physical(normalize(native_physical_sun.sun_direction_world), geometry, material), resolved_position, resolved.flags, sun_visibility)";
  const directLighting =
    "shade_standard_material_direct(material, geometry, vec2f(pixel) + vec2f(0.5), view_depth)" +
    (profile.physicalSun ? " + " + sunLighting : "");
  const directEnabled = profile.physicalSun
    ? "native_physical_sun.diagnostic_mode == 0u || native_physical_sun.diagnostic_mode == 4u"
    : "true";
  let materialLighting = `  var direct = vec3f(0.0);
  if (${directEnabled}) {
    direct = ${directLighting};
  }
  let color = direct + native_environment(material, mapped_normal, direction, pixel);`;
  if (lateSun) {
    // End attributes/material/local/IBL before PCF. Only separate local/IBL
    // RGB and the BRDF response survive; preserve (local + Sun) + environment.
    materialLighting = `  if (${directEnabled}) {
    local_color = shade_standard_material_direct(material, geometry, vec2f(pixel) + vec2f(0.5), view_depth);
    sun_response = prepare_direct_physical(normalize(native_physical_sun.sun_direction_world), geometry, material);
  }
  environment_color = native_environment(material, mapped_normal, direction, pixel);`;
  }
  if ((costSlice === "D" || costSlice === "E") && !profile.unlit) {
    // One real shared BRDF evaluation under unit irradiance. F replaces this
    // incident with the actual atmosphere Sun; it does not add a second BRDF.
    const direction = profile.physicalSun
      ? "normalize(native_physical_sun.sun_direction_world)"
      : "normalize(vec3f(0.3, 0.8, 0.4))";
    materialLighting = /* wgsl */ `
  var diagnostic_incident: GpuPrimitiveTypeTable;
  diagnostic_incident.direction = ${direction};
  diagnostic_incident.color = vec3f(1.0);
  var diagnostic_reflected: ReflectedLight;
  re_direct_physical(diagnostic_incident, geometry, material, &diagnostic_reflected);
  let local = shade_standard_material_direct(material, geometry, vec2f(pixel) + vec2f(0.5), view_depth);
  let color = local + diagnostic_reflected.diffuse + diagnostic_reflected.specular${
    costSlice === "E" ? " + native_environment(material, mapped_normal, direction, pixel)" : ""
  };`;
  }
  const material = profile.unlit
    ? /* wgsl */ `
  let color = ${vector("baseColor", "vec3f(0.0)")};
  ${
    reflections
      ? `let reflection_face = native_face_normal(resolved.world_plane.xyz, resolved_position);
  sssr_write_receiver(pixel.y * settings.dimensions.x + pixel.x, vec4f(reflection_face, 1.0), vec4f(reflection_face, 1.0), vec4f(0.0), vec4f(0.0, 0.0, 0.0, 1.0));`
      : ""
  }
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
  ${
    reflections
      ? `let reflection_alpha = unpack2x16float(pack2x16float(vec2f(material.roughness * material.roughness, material.coatRoughness * material.coatRoughness)));
  sssr_write_receiver(pixel.y * settings.dimensions.x + pixel.x,
    vec4f(mapped_normal, reflection_alpha.x), vec4f(material.coatNormal, reflection_alpha.y), reflection_response,
    vec4f(oengine_linear_rec709_to_rec2020(reflection_baseline) * settings.camera_position_exposure.w, f32(reflection_flags)));`
      : ""
  }
`;
  // Debug sampling uses the existing invocation facts; no cross-pass mask.
  const vsmDebug =
    costSlice === "G" && profile.physicalSun && !profile.unlit
      ? /* wgsl */ `
  if (vsm_constants.identity.z != 0u) {
    output_radiance = oengine_linear_rec709_to_rec2020(vsm_debug_color(resolved_position, native_face_normal(resolved.world_plane.xyz, resolved_position), native_physical_sun.sun_direction_world, (resolved.flags & ${GPU_INSTANCE_FLAGS.ReceivesShadow}u) != 0u, pixel));
  }
`
      : "";
  const sharedCachePopulate = "  let cache_slot = select(0xffffffffu, 0u, tile_broadcast);";
  const pixelSelection = profile.compact
    ? /* wgsl */ `
  let record = (route.x + route.z) * 8u;
  let work_index = group.y * groups.x + group.x;
  let valid_group = work_index < native_tiles[record + 1u];
  let address = select(0u, native_tiles[record] + work_index * 3u, valid_group);
  let raw_tile = select(0u, native_tiles[address], valid_group);
  let low_mask = select(0u, native_tiles[address + 1u], valid_group);
  let high_mask = select(0u, native_tiles[address + 2u], valid_group);
  let tile = native_tiles[address] & 0x7fffffffu;
  let tiles_x = (settings.dimensions.x + 7u) / 8u;

  if lane == 0u {
    wg_tile_broadcast = 0u;
    if valid_group && (raw_tile & 0x80000000u) != 0u && (low_mask | high_mask) != 0u &&
        meshlet_work.header.generation == settings.dimensions.w {
      let rep_lane = select(32u + firstTrailingBit(high_mask), firstTrailingBit(low_mask), low_mask != 0u);
      let rep_pixel = vec2u((tile % tiles_x) * 8u + rep_lane % 8u, (tile / tiles_x) * 8u + rep_lane / 8u);
      if all(rep_pixel < settings.dimensions.xy) {
        let rep_key = textureLoad(visibility, vec2i(rep_pixel), 0).r;
        let rep_decoded = oengine_visibility_key_resolve(rep_key, meshlet_work.header.generation, meshlet_work.header.written_count);
        if rep_decoded.valid != 0u &&
            rep_decoded.meshlet_work_slot < min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements)) {
          let rep_work = meshlet_work.elements[rep_decoded.meshlet_work_slot];
          if rep_work.instance_slot < arrayLength(&frame_instances) &&
              frame_instances[rep_work.instance_slot].generation == settings.dimensions.w &&
              rep_work.material_slot_or_range < native_material_count() {
            let rep_entry = native_material_entry(rep_work.material_slot_or_range);
            if rep_entry.execution_bin == route.x${profile.finalPixel ? " && rep_entry.program_index != 0xffffffffu" : ""} {
              let rep_instance = frame_instances[rep_work.instance_slot];
              let rep_resolved = geometry_complete_resolved(rep_decoded, rep_work, rep_instance);
              wg_cache_work[0] = rep_work;
              wg_cache_entry[0] = rep_entry;
              wg_cache_instance_source[0] = rep_instance.source;
              wg_cache_corners[0] = geometry_complete_attributes(rep_resolved, rep_instance);
              wg_tile_broadcast = 1u;
            }
          }
        }
      }
    }
  }
  let tile_broadcast = workgroupUniformLoad(&wg_tile_broadcast) != 0u;
  let mask = select(0u, native_tiles[address + 1u + lane / 32u], valid_group);
  let pixel = vec2u((tile % tiles_x) * 8u + lane % 8u, (tile / tiles_x) * 8u + lane / 8u);
  let lane_active = valid_group && ((mask & (1u << (lane % 32u))) != 0u) && all(pixel < settings.dimensions.xy);
  var lane_key = OENGINE_VISIBILITY_KEY_EMPTY;
  if (!tile_broadcast && lane_active) {
    lane_key = textureLoad(visibility, vec2i(pixel), 0).r;
  }
${sharedCachePopulate}
  if (!lane_active) { return; }
`
    : /* wgsl */ `
  let pixel = id.xy + vec2u(route.y & 65535u, route.y >> 16u);
  let in_bounds = all(pixel < settings.dimensions.xy);
  let dense_key = select(OENGINE_VISIBILITY_KEY_EMPTY, textureLoad(visibility, vec2i(pixel), 0).r, in_bounds);
  wg_dense_keys[lane] = dense_key;

  if lane == 0u {
    wg_tile_broadcast = 0u;
    atomicStore(&wg_dense_mixed, 0u);
  }
  workgroupBarrier();
  if !in_bounds || dense_key == OENGINE_VISIBILITY_KEY_EMPTY || dense_key != wg_dense_keys[0] {
    atomicOr(&wg_dense_mixed, 1u);
  }
  workgroupBarrier();
  if lane == 0u && atomicLoad(&wg_dense_mixed) == 0u && meshlet_work.header.generation == settings.dimensions.w {
    let rep_decoded = oengine_visibility_key_resolve(dense_key, meshlet_work.header.generation, meshlet_work.header.written_count);
    if rep_decoded.valid != 0u &&
        rep_decoded.meshlet_work_slot < min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements)) {
      let rep_work = meshlet_work.elements[rep_decoded.meshlet_work_slot];
      if rep_work.instance_slot < arrayLength(&frame_instances) &&
          frame_instances[rep_work.instance_slot].generation == settings.dimensions.w &&
          rep_work.material_slot_or_range < native_material_count() {
        let rep_entry = native_material_entry(rep_work.material_slot_or_range);
        if rep_entry.execution_bin == route.x${profile.finalPixel ? " && rep_entry.program_index != 0xffffffffu" : ""} {
          let rep_instance = frame_instances[rep_work.instance_slot];
          let rep_resolved = geometry_complete_resolved(rep_decoded, rep_work, rep_instance);
          wg_cache_work[0] = rep_work;
          wg_cache_entry[0] = rep_entry;
          wg_cache_instance_source[0] = rep_instance.source;
          wg_cache_corners[0] = geometry_complete_attributes(rep_resolved, rep_instance);
          wg_tile_broadcast = 1u;
        }
      }
    }
  }
  let tile_broadcast = workgroupUniformLoad(&wg_tile_broadcast) != 0u;
  let lane_active = in_bounds;
  let lane_key = dense_key;
${sharedCachePopulate}
  if (!lane_active) { return; }
`;
  const rasterFlags = `  let raster_flags = u32(native_material_constant(entry.constant_base, ${program.constants.length + 1}u));`;
  let evaluation = /* wgsl */ `
  var inputs: NativeMaterialInputs;
${inputs.join("\n")}
  let values = native_material_evaluate(entry.constant_base, inputs);
${fusedSun ? "" : rasterFlags}
  let position = resolved_position;
  let normal = native_geometry_input(corners, interpolation.weights, 5u).xyz;
  let tangent = native_geometry_input(corners, interpolation.weights, 6u);
  let basis = mat3x3f(tangent.xyz, cross(normal, tangent.xyz) * tangent.w, normal);
${material}
`;
  if (costSlice === "A" || costSlice === "B0" || costSlice === "B" || costSlice === "C") {
    // Fixed output would DCE the reconstruction. Consume every requested corner
    // and interpolation result. This deliberately adds anchor ALU and changes
    // liveness: A/B/C are diagnostic bounds, not standalone production costs.
    const fields = ["position", "normal", "tangent", "uv", "uv2", "color"];
    const cornerTerms = fields.flatMap((field) =>
      [0, 1, 2].map((corner) => `dot(corners.${field}.p${corner}, vec4f(0.13, 0.19, 0.23, 0.29))`),
    );
    cornerTerms.push(
      "dot(corners.world_plane, vec4f(0.31, 0.37, 0.41, 0.43))",
      "dot(interpolation.weights, vec3f(0.47, 0.53, 0.59))",
    );
    evaluation = `${rasterFlags}\n  var diagnostic_anchor = ${cornerTerms.join(" +\n    ")};\n`;
    if (costSlice !== "A") {
      // B0 shares A's reconstruction anchor, but consumes only center inputs.
      // B additionally keeps finite one-pixel footprints and neighbour inputs live.
      const diagnosticInputs =
        costSlice === "B0" ? inputs.filter((line) => line.startsWith("  inputs.center[")) : inputs;
      evaluation += `  var inputs: NativeMaterialInputs;\n${diagnosticInputs.join("\n")}\n`;
      for (let index = 0; index < program.inputCount; index++) {
        for (const [point, factor] of [
          ["center", "1.17"],
          ["x", "1.93"],
          ["y", "2.71"],
        ]) {
          if (costSlice === "B0" && point !== "center") {
            continue;
          }
          evaluation += `  diagnostic_anchor += dot(inputs.${point}[${index}u], vec4f(0.13, 0.19, 0.23, 0.29)) * ${factor};\n`;
        }
      }
      if (costSlice !== "B0") {
        evaluation +=
          "  diagnostic_anchor += dot(interpolation.dx, vec3f(0.61, 0.67, 0.71)) + dot(interpolation.dy, vec3f(0.73, 0.79, 0.83));\n";
      }
    }
    if (costSlice === "C") {
      evaluation += "  let values = native_material_evaluate(entry.constant_base, inputs);\n";
      const slots = [...new Set(Object.values(program.outputs).flat())];
      for (const slot of slots) {
        evaluation += `  diagnostic_anchor += values[${slot}u] * 0.17;\n`;
      }
    }
    evaluation += "  let color = vec3f(0.2) + vec3f(diagnostic_anchor * 0.0001);\n";
  }
  const seedSurfaceBlock = profile.finalPixel
    ? /* wgsl */ `var seed_instance_source: OEngineInstanceRecord;
  if (cache_hit) {
    seed_instance_source = wg_cache_instance_source[cache_slot];
  } else {
    seed_instance_source = frame_instances[work.instance_slot].source;
  }
  seed_surface(pixel, resolved_position, settings.view_matrix, seed_instance_source,
    work, entry, (raster_flags & 1u) != 0u);`
    : "";
  return /* wgsl */ `
// Native cost slice: ${costSlice}
${surfaceGeometryCompletionWgsl(profile.productGeometry, true, false, fusedSun)}
${NATIVE_RESOLVED_POSITION_WGSL}
${lighting}
${profile.finalPixel && !profile.unlit ? SCGI_NATIVE_WGSL : ""}
${LINEAR_REC709_TO_REC2020_WGSL}
${profile.finalPixel ? FINAL_PIXEL_DIRECTORY_WGSL : NATIVE_MATERIAL_DIRECTORY_WGSL}
struct NativeSurfaceSettings {
  source: vec4u,
  source_payload: vec4u,
  dimensions: vec4u,
  camera_position_exposure: vec4f,
  view_matrix: mat4x4f,
  background: vec4f,
  inverse_view_projection: mat4x4f,
  ${profile.finalPixel ? "temporal: NativeTemporalSeedView," : ""}
}
@group(0) @binding(0) var<uniform> settings: NativeSurfaceSettings;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> source_heap: array<u32>;
@group(0) @binding(3) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(4) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(5) var visibility: texture_2d<u32>;
@group(0) @binding(7) var hdr: texture_storage_2d<rgba16float, write>;
${
  reflections
    ? `@group(0) @binding(15) var<storage, read_write> reflection_receivers: array<u32>;
${SSSR_RECEIVER_WRITE_WGSL}
var<private> reflection_response: vec4f;
var<private> reflection_baseline: vec3f;
var<private> reflection_flags: u32 = 1u;`
    : ""
}

${reactiveDeclaration}
${profile.finalPixel ? "fn seed_view() -> NativeTemporalSeedView { return settings.temporal; }" : ""}
${productBindings}
@group(2) @binding(0) var<storage, read> native_publication: array<u32>;
${profile.compact ? "@group(2) @binding(2) var<storage, read> native_tiles: array<u32>;" : ""}
@group(2) @binding(3) var<uniform> route: vec4u;
@group(2) @binding(4) var<uniform> native_frame_inputs: array<vec4f, ${Math.max(program.inputCount, 1)}>;
const geometry_needs: u32 = ${needs}u;
${nativePublicationAccessors("native_publication")}
${program.virtualTextures ? VIRTUAL_TEXTURE_FEEDBACK_WGSL : ""}
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
${
  fusedSun
    ? `fn native_face_normal(value: vec3f, position: vec3f) -> vec3f {
  let face = native_safe_normal(value, vec3f(0.0, 0.0, 1.0));
  return select(face, -face, dot(face, settings.camera_position_exposure.xyz - position) < 0.0);
}`
    : ""
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
var<workgroup> wg_tile_broadcast: u32;
var<workgroup> wg_cache_work: array<OEngineMeshletRasterWork, 1>;
var<workgroup> wg_cache_entry: array<NativeMaterialDirectoryEntry, 1>;
var<workgroup> wg_cache_instance_source: array<OEngineInstanceRecord, 1>;
var<workgroup> wg_cache_corners: array<GeometryCompletion, 1>;
${
  profile.compact
    ? ""
    : `var<workgroup> wg_dense_keys: array<u32, 64>;
var<workgroup> wg_dense_mixed: atomic<u32>;`
}
@compute @workgroup_size(${profile.compact ? "64" : "8, 8"})
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
${pixelSelection}
  let cache_hit = cache_slot == 0u;
  var work: OEngineMeshletRasterWork;
  var entry: NativeMaterialDirectoryEntry;
  var resolved: GeometryResolved;
  if (cache_hit) {
    work = wg_cache_work[cache_slot];
    entry = wg_cache_entry[cache_slot];
    let shared_c = wg_cache_corners[cache_slot];
    resolved = GeometryResolved(shared_c.flags, vec3u(0u), shared_c.coefficients, shared_c.position, shared_c.world_plane);
  } else {
    let key = lane_key;
    ${
      profile.finalPixel
        ? `if (key == OENGINE_VISIBILITY_KEY_EMPTY) {
      seed_unassigned(pixel, true);
      return;
    }`
        : ""
    }
    if (meshlet_work.header.generation != settings.dimensions.w) {
      ${profile.finalPixel ? "seed_unassigned(pixel, false);" : ""}
      return;
    }
    let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
    if (decoded.valid == 0u) {
      ${profile.finalPixel ? "seed_unassigned(pixel, key == OENGINE_VISIBILITY_KEY_EMPTY);" : ""}
      return;
    }
    if (decoded.meshlet_work_slot >= min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements))) {
      ${profile.finalPixel ? "seed_unassigned(pixel, false);" : ""}
      return;
    }
    work = meshlet_work.elements[decoded.meshlet_work_slot];
    if (work.instance_slot >= arrayLength(&frame_instances)) {
      ${profile.finalPixel ? "seed_unassigned(pixel, false);" : ""}
      return;
    }
    if (frame_instances[work.instance_slot].generation != settings.dimensions.w) {
      ${profile.finalPixel ? "seed_unassigned(pixel, false);" : ""}
      return;
    }
    let slot = work.material_slot_or_range;
    if (slot >= native_material_count()) {
      ${profile.finalPixel ? "seed_unassigned(pixel, false);" : ""}
      return;
    }
    entry = native_material_entry(slot);
    if (entry.execution_bin != route.x${profile.finalPixel ? " || entry.program_index == 0xffffffffu" : ""}) {
      ${profile.finalPixel ? "seed_unassigned(pixel, false);" : ""}
      return;
    }
    resolved = geometry_complete_resolved(decoded, work, frame_instances[work.instance_slot]);
  }
${
  fusedSun
    ? `${rasterFlags}
  let resolved_position = native_resolved_position(resolved, pixel);
  ${
    lateSun
      ? `var local_color = vec3f(0.0);
  var environment_color = vec3f(0.0);
  var sun_response: DirectPhysicalResponse;
  {`
      : "var sun_visibility = 1.0;"
  }
  let interpolation = winner_interpolate(resolved.coefficients, vec2f(pixel) + vec2f(0.5), vec2f(settings.dimensions.xy));
  if ((interpolation.flags & WINNER_VALUE_VALID) == 0u) {
    ${profile.finalPixel ? "seed_unassigned(pixel, false);" : ""}
    return;
  }
  ${
    profile.finalPixel && !profile.unlit
      ? `final_pixel_receiver = pixel;
  scgi_receiver_position = resolved_position;
  scgi_receiver_normal = normalize(resolved.world_plane.xyz);
  scgi_receiver_instance = frame_instances[work.instance_slot].source;
  scgi_receiver_slot = work.instance_slot;
  if ((scgi_receiver_instance.flags & 16u) != 0u &&
      dot(scgi_receiver_normal, settings.camera_position_exposure.xyz - resolved_position) < 0.0) {
    scgi_receiver_normal = -scgi_receiver_normal;
  }
  scgi_material_revision = entry.value_revision;`
      : ""
  }
  var corners: GeometryCompletion;
  if (cache_hit) {
    corners = wg_cache_corners[cache_slot];
  } else {
    corners = geometry_complete_attributes(resolved, frame_instances[work.instance_slot]);
  }`
    : ""
}
${evaluation}
${
  lateSun
    ? `  }
  // The resolved receiver is reused; no second geometry or material load.
  var sun_visibility = 1.0;
  ${
    costSlice === "G" || costSlice === "K"
      ? `if ((${directEnabled}) && direct_physical_can_contribute(sun_response) &&
      (resolved.flags & ${GPU_INSTANCE_FLAGS.ReceivesShadow}u) != 0u) {
    let face = native_face_normal(resolved.world_plane.xyz, resolved_position);
    var incident: GpuPrimitiveTypeTable;
    incident.direction = normalize(native_physical_sun.sun_direction_world);
    incident.color = vec3f(1.0);
    sun_visibility = vsm_sample_directional(resolved_position, face, incident, pixel);
  }`
      : ""
  }
  var sun_color = vec3f(0.0);
  if (${directEnabled}) {
    sun_color = native_surface_physical_sun(sun_response, resolved_position, resolved.flags, sun_visibility);
  }
  let color = (local_color + sun_color) + environment_color;`
    : ""
}
  // P is the positive GPU exposure published by radiometry. An artistic lower
  // floor here would disagree with Sky/Aerial and HDR metering above L=1800.
  let contribution = oengine_linear_rec709_to_rec2020(color) * settings.camera_position_exposure.w;
  var output_radiance = contribution;
${vsmDebug}
  ${
    profile.finalPixel && !profile.unlit
      ? `if (lighting_ranges.extent_debug.z != 0u) {
    let debug_gi = scgi_native_irradiance(scgi_receiver_normal, pixel);
    output_radiance = select(oengine_linear_rec709_to_rec2020(debug_gi.xyz) * settings.camera_position_exposure.w,
      vec3f(debug_gi.w), lighting_ranges.extent_debug.z == 2u);
  }`
      : ""
  }
  textureStore(hdr, vec2i(pixel), vec4f(output_radiance, 1.0));
  ${seedSurfaceBlock}
  ${reactiveWrite}
}
`;
}
