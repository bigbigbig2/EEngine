import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { isKtx2TextureSource } from "../assets/MaterialTextureAssetPackage.js";
import { TextureFilterType } from "../texture/TextureFilterType.js";
import type { CachedRenderPipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { GPUTextureContext } from "./GPUTextureContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  GPU_MATERIAL_VISIBILITY_ABI_VERSION,
  GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_BIT,
  GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
  GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
  materialVisibilitySource,
  packGpuMaterialVisibilityRecord
} from "./GpuMaterialVisibilityAbi.js";

export const GPU_MATERIAL_VISIBILITY_CAPACITY = 4096;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE = 256;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_TILES_PER_AXIS = 1;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY = 64;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_ATLAS_SIZE =
  GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_MIP_COUNT = 9;
export const GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_SIZE = 4096;
export const GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_CAPACITY = 16;
export const GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_MIP_COUNT = 13;
const GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_MIN_CAPACITY = 16;

export interface GpuMaterialVisibilityBindings {
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly textureCapacity: number;
  readonly materialRecords: GPUBuffer;
  readonly textureArray: GPUTextureView;
  readonly highResolutionTextureArray: GPUTextureView;
  /** R4-A compatibility name; alpha and shading now share textureArray. */
  readonly alphaAtlas: GPUTextureView;
  readonly highResolutionAlphaAtlas: GPUTextureView;
}

export interface GpuMaterialVisibilityStage {
  readonly bindings: GpuMaterialVisibilityBindings;
  /** Dense resident slots aligned with the input material dictionary. */
  readonly materialSlots: readonly number[];
  /** Legacy uncompressed array refs aligned with the material dictionary. */
  readonly textureRefs: readonly Readonly<{
    baseColor: number;
    normal: number;
    orm: number;
    emissive: number;
  }>[];
}

export interface GpuMaterialVisibilityEvidence {
  readonly schemaVersion: 6;
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly textureCapacity: number;
  readonly residentMaterialSlotCount: number;
  readonly retiringMaterialSlotCount: number;
  readonly freeMaterialSlotCount: number;
  readonly residentTextureCount: number;
  readonly retiringTextureCount: number;
  readonly freeTextureLayerCount: number;
  readonly textureFallbackCount: number;
  readonly samplerFallbackCount: number;
  readonly allocatedBytes: number;
  readonly residentTextureBytes: number;
  readonly textureSize: number;
  readonly mipLevelCount: number;
  readonly highResolutionTextureSize: number;
  readonly highResolutionTextureCapacity: number;
  readonly highResolutionMipLevelCount: number;
  readonly highResolutionArrayAllocated: boolean;
  readonly residentHighResolutionTextureCount: number;
  readonly retiringHighResolutionTextureCount: number;
  readonly freeHighResolutionTextureLayerCount: number;
  readonly privateSubmitCount: 0;
  readonly takeoverTask: null;
}

interface ResidentTexture {
  readonly layer: number;
  readonly highResolution: boolean;
  readonly source: ShadeTexture;
  refCount: number;
  retireGeneration: number;
}

interface ResidentMaterial {
  readonly slot: number;
  refCount: number;
  retireGeneration: number;
  textures: ResidentTexture[];
}

interface MaterialRetainOperation {
  readonly material: StandardShadeMaterial;
  readonly entry: ResidentMaterial;
  readonly created: boolean;
  readonly previousRetireGeneration: number;
}

interface TextureRetainOperation {
  readonly entry: ResidentTexture;
  readonly created: boolean;
  readonly previousRetireGeneration: number;
}

interface MaterialTextureTransition {
  readonly material: ResidentMaterial;
  readonly previous: readonly ResidentTexture[];
  readonly next: readonly ResidentTexture[];
  readonly added: readonly TextureRetainOperation[];
  readonly removed: readonly ResidentTexture[];
}

