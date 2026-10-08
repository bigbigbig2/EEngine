export const GPU_TEXTURE_REF_ABI_VERSION = 3;
export const GPU_TEXTURE_REF_INVALID = 0xffffffff;
export const GPU_TEXTURE_REF_VERSION_SHIFT = 28;
export const GPU_TEXTURE_REF_VERSION_MASK = 0xf0000000;
export const GPU_TEXTURE_REF_BANK_SHIFT = 24;
export const GPU_TEXTURE_REF_BANK_MASK = 0x0f000000;
export const GPU_TEXTURE_REF_ROUTING_SHIFT = 22;
export const GPU_TEXTURE_REF_ROUTING_MASK = 0x00c00000;
export const GPU_TEXTURE_REF_LAYER_MASK = 0x003fffff;

export const GPU_TEXTURE_REF_ROUTING = Object.freeze({
  Identity: 0,
  AlphaFromRed: 1,
  AlphaFromAlpha: 2,
});

/** TextureRef bank bits are material-local slots, never a global bank index. */
export const GPU_TEXTURE_BANK_COUNT = 16;
export const GPU_TEXTURE_BANK_ALL_MASK = (1 << GPU_TEXTURE_BANK_COUNT) - 1;

export interface GpuTextureRef {
  readonly version: number;
  readonly bankClass: number;
  readonly routing: number;
  readonly layer: number;
}

export function encodeGpuTextureRef(bankClass: number, layer: number, routing = 0): number {
  if (!Number.isInteger(bankClass) || bankClass < 0 || bankClass >= GPU_TEXTURE_BANK_COUNT) {
    throw new RangeError(`TextureRef bank class ${bankClass} is outside the bounded bank table`);
  }
  if (!Number.isInteger(layer) || layer <= 0 || layer > GPU_TEXTURE_REF_LAYER_MASK) {
    throw new RangeError(`TextureRef layer ${layer} is outside the usable layer range`);
  }
  if (!Number.isInteger(routing) || routing < 0 || routing > 2) {
    throw new RangeError(`TextureRef routing ${routing} is outside the bounded routing table`);
  }
  return (
    ((GPU_TEXTURE_REF_ABI_VERSION << GPU_TEXTURE_REF_VERSION_SHIFT) |
      (bankClass << GPU_TEXTURE_REF_BANK_SHIFT) |
      (routing << GPU_TEXTURE_REF_ROUTING_SHIFT) |
      layer) >>>
    0
  );
}

export function decodeGpuTextureRef(value: number): GpuTextureRef | null {
  const ref = value >>> 0;
  if (ref === GPU_TEXTURE_REF_INVALID) return null;
  const version = (ref & GPU_TEXTURE_REF_VERSION_MASK) >>> GPU_TEXTURE_REF_VERSION_SHIFT;
  const bankClass = (ref & GPU_TEXTURE_REF_BANK_MASK) >>> GPU_TEXTURE_REF_BANK_SHIFT;
  const routing = (ref & GPU_TEXTURE_REF_ROUTING_MASK) >>> GPU_TEXTURE_REF_ROUTING_SHIFT;
  const layer = ref & GPU_TEXTURE_REF_LAYER_MASK;
  if (
    version !== GPU_TEXTURE_REF_ABI_VERSION ||
    bankClass >= GPU_TEXTURE_BANK_COUNT ||
    routing > GPU_TEXTURE_REF_ROUTING.AlphaFromAlpha ||
    layer === 0
  ) {
    return null;
  }
  return Object.freeze({ version, bankClass, routing, layer });
}

