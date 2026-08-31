import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_UV_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_SECONDARY_RASTER_FLAGS } from "../gpu/GpuSecondaryRasterAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { LIGHTING_DIRECT_WGSL } from "./lighting_direct.js";

export const PACKED_TRANSPARENT_FIXED_VERTEX_COUNT = 384;
export const PACKED_TRANSPARENT_OPTICAL_FORMAT = "r32float" as const;
export const PACKED_TRANSPARENT_MOMENT_FORMAT = "rgba32float" as const;
export const PACKED_TRANSPARENT_RESOLVED_FORMAT = "rgba16float" as const;
export const PACKED_TRANSPARENT_REACTIVE_FORMAT = "r8unorm" as const;

function removeWgslFunction(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  if (start < 0) return source;
  const brace = source.indexOf("{", start);
  if (brace < 0) return source;
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) {
      return `${source.slice(0, start)}${source.slice(index + 1)}`;
    }
  }
  return source;
}

function packedDirectLightingCore(): string {
  let source = LIGHTING_DIRECT_WGSL
    .replace(LPV_CAMERA_TYPE.wgsl_declaration, "")
    .replace(/^@group\(0\).*$/gm, "")
    .replace(/@group\(2\)/g, "@group(3)")
    .replace(/@group\(1\)/g, "@group(2)")
    .replace(/^@group\(3\) @binding\(1\) var<uniform> camera.*$/gm, "");
  source = removeWgslFunction(source, "read_gBuffer_material");
  const fullscreen = source.indexOf("const FULLSCREEN_POSITIONS");
  return fullscreen < 0 ? source : source.slice(0, fullscreen);
}

const PACKED_DIRECT_LIGHTING_CORE = packedDirectLightingCore();

const PACKED_TRANSPARENT_COMMON = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}

struct QueueHeaderRead {
  written: u32, attempted: u32, peak: u32, overflow: u32,
  fallback: u32, capacity: u32, rejected_cone: u32, rejected_hzb: u32,
}
struct VisibleClusterRecord {
  instance_record_index: u32,
  geometry_record_index: u32,
  cluster_record_index: u32,
  material_handle: u32,
  raster_flags: u32,
}
struct VisibleClusterQueue { header: QueueHeaderRead, elements: array<VisibleClusterRecord> }
struct SecondaryRasterWork {
  visible_cluster_slot: u32,
  meshlet_record_index: u32,
  raster_flags: u32,
}
struct SecondaryRasterQueue { header: QueueHeaderRead, elements: array<SecondaryRasterWork> }

struct TransparentVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) world_position: vec3f,
  @location(1) uv0: vec2f,
  @location(2) uv1: vec2f,
  @location(3) @interpolate(flat) uv_valid_mask: u32,
  @location(4) @interpolate(flat) material_handle: u32,
  @location(5) @interpolate(flat) mirrored: u32,
  @location(6) @interpolate(flat) raster_flags: u32,
}

@group(0) @binding(0) var<uniform> camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(0) @binding(3) var<storage, read> meshlet_vertices: array<u32>;
@group(0) @binding(4) var<storage, read> meshlet_triangles: array<u32>;
@group(0) @binding(5) var<storage, read> vertex_data: array<u32>;
@group(0) @binding(6) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(0) @binding(7) var<storage, read> visible_clusters: VisibleClusterQueue;
@group(0) @binding(8) var<storage, read> raster_work: SecondaryRasterQueue;
@group(0) @binding(9) var<storage, read> materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(10) var material_textures: texture_2d_array<f32>;
@group(0) @binding(11) var sampler_repeat_linear: sampler;
@group(0) @binding(12) var sampler_clamp_linear: sampler;
@group(0) @binding(13) var sampler_mirror_linear: sampler;
@group(0) @binding(14) var sampler_repeat_nearest: sampler;
@group(0) @binding(15) var sampler_clamp_nearest: sampler;
@group(0) @binding(16) var sampler_mirror_nearest: sampler;

