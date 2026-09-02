import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import {
  GPU_MATERIAL_VISIBILITY_ABI_VERSION,
  GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
  GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
  materialVisibilitySource,
  packGpuMaterialVisibilityRecord
} from "./GpuMaterialVisibilityAbi.js";

export const GPU_MATERIAL_CAPACITY = 4096;

export interface GpuMaterialBindings {
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly materialRecords: GPUBuffer;
}

export interface GpuMaterialStage {
  readonly bindings: GpuMaterialBindings;
  readonly materialSlots: readonly number[];
}

export interface GpuMaterialStoreEvidence {
  readonly schemaVersion: 1;
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly residentMaterialSlotCount: number;
  readonly retiringMaterialSlotCount: number;
  readonly freeMaterialSlotCount: number;
  readonly textureFallbackCount: number;
  readonly samplerFallbackCount: number;
  readonly allocatedBytes: number;
  readonly privateSubmitCount: 0;
}

interface ResidentMaterial {
  readonly slot: number;
  refCount: number;
  retireGeneration: number;
}

interface RetainOperation {
  readonly material: StandardShadeMaterial;
  readonly entry: ResidentMaterial;
  readonly created: boolean;
  readonly previousRetireGeneration: number;
}

/** Stable material-record owner. Texture allocation is deliberately outside this class. */
export class GpuMaterialStore {
  private readonly materialRecords: GPUBuffer;
  private readonly resident = new Map<StandardShadeMaterial, ResidentMaterial>();
  private readonly freeSlots: number[] = [];
  private readonly textureFallbackSlots = new Set<number>();
  private readonly samplerFallbackSlots = new Set<number>();
  private destroyed = false;

