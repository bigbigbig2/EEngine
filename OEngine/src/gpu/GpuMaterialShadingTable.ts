import {
  isKtx2TextureSource,
  type Ktx2TextureSource
} from "../assets/MaterialTextureAssetPackage.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import {
  GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_BIT,
  GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
} from "./GpuMaterialVisibilityAbi.js";
import {
  GPU_MATERIAL_SHADING_ABI_VERSION,
  GPU_MATERIAL_SHADING_INVALID_TEXTURE,
  GPU_MATERIAL_SHADING_LEGACY_BANK_COUNT,
  GPU_MATERIAL_SHADING_MAX_COMPRESSED_BANKS,
  GPU_MATERIAL_SHADING_RECORD_STRIDE,
  encodeGpuMaterialShadingTextureRef,
  packGpuMaterialShadingRecord,
  standardPbrFeatureKey
} from "./GpuMaterialShadingAbi.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  Ktx2Transcoder,
  type TranscodedKtx2Texture
} from "./Ktx2Transcoder.js";
import { writeGpuTexture } from "./GpuQueueEvidence.js";

export const GPU_MATERIAL_TEXTURE_RESIDENT_BUDGET = 512 * 1024 * 1024;

type TextureRole = "albedo" | "normal" | "orm" | "emissive";
type TextureColorSpace = "linear" | "srgb";

export interface LegacyMaterialTextureRefs {
  readonly baseColor: number;
  readonly normal: number;
  readonly orm: number;
  readonly emissive: number;
}

export interface GpuMaterialShadingBindings {
  readonly abiVersion: number;
  readonly records: GPUBuffer;
  /** bank 0/1 are the existing visibility arrays; 2..5 are compressed banks. */
  readonly textureBanks: readonly GPUTextureView[];
  readonly specializationKey: string;
  readonly featureKeys: readonly number[];
}

export interface GpuMaterialShadingEvidence {
  readonly schemaVersion: 1;
  readonly abiVersion: number;
  readonly budgetBytes: number;
  readonly allocatedBytes: number;
  readonly residentLogicalBytes: number;
  readonly compressedBankCount: number;
  readonly residentCompressedTextureCount: number;
  readonly retiringCompressedTextureCount: number;
  readonly evictionCount: number;
  readonly budgetRejectCount: number;
  readonly bankLimitFallbackCount: number;
  readonly featureClassCount: number;
  readonly featureClassKeys: readonly number[];
  readonly transcoder: ReturnType<Ktx2Transcoder["evidence"]>;
}

interface PreparedTexture {
  readonly key: string;
  readonly texture: ShadeTexture;
  readonly role: TextureRole;
  readonly colorSpace: TextureColorSpace;
  readonly decoded: TranscodedKtx2Texture;
}

interface CompressedBank {
  readonly slot: number;
  readonly key: string;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
  readonly capacity: number;
  readonly layerBytes: number;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly freeLayers: number[];
  residentCount: number;
}

interface ResidentTexture {
  readonly key: string;
  readonly source: ShadeTexture;
  readonly colorSpace: TextureColorSpace;
  readonly bank: CompressedBank;
  readonly layer: number;
  readonly logicalBytes: number;
  refCount: number;
  retireGeneration: number;
}

interface ResidentMaterial {
  readonly material: StandardShadeMaterial;
  readonly slot: number;
  readonly textures: readonly ResidentTexture[];
  readonly featureKey: number;
  refCount: number;
  retireGeneration: number;
}

/**
 * Standard PBR shading-only texture owner. Visibility keeps its frozen alpha
 * ABI while Material Resolve can bind block-compressed size-class banks.
 */