fn read_u8(words: ptr<storage, array<u32>, read>, byte_offset: u32) -> u32 {
  let word = (*words)[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}
fn read_u16(words: ptr<storage, array<u32>, read>, byte_offset: u32) -> u32 {
  return read_u8(words, byte_offset) | (read_u8(words, byte_offset + 1u) << 8u);
}
fn read_uv(
  words: ptr<storage, array<u32>, read>, byte_offset: u32, stride: u32,
  format: u32, source_vertex: u32
) -> vec3f {
  let offset = byte_offset + source_vertex * stride;
  if format == ${GPU_UV_FORMAT.Float32x2}u {
    let word = offset >> 2u;
    return vec3f(bitcast<f32>((*words)[word]), bitcast<f32>((*words)[word + 1u]), 1.0);
  }
  if format == ${GPU_UV_FORMAT.Unorm8x2}u {
    return vec3f(f32(read_u8(words, offset)), f32(read_u8(words, offset + 1u)), 255.0);
  }
  if format == ${GPU_UV_FORMAT.Unorm16x2}u {
    return vec3f(f32(read_u16(words, offset)), f32(read_u16(words, offset + 2u)), 65535.0);
  }
  return vec3f(0.0);
}

@vertex
fn packed_transparent_vertex(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) work_index: u32
) -> TransparentVertexOutput {
  let work = raster_work.elements[work_index];
  let visible = visible_clusters.elements[work.visible_cluster_slot];
  let instance = instances[visible.instance_record_index];
  let geometry = geometries[visible.geometry_record_index];
  let meshlet = meshlets[work.meshlet_record_index];
  let corner = min(vertex_index, max(meshlet.triangle_count * 3u, 1u) - 1u);
  let local_vertex = read_u8(&meshlet_triangles, meshlet.triangle_byte_offset + corner);
  let source_vertex = meshlet_vertices[meshlet.vertex_offset + local_vertex];
  let position_word = geometry.position_byte_offset / 4u +
    source_vertex * (geometry.position_stride / 4u);
  let local_position = vec3f(
    bitcast<f32>(vertex_data[position_word]),
    bitcast<f32>(vertex_data[position_word + 1u]),
    bitcast<f32>(vertex_data[position_word + 2u])
  );
  let world = instance.current_object_to_world * vec4f(local_position, 1.0);
  let uv0 = read_uv(&vertex_data, geometry.uv0_byte_offset, geometry.uv0_stride,
    geometry.uv0_format, source_vertex);
  let uv1 = read_uv(&vertex_data, geometry.uv1_byte_offset, geometry.uv1_stride,
    geometry.uv1_format, source_vertex);
  var output: TransparentVertexOutput;
  output.position = camera.view_projection_matrix * world;
  output.world_position = world.xyz / world.w;
  output.uv0 = select(vec2f(0.0), uv0.xy / uv0.z, uv0.z > 0.0);
  output.uv1 = select(vec2f(0.0), uv1.xy / uv1.z, uv1.z > 0.0);
  output.uv_valid_mask = select(0u, 1u, uv0.z > 0.0) |
    select(0u, 2u, uv1.z > 0.0);
  output.material_handle = visible.material_handle;
  let linear = instance.current_object_to_world;
  output.mirrored = select(0u, 1u,
    dot(linear[0].xyz, cross(linear[1].xyz, linear[2].xyz)) < 0.0);
  output.raster_flags = work.raster_flags;
  return output;
}

