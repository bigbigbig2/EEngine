/**
 * transparent_oit：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";
import { GPU_VIEW_TYPE } from "../render/ViewContext.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { LIGHTING_DIRECT_WGSL } from "./lighting_direct.js";
import { BRICK4_COMMON_WGSL } from "./brick4_indirect.js";

export const OIT_OPTICAL_DEPTH_FORMAT = "r32float" as const;
export const OIT_MOMENTS_FORMAT = "rgba32float" as const;
export const OIT_RESOLVED_FORMAT = "rgba16float" as const;

function removeWgslFunction(source: string, name: string): string {
  const token = `fn ${name}(`;
  const start = source.indexOf(token);
  if (start < 0) return source;
  const brace = source.indexOf("{", start + token.length);
  if (brace < 0) return source;
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    const character = source[index];
    if (character === "{") depth++;
    if (character === "}") {
      depth--;
      if (depth === 0) {
        return `${source.slice(0, start)}${source.slice(index + 1)}`;
      }
    }
  }
  return source;
}

function directLightingCore(): string {
  let source = LIGHTING_DIRECT_WGSL;
  source = source.replace(/^@group\(0\).*$/gm, "");
  source = source.replace(/^@group\(2\).*$/gm, "");
  source = source.replace(/@group\(1\)/g, "@group(3)");
  source = removeWgslFunction(source, "read_gBuffer_material");
  const fullscreen = source.indexOf("const FULLSCREEN_POSITIONS");
  return fullscreen < 0 ? source : source.slice(0, fullscreen);
}

const DIRECT_LIGHTING_CORE = directLightingCore();

function brick4ForwardCore(): string {
  let source = BRICK4_COMMON_WGSL
    .replace(LPV_CAMERA_TYPE.wgsl_declaration, "")
    .replace(GPU_VIEW_TYPE.wgsl_declaration, "");
  const fullscreen = source.indexOf("const FULLSCREEN_POSITIONS");
  if (fullscreen >= 0) source = source.slice(0, fullscreen);
  for (const name of [
    "uv_octahedral_unit_decode",
    "decode_g_buffer_normal",
    "decode_g_buffer_roughness",
    "decode_g_buffer_metalness",
    "uv_to_ndc",
    "project_position_from_depth",
    "rgbe9995_decode",
    "stbn_sample_vec2"
  ]) {
    source = removeWgslFunction(source, name);
  }
  return source;
}

const BRICK4_FORWARD_CORE = brick4ForwardCore();

const MATERIAL_AND_MESHLET_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}

struct MaterialInfo {
  albedo_color: vec4f,
  emissive_factor: vec3f,
  id: u32,
  ambient_factors: vec2f,
  metallic_factor: f32,
  roughness_factor: f32,
  transmission_factor: f32,
  ior_factor: f32,
  transparency_mode: u32,
  draw_mode: u32,
  draw_side: u32,
}

struct MeshletElement { index: u32, mesh: u32 }

struct MeshletHeader {
  bounds_box: array<f32, 6>,
  address: u32,
  primitive_count: u32,
  vertex_count: u32,
  flags: u32,
}

struct MeshletVertex {
  position: vec3f,
  normal: vec3f,
  tangent: vec4f,
  uv: vec2f,
  uv1: vec2f,
  color: vec3f,
}

struct ForwardVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) position_ws: vec3f,
  @location(2) normal: vec3f,
  @location(3) tangent: vec4f,
  @location(4) color: vec3f,
}

@group(0) @binding(0) var<uniform> material_info: MaterialInfo;
@group(0) @binding(1) var normal: texture_2d<f32>;
@group(0) @binding(2) var lookup: sampler;
@group(0) @binding(3) var transmitted_energy_factor: texture_2d<f32>;
@group(0) @binding(4) var screen_st: sampler;
@group(0) @binding(5) var xyz: texture_2d<f32>;
@group(0) @binding(6) var elements_per_texel_depth: sampler;
@group(0) @binding(7) var bb_dim: texture_2d<f32>;
@group(0) @binding(8) var normals: sampler;

@group(1) @binding(0) var<storage, read> meshlets: array<MeshletElement>;
@group(1) @binding(1) var<storage, read> camera_icon: array<u32>;
@group(1) @binding(2) var<storage, read> history_raw_type: array<f32>;
@group(1) @binding(3) var<storage, read> scene_database: array<u32>;
@group(1) @binding(4) var<storage, read> geometries: array<u32>;

fn read_meshlet_header(meshlet_id: u32) -> MeshletHeader {
  let offset = meshlet_id * 10u;
  var header: MeshletHeader;
  header.bounds_box = array<f32, 6>(
    bitcast<f32>(camera_icon[offset]), bitcast<f32>(camera_icon[offset + 1u]),
    bitcast<f32>(camera_icon[offset + 2u]), bitcast<f32>(camera_icon[offset + 3u]),
    bitcast<f32>(camera_icon[offset + 4u]), bitcast<f32>(camera_icon[offset + 5u])
  );
  header.address = camera_icon[offset + 6u];
  header.primitive_count = camera_icon[offset + 7u];
  header.vertex_count = camera_icon[offset + 8u];
  header.flags = camera_icon[offset + 9u];
  return header;
}

fn read_meshlet_attribute_u32(offset: u32) -> u32 {
  return bitcast<u32>(history_raw_type[offset]);
}
fn read_meshlet_attribute_vec2f(offset: u32) -> vec2f {
  return vec2f(history_raw_type[offset], history_raw_type[offset + 1u]);
}
fn read_meshlet_attribute_vec3f(offset: u32) -> vec3f {
  return vec3f(history_raw_type[offset], history_raw_type[offset + 1u], history_raw_type[offset + 2u]);
}
fn meshlet_compute_attribute_section_offset(header: MeshletHeader) -> u32 {
  return header.address + ((header.primitive_count * 3u + 3u) >> 2u);
}
fn uv_octahedral_unit_decode_meshlet(encoded: vec2f) -> vec3f {
  var direction = vec3f(fma(encoded, vec2f(2.0), vec2f(-1.0)), 0.0);
  direction.z = 1.0 - abs(direction.x) - abs(direction.y);
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}
fn decode_vertex_normal(value: u32) -> vec3f {
  let encoded = (vec2u(value) >> vec2u(0u, 16u)) & vec2u(0xffffu);
  return uv_octahedral_unit_decode_meshlet(vec2f(encoded) / vec2f(65535.0));
}
fn decode_vertex_tangent(value: u32) -> vec4f {
  let sign_value = f32(value & 1u) * 2.0 - 1.0;
  let encoded = (vec2u(value) >> vec2u(1u, 16u)) & vec2u(0x7fffu, 0xffffu);
  return vec4f(uv_octahedral_unit_decode_meshlet(vec2f(encoded) / vec2f(32767.0, 65535.0)), sign_value);
}
fn read_meshlet_resolved_index(header: MeshletHeader, draw_index: u32) -> u32 {
  let packed = read_meshlet_attribute_u32(header.address + (draw_index >> 2u));
  return (packed >> ((draw_index & 3u) << 3u)) & 0xffu;
}
fn read_meshlet_vertex(header: MeshletHeader, vertex_id: u32) -> MeshletVertex {
  let id = min(vertex_id, header.vertex_count - 1u);
  var offset = meshlet_compute_attribute_section_offset(header);
  var output: MeshletVertex;
  output.position = read_meshlet_attribute_vec3f(offset + id * 3u);
  offset += header.vertex_count * 3u;
  output.normal = decode_vertex_normal(read_meshlet_attribute_u32(offset + select(id, 0u, (header.flags & 1u) != 0u)));
  offset += select(header.vertex_count, 1u, (header.flags & 1u) != 0u);
  output.tangent = decode_vertex_tangent(read_meshlet_attribute_u32(offset + select(id, 0u, (header.flags & 2u) != 0u)));
  offset += select(header.vertex_count, 1u, (header.flags & 2u) != 0u);
  output.color = unpack4x8unorm(read_meshlet_attribute_u32(offset + select(id, 0u, (header.flags & 4u) != 0u))).xyz;
  offset += select(header.vertex_count, 1u, (header.flags & 4u) != 0u);
  output.uv = read_meshlet_attribute_vec2f(offset + select(id, 0u, (header.flags & 8u) != 0u) * 2u);
  offset += select(header.vertex_count, 2u, (header.flags & 8u) != 0u);
  output.uv1 = unpack2x16unorm(read_meshlet_attribute_u32(offset + select(id, 0u, (header.flags & 16u) != 0u)));
  return output;
}
fn read_meshlet_vertex_by_draw_index(header: MeshletHeader, draw_index: u32) -> MeshletVertex {
  let clamped = min(draw_index, header.primitive_count * 3u - 1u);
  return read_meshlet_vertex(header, read_meshlet_resolved_index(header, clamped));
}
fn compute_normal_matrix_from_m4(value: mat4x4f) -> mat3x3f {
  return mat3x3f(cross(value[1].xyz, value[2].xyz), cross(value[2].xyz, value[0].xyz), cross(value[0].xyz, value[1].xyz));
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32, @builtin(instance_index) instance_index: u32) -> ForwardVertex {
  let element = meshlets[instance_index];
  let header = read_meshlet_header(element.index);
  let mesh = scene_read_mesh(&scene_database, element.mesh);
  let node_record = scene_read_node(&scene_database, mesh.node);
  let vertex = read_meshlet_vertex_by_draw_index(header, vertex_index);
  let world = node_record.global * vec4f(vertex.position, 1.0);
  let normal_matrix = compute_normal_matrix_from_m4(node_record.global);
  var output: ForwardVertex;
  output.position_ws = world.xyz / world.w;
  output.position = camera.view_projection_matrix * world;
  output.uv = vertex.uv;
  output.normal = normalize(normal_matrix * vertex.normal);
  output.tangent = vec4f(normalize(normal_matrix * vertex.tangent.xyz), vertex.tangent.w);
  output.color = vertex.color * material_info.albedo_color.rgb;
  return output;
}
`;

const OIT_DEPTH_AND_MATERIAL_WGSL = /* wgsl */ `
fn saturate_oit(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }
fn inverse_lerp_oit(a: f32, b: f32, value: f32) -> f32 { return (value - a) / (b - a); }
fn get_view_space_depth_oit(depth: f32) -> f32 {
  return camera.device_depth_to_view_space.y / (depth + camera.device_depth_to_view_space.x);
}
fn compute_near_far_from_projection_oit() -> vec2f {
  return vec2f(0.1, 100.0);
}
fn oit_linearize_depth(position: vec4f) -> f32 {
  let view_depth = get_view_space_depth_oit(position.z / position.w);
  let near_far = compute_near_far_from_projection_oit();
  return saturate_oit(inverse_lerp_oit(near_far.x, near_far.y, view_depth));
}
fn unjitter_uv(uv: vec2f, jitter: vec2f) -> vec2f {
  return uv - jitter.x * dpdx(uv) - jitter.y * dpdy(uv);
}
fn dielectric_specular_color(ior: f32, metalness: f32, diffuse: vec3f) -> vec3f {
  let ratio = (ior - 1.0) / (ior + 1.0);
  return mix(vec3f(ratio * ratio), diffuse, metalness);
}
fn F_Hauber_oit(f0: vec3f, f90: f32, cosine: f32) -> vec3f {
  let one_minus = 1.0 - cosine;
  let fourth = one_minus * one_minus * one_minus * one_minus;
  return mix(f0, vec3f(f90 - cosine), fourth);
}
`;