/**
 * Single bounded R4-B Standard PBR material and texture residency owner.
 * Visibility alpha and Material Resolve consume the same stable TextureRef.
 */
export class GpuMaterialVisibilityTable {
  private readonly materialRecords: GPUBuffer;
  private readonly textureArray: GPUTexture;
  private readonly textureArrayView: GPUTextureView;
  private readonly textureDescriptor: GPUTextureDescriptor;
  private highResolutionTextureDescriptor: GPUTextureDescriptor;
  private highResolutionTextureArray: GPUTexture | null = null;
  private highResolutionTextureArrayView: GPUTextureView | null = null;
  private highResolutionTextureSize = GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_SIZE;
  private highResolutionTextureCapacity = GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_CAPACITY;
  private highResolutionMipLevelCount = GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_MIP_COUNT;
  private readonly textures = new Map<ShadeTexture, ResidentTexture>();
  private readonly residentMaterials = new Map<StandardShadeMaterial, ResidentMaterial>();
  private readonly freeMaterialSlots: number[] = [];
  private readonly freeTextureLayers: number[] = [];
  private readonly freeHighResolutionTextureLayers: number[] = [];
  private readonly textureFallbackMaterialIds = new Set<number>();
  private readonly samplerFallbackMaterialIds = new Set<number>();
  private resizePipeline: GPURenderPipeline | null = null;
  private destroyed = false;

  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    const materialBytes =
      GPU_MATERIAL_VISIBILITY_CAPACITY * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE;
    if (
      materialBytes > Number(device.limits.maxBufferSize) ||
      materialBytes > Number(device.limits.maxStorageBufferBindingSize)
    ) {
      throw new RangeError(
        `R4 Material Visibility table requires ${materialBytes} bytes but the device limit is smaller`
      );
    }
    this.materialRecords = device.createBuffer({
      label: "R4-B Standard PBR MaterialRecord table",
      size: materialBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint8Array(this.materialRecords.getMappedRange()).fill(0);
    this.materialRecords.unmap();
    this.textureDescriptor = {
      label: "R4-B bounded Standard PBR texture array",
      size: [
        GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
        GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
        GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY
      ],
      format: "rgba8unorm",
      mipLevelCount: GPU_MATERIAL_VISIBILITY_TEXTURE_MIP_COUNT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST
    };
    this.textureArray = device.createTexture(this.textureDescriptor);
    this.textureArrayView = this.textureArray.createView({ dimension: "2d-array" });
    this.highResolutionTextureDescriptor = {
      label: "R4-B bounded 4K Standard PBR texture array",
      size: [
        GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_SIZE,
        GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_SIZE,
        GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_CAPACITY
      ],
      format: "rgba8unorm",
      mipLevelCount: GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_MIP_COUNT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST
    };
    for (let slot = GPU_MATERIAL_VISIBILITY_CAPACITY - 1; slot >= 0; slot--) {
      this.freeMaterialSlots.push(slot);
    }
    // Layer 0 remains the deterministic fallback/cleared layer.
    for (let layer = GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY - 1; layer >= 1; layer--) {
      this.freeTextureLayers.push(layer);
    }
    for (
      let layer = GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_CAPACITY - 1;
      layer >= 1;
      layer--
    ) {
      this.freeHighResolutionTextureLayers.push(layer);
    }
  }

  stage(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext
  ): GpuMaterialVisibilityStage {
    this.preflight(materials);
    const retainOperations = this.retainMaterialSlots(materials);
    const materialSlots = retainOperations.map(({ entry }) => entry.slot);
    const textureRefs = new Map<ShadeTexture, number>();
    const textureTransitions: MaterialTextureTransition[] = [];
    const newTextures: ResidentTexture[] = [];
    const previousFallbacks: Array<readonly [number, boolean, boolean]> = [];
    let rolledBack = false;
    const rollback = (): void => {
      if (rolledBack) return;
      rolledBack = true;
      for (let index = textureTransitions.length - 1; index >= 0; index--) {
        const transition = textureTransitions[index]!;
        transition.material.textures = [...transition.previous];
        for (let addedIndex = transition.added.length - 1; addedIndex >= 0; addedIndex--) {
          this.rollbackTextureRetain(transition.added[addedIndex]!);
        }
      }
      for (let index = previousFallbacks.length - 1; index >= 0; index--) {
        const [materialId, textureFallback, samplerFallback] = previousFallbacks[index]!;
        writeSet(this.textureFallbackMaterialIds, materialId, textureFallback);
        writeSet(this.samplerFallbackMaterialIds, materialId, samplerFallback);
      }
      for (let index = retainOperations.length - 1; index >= 0; index--) {
        const operation = retainOperations[index]!;
        operation.entry.refCount--;
        operation.entry.retireGeneration = operation.previousRetireGeneration;
        if (operation.entry.refCount === 0 && operation.created) {
          if (this.residentMaterials.get(operation.material) === operation.entry) {
            this.residentMaterials.delete(operation.material);
          }
          this.freeMaterialSlots.push(operation.entry.slot);
        }
      }
    };
    command.onAborted.addOne(rollback);
    try {
      const transitioned = new Set<ResidentMaterial>();
      for (let index = 0; index < materials.length; index++) {
        const resident = retainOperations[index]!.entry;
        if (transitioned.has(resident)) continue;
        transitioned.add(resident);
        const transition = this.transitionMaterialTextures(resident, materials[index]!);
        textureTransitions.push(transition);
        for (const operation of transition.added) {
          if (operation.created) newTextures.push(operation.entry);
        }
      }
      for (const entry of this.textures.values()) {
        if (entry.refCount > 0) {
          textureRefs.set(entry.source, entry.highResolution
            ? (entry.layer | GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_BIT) >>> 0
            : entry.layer);
        }
      }
      this.graphics.textures.mipmaps.flush(command);
      for (const texture of newTextures) {
        this.encodeResizeCopy(command, texture);
      }
      if (newTextures.some(({ highResolution }) => !highResolution)) {
        this.graphics.textures.mipmaps.generateMipmap(
          this.textureArray,
          this.textureDescriptor,
          TextureFilterType.Linear,
          command
        );
      }
      if (newTextures.some(({ highResolution }) => highResolution)) {
        this.graphics.textures.mipmaps.generateMipmap(
          this.requireHighResolutionTextureArray(),
          this.highResolutionTextureDescriptor,
          TextureFilterType.Linear,
          command
        );
      }

      for (let materialIndex = 0; materialIndex < materials.length; materialIndex++) {
        const material = materials[materialIndex]!;
        const materialSlot = materialSlots[materialIndex]!;
        const textureRef = (texture: ShadeTexture | undefined): number =>
          texture === undefined
            ? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
            : textureRefs.get(texture) ??
              GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
        const source = materialVisibilitySource(material, {
          baseColor: textureRef(material.texture_albedo),
          normal: textureRef(material.texture_normal),
          orm: textureRef(material.texture_orm),
          emissive: textureRef(material.texture_emissive)
        }, materialSlot);
        previousFallbacks.push([
          materialSlot,
          this.textureFallbackMaterialIds.has(materialSlot),
          this.samplerFallbackMaterialIds.has(materialSlot)
        ]);
        const packed = packGpuMaterialVisibilityRecord(source.packed);
        command.writeBuffer(
          this.materialRecords,
          materialSlot * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
          packed,
          0,
          packed.byteLength
        );
        writeSet(this.textureFallbackMaterialIds, materialSlot, source.textureFallback);
        writeSet(this.samplerFallbackMaterialIds, materialSlot, source.samplerFallback);
      }
      const materialTextureRefs = materials.map((material) => Object.freeze({
        baseColor: textureRefOrInvalid(textureRefs, material.texture_albedo),
        normal: textureRefOrInvalid(textureRefs, material.texture_normal),
        orm: textureRefOrInvalid(textureRefs, material.texture_orm),
        emissive: textureRefOrInvalid(textureRefs, material.texture_emissive)
      }));
      command.onFinished.addOne(() => {
        for (const transition of textureTransitions) {
          this.releaseTextureRefs(transition.removed, command.gpuDone);
        }
      });
      return Object.freeze({
        bindings: this.bindings(),
        materialSlots: Object.freeze(materialSlots),
        textureRefs: Object.freeze(materialTextureRefs)
      });
    } catch (error) {
      rollback();
      throw error;
    }
  }

  release(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext
  ): void {
    const releaseCounts = new Map<StandardShadeMaterial, number>();
    for (const material of materials) {
      releaseCounts.set(material, (releaseCounts.get(material) ?? 0) + 1);
    }
    for (const [material, count] of releaseCounts) {
      const entry = this.residentMaterials.get(material);
      if (entry === undefined || entry.refCount < count) {
        throw new Error(`Material '${material.name}' has no matching resident slot reference`);
      }
    }
    command.onFinished.addOne(() => {
      for (const [material, count] of releaseCounts) {
        const entry = this.residentMaterials.get(material);
        if (entry === undefined) continue;
        entry.refCount -= count;
        if (entry.refCount !== 0) continue;
        this.textureFallbackMaterialIds.delete(entry.slot);
        this.samplerFallbackMaterialIds.delete(entry.slot);
        const generation = ++entry.retireGeneration;
        const textures = entry.textures;
        entry.textures = [];
        this.releaseTextureRefs(textures, command.gpuDone);
        const retire = (): void => this.retireMaterialSlot(material, entry, generation);
        void command.gpuDone.then(retire, retire);
      }
    });
  }

  bindings(): GpuMaterialVisibilityBindings {
    return Object.freeze({
      abiVersion: GPU_MATERIAL_VISIBILITY_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_VISIBILITY_CAPACITY,
      textureCapacity: GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY,
      materialRecords: this.materialRecords,
      textureArray: this.textureArrayView,
      highResolutionTextureArray: this.highResolutionTextureArrayView ?? this.textureArrayView,
      alphaAtlas: this.textureArrayView,
      highResolutionAlphaAtlas: this.highResolutionTextureArrayView ?? this.textureArrayView
    });
  }

  evidence(): GpuMaterialVisibilityEvidence {
    let residentMaterialSlotCount = 0;
    let retiringMaterialSlotCount = 0;
    for (const entry of this.residentMaterials.values()) {
      if (entry.refCount > 0) residentMaterialSlotCount++;
      else retiringMaterialSlotCount++;
    }
    let residentTextureCount = 0;
    let retiringTextureCount = 0;
    let residentHighResolutionTextureCount = 0;
    let retiringHighResolutionTextureCount = 0;
    for (const entry of this.textures.values()) {
      if (entry.refCount > 0) {
        residentTextureCount++;
        if (entry.highResolution) residentHighResolutionTextureCount++;
      } else {
        retiringTextureCount++;
        if (entry.highResolution) retiringHighResolutionTextureCount++;
      }
    }
    return Object.freeze({
      schemaVersion: 6,
      abiVersion: GPU_MATERIAL_VISIBILITY_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_VISIBILITY_CAPACITY,
      textureCapacity: GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY,
      residentMaterialSlotCount,
      retiringMaterialSlotCount,
      freeMaterialSlotCount: this.freeMaterialSlots.length,
      residentTextureCount,
      retiringTextureCount,
      freeTextureLayerCount: this.freeTextureLayers.length,
      textureFallbackCount: this.textureFallbackMaterialIds.size,
      samplerFallbackCount: this.samplerFallbackMaterialIds.size,
      allocatedBytes:
        GPU_MATERIAL_VISIBILITY_CAPACITY * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE +
        textureArrayBytes() + (this.highResolutionTextureArray === null
          ? 0
          : highResolutionTextureArrayBytes(
            this.highResolutionTextureSize,
            this.highResolutionTextureCapacity,
            this.highResolutionMipLevelCount
          )),
      residentTextureBytes: textureArrayBytes() + (this.highResolutionTextureArray === null
        ? 0
        : highResolutionTextureArrayBytes(
          this.highResolutionTextureSize,
          this.highResolutionTextureCapacity,
          this.highResolutionMipLevelCount
        )),
      textureSize: GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
      mipLevelCount: GPU_MATERIAL_VISIBILITY_TEXTURE_MIP_COUNT,
      highResolutionTextureSize: this.highResolutionTextureSize,
      highResolutionTextureCapacity: this.highResolutionTextureCapacity,
      highResolutionMipLevelCount: this.highResolutionMipLevelCount,
      highResolutionArrayAllocated: this.highResolutionTextureArray !== null,
      residentHighResolutionTextureCount,
      retiringHighResolutionTextureCount,
      freeHighResolutionTextureLayerCount: this.freeHighResolutionTextureLayers.length,
      privateSubmitCount: 0,
      takeoverTask: null
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.materialRecords.destroy();
    this.textureArray.destroy();
    this.highResolutionTextureArray?.destroy();
    this.textures.clear();
    this.residentMaterials.clear();
    this.freeMaterialSlots.length = 0;
    this.freeTextureLayers.length = 0;
    this.freeHighResolutionTextureLayers.length = 0;
    this.textureFallbackMaterialIds.clear();
    this.samplerFallbackMaterialIds.clear();
    this.resizePipeline = null;
  }

  private preflight(materials: readonly StandardShadeMaterial[]): void {
    const newMaterials = new Set<StandardShadeMaterial>();
    const newTextures = new Set<ShadeTexture>();
    const newHighResolutionTextures = new Set<ShadeTexture>();
    for (const material of materials) {
      if (!this.residentMaterials.has(material)) newMaterials.add(material);
      for (const texture of material.textures) {
        if (!canStageTexture(texture) || this.textures.has(texture)) continue;
        if (requiresHighResolutionBank(texture)) newHighResolutionTextures.add(texture);
        else newTextures.add(texture);
      }
    }
    if (newMaterials.size > this.freeMaterialSlots.length) {
      throw new RangeError(
        `R4-B material residency requires ${newMaterials.size} new slots but only ` +
        `${this.freeMaterialSlots.length} of ${GPU_MATERIAL_VISIBILITY_CAPACITY} are free`
      );
    }
    if (newTextures.size > this.freeTextureLayers.length) {
      throw new RangeError(
        `R4-B texture residency requires ${newTextures.size} new layers but only ` +
        `${this.freeTextureLayers.length} of ${GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY - 1} are free`
      );
    }
    if (newHighResolutionTextures.size > 0) {
      this.ensureHighResolutionTextureArray(newHighResolutionTextures);
    }
    if (newHighResolutionTextures.size > this.freeHighResolutionTextureLayers.length) {
      throw new RangeError(
        `R4-B high-resolution texture residency requires ${newHighResolutionTextures.size} ` +
        `new layers but only ` +
        `${this.freeHighResolutionTextureLayers.length} of ` +
        `${this.highResolutionTextureCapacity - 1} are free`
      );
    }
  }

  private retainMaterialSlots(
    materials: readonly StandardShadeMaterial[]
  ): MaterialRetainOperation[] {
    const operations: MaterialRetainOperation[] = [];
    for (const material of materials) {
      let entry = this.residentMaterials.get(material);
      let created = false;
      if (entry === undefined) {
        const slot = this.freeMaterialSlots.pop();
        if (slot === undefined) throw new RangeError("R4-B material resident slot overflow");
        entry = { slot, refCount: 0, retireGeneration: 0, textures: [] };
        this.residentMaterials.set(material, entry);
        created = true;
      }
      const previousRetireGeneration = entry.retireGeneration;
      if (!created && entry.refCount === 0) {
        entry.retireGeneration++;
      }
      entry.refCount++;
      operations.push({ material, entry, created, previousRetireGeneration });
    }
    return operations;
  }

  private retireMaterialSlot(
    material: StandardShadeMaterial,
    entry: ResidentMaterial,
    generation: number
  ): void {
    if (this.destroyed || entry.refCount !== 0 || entry.retireGeneration !== generation) return;
    if (this.residentMaterials.get(material) !== entry) return;
    this.residentMaterials.delete(material);
    this.freeMaterialSlots.push(entry.slot);
  }

  private transitionMaterialTextures(
    resident: ResidentMaterial,
    material: StandardShadeMaterial
  ): MaterialTextureTransition {
    const desired = [...new Set(material.textures)];
    const previous = resident.textures;
    const previousSet = new Set(previous.map(({ source }) => source));
    const desiredSet = new Set(desired);
    const next: ResidentTexture[] = [];
    const added: TextureRetainOperation[] = [];
    for (const texture of desired) {
      const current = this.textures.get(texture);
      if (current !== undefined && previousSet.has(texture)) {
        next.push(current);
        continue;
      }
      const operation = this.retainTexture(texture);
      if (operation === null) continue;
      added.push(operation);
      next.push(operation.entry);
    }
    const removed = previous.filter(({ source }) => !desiredSet.has(source));
    resident.textures = next;
    return { material: resident, previous, next, added, removed };
  }

  private retainTexture(texture: ShadeTexture): TextureRetainOperation | null {
    if (!canStageTexture(texture)) return null;
    let entry = this.textures.get(texture);
    let created = false;
    if (entry === undefined) {
      try {
        this.graphics.textures.obtain(texture);
      } catch {
        return null;
      }
      const highResolution = requiresHighResolutionBank(texture);
      const freeLayers = highResolution
        ? this.freeHighResolutionTextureLayers
        : this.freeTextureLayers;
      const layer = freeLayers.pop();
      if (layer === undefined) throw new RangeError("R4-B texture resident layer overflow");
      entry = { layer, highResolution, source: texture, refCount: 0, retireGeneration: 0 };
      this.textures.set(texture, entry);
      created = true;
    }
    const previousRetireGeneration = entry.retireGeneration;
    if (!created && entry.refCount === 0) entry.retireGeneration++;
    entry.refCount++;
    return { entry, created, previousRetireGeneration };
  }

  private rollbackTextureRetain(operation: TextureRetainOperation): void {
    const entry = operation.entry;
    entry.refCount--;
    entry.retireGeneration = operation.previousRetireGeneration;
    if (!operation.created || entry.refCount !== 0) return;
    if (this.textures.get(entry.source) === entry) this.textures.delete(entry.source);
    this.freeLayers(entry).push(entry.layer);
  }

  private releaseTextureRefs(
    textures: readonly ResidentTexture[],
    gpuDone: Promise<void>
  ): void {
    for (const entry of textures) {
      entry.refCount--;
      if (entry.refCount < 0) throw new Error("R4-B texture resident refcount underflow");
      if (entry.refCount !== 0) continue;
      const generation = ++entry.retireGeneration;
      const retire = (): void => this.retireTextureLayer(entry, generation);
      void gpuDone.then(retire, retire);
    }
  }

  private retireTextureLayer(entry: ResidentTexture, generation: number): void {
    if (this.destroyed || entry.refCount !== 0 || entry.retireGeneration !== generation) return;
    if (this.textures.get(entry.source) !== entry) return;
    this.textures.delete(entry.source);
    this.freeLayers(entry).push(entry.layer);
  }

  private encodeResizeCopy(
    command: ShadeGPUCommandContext,
    tile: ResidentTexture
  ): void {
    const source = this.graphics.textures.obtain(tile.source);
    const targetSize = tile.highResolution
      ? this.highResolutionTextureSize
      : GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE;
    const targetTexture = tile.highResolution
      ? this.requireHighResolutionTextureArray()
      : this.textureArray;
    const sourceMip = Math.max(0, Math.floor(Math.min(
      Math.log2(source.width / targetSize),
      Math.log2(source.height / targetSize)
    )));
    const sourceWidth = Math.max(1, source.width >> sourceMip);
    const sourceHeight = Math.max(1, source.height >> sourceMip);
    const clip = new Uint32Array([0, 0, sourceWidth, sourceHeight]);
    const clipBuffer = command.allocateTransientBufferAndLoad(
      clip.buffer,
      GPUBufferUsage.UNIFORM
    );
    const bindGroup = this.graphics.bind_groups.obtain({
      layout: RESIZE_COPY_GROUP_LAYOUT,
      entries: [
        source.obtainView({ baseMipLevel: sourceMip, mipLevelCount: 1 }),
        { buffer: clipBuffer }
      ]
    });
    const pass = command.beginRenderPass({
      label: "R4-B texture array layer upload",
      colorAttachments: [{
        view: targetTexture.createView({
          dimension: "2d",
          baseMipLevel: 0,
          mipLevelCount: 1,
          baseArrayLayer: tile.layer,
          arrayLayerCount: 1
        }),
        loadOp: "load",
        storeOp: "store"
      }]
    });
    pass.setViewport(
      0,
      0,
      targetSize,
      targetSize,
      0,
      1
    );
    pass.setPipeline(this.obtainResizePipeline());
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private obtainResizePipeline(): GPURenderPipeline {
    this.resizePipeline ??= this.graphics.render_pipelines.obtain(
      RESIZE_COPY_PIPELINE
    );
    return this.resizePipeline;
  }

  private freeLayers(entry: ResidentTexture): number[] {
    return entry.highResolution
      ? this.freeHighResolutionTextureLayers
      : this.freeTextureLayers;
  }

  private ensureHighResolutionTextureArray(textures: ReadonlySet<ShadeTexture>): void {
    const requiredSize = highResolutionBankSize(textures);
    if (this.highResolutionTextureArray !== null) {
      if (requiredSize > this.highResolutionTextureSize) {
        throw new RangeError(
          `R4-B high-resolution texture residency bank is ${this.highResolutionTextureSize}px ` +
          `but this upload requires ${requiredSize}px; upload bulk scene textures together`
        );
      }
      return;
    }
    const limits = this.graphics.device.limits;
    const requiredCapacity = Math.max(
      GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_MIN_CAPACITY,
      nextPowerOfTwo(textures.size + 1)
    );
    const budgetCapacity = Math.max(
      1,
      Math.floor(
        GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_CAPACITY *
        (GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_SIZE / requiredSize) ** 2
      )
    );
    const capacity = Math.min(budgetCapacity, Number(limits.maxTextureArrayLayers));
    if (
      Number(limits.maxTextureDimension2D) < requiredSize ||
      capacity < requiredCapacity
    ) {
      throw new RangeError(
        `R4-B high-resolution texture residency requires ${requiredSize}px × ` +
        `${requiredCapacity} layers but this device/budget permits ${capacity}`
      );
    }
    this.highResolutionTextureSize = requiredSize;
    this.highResolutionTextureCapacity = requiredCapacity;
    this.highResolutionMipLevelCount = Math.floor(Math.log2(requiredSize)) + 1;
    this.highResolutionTextureDescriptor = {
      ...this.highResolutionTextureDescriptor,
      size: [requiredSize, requiredSize, requiredCapacity],
      mipLevelCount: this.highResolutionMipLevelCount
    };
    this.freeHighResolutionTextureLayers.length = 0;
    for (let layer = requiredCapacity - 1; layer >= 1; layer--) {
      this.freeHighResolutionTextureLayers.push(layer);
    }
    this.highResolutionTextureArray = this.graphics.device.createTexture(
      this.highResolutionTextureDescriptor
    );
    this.highResolutionTextureArrayView = this.highResolutionTextureArray.createView({
      dimension: "2d-array"
    });
  }

  private requireHighResolutionTextureArray(): GPUTexture {
    if (this.highResolutionTextureArray === null) {
      throw new Error("R4-B high-resolution texture array was not allocated during preflight");
    }
    return this.highResolutionTextureArray;
  }
}

const RESIZE_COPY_VERTEX_WGSL = /* wgsl */ `
const positions = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f(3.0, -1.0),
  vec2f(-1.0, 3.0)
);

struct Output {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn main(@builtin(vertex_index) vertex_index: u32) -> Output {
  let ndc = positions[vertex_index];
  return Output(vec4f(ndc, 0.0, 1.0), fma(ndc, vec2f(0.5, -0.5), vec2f(0.5)));
}
`;

const RESIZE_COPY_FRAGMENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> source_clip: vec4u;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = max(source_clip.zw, vec2u(1u));
  let pixel = min(vec2u(uv * vec2f(size)), size - vec2u(1u));
  return textureLoad(source, vec2i(source_clip.xy + pixel), 0);
}
`;

const RESIZE_COPY_GROUP_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "R4-B texture array resize group",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    }
  ]
};

const RESIZE_COPY_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "R4-B texture array resize",
  layout: {
    label: "R4-B texture array resize layout",
    bindGroupLayouts: [RESIZE_COPY_GROUP_LAYOUT]
  },
  vertex: {
    module: { label: "R4-B texture array resize vertex", code: RESIZE_COPY_VERTEX_WGSL },
    entryPoint: "main",
    buffers: []
  },
  fragment: {
    module: { label: "R4-B texture array resize fragment", code: RESIZE_COPY_FRAGMENT_WGSL },
    entryPoint: "main",
    targets: [{ format: "rgba8unorm" }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  multisample: {}
};

function canStageTexture(texture: ShadeTexture): boolean {
  const image = texture.image;
  return image !== undefined && !isKtx2TextureSource(image.source) &&
    image.width > 0 && image.height > 0 && image.depth <= 1;
}

function requiresHighResolutionBank(texture: ShadeTexture): boolean {
  const image = texture.image;
  return image !== undefined && Math.max(image.width, image.height) >
    GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE;
}

function writeSet(set: Set<number>, value: number, present: boolean): void {
  if (present) set.add(value);
  else set.delete(value);
}

function textureRefOrInvalid(
  refs: ReadonlyMap<ShadeTexture, number>,
  texture: ShadeTexture | undefined
): number {
  return texture === undefined
    ? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
    : refs.get(texture) ?? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
}

function textureArrayBytes(): number {
  let texels = 0;
  for (let mip = 0; mip < GPU_MATERIAL_VISIBILITY_TEXTURE_MIP_COUNT; mip++) {
    const size = Math.max(1, GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE >> mip);
    texels += size * size;
  }
  return texels * GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY * 4;
}


function highResolutionTextureArrayBytes(
  textureSize: number,
  capacity: number,
  mipLevelCount: number
): number {
  let texels = 0;
  for (let mip = 0; mip < mipLevelCount; mip++) {
    const size = Math.max(1, textureSize >> mip);
    texels += size * size;
  }
  return texels * capacity * 4;
}

function highResolutionBankSize(textures: ReadonlySet<ShadeTexture>): number {
  let required = GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE + 1;
  for (const texture of textures) {
    const image = texture.image;
    if (image !== undefined) required = Math.max(required, image.width, image.height);
  }
  return Math.min(
    GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_TEXTURE_SIZE,
    nextPowerOfTwo(required)
  );
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}