fn material_sampler_class(material: OEngineMaterialVisibilityRecord, slot: u32) -> u32 {
  if slot == 0u { return material.sampler_class; }
  return (material.texture_sampler_classes >> ((slot - 1u) * 8u)) & 0xffu;
}
fn sample_material_texture(
  texture_ref: u32, sampler_class: u32, uv: vec2f,
  uv_dx: vec2f, uv_dy: vec2f, fallback: vec4f
) -> vec4f {
  if texture_ref == OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE { return fallback; }
  let address = sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK;
  let linear = (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) != 0u;
  if linear {
    if address == 0u { return textureSampleGrad(material_textures, sampler_clamp_linear, uv, i32(texture_ref), uv_dx, uv_dy); }
    if address == 2u { return textureSampleGrad(material_textures, sampler_mirror_linear, uv, i32(texture_ref), uv_dx, uv_dy); }
    return textureSampleGrad(material_textures, sampler_repeat_linear, uv, i32(texture_ref), uv_dx, uv_dy);
  }
  if address == 0u { return textureSampleGrad(material_textures, sampler_clamp_nearest, uv, i32(texture_ref), uv_dx, uv_dy); }
  if address == 2u { return textureSampleGrad(material_textures, sampler_mirror_nearest, uv, i32(texture_ref), uv_dx, uv_dy); }
  return textureSampleGrad(material_textures, sampler_repeat_nearest, uv, i32(texture_ref), uv_dx, uv_dy);
}
fn transform_uv(record: OEngineMaterialVisibilityRecord, uv: vec2f) -> vec2f {
  let scaled = uv * record.uv_offset_scale.zw;
  return record.uv_offset_scale.xy + vec2f(
    record.uv_rotation.x * scaled.x - record.uv_rotation.y * scaled.y,
    record.uv_rotation.y * scaled.x + record.uv_rotation.x * scaled.y
  );
}
fn transparent_material(input: TransparentVertexOutput) -> OEngineMaterialVisibilityRecord {
  return materials[min(input.material_handle, arrayLength(&materials) - 1u)];
}
fn material_uv(input: TransparentVertexOutput, material: OEngineMaterialVisibilityRecord) -> vec2f {
  return transform_uv(material, select(input.uv0, input.uv1, material.uv_set == 1u));
}
fn validate_transparent_fragment(
  input: TransparentVertexOutput,
  material: OEngineMaterialVisibilityRecord,
  front: bool
) -> bool {
  if (input.raster_flags & ${GPU_SECONDARY_RASTER_FLAGS.Transparent}u) == 0u { return false; }
  if input.material_handle >= arrayLength(&materials) ||
    (material.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u ||
    material.material_id != input.material_handle ||
    material.alpha_mode != OENGINE_MATERIAL_ALPHA_BLEND ||
    material.uv_set > 1u { return false; }
  let corrected_front = front != (input.mirrored != 0u);
  if (material.flags & OENGINE_MATERIAL_VISIBILITY_DOUBLE_SIDED) == 0u && !corrected_front {
    return false;
  }
  let uv_bit = select(0u, 1u << material.uv_set, material.uv_set < 2u);
  return material.texture_ref == OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE ||
    (input.uv_valid_mask & uv_bit) != 0u;
}
fn fragment_alpha(
  material: OEngineMaterialVisibilityRecord, uv: vec2f, uv_dx: vec2f, uv_dy: vec2f
) -> f32 {
  let sample = sample_material_texture(material.texture_ref,
    material_sampler_class(material, 0u), uv, uv_dx, uv_dy, vec4f(1.0));
  return clamp(sample.a * material.base_color_factor_alpha, 0.0, 0.997);
}
`;

export const PACKED_TRANSPARENT_MOMENT_WGSL = /* wgsl */ `
${PACKED_TRANSPARENT_COMMON}
struct MomentOutput { @location(0) b0: f32, @location(1) moments: vec4f }
@fragment
fn packed_transparent_moment(
  input: TransparentVertexOutput,
  @builtin(front_facing) front: bool
) -> MomentOutput {
  let material = transparent_material(input);
  let uv = material_uv(input, material);
  let uv_dx = dpdx(uv);
  let uv_dy = dpdy(uv);
  if !validate_transparent_fragment(input, material, front) { discard; }
  let opacity = fragment_alpha(material, uv, uv_dx, uv_dy);
  if opacity <= 0.0 { discard; }
  let absorbance = -log(1.0 - opacity);
  let depth = clamp(1.0 - input.position.z, 0.0, 1.0);
  let depth2 = depth * depth;
  var output: MomentOutput;
  output.b0 = absorbance;
  output.moments = vec4f(depth, depth2, depth2 * depth, depth2 * depth2) * absorbance;
  return output;
}
`;

const MBOIT_RESOLVE = /* wgsl */ `
fn finite_f32(value: f32) -> bool {
  return value == value && abs(value) <= 3.402823e38;
}
fn total_transmittance(b0: f32) -> f32 { return exp(-max(0.0, b0)); }
fn resolve_power_moments_4(depth: f32, b0: f32, raw: vec4f) -> f32 {
  let fallback = total_transmittance(b0);
  if b0 <= 1e-8 { return 1.0; }
  var moments = raw / b0;
  moments = mix(moments, vec4f(0.0, 0.375, 0.0, 0.375), 0.0000005);
  let l21_d11 = fma(-moments.x, moments.x, moments.y);
  let l32_d11 = fma(-moments.x, moments.y, moments.z);
  if abs(l21_d11) <= 1e-12 { return fallback; }
  let l32 = l32_d11 / l21_d11;
  let denominator22 = fma(-l32_d11, l32, fma(-moments.y, moments.y, moments.w));
  if abs(denominator22) <= 1e-12 { return fallback; }
  var coefficients = vec3f(1.0, depth, depth * depth);
  coefficients.y -= moments.x;
  coefficients.z -= moments.y + l32 * coefficients.y;
  coefficients.y /= l21_d11;
  coefficients.z /= denominator22;
  coefficients.y -= l32 * coefficients.z;
  coefficients.x -= dot(coefficients.yz, moments.xy);
  if abs(coefficients.z) <= 1e-12 { return fallback; }
  let p = coefficients.y / coefficients.z;
  let q = coefficients.x / coefficients.z;
  let discriminant = p * p * 0.25 - q;
  if !finite_f32(discriminant) || discriminant < 0.0 { return fallback; }
  let root = sqrt(discriminant);
  let z1 = -p * 0.5 - root;
  let z2 = -p * 0.5 + root;
  let d10 = z1 - depth;
  let d21 = z2 - z1;
  let d20 = z2 - depth;
  if min(abs(d10), min(abs(d21), abs(d20))) <= 1e-12 { return fallback; }
  let sw = vec3f(0.25, select(0.0, 1.0, z1 < depth), select(0.0, 1.0, z2 < depth));
  let quotient = (sw.y - sw.x) / d10;
  let quotient2 = (sw.z - sw.y) / d21;
  let coefficient = (quotient2 - quotient) / d20;
  var polynomial = vec3f(coefficient, coefficient, coefficient);
  polynomial.x = quotient - polynomial.x * z1;
  polynomial.y = polynomial.x - polynomial.y * depth;
  polynomial.x = sw.x - polynomial.x * depth;
  let absorbance = polynomial.x + dot(moments.xy, polynomial.yz);
  let result = exp(-b0 * absorbance);
  return select(fallback, clamp(result, 0.0, 1.0), finite_f32(result));
}
`;

const OCTAHEDRAL = /* wgsl */ `
fn oct_sign(value: vec2f) -> vec2f { return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0)); }
fn oct_encode(direction: vec3f) -> vec2f {
  var p = direction.xy / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if direction.z < 0.0 { p = (1.0 - abs(p.yx)) * oct_sign(p); }
  return 0.5 + 0.5 * p;
}
fn oct_wrap(position: vec2i, resolution: i32) -> vec2u {
  let wrapped = ((position % resolution) + resolution) % resolution;
  let crossings = abs(position / resolution) + select(vec2i(0), vec2i(1), position < vec2i(0));
  return select(vec2u(wrapped), vec2u(resolution - (wrapped + vec2i(1))),
    ((crossings.x ^ crossings.y) & 1) != 0);
}
fn oct_sample(source: texture_2d<f32>, direction: vec3f, lod: u32) -> vec3f {
  let resolution = textureDimensions(source, i32(lod)).x;
  let texel = oct_encode(direction) * f32(resolution) - 0.5;
  let f = fract(texel);
  let base = vec2i(floor(texel));
  let c00 = textureLoad(source, vec2i(oct_wrap(base, i32(resolution))), i32(lod)).rgb;
  let c10 = textureLoad(source, vec2i(oct_wrap(base + vec2i(1, 0), i32(resolution))), i32(lod)).rgb;
  let c01 = textureLoad(source, vec2i(oct_wrap(base + vec2i(0, 1), i32(resolution))), i32(lod)).rgb;
  let c11 = textureLoad(source, vec2i(oct_wrap(base + vec2i(1, 1), i32(resolution))), i32(lod)).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}