  constructor(device: GPUDevice) {
    const bytes = GPU_MATERIAL_CAPACITY * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE;
    if (bytes > Number(device.limits.maxBufferSize) ||
        bytes > Number(device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError(`GpuMaterialStore requires ${bytes} bytes but the device limit is smaller`);
    }
    this.materialRecords = device.createBuffer({
      label: "GpuMaterialStore/records",
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint8Array(this.materialRecords.getMappedRange()).fill(0);
    this.materialRecords.unmap();
    for (let slot = GPU_MATERIAL_CAPACITY - 1; slot >= 0; slot--) this.freeSlots.push(slot);
  }

  stage(
    materials: readonly StandardShadeMaterial[],
    textureRefs: ReadonlyMap<ShadeTexture, number>,
    command: ShadeGPUCommandContext
  ): GpuMaterialStage {
    this.preflight(materials);
    const operations = this.retain(materials);
    const previousFallbacks: Array<readonly [number, boolean, boolean]> = [];
    let rolledBack = false;
    const rollback = (): void => {
      if (rolledBack) return;
      rolledBack = true;
      for (let index = previousFallbacks.length - 1; index >= 0; index--) {
        const [slot, textureFallback, samplerFallback] = previousFallbacks[index]!;
        writeSet(this.textureFallbackSlots, slot, textureFallback);
        writeSet(this.samplerFallbackSlots, slot, samplerFallback);
      }
      for (let index = operations.length - 1; index >= 0; index--) {
        const operation = operations[index]!;
        operation.entry.refCount--;
        operation.entry.retireGeneration = operation.previousRetireGeneration;
        if (operation.created && operation.entry.refCount === 0 &&
            this.resident.get(operation.material) === operation.entry) {
          this.resident.delete(operation.material);
          this.freeSlots.push(operation.entry.slot);
        }
      }
    };
    command.onAborted.addOne(rollback);
    try {
      const materialSlots = operations.map(({ entry }) => entry.slot);
      for (let index = 0; index < materials.length; index++) {
        const material = materials[index]!;
        const slot = materialSlots[index]!;
        const textureRef = (texture: ShadeTexture | undefined): number =>
          texture === undefined
            ? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
            : textureRefs.get(texture) ?? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
        const source = materialVisibilitySource(material, {
          baseColor: textureRef(material.texture_albedo),
          normal: textureRef(material.texture_normal),
          orm: textureRef(material.texture_orm),
          emissive: textureRef(material.texture_emissive)
        }, slot);
        previousFallbacks.push([
          slot,
          this.textureFallbackSlots.has(slot),
          this.samplerFallbackSlots.has(slot)
        ]);
        const packed = packGpuMaterialVisibilityRecord(source.packed);
        command.writeBuffer(
          this.materialRecords,
          slot * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
          packed,
          0,
          packed.byteLength
        );
        writeSet(this.textureFallbackSlots, slot, source.textureFallback);
        writeSet(this.samplerFallbackSlots, slot, source.samplerFallback);
      }
      return Object.freeze({
        bindings: this.bindings(),
        materialSlots: Object.freeze(materialSlots)
      });
    } catch (error) {
      rollback();
      throw error;
    }
  }

  release(materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext): void {
    const counts = countMaterials(materials);
    for (const [material, count] of counts) {
      const entry = this.resident.get(material);
      if (entry === undefined || entry.refCount < count) {
        throw new Error(`Material '${material.name}' has no matching resident slot reference`);
      }
    }
    command.onFinished.addOne(() => {
      for (const [material, count] of counts) {
        const entry = this.resident.get(material);
        if (entry === undefined) continue;
        entry.refCount -= count;
        if (entry.refCount !== 0) continue;
        this.textureFallbackSlots.delete(entry.slot);
        this.samplerFallbackSlots.delete(entry.slot);
        const generation = ++entry.retireGeneration;
        const retire = (): void => this.retire(material, entry, generation);
        void command.gpuDone.then(retire, retire);
      }
    });
  }

  bindings(): GpuMaterialBindings {
    return Object.freeze({
      abiVersion: GPU_MATERIAL_VISIBILITY_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_CAPACITY,
      materialRecords: this.materialRecords
    });
  }

  evidence(): GpuMaterialStoreEvidence {
    let residentMaterialSlotCount = 0;
    let retiringMaterialSlotCount = 0;
    for (const entry of this.resident.values()) {
      if (entry.refCount > 0) residentMaterialSlotCount++;
      else retiringMaterialSlotCount++;
    }
    return Object.freeze({
      schemaVersion: 1,
      abiVersion: GPU_MATERIAL_VISIBILITY_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_CAPACITY,
      residentMaterialSlotCount,
      retiringMaterialSlotCount,
      freeMaterialSlotCount: this.freeSlots.length,
      textureFallbackCount: this.textureFallbackSlots.size,
      samplerFallbackCount: this.samplerFallbackSlots.size,
      allocatedBytes: GPU_MATERIAL_CAPACITY * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
      privateSubmitCount: 0
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.materialRecords.destroy();
    this.resident.clear();
    this.freeSlots.length = 0;
    this.textureFallbackSlots.clear();
    this.samplerFallbackSlots.clear();
  }

  private preflight(materials: readonly StandardShadeMaterial[]): void {
    const fresh = new Set(materials.filter((material) => !this.resident.has(material)));
    if (fresh.size > this.freeSlots.length) {
      throw new RangeError(
        `GpuMaterialStore requires ${fresh.size} new slots but only ${this.freeSlots.length} ` +
        `of ${GPU_MATERIAL_CAPACITY} are free`
      );
    }
    for (const material of materials) {
      materialVisibilitySource(material, GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE, 0);
    }
  }

  private retain(materials: readonly StandardShadeMaterial[]): RetainOperation[] {
    const operations: RetainOperation[] = [];
    for (const material of materials) {
      let entry = this.resident.get(material);
      let created = false;
      if (entry === undefined) {
        const slot = this.freeSlots.pop();
        if (slot === undefined) throw new RangeError("GpuMaterialStore slot overflow");
        entry = { slot, refCount: 0, retireGeneration: 0 };
        this.resident.set(material, entry);
        created = true;
      }
      const previousRetireGeneration = entry.retireGeneration;
      if (!created && entry.refCount === 0) entry.retireGeneration++;
      entry.refCount++;
      operations.push({ material, entry, created, previousRetireGeneration });
    }
    return operations;
  }

  private retire(material: StandardShadeMaterial, entry: ResidentMaterial, generation: number): void {
    if (this.destroyed || entry.refCount !== 0 || entry.retireGeneration !== generation) return;
    if (this.resident.get(material) !== entry) return;
    this.resident.delete(material);
    this.freeSlots.push(entry.slot);
  }
}

function countMaterials(materials: readonly StandardShadeMaterial[]): Map<StandardShadeMaterial, number> {
  const counts = new Map<StandardShadeMaterial, number>();
  for (const material of materials) counts.set(material, (counts.get(material) ?? 0) + 1);
  return counts;
}

function writeSet(set: Set<number>, value: number, present: boolean): void {
  if (present) set.add(value);
  else set.delete(value);
}
