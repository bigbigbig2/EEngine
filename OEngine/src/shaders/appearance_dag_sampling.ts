import {
  GPU_TEXTURE_REF_WGSL,
  GPU_TEXTURE_CLAMPED_SAMPLE_WGSL,
  GPU_TEXTURE_BANK_COUNT,
} from "../gpu/GpuTextureRefAbi.js";
import { GPU_MATERIAL_VISIBILITY_SAMPLER as S } from "../gpu/GpuMaterialVisibilityAbi.js";
import { APPEARANCE_DAG_PRODUCT_WORDS, APPEARANCE_DAG_MIP_WORDS } from "../gpu/GpuAppearanceDagAbi.js";

/** Finite resident-bank switch. Binding sets are the existing four negotiated
 * residency classes; topology/sample count/material instances remain data. */
export function appearanceDagResidentSamplingWgsl(group: number): string {
  const declarations: string[] = [];
  const branches: string[] = [];
  for (let bank = 0; bank < GPU_TEXTURE_BANK_COUNT; bank++) {
    declarations.push(`@group(${group}) @binding(${bank}) var dag_texture_${bank}: texture_2d_array<f32>;`);
    const samplers: string[] = [];
    for (let sampler = 0; sampler < 6; sampler++) {
      samplers.push(/* wgsl */ `
      case ${sampler}u: {
        return oengine_sample_texture_clamped(dag_texture_${bank}, dag_sampler_${sampler},
          route.x, route.y, uv, i32(oengine_texture_ref_layer(route.x)), dx, dy);
      }`);
    }
    branches.push(/* wgsl */ `
    case ${bank}u: {
      switch sampler_index {
${samplers.join("\n")}
        default: { return vec4f(0.0); }
      }
    }`);
  }
  for (let sampler = 0; sampler < 6; sampler++) {
    declarations.push(
      `@group(${group}) @binding(${GPU_TEXTURE_BANK_COUNT + sampler}) var dag_sampler_${sampler}: sampler;`,
    );
  }
  return /* wgsl */ `
${declarations.join("\n")}
${GPU_TEXTURE_REF_WGSL}
const OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK: u32 = ${S.AddressMask}u;
const OENGINE_MATERIAL_SAMPLER_LINEAR: u32 = ${S.LinearBit}u;
const OENGINE_MATERIAL_SAMPLER_MIP_MASK: u32 = ${S.MipMask}u;
const OENGINE_MATERIAL_SAMPLER_MIP_SHIFT: u32 = ${S.MipShift}u;
const OENGINE_MATERIAL_SAMPLER_FULL_MIP_CODE: u32 = ${S.FullMipCode}u;
${GPU_TEXTURE_CLAMPED_SAMPLE_WGSL}
fn dag_sample_resident(route: vec2u, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  let address = route.y & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK;
  let sampler_index = select(3u, 0u, (route.y & OENGINE_MATERIAL_SAMPLER_LINEAR) != 0u)
    + select(select(2u, 1u, address == 2u), 0u, address == 0u);
  switch oengine_texture_ref_bank(route.x) {
${branches.join("\n")}
    default: { return vec4f(0.0); }
  }
}
fn dag_transform_uv(value: vec2f, scale: vec2f, rotation: vec2f) -> vec2f {
  let scaled = value * scale;
  return vec2f(rotation.x * scaled.x - rotation.y * scaled.y,
    rotation.y * scaled.x + rotation.x * scaled.y);
}
fn appearance_dag_sample(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  let at = dag_routes_base + (dag_code[dag_entry + 6u] + index) * 16u;
  let reference = dag_metadata[at];
  if reference == OENGINE_TEXTURE_REF_INVALID {
    return dag_metadata_vec4(at + 12u);
  }
  let mapping = dag_metadata_vec4(at + 4u);
  let rotation = dag_metadata_vec4(at + 8u).xy;
  let sampled = dag_sample_resident(vec2u(reference, dag_metadata[at + 1u]),
    dag_transform_uv(uv, mapping.zw, rotation) + mapping.xy,
    dag_transform_uv(dx, mapping.zw, rotation), dag_transform_uv(dy, mapping.zw, rotation));
  return oengine_texture_ref_apply_routing(reference, sampled);
}
`;
}

/** Exact cooked-format sampler: all original half texels/mips, bilinear clamp
 * and trilinear footprint LOD. No atlas resize, quantization, mip bias or
 * asset-specific bindings. Independent hardware textureSampleGrad comparison
 * is required before the owner adopts this local sampling implementation. */
export const APPEARANCE_DAG_PRODUCT_SAMPLING_WGSL = /* wgsl */ `
fn dag_product_word(index: u32) -> u32 {
  if index < dag_product_bank_words {
    return dag_product_0[index];
  }
  return dag_product_1[index - dag_product_bank_words];
}
fn dag_product_texel(mip: u32, channels: u32, pixel: vec2i) -> vec4f {
  let extent = vec2u(dag_code[mip + 1u], dag_code[mip + 2u]);
  let coordinate = vec2u(clamp(pixel, vec2i(0), vec2i(extent) - vec2i(1)));
  let texel = (coordinate.y * extent.x + coordinate.x) * channels;
  var value = vec4f(0.0, 0.0, 0.0, 1.0);
  for (var channel = 0u; channel < channels; channel++) {
    let component = texel + channel;
    let packed = dag_product_word(dag_code[mip] + component / 2u);
    value[channel] = unpack2x16float(packed)[component & 1u];
  }
  return value;
}
fn dag_product_bilinear(mip: u32, channels: u32, uv: vec2f) -> vec4f {
  let extent = vec2f(f32(dag_code[mip + 1u]), f32(dag_code[mip + 2u]));
  // Clamp before integer conversion, matching clamp-to-edge for far UVs.
  let position = clamp(uv, vec2f(0.0), vec2f(1.0)) * extent - vec2f(0.5);
  let base = vec2i(floor(position));
  let fraction = fract(position);
  let a = dag_product_texel(mip, channels, base);
  let b = dag_product_texel(mip, channels, base + vec2i(1, 0));
  let c = dag_product_texel(mip, channels, base + vec2i(0, 1));
  let d = dag_product_texel(mip, channels, base + vec2i(1, 1));
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}
fn appearance_dag_product(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  let at = dag_code[dag_entry + 9u] + index * ${APPEARANCE_DAG_PRODUCT_WORDS}u;
  let mip_base = dag_code[at];
  let levels = dag_code[at + 1u];
  let channels = dag_code[at + 2u];
  let origin = bitcast<vec2f>(vec2u(dag_code[at + 4u], dag_code[at + 5u]));
  let scale = bitcast<vec2f>(vec2u(dag_code[at + 6u], dag_code[at + 7u]));
  let coordinate = (uv - origin) * scale;
  let extent = vec2f(f32(dag_code[mip_base + 1u]), f32(dag_code[mip_base + 2u]));
  let footprint = max(length(dx * scale * extent), length(dy * scale * extent));
  let lod = clamp(log2(max(footprint, 1e-20)), 0.0, f32(levels - 1u));
  let low = u32(floor(lod));
  let high = min(low + 1u, levels - 1u);
  let a = dag_product_bilinear(mip_base + low * ${APPEARANCE_DAG_MIP_WORDS}u, channels, coordinate);
  let b = dag_product_bilinear(mip_base + high * ${APPEARANCE_DAG_MIP_WORDS}u, channels, coordinate);
  return mix(a, b, fract(lod));
}
`;