fn specular_environment(direction: vec3f, roughness: f32) -> vec3f {
  let max_mip = textureNumLevels(specular_environment_map) - 1u;
  let lod = clamp(roughness, 0.0, 1.0) * f32(max_mip);
  let lower = u32(floor(lod));
  return mix(oct_sample(specular_environment_map, direction, lower),
    oct_sample(specular_environment_map, direction, min(lower + 1u, max_mip)), fract(lod));
}
`;

export const PACKED_TRANSPARENT_FORWARD_WGSL = /* wgsl */ `
${PACKED_TRANSPARENT_COMMON}
${PACKED_DIRECT_LIGHTING_CORE}
@group(1) @binding(0) var moment_texture: texture_2d<f32>;
@group(1) @binding(1) var optical_texture: texture_2d<f32>;
@group(1) @binding(2) var specular_environment_map: texture_2d<f32>;
@group(1) @binding(3) var diffuse_irradiance_map: texture_2d<f32>;
@group(1) @binding(4) var split_sum: texture_2d<f32>;
@group(1) @binding(5) var linear_clamp: sampler;
${MBOIT_RESOLVE}
${OCTAHEDRAL}

fn surface_normal(input: TransparentVertexOutput, material: OEngineMaterialVisibilityRecord,
  front: bool, uv: vec2f, uv_dx: vec2f, uv_dy: vec2f,
  world_dx: vec3f, world_dy: vec3f) -> vec3f {
  var normal = normalize(cross(world_dx, world_dy));
  let corrected_front = front != (input.mirrored != 0u);
  if !corrected_front { normal = -normal; }
  if (material.flags & OENGINE_MATERIAL_HAS_NORMAL_TEXTURE) == 0u { return normal; }
  let dp1 = world_dx;
  let dp2 = world_dy;
  let duv1 = uv_dx;
  let duv2 = uv_dy;
  let determinant = duv1.x * duv2.y - duv1.y * duv2.x;
  if abs(determinant) <= 1e-8 { return normal; }
  let tangent = normalize((dp1 * duv2.y - dp2 * duv1.y) / determinant);
  let bitangent = normalize(cross(normal, tangent));
  let sampled = sample_material_texture(material.normal_texture_ref,
    material_sampler_class(material, 1u), uv, uv_dx, uv_dy,
    vec4f(0.5, 0.5, 1.0, 1.0)).xyz;
  let local = normalize(vec3f((sampled.xy * 2.0 - 1.0) * material.pbr_factors.z,
    sampled.z * 2.0 - 1.0));
  return normalize(mat3x3f(tangent, bitangent, normal) * local);
}

