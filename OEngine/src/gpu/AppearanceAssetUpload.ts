import type { AppearanceAssetPackage, AppearanceAssetField } from "../assets/AppearanceAssetPackage.js";
import { RuntimeAssetResidencyState } from "../assets/RuntimeAssetResidency.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";

export interface AppearanceAssetDestination {
  readonly texture: GPUTexture;
  readonly layer: number;
}
export interface AppearanceAssetUploadBudget {
  readonly maxUploadBytes: number;
  readonly maxResidentBytes: number;
  readonly maxStagingBytes: number;
}
export interface StagedAppearanceAssetUpload {
  readonly residency: RuntimeAssetResidencyState;
  readonly evidence: Readonly<{
    payloadBytes: number;
    stagingBytes: number;
    pooledBufferBytes: number;
    residentBytes: number;
    copyCount: number;
    privateSubmitCount: 0;
  }>;
}

/**
 * Local upload/ABI glue. Destination textures belong to the caller's Appearance
 * page owner, never to a Loader or this helper. Preflight all fields, extents and
 * padded bytes before any staging allocation/copy. Only the caller's successful
 * command commits residency; abort leaves destination GPU content untouched.
 */
export function stageAppearanceAssetUpload(
  device: GPUDevice,
  asset: AppearanceAssetPackage,
  destinations: ReadonlyMap<string, AppearanceAssetDestination>,
  command: ShadeGPUCommandContext,
  budget: AppearanceAssetUploadBudget,
): StagedAppearanceAssetUpload {
  if (command.closed || command.device !== device)
    throw new Error("Appearance upload requires an open same-device transaction");
  for (const value of Object.values(budget))
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid Appearance upload budget");
  const copies: {
    field: AppearanceAssetField;
    level: number;
    destination: AppearanceAssetDestination;
    rowBytes: number;
    rowPitch: number;
    stagingBytes: number;
  }[] = [];
  const targets = new Map<GPUTexture, Set<number>>();
  let payloadBytes = 0,
    stagingBytes = 0;
  const chunks: string[] = [];
  for (const field of asset.fields) {
    if (field.format === null) {
      if (destinations.has(field.name))
        throw new RangeError("Constant Appearance fields must not allocate texture destinations");
      continue;
    }
    const destination = destinations.get(field.name);
    if (destination === undefined) throw new RangeError(`Appearance destination missing for '${field.name}'`);
    const { texture, layer } = destination,
      base = field.mips[0]!;
    if (
      texture.dimension !== "2d" ||
      texture.format !== field.format ||
      (texture.usage & GPUTextureUsage.COPY_DST) === 0 ||
      (texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0 ||
      !Number.isInteger(layer) ||
      layer < 0 ||
      layer >= texture.depthOrArrayLayers ||
      texture.width !== base.width ||
      texture.height !== base.height ||
      texture.mipLevelCount < field.mips.length ||
      texture.width > device.limits.maxTextureDimension2D ||
      texture.height > device.limits.maxTextureDimension2D ||
      texture.depthOrArrayLayers > device.limits.maxTextureArrayLayers
    ) {
      throw new RangeError(
        `Appearance '${field.name}' destination is outside its negotiated format/extent/layer profile`,
      );
    }
    const layers = targets.get(texture) ?? new Set<number>();
    if (layers.has(layer)) throw new RangeError("Appearance fields cannot overwrite the same texture layer");
    layers.add(layer);
    targets.set(texture, layers);
    const channels = field.width === 3 ? 4 : field.width;
    field.mips.forEach((mip, level) => {
      const rowBytes = mip.width * channels * 2,
        rowPitch = Math.ceil(rowBytes / 256) * 256;
      const bytes = rowPitch * (mip.height - 1) + rowBytes;
      const alignedBytes = Math.ceil(bytes / 4) * 4;
      if (alignedBytes > device.limits.maxBufferSize)
        throw new RangeError("Appearance upload exceeds negotiated staging-buffer limit");
      payloadBytes += mip.payload.byteLength;
      stagingBytes += alignedBytes;
      chunks.push(mip.chunkId);
      copies.push({ field, level, destination, rowBytes, rowPitch, stagingBytes: alignedBytes });
    });
  }
  if (destinations.size !== asset.fields.filter((field) => field.format !== null).length) {
    throw new RangeError("Appearance upload contains unused destinations");
  }
  if (
    !Number.isSafeInteger(stagingBytes) ||
    stagingBytes > budget.maxStagingBytes ||
    stagingBytes > budget.maxUploadBytes ||
    asset.residentBytes > budget.maxResidentBytes
  )
    throw new RangeError("Appearance upload exceeds padded upload/staging/resident budget");
  const residency = new RuntimeAssetResidencyState(
    asset.runtime.manifest,
    asset.runtime.manifest.variants[0]!,
  );
  const reservation =
    chunks.length === 0
      ? null
      : residency.request(chunks, {
          maxUploadBytes: budget.maxUploadBytes,
          maxResidentBytes: budget.maxResidentBytes,
        });
  const ranges: Record<string, { resourceId: string; byteOffset: number; byteLength: number }> =
    Object.create(null);
  let pooledBufferBytes = 0;
  try {
    for (const copy of copies) {
      const mip = copy.field.mips[copy.level]!,
        padded = new Uint8Array(copy.stagingBytes);
      for (let y = 0; y < mip.height; y++)
        padded.set(mip.payload.subarray(y * copy.rowBytes, (y + 1) * copy.rowBytes), y * copy.rowPitch);
      const source = command.allocateTextureUploadBuffer(padded.buffer);
      pooledBufferBytes += source.size;
      command.copyBufferToTexture(
        { buffer: source, bytesPerRow: copy.rowPitch, rowsPerImage: mip.height },
        { texture: copy.destination.texture, mipLevel: copy.level, origin: [0, 0, copy.destination.layer] },
        [mip.width, mip.height, 1],
      );
      ranges[mip.chunkId] = {
        resourceId: `Appearance/${asset.runtime.manifest.assetId}/${copy.field.name}/${copy.destination.layer}`,
        byteOffset: copy.field.mips
          .slice(0, copy.level)
          .reduce((sum, level) => sum + level.payload.byteLength, 0),
        byteLength: mip.payload.byteLength,
      };
    }
  } catch (error) {
    if (reservation !== null) residency.abort(reservation);
    command.abort(error);
    throw error;
  }
  if (reservation !== null) {
    command.onFinished.addOne(() => residency.commit(reservation, ranges));
    command.onAborted.addOne(() => residency.abort(reservation));
  }
  return Object.freeze({
    residency,
    evidence: Object.freeze({
      payloadBytes,
      stagingBytes,
      pooledBufferBytes,
      residentBytes: asset.residentBytes,
      copyCount: copies.length,
      privateSubmitCount: 0,
    }),
  });
}
