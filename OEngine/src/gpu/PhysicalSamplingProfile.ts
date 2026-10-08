import {
  TEXTURE_BINDING_SET_SLOT_COUNT,
  TEXTURE_BINDING_SET_SAMPLER_CLASS_COUNT,
} from "./TextureBindingSetPolicy.js";

/** Physical resource shape only; closure family and authored material stay independent. */
export type ResidentSamplingProfile = "ResidentHot" | "ResidentOther";

export interface PhysicalSamplingSelection {
  readonly profile: ResidentSamplingProfile;
  readonly bindingSetId: number;
  readonly textureBankSlots: number;
  readonly samplerClasses: number;
}

export function residentSamplingProfile(bindingSetId: number): PhysicalSamplingSelection {
  if (!Number.isInteger(bindingSetId) || bindingSetId < 0 || bindingSetId > 0xffffffff) {
    throw new RangeError(`Resident physical sampling set ${bindingSetId} is invalid`);
  }
  return Object.freeze({
    profile: bindingSetId === 0 ? "ResidentHot" : "ResidentOther",
    bindingSetId,
    textureBankSlots: TEXTURE_BINDING_SET_SLOT_COUNT,
    samplerClasses: TEXTURE_BINDING_SET_SAMPLER_CLASS_COUNT,
  });
}

/** Startup preflight for the full resident Surface layout, before resource creation. */
export function preflightResidentSurfaceLimits(
  limits: Pick<
    GPUSupportedLimits,
    | "maxSampledTexturesPerShaderStage"
    | "maxSamplersPerShaderStage"
    | "maxStorageBuffersPerShaderStage"
    | "maxStorageTexturesPerShaderStage"
    | "maxBindGroups"
    | "maxTextureDimension3D"
  >,
): void {
  // Nine bank views, visibility/depth, four environment inputs and the
  // r32uint frequency plan. Actual kernels may bind fewer banks.
  const required = [
    ["sampled textures", Number(limits.maxSampledTexturesPerShaderStage), 16],
    ["samplers", Number(limits.maxSamplersPerShaderStage), 8],
    ["storage buffers", Number(limits.maxStorageBuffersPerShaderStage), 16],
    ["storage textures", Number(limits.maxStorageTexturesPerShaderStage), 2],
    ["bind groups", Number(limits.maxBindGroups), 4],
    ["3D sky LUT dimension", Number(limits.maxTextureDimension3D), 256],
  ] as const;
  for (const [name, available, needed] of required) {
    if (!Number.isFinite(available) || available < needed) {
      throw new RangeError(`Resident Surface requires ${needed} ${name}; device permits ${available}`);
    }
  }
}
