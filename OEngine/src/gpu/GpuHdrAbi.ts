/** ADR-0009 Step 3 pre-exposed HDR and history physical contract. */
export const GPU_HDR_ABI_VERSION = 1;

/**
 * The main HDR and color-history ABI deliberately remains RGBA16F.
 * `rg11b10ufloat` halves bandwidth, but cannot preserve alpha and signed
 * intermediate values and does not provide the uniform render/storage/history
 * contract required by every main-pipeline consumer. It remains legal for
 * semantic RGB-only companion products after their own quality gate.
 */
export const GPU_HDR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const GPU_HDR_BYTES_PER_PIXEL = 8;

export const GPU_HDR_PROFILE = Object.freeze({
  abiVersion: GPU_HDR_ABI_VERSION,
  name: "pre-exposed-rgba16float-v1",
  format: GPU_HDR_FORMAT,
  bytesPerPixel: GPU_HDR_BYTES_PER_PIXEL,
  alpha: "preserved",
  signedValues: true,
  renderAttachment: true,
  storageWrite: true,
  filterable: true,
  historyCompatible: true,
  preExposure: "scene-referred-times-frame-pre-exposure"
} as const);

export const GPU_HDR_REJECTED_MAIN_CANDIDATES = Object.freeze({
  rg11b10ufloat: Object.freeze([
    "no alpha channel",
    "unsigned-only representation",
    "not one uniform render/storage/history contract"
  ] as const)
} as const);