export const OIT_MOMENTS_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_VIEW_TYPE.wgsl_declaration}
${MATERIAL_AND_MESHLET_WGSL}
@group(2) @binding(0) var<uniform> camera: CommandEncoder;
@group(2) @binding(1) var<uniform> view: PipelineCacheKey;
${OIT_DEPTH_AND_MATERIAL_WGSL}

struct MomentOutput {
  @location(0) b_0: f32,
  @location(1) moments: vec4f,
}

@fragment
fn fs_main(@builtin(front_facing) front_facing: bool, input: ForwardVertex) -> MomentOutput {
  _ = front_facing;
  let uv = unjitter_uv(input.uv, view.jitter);
  let diffuse_sample = textureSample(normal, lookup, uv);
  let surface_alpha = diffuse_sample.a * material_info.albedo_color.a;
  var opacity = surface_alpha;
  let transmission = material_info.transmission_factor;
  if (transmission > 0.0) {
    let pbr = textureSample(xyz, elements_per_texel_depth, uv);
    let diffuse = diffuse_sample.rgb / max(diffuse_sample.a, 1e-7);
    let metalness = pbr.b * material_info.metallic_factor;
    let specular_f0 = dielectric_specular_color(material_info.ior_factor, metalness, diffuse);
    let view_direction = normalize(camera.transform[3].xyz - input.position_ws);
    let nov = saturate_oit(abs(dot(normalize(input.normal), view_direction)));
    let fresnel = F_Hauber_oit(specular_f0, 1.0, nov);
    opacity = mix(surface_alpha, max(fresnel.r, max(fresnel.g, fresnel.b)), transmission);
  }
  let coverage = min(opacity, 0.997);
  let b_0 = -log(1.0 - coverage);
  let depth = oit_linearize_depth(input.position);
  let depth2 = depth * depth;
  var output: MomentOutput;
  output.b_0 = b_0;
  output.moments = vec4f(depth, depth2, depth2 * depth, depth2 * depth2) * b_0;
  return output;
}
`;

const POWER_MOMENT_RESOLVE_WGSL = /* wgsl */ `
fn resolve_hamburger_msm(depth: f32, b0: f32, even_moments: vec2f, odd_moments: vec2f) -> f32 {
  var moments = vec4f(odd_moments.x, even_moments.x, odd_moments.y, even_moments.y);
  moments = mix(moments, vec4f(0.0, 0.375, 0.0, 0.375), 0.000006);
  let l21_d11 = fma(-moments.x, moments.x, moments.y);
  let l32_d11 = fma(-moments.x, moments.y, moments.z);
  let inv_d11 = 1.0 / l21_d11;
  let l32 = l32_d11 * inv_d11;
  let d22 = fma(-moments.y, moments.y, moments.w);
  let inv_d22 = 1.0 / fma(-l32_d11, l32, d22);
  var coefficients = vec3f(1.0, depth, depth * depth);
  coefficients.y -= moments.x;
  coefficients.z -= moments.y + l32 * coefficients.y;
  coefficients.y *= inv_d11;
  coefficients.z *= inv_d22;
  coefficients.y -= l32 * coefficients.z;
  coefficients.x -= dot(coefficients.yz, moments.xy);
  let inv_c2 = 1.0 / coefficients.z;
  let p = coefficients.y * inv_c2;
  let q = coefficients.x * inv_c2;
  let discriminant = p * p * 0.25 - q;
  let root = sqrt(discriminant);
  let z1 = -p * 0.5 - root;
  let z2 = -p * 0.5 + root;
  let sw = vec3f(0.25, select(0.0, 1.0, z1 < depth), select(0.0, 1.0, z2 < depth));
  let quotient = (sw.y - sw.x) / (z1 - depth);
  let quotient2 = (sw.z - sw.y) / (z2 - z1);
  let coefficient = (quotient2 - quotient) / (z2 - depth);
  var polynomial: vec3f;
  polynomial.x = coefficient;
  polynomial.y = polynomial.x;
  polynomial.x = quotient - polynomial.x * z1;
  polynomial.z = polynomial.y;
  polynomial.y = polynomial.x - polynomial.y * depth;
  polynomial.x = sw.x - polynomial.x * depth;
  let absorbance = polynomial.x + dot(moments.xy, polynomial.yz);
  return saturate_oit(exp(-b0 * absorbance));
}
fn resolve_power_moments_4(depth: f32, b0: f32, moments: vec4f) -> f32 {
  return resolve_hamburger_msm(depth, b0, moments.yw / b0, moments.xz / b0);
}
`;

const FORWARD_HELPERS_WGSL = /* wgsl */ `
fn build_orthonormal_matrix_nt(normal_value: vec3f, tangent: vec4f) -> mat3x3f {
  let x = normalize(tangent.xyz - normal_value * dot(normal_value, tangent.xyz));
  let y = normalize(cross(normal_value, x) * tangent.w);
  return mat3x3f(x, y, normal_value);
}
fn anti_alias_roughness_kaplanyan(roughness: f32, normal_value: vec3f, tangent: vec3f, bitangent: vec3f) -> f32 {
  let derivative = fwidth(vec2f(dot(normal_value, tangent), dot(normal_value, bitangent)));
  let variance = 0.25 * pow(clamp(max(derivative.x, derivative.y), 1e-3, 0.3), 2.0);
  return sqrt(roughness * roughness + min(0.18, variance * 2.0));
}
fn compute_specular_occlusion(nov: f32, occlusion: f32, roughness: f32) -> f32 {
  let exponent = exp2(-16.0 * roughness - 1.0);
  return saturate_oit(pow(nov + occlusion, exponent) - 1.0 + occlusion);
}
fn decode_typed_buffer_oit(split_sum: vec2f, f0: vec3f, f90: f32, single: ptr<function, vec3f>, multi: ptr<function, vec3f>) {
  let combined = f0 * split_sum.x + f90 * split_sum.y;
  let sum = split_sum.x + split_sum.y;
  let ratio = (1.0 - sum) / max(sum, 1e-4);
  *single += combined;
  *multi += combined * (f0 * ratio);
}
fn compute_indirect_specular_oit(radiance: vec3f, irradiance: vec3f, shading_normal: vec3f, view_direction: vec3f, diffuse: vec3f, f0: vec3f, f90: f32, roughness: f32) -> mat2x3f {
  var single = vec3f(0.0);
  var multi = vec3f(0.0);
  let split_sum = textureSampleLevel(dependencies, segment_height, vec2f(saturate_oit(dot(shading_normal, view_direction)), roughness), 0.0).rg;
  decode_typed_buffer_oit(split_sum, f0, f90, &single, &multi);
  let directional_albedo = single + multi;
  let indirect_specular = radiance * directional_albedo;
  let indirect_diffuse = diffuse * clamp(vec3f(1.0) - directional_albedo, vec3f(0.0), vec3f(1.0)) * irradiance * 0.3183098861837907;
  return mat2x3f(indirect_specular, indirect_diffuse);
}
`;

const BRICK4_FORWARD_RANDOM_WGSL = /* wgsl */ `
fn oit_rotate_left(value: u32, count: u32) -> u32 {
  return (value << count) | (value >> (32u - count));
}
fn oit_murmur_finalize(value_original: u32) -> u32 {
  var value = value_original;
  value ^= value >> 16u;
  value *= 0x85ebca6bu;
  value ^= value >> 13u;
  value *= 0xc2b2ae35u;
  value ^= value >> 16u;
  return value;
}
fn oit_hash_vec3(value: vec3u) -> u32 {
  let c1 = 0xcc9e2d51u;
  let c2 = 0x1b873593u;
  var hash = 0u;
  var lane: u32;
  lane = oit_rotate_left(value.x * c1, 15u) * c2;
  hash = oit_rotate_left(hash ^ lane, 13u) * 5u + 0xe6546b64u;
  lane = oit_rotate_left(value.y * c1, 15u) * c2;
  hash = oit_rotate_left(hash ^ lane, 13u) * 5u + 0xe6546b64u;
  lane = oit_rotate_left(value.z * c1, 15u) * c2;
  hash = oit_rotate_left(hash ^ lane, 13u) * 5u + 0xe6546b64u;
  return oit_murmur_finalize(hash ^ 12u);
}
fn oit_brick4_sample_noise(position: vec3f, normal_value: vec3f, frame_index: u32) -> vec2f {
  var bits = bitcast<vec3u>(position) ^ bitcast<vec3u>(normal_value);
  bits.x ^= frame_index;
  return unpack2x16unorm(oit_hash_vec3(bits));
}
`;

const IBL_FORWARD_WGSL = /* wgsl */ `
fn oct_sign_oit(value: vec2f) -> vec2f { return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0)); }
fn oct_encode_oit(direction: vec3f) -> vec2f {
  var projected = direction.xy / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if (direction.z < 0.0) { projected = (1.0 - abs(projected.yx)) * oct_sign_oit(projected); }
  return 0.5 + 0.5 * projected;
}
fn oct_wrap_oit(position: vec2i, resolution: i32) -> vec2u {
  let wrapped = ((position % resolution) + resolution) % resolution;
  let crossings = abs(position / resolution) + select(vec2i(0), vec2i(1), position < vec2i(0));
  return select(vec2u(wrapped), vec2u(resolution - (wrapped + vec2i(1))), ((crossings.x ^ crossings.y) & 1) != 0);
}
fn sample_octahedral_oit(source: texture_2d<f32>, direction: vec3f, lod: u32) -> vec3f {
  let resolution = textureDimensions(source, i32(lod)).x;
  let texel = fma(oct_encode_oit(direction), vec2f(f32(resolution)), vec2f(-0.5));
  let fraction = fract(texel);
  let base = vec2i(floor(texel));
  let w = vec4f((1.0-fraction.x)*(1.0-fraction.y), fraction.x*(1.0-fraction.y), (1.0-fraction.x)*fraction.y, fraction.x*fraction.y);
  return textureLoad(source, vec2i(oct_wrap_oit(base, i32(resolution))), i32(lod)).rgb*w.x +
    textureLoad(source, vec2i(oct_wrap_oit(base+vec2i(1,0), i32(resolution))), i32(lod)).rgb*w.y +
    textureLoad(source, vec2i(oct_wrap_oit(base+vec2i(0,1), i32(resolution))), i32(lod)).rgb*w.z +
    textureLoad(source, vec2i(oct_wrap_oit(base+vec2i(1,1), i32(resolution))), i32(lod)).rgb*w.w;
}
fn roughness_to_mip_ratio_oit(roughness: f32) -> f32 {
  let ratio = saturate_oit(roughness / 0.7);
  return mix(ratio, sqrt(ratio), 0.4);
}
fn get_ibl_radiance_oit(view_direction: vec3f, normal_value: vec3f, roughness: f32) -> vec3f {
  let direction = normalize(mix(reflect(-view_direction, normal_value), normal_value, roughness * roughness));
  let lod = roughness_to_mip_ratio_oit(roughness) * 4.0;
  let lower = u32(floor(lod));
  return mix(sample_octahedral_oit(sec_radix_passes, direction, lower), sample_octahedral_oit(sec_radix_passes, direction, lower + 1u), fract(lod));
}
fn get_ibl_irradiance_oit(normal_value: vec3f) -> vec3f {
  return sample_octahedral_oit(sec_radix_passes, normal_value, 4u) * 3.141592653589793;
}
`;

function forwardFragment(indirectMode: "ibl" | "brick4"): string {
  const brick4 = indirectMode === "brick4";
  const splitSumBinding = brick4 ? 5 : 4;
  const samplerBinding = brick4 ? 6 : 5;
  const modeBindings = brick4
    ? "@group(2) @binding(4) var<storage, read> radiip: Brick4LightMapStorage;"
    : "";
  const indirectCore = brick4 ? BRICK4_FORWARD_CORE : IBL_FORWARD_WGSL;
  const indirectSample = brick4
    ? /* wgsl */ `
      let node_oit = brick4_node_by_position(geometry.position);
      let meta_oit = brick4_node_sample_probes_meta(node_oit.bounds, geometry.position, geometry.shading_normal);
      let noise_oit = oit_brick4_sample_noise(geometry.position, geometry.shading_normal, view.frame_index);
      let pair_oit = brick4_probe_meta_pick2(meta_oit, node_oit.address, noise_oit);
      let probes_oit = sh3_color_mix2(brick4_load_probe(pair_oit.global_indices.x), brick4_load_probe(pair_oit.global_indices.y), pair_oit.blend);
      let reflection_oit = normalize(mix(reflect(-geometry.view_direction, geometry.shading_normal), geometry.shading_normal, material.roughness * material.roughness));
      let radiance_oit = sh3_color_get_radiance_with_ggx(probes_oit, reflection_oit, material.roughness * material.roughness);
      let irradiance_oit = sh3_color_estimate_for_cone(probes_oit, 0.0, geometry.shading_normal);`
    : /* wgsl */ `
      let radiance_oit = get_ibl_radiance_oit(geometry.view_direction, geometry.shading_normal, material.roughness);
      let irradiance_oit = get_ibl_irradiance_oit(geometry.shading_normal);`;
  return /* wgsl */ `
