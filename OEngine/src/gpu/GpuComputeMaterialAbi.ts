/** ADR-0009 Step 2 compute material transition product. */
export const GPU_COMPUTE_MATERIAL_ABI_VERSION = 1;

/**
 * Four core storage-texture formats keep the evaluator within the portable
 * maxStorageTexturesPerShaderStage=4 floor. The packed texture stores:
 * x=pack2x16unorm(metallic, roughness), y=Surface metadata,
 * z=pack2x16float(velocity), w=reserved.
 */
export const GPU_COMPUTE_MATERIAL_FORMATS = Object.freeze({
  normal: "rgba16uint",
  albedoAo: "rgba8unorm",
  emissive: "r32uint",
  pbrMetadataVelocity: "rgba32uint"
} as const);

export const GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL = 32;

export const GPU_COMPUTE_MATERIAL_PACKED_CHANNELS = Object.freeze({
  pbr: 0,
  metadata: 1,
  velocity: 2,
  reserved: 3
} as const);

export function packComputeMaterialPbr(
  metallic: number,
  roughness: number
): number {
  return packUnorm16(metallic) | (packUnorm16(roughness) << 16);
}

export function unpackComputeMaterialPbr(
  packed: number
): readonly [number, number] {
  return Object.freeze([
    (packed & 0xffff) / 0xffff,
    ((packed >>> 16) & 0xffff) / 0xffff
  ] as const);
}

function packUnorm16(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("UNORM16 input must be finite");
  return Math.round(Math.min(1, Math.max(0, value)) * 0xffff) & 0xffff;
}
