import { surfaceGeometryCompletionWgsl } from "../../.test-dist/shaders/surface_geometry_completion.js";
import { createProductionSparseDirectLightingWgsl } from "../../.test-dist/shaders/lighting_direct.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "../../.test-dist/shaders/environment_ibl.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "../../.test-dist/shaders/working_color.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import { SURFACE_FRAME_GEOMETRY_WGSL } from "../../.test-dist/shaders/surface_frame_geometry.js";

// S0 experiment only. No production owner imports this generator.
// Dense 8x8 workgroups, no queues, atomics, barriers, VM or shading history.
// 32B response + original fp32 position. Reconstructing position from Depth
// crossed a VSM page boundary in the numeric oracle; do not hide that error.
export const COMPACT_RECORD_BYTES = 44;

// Actual hardware raster creates winners from the same committed frame arena
// the compute consumer reads. Scene/culling/alpha inputs are fixture data.
export const PROBE_VISIBILITY_WGSL = /* wgsl */ `
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${SURFACE_FRAME_GEOMETRY_WGSL}
struct RasterSettings {
  source: vec4u,
  source_payload: vec4u,
  dimensions: vec4u,
  camera_position_exposure: vec4f,
}
@group(0) @binding(0) var<uniform> settings: RasterSettings;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> source_heap: array<u32>;
struct RasterVertex {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat) key: u32,
}
@vertex fn vertex_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) slot: u32) -> RasterVertex {
  let primitive = vertex / 3u;
  let frame = surface_frame_geometry(slot, primitive);
  let corner = surface_frame_corner(frame, primitive, vertex % 3u);
  return RasterVertex(surface_frame_clip(frame, corner), oengine_visibility_key_try_encode(slot, primitive).key);
}
@fragment fn fragment_main(input: RasterVertex) -> @location(0) u32 {
  if u32(input.clip.x) % settings.dimensions.z == 0u { discard; }
  return input.key;
}
`;