${DIRECT_LIGHTING_CORE}
${MATERIAL_AND_MESHLET_WGSL}
@group(2) @binding(0) var<uniform> camera: CommandEncoder;
@group(2) @binding(1) var<uniform> view: PipelineCacheKey;
@group(2) @binding(2) var getter_return_type: texture_2d<f32>;
@group(2) @binding(3) var g: texture_2d<f32>;
${modeBindings}
@group(2) @binding(${splitSumBinding}) var dependencies: texture_2d<f32>;
@group(2) @binding(${samplerBinding}) var segment_height: sampler;
${OIT_DEPTH_AND_MATERIAL_WGSL}
${POWER_MOMENT_RESOLVE_WGSL}
${FORWARD_HELPERS_WGSL}
${brick4 ? BRICK4_FORWARD_RANDOM_WGSL : ""}
${indirectCore}

fn forward_shade_standard_fragment(input: ForwardVertex, front_facing: bool) -> vec4f {
  let tangent_frame = build_orthonormal_matrix_nt(input.normal, input.tangent);
  let sampled_normal = textureSample(transmitted_energy_factor, screen_st, input.uv).rgb * 2.0 - 1.0;
  var shading_normal = normalize(tangent_frame * sampled_normal);
  if (!front_facing) { shading_normal = -shading_normal; }
  let view_direction = normalize(camera.transform[3].xyz - input.position_ws);
  let geometry = SurfaceGeometry(shading_normal, shading_normal, input.position_ws, view_direction);
  let pbr = textureSample(xyz, elements_per_texel_depth, input.uv);
  let diffuse_sample = textureSample(normal, lookup, input.uv);
  let emissive_sample = textureSample(bb_dim, normals, input.uv);
  let diffuse = diffuse_sample.rgb * input.color / max(diffuse_sample.a, 1e-7);
  let occlusion = pbr.r;
  let metalness = pbr.b * material_info.metallic_factor;
  let roughness = max(anti_alias_roughness_kaplanyan(pbr.g * material_info.roughness_factor, shading_normal, tangent_frame[0], tangent_frame[1]), 0.02);
  let transmission = material_info.transmission_factor;
  let albedo = diffuse * (1.0 - metalness) * (1.0 - transmission);
  let specular_f0 = dielectric_specular_color(material_info.ior_factor, metalness, diffuse);
  let fresnel = F_Hauber(specular_f0, 1.0, saturate(dot(shading_normal, view_direction)));
  let opacity = mix(diffuse_sample.a * material_info.albedo_color.a, max(fresnel.r, max(fresnel.g, fresnel.b)), transmission);
  let material = StandardMaterial(albedo, roughness, occlusion, specular_f0, 1.0, emissive_sample.rgb * material_info.emissive_factor, opacity);
  var color = shade_standard_material_direct(material, geometry, input.position.xy, get_view_space_depth(input.position.z, camera));
  ${indirectSample}
  let indirect = compute_indirect_specular_oit(radiance_oit, irradiance_oit, geometry.shading_normal, geometry.view_direction, material.diffuse, material.specularF0, material.specularF90, material.roughness);
  let specular_occlusion = compute_specular_occlusion(saturate(dot(geometry.shading_normal, geometry.view_direction)), material.occlusion, material.roughness);
  color += indirect[0] * material.occlusion + indirect[1] * specular_occlusion;
  return vec4f(color, material.opacity);
}