/** Shared CPU/WGSL TextureRef fact source. Consumer shaders append only sampling policy. */
export const GPU_TEXTURE_REF_WGSL = /* wgsl */ `
const OENGINE_TEXTURE_REF_ABI_VERSION: u32 = ${GPU_TEXTURE_REF_ABI_VERSION}u;
const OENGINE_TEXTURE_REF_INVALID: u32 = 0xffffffffu;
const OENGINE_TEXTURE_REF_VERSION_SHIFT: u32 = ${GPU_TEXTURE_REF_VERSION_SHIFT}u;
const OENGINE_TEXTURE_REF_VERSION_MASK: u32 = 0x${GPU_TEXTURE_REF_VERSION_MASK.toString(16)}u;
const OENGINE_TEXTURE_REF_BANK_SHIFT: u32 = ${GPU_TEXTURE_REF_BANK_SHIFT}u;
const OENGINE_TEXTURE_REF_BANK_MASK: u32 = 0x${GPU_TEXTURE_REF_BANK_MASK.toString(16).padStart(8, "0")}u;
const OENGINE_TEXTURE_REF_ROUTING_SHIFT: u32 = ${GPU_TEXTURE_REF_ROUTING_SHIFT}u;
const OENGINE_TEXTURE_REF_ROUTING_MASK: u32 = 0x${GPU_TEXTURE_REF_ROUTING_MASK.toString(16).padStart(8, "0")}u;
const OENGINE_TEXTURE_REF_LAYER_MASK: u32 = 0x${GPU_TEXTURE_REF_LAYER_MASK.toString(16).padStart(8, "0")}u;
const OENGINE_TEXTURE_BANK_COUNT: u32 = ${GPU_TEXTURE_BANK_COUNT}u;

fn oengine_texture_ref_version(texture_ref: u32) -> u32 {
  return (texture_ref & OENGINE_TEXTURE_REF_VERSION_MASK) >> OENGINE_TEXTURE_REF_VERSION_SHIFT;
}

fn oengine_texture_ref_bank(texture_ref: u32) -> u32 {
  return (texture_ref & OENGINE_TEXTURE_REF_BANK_MASK) >> OENGINE_TEXTURE_REF_BANK_SHIFT;
}

fn oengine_texture_ref_layer(texture_ref: u32) -> u32 {
  return texture_ref & OENGINE_TEXTURE_REF_LAYER_MASK;
}

fn oengine_texture_ref_routing(texture_ref: u32) -> u32 {
  return (texture_ref & OENGINE_TEXTURE_REF_ROUTING_MASK) >> OENGINE_TEXTURE_REF_ROUTING_SHIFT;
}

fn oengine_texture_ref_apply_routing(texture_ref: u32, value: vec4f) -> vec4f {
  let routing = oengine_texture_ref_routing(texture_ref);
  if routing == ${GPU_TEXTURE_REF_ROUTING.AlphaFromRed}u { return vec4f(1.0, 1.0, 1.0, value.r); }
  if routing == ${GPU_TEXTURE_REF_ROUTING.AlphaFromAlpha}u { return vec4f(1.0, 1.0, 1.0, value.a); }
  return value;
}

fn oengine_texture_ref_valid(texture_ref: u32) -> bool {
  return texture_ref != OENGINE_TEXTURE_REF_INVALID &&
    oengine_texture_ref_version(texture_ref) == OENGINE_TEXTURE_REF_ABI_VERSION &&
    oengine_texture_ref_bank(texture_ref) < OENGINE_TEXTURE_BANK_COUNT &&
    oengine_texture_ref_routing(texture_ref) <= ${GPU_TEXTURE_REF_ROUTING.AlphaFromAlpha}u &&
    oengine_texture_ref_layer(texture_ref) != 0u;
}
`;

/** Same residency/mip policy for direct resource-profile sampling and bank routing. */
export const GPU_TEXTURE_CLAMPED_SAMPLE_WGSL = /* wgsl */ `
fn oengine_sample_texture_clamped(
  texture: texture_2d_array<f32>, texture_sampler: sampler, texture_ref: u32,
  sampler_class: u32, uv: vec2f, layer: i32, uv_dx: vec2f, uv_dy: vec2f
) -> vec4f {
  let dimensions = textureDimensions(texture, 0);
  let footprint = max(length(uv_dx * vec2f(dimensions)), length(uv_dy * vec2f(dimensions)));
  let lod = max(log2(max(footprint, 1.0)), 0.0);
  let code = (sampler_class & OENGINE_MATERIAL_SAMPLER_MIP_MASK) >> OENGINE_MATERIAL_SAMPLER_MIP_SHIFT;
  if code == OENGINE_MATERIAL_SAMPLER_FULL_MIP_CODE {
    return textureSampleGrad(texture, texture_sampler, uv, layer, uv_dx, uv_dy);
  }
  let max_mip = u32(floor(log2(f32(max(dimensions.x, dimensions.y)))));
  let min_mip = select(code, 0u,
    code == OENGINE_MATERIAL_SAMPLER_FULL_MIP_CODE || code > max_mip);
  return textureSampleLevel(texture, texture_sampler, uv, layer, max(lod, f32(min_mip)));
}
`;