export function nativeSurfaceProbeWgsl({ stage, split = false, resolve = false }) {
  const geometry = surfaceGeometryCompletionWgsl(false, true, false);
  const direct = createProductionSparseDirectLightingWgsl(stage >= 4, "vsm");
  return /* wgsl */ `
${geometry}
${direct}
${OCTAHEDRAL_SAMPLE_WGSL}
${LINEAR_REC709_TO_REC2020_WGSL}
struct ProbeSettings {
  source: vec4u,
  source_payload: vec4u,
  dimensions: vec4u,
  camera_position_exposure: vec4f,
}
struct ProbeView {
  width: u32,
  height: u32,
  frame_index: u32,
  reserved: u32,
}
struct CompactRecord {
  base_rg: u32,
  base_b_metallic: u32,
  roughness_occlusion: u32,
  coat: u32,
  normal: u32,
  emissive_rg: u32,
  emissive_b: u32,
  coat_normal: u32,
  position_x: f32,
  position_y: f32,
  position_z: f32,
}
struct ProbeSurface {
  position: vec3f,
  normal: vec3f,
  tangent: vec4f,
  uv: vec2f,
  dx: vec2f,
  dy: vec2f,
  base: vec3f,
  metallic: f32,
  roughness: f32,
  occlusion: f32,
  emissive: vec3f,
  coat: vec2f,
  coat_normal: vec3f,
}
@group(0) @binding(0) var<uniform> settings: ProbeSettings;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> source_heap: array<u32>;
@group(0) @binding(3) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(4) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(5) var visibility: texture_2d<u32>;
@group(0) @binding(6) var winner_depth: texture_depth_2d;
@group(0) @binding(7) var hdr: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var material_textures: texture_2d_array<f32>;
@group(0) @binding(9) var material_sampler: sampler;
@group(0) @binding(10) var<storage, read_write> compact: array<CompactRecord>;
@group(1) @binding(0) var<storage, read> node: array<u32>;
@group(1) @binding(1) var<uniform> cluster_parameters: vec3f;
@group(1) @binding(2) var<storage, read> cluster_lookup: array<ClusterMetadata>;
@group(1) @binding(3) var<storage, read> cluster_data: ClusterData;
@group(1) @binding(4) var<uniform> shading_view: ProbeView;
@group(1) @binding(5) var environment_diffuse: texture_2d<f32>;
@group(1) @binding(6) var environment_specular: texture_2d<f32>;
@group(1) @binding(7) var environment_dfg: texture_2d<f32>;
${
  stage >= 4
    ? /* wgsl */ `
@group(2) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(2) @binding(1) var<storage, read> vsm_page_table: array<VsmPageEntry>;
@group(2) @binding(2) var vsm_atlas_depth: texture_depth_2d;
`
    : ""
}
const geometry_needs: u32 = (1u << 1u) | (1u << 5u) | (1u << 6u) | (1u << 7u);
fn interpolate(c: GeometryCorners, weights: vec3f) -> vec4f {
  return c.p0 * weights.x + c.p1 * weights.y + c.p2 * weights.z;
}
fn probe_geometry(key: u32, pixel: vec2f) -> ProbeSurface {
  let corners = geometry_build_completion(key);
  let weights = winner_interpolate(corners.coefficients, pixel, vec2f(settings.dimensions.xy));
  var surface: ProbeSurface;
  surface.position = interpolate(corners.position, weights.weights).xyz;
  surface.normal = normalize(interpolate(corners.normal, weights.weights).xyz);
  let tangent = interpolate(corners.tangent, weights.weights);
  surface.tangent = vec4f(normalize(tangent.xyz - surface.normal * dot(surface.normal, tangent.xyz)), tangent.w);
  surface.uv = interpolate(corners.uv, weights.weights).xy;
  surface.dx = interpolate(corners.uv, weights.dx).xy;
  surface.dy = interpolate(corners.uv, weights.dy).xy;
  surface.coat_normal = surface.normal;
  return surface;
}
fn sample_material(layer: i32, surface: ProbeSurface) -> vec4f {
  return textureSampleGrad(material_textures, material_sampler, surface.uv, layer, surface.dx, surface.dy);
}
fn probe_material(surface_in: ProbeSurface) -> ProbeSurface {
  var surface = surface_in;
  let base = sample_material(0, surface);
  ${stage === 6 ? "surface.base = base.rgb * vec3f(0.8, 0.7, 0.6); return surface;" : ""}
  let orm = sample_material(1, surface);
  let normal = sample_material(2, surface).xyz * 2.0 - vec3f(1.0);
  surface.base = base.rgb * vec3f(0.8, 0.7, 0.6);
  surface.metallic = clamp(orm.b * 0.7, 0.0, 1.0);
  surface.roughness = clamp(orm.g * 0.8, 0.04, 1.0);
  surface.occlusion = mix(1.0, orm.r, 0.8);
  surface.emissive = sample_material(3, surface).rgb * vec3f(0.1, 0.05, 0.02);
  let coat = sample_material(4, surface);
  surface.coat = vec2f(coat.r * 0.35, max(coat.g * 0.4, 0.04));
  let bitangent = cross(surface.normal, surface.tangent.xyz) * surface.tangent.w;
  surface.normal = normalize(mat3x3f(surface.tangent.xyz, bitangent, surface.normal) * normal);
  return surface;
}
fn probe_lighting(surface: ProbeSurface, pixel: vec2f) -> vec3f {
  var material: StandardMaterial;
  material.diffuse = surface.base * (1.0 - surface.metallic);
  material.roughness = surface.roughness;
  material.occlusion = surface.occlusion;
  material.specularF0 = mix(vec3f(0.04), surface.base, surface.metallic);
  material.specularF90 = 1.0;
  material.energyCompensation = vec3f(1.0);
  material.emissive = surface.emissive;
  material.coatFactor = surface.coat.x;
  material.coatRoughness = surface.coat.y;
  material.coatNormal = surface.coat_normal;
  let direction = normalize(settings.camera_position_exposure.xyz - surface.position);
  let geometry = SurfaceGeometry(surface.normal, surface.coat_normal, surface.position, direction);
  // Fixture camera looks down -Z. Use recovered world position for the
  // actual logarithmic cluster slice; never replace that dependency by 1.
  let view_depth = max(settings.camera_position_exposure.z - surface.position.z, 1e-4);
  var color = shade_standard_material_direct(material, geometry, pixel, view_depth);
  ${
    stage >= 5
      ? /* wgsl */ `
  let irradiance = sample_octahedral_bilinear(environment_diffuse, vec2u(0u), textureDimensions(environment_diffuse).x, surface.normal, 0u).rgb;
  let specular = sample_prefiltered_environment(environment_specular, reflect(-direction, surface.normal), surface.roughness);
  let dfg_dimensions = textureDimensions(environment_dfg);
  let dfg_pixel = vec2i(clamp(vec2f(saturate(dot(surface.normal, direction)), surface.roughness) * vec2f(dfg_dimensions), vec2f(0.0), vec2f(dfg_dimensions) - vec2f(1.0)));
  let dfg = textureLoad(environment_dfg, dfg_pixel, 0).xy;
  let coat_specular = sample_prefiltered_environment(environment_specular, reflect(-direction, surface.coat_normal), surface.coat.y);
  color += (irradiance * material.diffuse * RECIPROCAL_PI + specular * (material.specularF0 * dfg.x + vec3f(dfg.y)) + coat_specular * surface.coat.x * 0.04) * surface.occlusion;
  `
      : ""
  }
  return color;
}
fn compact_write(pixel: u32, surface: ProbeSurface) {
  compact[pixel] = CompactRecord(
    pack2x16float(surface.base.rg),
    pack2x16float(vec2f(surface.base.b, surface.metallic)),
    pack2x16float(vec2f(surface.roughness, surface.occlusion)),
    pack2x16float(surface.coat),
    pack2x16unorm(oct_encode(surface.normal)),
    pack2x16float(surface.emissive.rg),
    pack2x16float(vec2f(surface.emissive.b, 0.0)),
    pack2x16unorm(oct_encode(surface.coat_normal)),
    surface.position.x,
    surface.position.y,
    surface.position.z,
  );
}
fn compact_read(pixel: u32, coordinate: vec2u) -> ProbeSurface {
  let record = compact[pixel];
  var surface: ProbeSurface;
  let base_rg = unpack2x16float(record.base_rg);
  let base_b_metallic = unpack2x16float(record.base_b_metallic);
  let roughness_occlusion = unpack2x16float(record.roughness_occlusion);
  surface.base = vec3f(base_rg, base_b_metallic.x);
  surface.metallic = base_b_metallic.y;
  surface.roughness = roughness_occlusion.x;
  surface.occlusion = roughness_occlusion.y;
  surface.coat = unpack2x16float(record.coat);
  surface.normal = oct_decode(unpack2x16unorm(record.normal));
  surface.coat_normal = oct_decode(unpack2x16unorm(record.coat_normal));
  surface.emissive = vec3f(unpack2x16float(record.emissive_rg), unpack2x16float(record.emissive_b).x);
  surface.position = vec3f(record.position_x, record.position_y, record.position_z);
  return surface;
}
fn geometry_sink(surface: ProbeSurface) -> vec3f {
  return abs(surface.position) + abs(surface.normal) * 0.1 + abs(surface.tangent.xyz) * 0.1
    + vec3f(surface.uv, surface.dx.x + surface.dy.y) * 0.01;
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= settings.dimensions.xy) { return; }
  let key = textureLoad(visibility, vec2i(id.xy), 0).r;
  if key == OENGINE_VISIBILITY_KEY_EMPTY {
    ${split && !resolve ? "return;" : "textureStore(hdr, vec2i(id.xy), vec4f(0.0)); return;"}
  }
  let pixel = id.x + id.y * settings.dimensions.x;
  ${resolve ? "let surface = compact_read(pixel, id.xy);" : "let surface = probe_geometry(key, vec2f(id.xy) + vec2f(0.5));"}
  ${!resolve && stage !== 0 ? "let evaluated = probe_material(surface);" : "let evaluated = surface;"}
  ${
    split && !resolve
      ? "compact_write(pixel, evaluated);"
      : /* wgsl */ `
  ${stage === 0 ? "let color = geometry_sink(evaluated);" : stage === 6 ? "let color = evaluated.base;" : stage === 1 ? "let color = geometry_sink(surface) + evaluated.base + evaluated.emissive + vec3f(evaluated.metallic + evaluated.roughness + evaluated.occlusion + evaluated.coat.x + evaluated.coat.y) * 0.01 + abs(evaluated.normal) * 0.01;" : "let color = probe_lighting(evaluated, vec2f(id.xy) + vec2f(0.5));"}
  textureStore(hdr, vec2i(id.xy), vec4f(oengine_linear_rec709_to_rec2020(color) * settings.camera_position_exposure.w, 1.0));
  `
  }
}
@compute @workgroup_size(8, 8)
fn alu_probe(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= settings.dimensions.xy) { return; }
  let seed = f32(id.x + id.y * settings.dimensions.x) * 0.000013;
  var value = vec3f(fract(seed) * 0.1 + 0.02);
  for (var i = 0u; i < 32u; i++) {
    // Every angular/roughness input depends on the lane AND prior result.
    // Constant BRDF angles let the compiler fold almost all of the old loop.
    let phase = fract(seed + value.x * 0.371 + f32(i) * 0.013);
    let no_l = 0.1 + phase * 0.8;
    let no_v = 0.1 + fract(seed * 0.73 + value.y) * 0.8;
    let no_h_squared = 0.05 + fract(phase * 0.57 + value.z) * 0.85;
    let vo_h = 0.1 + fract(phase + value.y * 0.13) * 0.8;
    let alpha = 0.1 + fract(phase + value.z * 0.21) * 0.6;
    value = BRDF_GGX(no_l, no_v, no_h_squared, vo_h, value, 1.0, alpha) * 0.01 + vec3f(0.02);
  }
  textureStore(hdr, vec2i(id.xy), vec4f(value, 1.0));
}
`;
}
