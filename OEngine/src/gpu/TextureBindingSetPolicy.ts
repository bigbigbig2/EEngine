import { GPU_TEXTURE_BANK_COUNT } from "./GpuTextureRefAbi.js";

/** Fixed per-set layout; changing it changes pipeline layouts. */
export const TEXTURE_BINDING_SET_SLOT_COUNT = GPU_TEXTURE_BANK_COUNT;
export const TEXTURE_BINDING_SET_SAMPLER_CLASS_COUNT = 6;
/** Visibility/Surface/forward-lighting products used beside material textures. */
export const TEXTURE_BINDING_SET_RESERVED_SAMPLED_TEXTURE_BINDINGS = 7;

export interface TextureBindingSetPolicyRecord {
  readonly textureSlotsPerBindingSet: number;
  readonly samplerClassCount: number;
  readonly reservedSampledTextureBindings: number;
}

export function textureBindingSetPolicy(
  limits: Pick<GPUSupportedLimits, "maxSampledTexturesPerShaderStage" | "maxSamplersPerShaderStage">,
): TextureBindingSetPolicyRecord {
  const requiredTextures = 16;
  const sampledTextureLimit = Number(limits.maxSampledTexturesPerShaderStage);
  const samplerLimit = Number(limits.maxSamplersPerShaderStage);
  if (!Number.isFinite(sampledTextureLimit) || sampledTextureLimit < requiredTextures) {
    throw new RangeError(
      `TextureBindingSet requires ${requiredTextures} sampled textures per shader stage, device permits ${sampledTextureLimit}`,
    );
  }
  if (!Number.isFinite(samplerLimit) || samplerLimit < TEXTURE_BINDING_SET_SAMPLER_CLASS_COUNT) {
    throw new RangeError(
      `TextureBindingSet requires ${TEXTURE_BINDING_SET_SAMPLER_CLASS_COUNT} samplers per shader stage, device permits ${samplerLimit}`,
    );
  }
  return Object.freeze({
    textureSlotsPerBindingSet: TEXTURE_BINDING_SET_SLOT_COUNT,
    samplerClassCount: TEXTURE_BINDING_SET_SAMPLER_CLASS_COUNT,
    reservedSampledTextureBindings: TEXTURE_BINDING_SET_RESERVED_SAMPLED_TEXTURE_BINDINGS,
  });
}