export class GpuMaterialShadingTable {
  private readonly records: GPUBuffer;
  private readonly fallbackTexture: GPUTexture;
  private readonly fallbackView: GPUTextureView;
  private readonly transcoder: Ktx2Transcoder;
  private readonly prepared = new Map<string, PreparedTexture>();
  private readonly desiredBankCounts = new Map<string, number>();
  private readonly banks: Array<CompressedBank | null> = Array.from(
    { length: GPU_MATERIAL_SHADING_MAX_COMPRESSED_BANKS },
    () => null
  );
  private readonly residentTextures = new Map<string, ResidentTexture>();
  private readonly residentMaterials = new Map<StandardShadeMaterial, ResidentMaterial>();
  private allocatedBytes = GPU_MATERIAL_SHADING_RECORD_STRIDE * 4096;
  private residentLogicalBytes = 0;
  private evictionCount = 0;
  private budgetRejectCount = 0;
  private bankLimitFallbackCount = 0;
  private destroyed = false;

  constructor(private readonly graphics: GraphicsContext) {
    this.transcoder = new Ktx2Transcoder(graphics.device);
    this.records = graphics.device.createBuffer({
      label: "R5 Standard PBR material specialization table",
      size: GPU_MATERIAL_SHADING_RECORD_STRIDE * 4096,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint8Array(this.records.getMappedRange()).fill(0xff);
    this.records.unmap();
    this.fallbackTexture = graphics.device.createTexture({
      label: "R5 Material shading unused bank",
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.fallbackView = this.fallbackTexture.createView({ dimension: "2d-array" });
    writeGpuTexture(
      graphics.device.queue,
      "GpuMaterialShadingTable/fallback",
      { texture: this.fallbackTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1]
    );
    this.allocatedBytes += 4;
  }

  async prepare(materials: readonly StandardShadeMaterial[]): Promise<void> {
    this.assertAlive();
    const requests = new Map<string, {
      texture: ShadeTexture;
      role: TextureRole;
      colorSpace: TextureColorSpace;
      source: Ktx2TextureSource;
    }>();
    for (const material of materials) {
      for (const [role, texture] of materialTextures(material)) {
        const source = texture.image?.source;
        if (!isKtx2TextureSource(source)) continue;
        const colorSpace = textureRoleColorSpace(role);
        const key = textureKey(texture, colorSpace);
        if (!this.residentTextures.has(key) && !this.prepared.has(key)) {
          requests.set(key, { texture, role, colorSpace, source });
        }
      }
    }
    const decoded = await Promise.all([...requests].map(async ([key, request]) => {
      const result = await this.transcoder.prepare(request.source, request.colorSpace);
      return { key, request, result };
    }));
    this.desiredBankCounts.clear();
    for (const { key, request, result } of decoded) {
      const prepared: PreparedTexture = Object.freeze({
        key,
        texture: request.texture,
        role: request.role,
        colorSpace: request.colorSpace,
        decoded: result
      });
      this.prepared.set(key, prepared);
      const bankKey = compressedBankKey(result);
      this.desiredBankCounts.set(bankKey, (this.desiredBankCounts.get(bankKey) ?? 0) + 1);
    }
  }

  stage(
    materials: readonly StandardShadeMaterial[],
    materialSlots: readonly number[],
    legacyRefs: readonly LegacyMaterialTextureRefs[],
    legacyTextureArray: GPUTextureView,
    legacyHighResolutionTextureArray: GPUTextureView,
    command: ShadeGPUCommandContext
  ): GpuMaterialShadingBindings {
    this.assertAlive();
    if (materials.length !== materialSlots.length || materials.length !== legacyRefs.length) {
      throw new Error("Material shading stage arrays must have identical lengths");
    }
    const retainedMaterials: ResidentMaterial[] = [];
    const createdTextures: ResidentTexture[] = [];
    const createdBanks: CompressedBank[] = [];
    let rolledBack = false;
    const rollback = (): void => {
      if (rolledBack) return;
      rolledBack = true;
      for (let index = retainedMaterials.length - 1; index >= 0; index--) {
        const entry = retainedMaterials[index]!;
        entry.refCount--;
        if (entry.refCount === 0 && entry.retireGeneration === 0) {
          this.residentMaterials.delete(entry.material);
          for (const texture of entry.textures) texture.refCount--;
        }
      }
      for (const texture of createdTextures) {
        if (texture.refCount !== 0) continue;
        this.residentTextures.delete(texture.key);
        texture.bank.freeLayers.push(texture.layer);
        texture.bank.residentCount--;
      }
      for (const bank of createdBanks) {
        if (bank.residentCount !== 0) continue;
        this.banks[bank.slot] = null;
        bank.texture.destroy();
        this.allocatedBytes -= bank.layerBytes * bank.capacity;
      }
    };
    command.onAborted.addOne(rollback);

    const featureKeys: number[] = [];
    try {
      for (let index = 0; index < materials.length; index++) {
        const material = materials[index]!;
        const slot = materialSlots[index]!;
        const existing = this.residentMaterials.get(material);
        let residentMaterial: ResidentMaterial;
        if (existing !== undefined) {
          if (existing.slot !== slot) {
            throw new Error("Material visibility and shading slots diverged");
          }
          existing.refCount++;
          residentMaterial = existing;
        } else {
          const textures: ResidentTexture[] = [];
          for (const [role, texture] of materialTextures(material)) {
            const source = texture.image?.source;
            if (!isKtx2TextureSource(source)) continue;
            const colorSpace = textureRoleColorSpace(role);
            const key = textureKey(texture, colorSpace);
            let resident = this.residentTextures.get(key);
            if (resident === undefined) {
              const prepared = this.prepared.get(key);
              if (prepared === undefined) {
                throw new Error(`KTX2 texture '${texture.label}' was not prepared before staging`);
              }
              const bankResult = this.obtainBank(prepared.decoded);
              if (bankResult.created) createdBanks.push(bankResult.bank);
              const layer = bankResult.bank.freeLayers.pop();
              if (layer === undefined) throw new Error("Compressed material bank has no free layer");
              resident = {
                key,
                source: texture,
                colorSpace,
                bank: bankResult.bank,
                layer,
                logicalBytes: prepared.decoded.decodedBytes,
                refCount: 0,
                retireGeneration: 0
              };
              bankResult.bank.residentCount++;
              this.residentTextures.set(key, resident);
              createdTextures.push(resident);
              this.upload(prepared.decoded, bankResult.bank, layer);
              command.onFinished.addOne(() => {
                if (this.prepared.get(key) === prepared) this.prepared.delete(key);
                this.transcoder.releaseDecoded(prepared.decoded);
              });
            }
            if (!textures.includes(resident)) {
              resident.refCount++;
              textures.push(resident);
            }
          }
          const provisionalRefs = this.resolveMaterialTextureRefs(material, legacyRefs[index]!);
          const provisionalFeatureKey = standardPbrFeatureKey(material, {
            albedo: provisionalRefs.baseColor !== GPU_MATERIAL_SHADING_INVALID_TEXTURE,
            normal: provisionalRefs.normal !== GPU_MATERIAL_SHADING_INVALID_TEXTURE,
            orm: provisionalRefs.orm !== GPU_MATERIAL_SHADING_INVALID_TEXTURE,
            emissive: provisionalRefs.emissive !== GPU_MATERIAL_SHADING_INVALID_TEXTURE
          });
          residentMaterial = {
            material,
            slot,
            textures: Object.freeze(textures),
            featureKey: provisionalFeatureKey,
            refCount: 1,
            retireGeneration: 0
          };
          this.residentMaterials.set(material, residentMaterial);
        }
        retainedMaterials.push(residentMaterial);
        const refs = this.resolveMaterialTextureRefs(material, legacyRefs[index]!);
        const available = {
          albedo: refs.baseColor !== GPU_MATERIAL_SHADING_INVALID_TEXTURE,
          normal: refs.normal !== GPU_MATERIAL_SHADING_INVALID_TEXTURE,
          orm: refs.orm !== GPU_MATERIAL_SHADING_INVALID_TEXTURE,
          emissive: refs.emissive !== GPU_MATERIAL_SHADING_INVALID_TEXTURE
        };
        const featureKey = standardPbrFeatureKey(material, available);
        featureKeys.push(featureKey);
        const packed = packGpuMaterialShadingRecord({
          featureKey,
          baseColorTextureRef: refs.baseColor,
          normalTextureRef: refs.normal,
          ormTextureRef: refs.orm,
          emissiveTextureRef: refs.emissive
        });
        command.writeBuffer(
          this.records,
          slot * GPU_MATERIAL_SHADING_RECORD_STRIDE,
          packed.buffer,
          packed.byteOffset,
          packed.byteLength
        );
      }
    } catch (error) {
      rollback();
      throw error;
    }
    const uniqueFeatureKeys = [...new Set(featureKeys)].sort((left, right) => left - right);
    const specializationKey = uniqueFeatureKeys.map((key) => key.toString(16)).join("-") || "0";
    return Object.freeze({
      abiVersion: GPU_MATERIAL_SHADING_ABI_VERSION,
      records: this.records,
      textureBanks: Object.freeze([
        legacyTextureArray,
        legacyHighResolutionTextureArray,
        ...this.banks.map((bank) => bank?.view ?? this.fallbackView)
      ]),
      specializationKey,
      featureKeys: Object.freeze(uniqueFeatureKeys)
    });
  }

  release(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext
  ): void {
    const counts = new Map<StandardShadeMaterial, number>();
    for (const material of materials) counts.set(material, (counts.get(material) ?? 0) + 1);
    for (const [material, count] of counts) {
      const entry = this.residentMaterials.get(material);
      if (entry === undefined || entry.refCount < count) {
        throw new Error(`Material '${material.name}' has no shading residency reference`);
      }
    }
    command.onFinished.addOne(() => {
      for (const [material, count] of counts) {
        const entry = this.residentMaterials.get(material);
        if (entry === undefined) continue;
        entry.refCount -= count;
        if (entry.refCount !== 0) continue;
        const generation = ++entry.retireGeneration;
        const retire = (): void => this.retireMaterial(entry, generation);
        void command.gpuDone.then(retire, retire);
      }
    });
  }

  evidence(): GpuMaterialShadingEvidence {
    let residentCompressedTextureCount = 0;
    let retiringCompressedTextureCount = 0;
    for (const texture of this.residentTextures.values()) {
      if (texture.refCount > 0) residentCompressedTextureCount++;
      else retiringCompressedTextureCount++;
    }
    const featureClassKeys = [...new Set(
      [...this.residentMaterials.values()].map((entry) => entry.featureKey)
    )].sort((left, right) => left - right);
    return Object.freeze({
      schemaVersion: 1,
      abiVersion: GPU_MATERIAL_SHADING_ABI_VERSION,
      budgetBytes: GPU_MATERIAL_TEXTURE_RESIDENT_BUDGET,
      allocatedBytes: this.allocatedBytes,
      residentLogicalBytes: this.residentLogicalBytes,
      compressedBankCount: this.banks.filter((bank) => bank !== null).length,
      residentCompressedTextureCount,
      retiringCompressedTextureCount,
      evictionCount: this.evictionCount,
      budgetRejectCount: this.budgetRejectCount,
      bankLimitFallbackCount: this.bankLimitFallbackCount,
      featureClassCount: featureClassKeys.length,
      featureClassKeys: Object.freeze(featureClassKeys),
      transcoder: this.transcoder.evidence()
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.records.destroy();
    this.fallbackTexture.destroy();
    for (const bank of this.banks) bank?.texture.destroy();
    this.banks.fill(null);
    this.prepared.clear();
    this.residentTextures.clear();
    this.residentMaterials.clear();
  }

  private obtainBank(decoded: TranscodedKtx2Texture): {
    readonly bank: CompressedBank;
    readonly created: boolean;
  } {
    const key = compressedBankKey(decoded);
    const existing = this.banks.find((bank) => bank?.key === key && bank.freeLayers.length > 0);
    if (existing !== undefined && existing !== null) return { bank: existing, created: false };
    const slot = this.banks.findIndex((bank) => bank === null);
    if (slot < 0) {
      this.bankLimitFallbackCount++;
      throw new RangeError(
        `Material texture workload exceeds ${GPU_MATERIAL_SHADING_MAX_COMPRESSED_BANKS} compressed size/format banks`
      );
    }
    const requested = Math.max(1, this.desiredBankCounts.get(key) ?? 1);
    const capacity = Math.min(
      Number(this.graphics.device.limits.maxTextureArrayLayers),
      nextPowerOfTwo(requested)
    );
    const layerBytes = decoded.mipLevels
      .filter((mip) => mip.layer === 0)
      .reduce((sum, mip) => sum + mip.data.byteLength, 0);
    const allocationBytes = layerBytes * capacity;
    if (this.allocatedBytes + allocationBytes > GPU_MATERIAL_TEXTURE_RESIDENT_BUDGET) {
      this.budgetRejectCount++;
      throw new RangeError(
        `Compressed material residency requires ${allocationBytes} bytes but only ` +
        `${GPU_MATERIAL_TEXTURE_RESIDENT_BUDGET - this.allocatedBytes} budget bytes remain`
      );
    }
    const texture = this.graphics.device.createTexture({
      label: `R5 compressed material bank ${slot}/${key}`,
      size: [decoded.width, decoded.height, capacity],
      mipLevelCount: decoded.mipLevelCount,
      format: decoded.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
    });
    const freeLayers: number[] = [];
    for (let layer = capacity - 1; layer >= 0; layer--) freeLayers.push(layer);
    const bank: CompressedBank = {
      slot,
      key,
      format: decoded.format,
      width: decoded.width,
      height: decoded.height,
      mipLevelCount: decoded.mipLevelCount,
      capacity,
      layerBytes,
      texture,
      view: texture.createView({ dimension: "2d-array" }),
      freeLayers,
      residentCount: 0
    };
    this.banks[slot] = bank;
    this.allocatedBytes += allocationBytes;
    return { bank, created: true };
  }

  private upload(
    decoded: TranscodedKtx2Texture,
    bank: CompressedBank,
    layer: number
  ): void {
    if (
      decoded.format !== bank.format || decoded.width !== bank.width ||
      decoded.height !== bank.height || decoded.mipLevelCount !== bank.mipLevelCount
    ) {
      throw new Error("Compressed material texture does not match its size-class bank");
    }
    for (const mip of decoded.mipLevels) {
      if (mip.layer !== 0) {
        throw new Error("glTF material KTX2 array layers are unsupported");
      }
      const blockColumns = Math.ceil(mip.width / decoded.blockWidth);
      const blockRows = Math.ceil(mip.height / decoded.blockHeight);
      const bytesPerRow = blockColumns * decoded.bytesPerBlock;
      const targetWidth = Math.max(1, decoded.width >> mip.level);
      const targetHeight = Math.max(1, decoded.height >> mip.level);
      writeGpuTexture(
        this.graphics.device.queue,
        "GpuMaterialShadingTable/KTX2",
        { texture: bank.texture, mipLevel: mip.level, origin: [0, 0, layer] },
        mip.data,
        { bytesPerRow, rowsPerImage: blockRows },
        [targetWidth, targetHeight, 1]
      );
    }
    this.residentLogicalBytes += decoded.decodedBytes;
  }

  private resolveMaterialTextureRefs(
    material: StandardShadeMaterial,
    legacy: LegacyMaterialTextureRefs
  ): Readonly<{ baseColor: number; normal: number; orm: number; emissive: number }> {
    return Object.freeze({
      baseColor: this.resolveTextureRef(material.texture_albedo, "albedo", legacy.baseColor),
      normal: material.is_unlit
        ? GPU_MATERIAL_SHADING_INVALID_TEXTURE
        : this.resolveTextureRef(material.texture_normal, "normal", legacy.normal),
      orm: material.is_unlit
        ? GPU_MATERIAL_SHADING_INVALID_TEXTURE
        : this.resolveTextureRef(material.texture_orm, "orm", legacy.orm),
      emissive: material.is_unlit
        ? GPU_MATERIAL_SHADING_INVALID_TEXTURE
        : this.resolveTextureRef(material.texture_emissive, "emissive", legacy.emissive)
    });
  }

  private resolveTextureRef(
    texture: ShadeTexture | undefined,
    role: TextureRole,
    legacyRef: number
  ): number {
    if (texture === undefined) return GPU_MATERIAL_SHADING_INVALID_TEXTURE;
    const colorSpace = textureRoleColorSpace(role);
    const resident = this.residentTextures.get(textureKey(texture, colorSpace));
    if (resident !== undefined) {
      return encodeGpuMaterialShadingTextureRef(
        GPU_MATERIAL_SHADING_LEGACY_BANK_COUNT + resident.bank.slot,
        resident.layer
      );
    }
    if (legacyRef === GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE) {
      return GPU_MATERIAL_SHADING_INVALID_TEXTURE;
    }
    const highResolution = (legacyRef & GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_BIT) !== 0;
    return encodeGpuMaterialShadingTextureRef(
      highResolution ? 1 : 0,
      legacyRef & 0x7fffffff
    );
  }

  private retireMaterial(entry: ResidentMaterial, generation: number): void {
    if (this.destroyed || entry.refCount !== 0 || entry.retireGeneration !== generation) return;
    if (this.residentMaterials.get(entry.material) !== entry) return;
    this.residentMaterials.delete(entry.material);
    for (const texture of entry.textures) {
      texture.refCount--;
      if (texture.refCount !== 0) continue;
      const textureGeneration = ++texture.retireGeneration;
      this.retireTexture(texture, textureGeneration);
    }
  }

  private retireTexture(texture: ResidentTexture, generation: number): void {
    if (this.destroyed || texture.refCount !== 0 || texture.retireGeneration !== generation) return;
    if (this.residentTextures.get(texture.key) !== texture) return;
    this.residentTextures.delete(texture.key);
    texture.bank.freeLayers.push(texture.layer);
    texture.bank.residentCount--;
    this.residentLogicalBytes = Math.max(0, this.residentLogicalBytes - texture.logicalBytes);
    if (texture.bank.residentCount !== 0) return;
    this.banks[texture.bank.slot] = null;
    texture.bank.texture.destroy();
    this.allocatedBytes -= texture.bank.layerBytes * texture.bank.capacity;
    this.evictionCount++;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("GpuMaterialShadingTable has been destroyed");
  }
}

function materialTextures(
  material: StandardShadeMaterial
): readonly (readonly [TextureRole, ShadeTexture])[] {
  const entries: Array<readonly [TextureRole, ShadeTexture | undefined]> = material.is_unlit
    ? [["albedo", material.texture_albedo]]
    : [
        ["albedo", material.texture_albedo],
        ["normal", material.texture_normal],
        ["orm", material.texture_orm],
        ["emissive", material.texture_emissive]
      ];
  return entries.filter((entry): entry is readonly [TextureRole, ShadeTexture] =>
    entry[1] !== undefined
  );
}

function textureRoleColorSpace(role: TextureRole): TextureColorSpace {
  return role === "albedo" || role === "emissive" ? "srgb" : "linear";
}

function textureKey(texture: ShadeTexture, colorSpace: TextureColorSpace): string {
  const image = texture.image;
  if (image === undefined) throw new Error("Material texture has no image");
  return `${image.id}/${colorSpace}`;
}

function compressedBankKey(decoded: TranscodedKtx2Texture): string {
  return `${decoded.format}/${decoded.width}x${decoded.height}/${decoded.mipLevelCount}`;
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}