struct ForwardOutput {
  @location(0) resolved: vec4f,
  @location(1) reactive: f32,
}
@fragment
fn packed_transparent_forward(
  input: TransparentVertexOutput,
  @builtin(front_facing) front: bool
) -> ForwardOutput {
  let material = transparent_material(input);
  let uv = material_uv(input, material);
  let uv_dx = dpdx(uv);
  let uv_dy = dpdy(uv);
  let world_dx = dpdx(input.world_position);
  let world_dy = dpdy(input.world_position);
  if !validate_transparent_fragment(input, material, front) { discard; }
  let opacity = fragment_alpha(material, uv, uv_dx, uv_dy);
  if opacity <= 0.0 { discard; }
  let pixel = vec2i(input.position.xy);
  let b0 = textureLoad(optical_texture, pixel, 0).r;
  if b0 <= 1e-8 { discard; }
  let base_sample = sample_material_texture(material.texture_ref,
    material_sampler_class(material, 0u), uv, uv_dx, uv_dy, vec4f(1.0));
  let orm = sample_material_texture(material.orm_texture_ref,
    material_sampler_class(material, 2u), uv, uv_dx, uv_dy, vec4f(1.0));
  let emissive = sample_material_texture(material.emissive_texture_ref,
    material_sampler_class(material, 3u), uv, uv_dx, uv_dy,
    vec4f(1.0)).rgb * material.emissive_factor.rgb;
  let albedo = base_sample.rgb * material.base_color_factor.rgb;
  let metallic = clamp(select(1.0, orm.b,
    (material.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u) * material.pbr_factors.x, 0.0, 1.0);
  let roughness = clamp(select(1.0, orm.g,
    (material.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u) * material.pbr_factors.y, 0.02, 1.0);
  let normal = surface_normal(input, material, front, uv, uv_dx, uv_dy, world_dx, world_dy);
  let view_direction = normalize(camera.transform[3].xyz - input.world_position);
  var color = albedo + emissive;
  if (material.flags & OENGINE_MATERIAL_UNLIT) == 0u {
    let nov = clamp(dot(normal, view_direction), 0.0, 1.0);
    let reflection = normalize(mix(reflect(-view_direction, normal), normal, roughness * roughness));
    let radiance = specular_environment(reflection, roughness);
    let irradiance = oct_sample(diffuse_irradiance_map, normal, 0u);
    let f0 = mix(vec3f(0.04), albedo, metallic);
    let dfg = textureSampleLevel(split_sum, linear_clamp, vec2f(nov, roughness), 0.0).rg;
    let specular = radiance * (f0 * dfg.x + dfg.y);
    let diffuse = irradiance * albedo * (1.0 - metallic) * 0.3183098861837907;
    let direct_material = StandardMaterial(
      albedo * (1.0 - metallic), roughness,
      clamp(select(1.0, orm.r, (material.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u), 0.0, 1.0),
      f0, 1.0, emissive, opacity
    );
    let direct_geometry = SurfaceGeometry(normal, normal, input.world_position, view_direction);
    let direct = shade_standard_material_direct(
      direct_material, direct_geometry, input.position.xy,
      get_view_space_depth(input.position.z, camera)
    );
    color = direct + diffuse + specular;
  }
  let depth = clamp(1.0 - input.position.z, 0.0, 1.0);
  let transmittance = resolve_power_moments_4(
    depth, b0, textureLoad(moment_texture, pixel, 0)
  );
  var output: ForwardOutput;
  output.resolved = vec4f(color * opacity, opacity) * transmittance;
  output.reactive = 1.0;
  return output;
}
`;

export const PACKED_TRANSPARENT_COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var optical_texture: texture_2d<f32>;
@group(0) @binding(1) var resolved_texture: texture_2d<f32>;
const POSITIONS = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
@vertex fn packed_transparent_composite_vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(POSITIONS[index], 0.0, 1.0);
}
fn finite_f32(value: f32) -> bool { return value == value && abs(value) <= 3.402823e38; }
@fragment fn packed_transparent_composite(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);
  let transmittance = exp(-max(textureLoad(optical_texture, pixel, 0).r, 0.0));
  let resolved = textureLoad(resolved_texture, pixel, 0);
  if !all(vec4<bool>(finite_f32(resolved.r), finite_f32(resolved.g),
    finite_f32(resolved.b), finite_f32(resolved.a))) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let normalization = select(0.0, (1.0 - transmittance) / resolved.a, resolved.a > 0.0001);
  return vec4f(resolved.rgb * normalization, transmittance);
}
`;

export const PACKED_TRANSPARENT_EVIDENCE_WGSL = /* wgsl */ `
struct QueueHeaderRead {
  written: u32, attempted: u32, peak: u32, overflow: u32,
  fallback: u32, capacity: u32, rejected_cone: u32, rejected_hzb: u32,
}
struct SecondaryRasterWork { visible_cluster_slot: u32, meshlet_record_index: u32, raster_flags: u32 }
struct SecondaryRasterQueue { header: QueueHeaderRead, elements: array<SecondaryRasterWork> }
@group(0) @binding(0) var<storage, read> work: SecondaryRasterQueue;
struct GpuMeshletRecord {
  vertex_offset: u32, vertex_count: u32, triangle_byte_offset: u32, triangle_count: u32,
  material_range_index: u32, material_id: u32, flags: u32, _pad0: u32,
  bounds_min: vec4f, bounds_max: vec4f, bounds_sphere: vec4f,
  cone_apex: vec4f, cone_axis_cutoff: vec4f,
}
@group(0) @binding(1) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(0) @binding(2) var optical_texture: texture_2d<f32>;
@group(0) @binding(3) var moment_texture: texture_2d<f32>;
@group(0) @binding(4) var reactive_texture: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> counters: array<atomic<u32>>;
const TRANSPARENT_WORK: u32 = 64u;
const TRANSPARENT_TRIANGLES: u32 = 65u;
const TRANSPARENT_REACTIVE: u32 = 66u;
const TRANSPARENT_FINITE_FAILURES: u32 = 67u;
const TRANSPARENT_OVERFLOW: u32 = 68u;
fn finite_f32(value: f32) -> bool { return value == value && abs(value) <= 3.402823e38; }
@compute @workgroup_size(8, 8)
fn packed_transparent_evidence(@builtin(global_invocation_id) id: vec3u) {
  let dimensions = textureDimensions(optical_texture);
  if id.x >= dimensions.x || id.y >= dimensions.y { return; }
  if id.x == 0u && id.y == 0u {
    let count = min(work.header.written, work.header.capacity);
    atomicAdd(&counters[TRANSPARENT_WORK], count);
    var triangles = 0u;
    for (var index = 0u; index < count; index++) {
      let meshlet_index = work.elements[index].meshlet_record_index;
      if meshlet_index < arrayLength(&meshlets) { triangles += meshlets[meshlet_index].triangle_count; }
    }
    atomicAdd(&counters[TRANSPARENT_TRIANGLES], triangles);
    if work.header.overflow != 0u { atomicOr(&counters[TRANSPARENT_OVERFLOW], 1u); }
  }
  let pixel = vec2i(id.xy);
  let b0 = textureLoad(optical_texture, pixel, 0).r;
  let moments = textureLoad(moment_texture, pixel, 0);
  let reactive = textureLoad(reactive_texture, pixel, 0).r;
  if reactive > 0.0 { atomicAdd(&counters[TRANSPARENT_REACTIVE], 1u); }
  if !finite_f32(b0) || !all(vec4<bool>(finite_f32(moments.r), finite_f32(moments.g),
    finite_f32(moments.b), finite_f32(moments.a))) {
    atomicAdd(&counters[TRANSPARENT_FINITE_FAILURES], 1u);
  }
}
`;