@fragment
fn fs_main(@builtin(front_facing) front_facing: bool, input_original: ForwardVertex) -> @location(0) vec4f {
  let pixel = vec2u(input_original.position.xy);
  let b_0 = textureLoad(g, pixel, 0).r;
  if (b_0 < 0.00100050033) { discard; }
  var input = input_original;
  input.uv = unjitter_uv(input.uv, view.jitter);
  let shaded = forward_shade_standard_fragment(input, front_facing);
  let coverage = min(shaded.a, 0.997);
  let transmittance = resolve_power_moments_4(oit_linearize_depth(input.position), b_0, textureLoad(getter_return_type, pixel, 0));
  return vec4f(shaded.rgb * coverage, coverage) * transmittance;
}
`;
}

export const OIT_FORWARD_IBL_WGSL = forwardFragment("ibl");
export const OIT_FORWARD_BRICK4_WGSL = forwardFragment("brick4");

export const OIT_COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var right: texture_2d<f32>;
@group(0) @binding(1) var static_copy: texture_2d<f32>;

const POSITIONS = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(POSITIONS[index], 0.0, 1.0);
}
fn is_nan_oit(value: f32) -> bool { return !(value < 0.0 || 0.0 < value || value == 0.0); }
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2u(position.xy);
  let transmittance = exp(-textureLoad(right, pixel, 0).r);
  let resolved = textureLoad(static_copy, pixel, 0);
  if (is_nan_oit(resolved.r)) { discard; }
  var normalization = 0.0;
  if (resolved.a > 0.0001) { normalization = (1.0 - transmittance) / resolved.a; }
  return vec4f(resolved.rgb * normalization, transmittance);
}
`;
