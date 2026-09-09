export const GPU_TEXTURE_REF_ABI_VERSION = 1;
export const GPU_TEXTURE_REF_INVALID = 0xffffffff;
export const GPU_TEXTURE_REF_VERSION_SHIFT = 28;
export const GPU_TEXTURE_REF_VERSION_MASK = 0xf0000000;
export const GPU_TEXTURE_REF_BANK_SHIFT = 24;
export const GPU_TEXTURE_REF_BANK_MASK = 0x0f000000;
export const GPU_TEXTURE_REF_LAYER_MASK = 0x00ffffff;

export const GPU_TEXTURE_BANK_SIZES = Object.freeze([256, 512, 1024, 2048, 4096] as const);
export const GPU_TEXTURE_BANK_MAX_CAPACITIES = Object.freeze([64, 32, 16, 32, 2] as const);
export const GPU_TEXTURE_BANK_COUNT = GPU_TEXTURE_BANK_SIZES.length;

export interface GpuTextureRef {
  readonly version: number;
  readonly bankClass: number;
  readonly layer: number;
}

export function encodeGpuTextureRef(bankClass: number, layer: number): number {
  if (!Number.isInteger(bankClass) || bankClass < 0 || bankClass >= GPU_TEXTURE_BANK_COUNT) {
    throw new RangeError(`TextureRef bank class ${bankClass} is outside the bounded bank table`);
  }
  if (!Number.isInteger(layer) || layer <= 0 || layer > GPU_TEXTURE_REF_LAYER_MASK) {
    throw new RangeError(`TextureRef layer ${layer} is outside the usable layer range`);
  }
  return (
    (GPU_TEXTURE_REF_ABI_VERSION << GPU_TEXTURE_REF_VERSION_SHIFT) |
    (bankClass << GPU_TEXTURE_REF_BANK_SHIFT) |
    layer
  ) >>> 0;
}

export function decodeGpuTextureRef(value: number): GpuTextureRef | null {
  const ref = value >>> 0;
  if (ref === GPU_TEXTURE_REF_INVALID) return null;
  const version = (ref & GPU_TEXTURE_REF_VERSION_MASK) >>> GPU_TEXTURE_REF_VERSION_SHIFT;
  const bankClass = (ref & GPU_TEXTURE_REF_BANK_MASK) >>> GPU_TEXTURE_REF_BANK_SHIFT;
  const layer = ref & GPU_TEXTURE_REF_LAYER_MASK;
  if (version !== GPU_TEXTURE_REF_ABI_VERSION || bankClass >= GPU_TEXTURE_BANK_COUNT || layer === 0) {
    return null;
  }
  return Object.freeze({ version, bankClass, layer });
}

/** Shared CPU/WGSL TextureRef fact source. Consumer shaders append only sampling policy. */
export const GPU_TEXTURE_REF_WGSL = /* wgsl */ `
const OENGINE_TEXTURE_REF_ABI_VERSION: u32 = ${GPU_TEXTURE_REF_ABI_VERSION}u;
const OENGINE_TEXTURE_REF_INVALID: u32 = 0xffffffffu;
const OENGINE_TEXTURE_REF_VERSION_SHIFT: u32 = ${GPU_TEXTURE_REF_VERSION_SHIFT}u;
const OENGINE_TEXTURE_REF_VERSION_MASK: u32 = 0x${GPU_TEXTURE_REF_VERSION_MASK.toString(16)}u;
const OENGINE_TEXTURE_REF_BANK_SHIFT: u32 = ${GPU_TEXTURE_REF_BANK_SHIFT}u;
const OENGINE_TEXTURE_REF_BANK_MASK: u32 = 0x${GPU_TEXTURE_REF_BANK_MASK.toString(16).padStart(8, "0")}u;
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

fn oengine_texture_ref_valid(texture_ref: u32) -> bool {
  return texture_ref != OENGINE_TEXTURE_REF_INVALID &&
    oengine_texture_ref_version(texture_ref) == OENGINE_TEXTURE_REF_ABI_VERSION &&
    oengine_texture_ref_bank(texture_ref) < OENGINE_TEXTURE_BANK_COUNT &&
    oengine_texture_ref_layer(texture_ref) != 0u;
}
`;

const GPU_TEXTURE_BANK_BINDING_NAMES = Object.freeze([
  "oengine_texture_bank_0",
  "oengine_texture_bank_1",
  "oengine_texture_bank_2",
  "oengine_texture_bank_3",
  "oengine_texture_bank_4"
]);

function sampleBranches(sampler: string): string {
  return GPU_TEXTURE_BANK_BINDING_NAMES.map((texture, bank) =>
    `  if bank == ${bank}u { return textureSampleGrad(${texture}, ${sampler}, uv, layer, uv_dx, uv_dy); }`
  ).join("\n");
}

/** Shared explicit-bank sampling policy for Surface and Transparency consumers. */
export const GPU_TEXTURE_BANK_SAMPLE_WGSL = /* wgsl */ `
fn oengine_sample_texture_bank(
  texture_ref: u32,
  sampler_class: u32,
  uv: vec2f,
  uv_dx: vec2f,
  uv_dy: vec2f,
  fallback: vec4f
) -> vec4f {
  if !oengine_texture_ref_valid(texture_ref) { return fallback; }
  let bank = oengine_texture_ref_bank(texture_ref);
  let layer = i32(oengine_texture_ref_layer(texture_ref));
  let address = sampler_class & OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK;
  let linear = (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) != 0u;
  if linear {
    if address == 0u {
${sampleBranches("sampler_clamp_linear")}
    } else if address == 2u {
${sampleBranches("sampler_mirror_linear")}
    } else {
${sampleBranches("sampler_repeat_linear")}
    }
  } else if address == 0u {
${sampleBranches("sampler_clamp_nearest")}
  } else if address == 2u {
${sampleBranches("sampler_mirror_nearest")}
  } else {
${sampleBranches("sampler_repeat_nearest")}
  }
  return fallback;
}
`;

/** Shared nearest-load primitives for alpha-tested visibility and shadow consumers. */
export const GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL = /* wgsl */ `
fn oengine_texture_bank_size(bank: u32) -> i32 {
  if bank == 0u { return i32(textureDimensions(oengine_texture_bank_0).x); }
  if bank == 1u { return i32(textureDimensions(oengine_texture_bank_1).x); }
  if bank == 2u { return i32(textureDimensions(oengine_texture_bank_2).x); }
  if bank == 3u { return i32(textureDimensions(oengine_texture_bank_3).x); }
  return i32(textureDimensions(oengine_texture_bank_4).x);
}

fn oengine_texture_bank_alpha(bank: u32, pixel: vec2i, layer: i32) -> f32 {
  if bank == 0u { return textureLoad(oengine_texture_bank_0, pixel, layer, 0).a; }
  if bank == 1u { return textureLoad(oengine_texture_bank_1, pixel, layer, 0).a; }
  if bank == 2u { return textureLoad(oengine_texture_bank_2, pixel, layer, 0).a; }
  if bank == 3u { return textureLoad(oengine_texture_bank_3, pixel, layer, 0).a; }
  return textureLoad(oengine_texture_bank_4, pixel, layer, 0).a;
}
`;
