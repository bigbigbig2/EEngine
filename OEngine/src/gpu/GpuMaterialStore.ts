import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import {
  GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
  materialVisibilitySource
} from "./GpuMaterialVisibilityAbi.js";
import {
  GPU_SHADING_MATERIAL_ABI_VERSION,
  GPU_SHADING_MATERIAL_RECORD_STRIDE,
  GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL,
  GPU_SHADING_TEXTURE_ROUTE_STRIDE,
  packGpuShadingMaterialRecord,
  packGpuShadingTextureRoute
} from "./GpuShadingMaterialAbi.js";

declare const GPU_MATERIAL_STAGE_HANDLE_BRAND: unique symbol;

/**
 * The previous capacity promised 4096 material dictionary entries. An unlit
 * material can legally require two association records (color/no-color), so
 * the association table preserves that promise with two slots per entry.
 */
export const GPU_MATERIAL_DICTIONARY_CAPACITY = 4096;
export const GPU_MATERIAL_CAPACITY = GPU_MATERIAL_DICTIONARY_CAPACITY * 2;

export interface GpuMaterialStageHandle {
  readonly [GPU_MATERIAL_STAGE_HANDLE_BRAND]: true;
}

export interface GpuMaterialBindings {
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly materialRecords: GPUBuffer;
  readonly textureRouteRecords: GPUBuffer;
}

/** One immutable material × geometry-program association to publish. */
export interface GpuMaterialAssociationSource {
  readonly material: StandardShadeMaterial;
  readonly programId: number;
  readonly textureBindingSetId: number;
}

export interface GpuMaterialStage {
  readonly handle: GpuMaterialStageHandle;
  readonly bindings: GpuMaterialBindings;
  /** GPU slots in exactly the same order as the staged association sources. */
  readonly associationSlots: readonly number[];
  readonly materialGeneration: number;
  readonly textureGeneration: number;
  readonly publicationRevision: number;
}

export interface GpuMaterialStoreEvidence {
  readonly schemaVersion: 2;
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly residentPublicationCount: number;
  readonly retiringPublicationCount: number;
  readonly residentMaterialSlotCount: number;
  readonly retiringMaterialSlotCount: number;
  readonly freeMaterialSlotCount: number;
  readonly textureFallbackCount: number;
  readonly samplerFallbackCount: number;
  readonly allocatedBytes: number;
  readonly privateSubmitCount: 0;
}

interface ResidentPublication {
  readonly handle: GpuMaterialStageHandle;
  readonly slots: readonly number[];
  readonly generation: number;
  state: "pending" | "resident" | "pending-release" | "retiring" | "aborted" | "released";
}

const STAGE_RUNTIME = new WeakMap<object, {
  readonly store: GpuMaterialStore;
  readonly publication: ResidentPublication;
}>();

/**
 * Unique owner for the production shading-material table and texture-routing
 * table. Slots belong to one immutable RenderWorld publication instead of to
 * a StandardShadeMaterial object: ShadingProgramId is an association property,
 * so material-only deduplication is not a valid GPU identity.
 */
export class GpuMaterialStore {
  private readonly materialRecords: GPUBuffer;
  private readonly textureRouteRecords: GPUBuffer;
  private readonly freeSlots: number[] = [];
  private readonly publications = new Set<ResidentPublication>();
  private readonly textureFallbackSlots = new Set<number>();
  private readonly samplerFallbackSlots = new Set<number>();
  private committedGeneration = 0;
  private pendingPublication: ResidentPublication | null = null;
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    const materialBytes = GPU_MATERIAL_CAPACITY * GPU_SHADING_MATERIAL_RECORD_STRIDE;
    const routeBytes = GPU_MATERIAL_CAPACITY * GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL *
      GPU_SHADING_TEXTURE_ROUTE_STRIDE;
    const storageLimit = Math.min(
      Number(device.limits.maxBufferSize),
      Number(device.limits.maxStorageBufferBindingSize)
    );
    if (materialBytes > storageLimit || routeBytes > storageLimit) {
      throw new RangeError(
        `GpuMaterialStore requires ${materialBytes} material bytes and ${routeBytes} route bytes ` +
        `but the storage-buffer limit is ${storageLimit}`
      );
    }
    this.materialRecords = createZeroBuffer(device, "GpuMaterialStore/shading-records", materialBytes);
    this.textureRouteRecords = createZeroBuffer(device, "GpuMaterialStore/texture-routes", routeBytes);
    for (let slot = GPU_MATERIAL_CAPACITY - 1; slot >= 0; slot--) this.freeSlots.push(slot);
  }

  stage(
    associations: readonly GpuMaterialAssociationSource[],
    textureRefsByMaterial: ReadonlyMap<StandardShadeMaterial, ReadonlyMap<ShadeTexture, number>>,
    command: ShadeGPUCommandContext
  ): GpuMaterialStage {
    this.assertStageCommand(command);
    this.preflight(associations, textureRefsByMaterial);
    const generation = nextGeneration(this.committedGeneration);
    const slots = Object.freeze(associations.map(() => this.freeSlots.pop()!));
    const handle = Object.freeze({}) as GpuMaterialStageHandle;
    const publication: ResidentPublication = {
      handle,
      slots,
      generation,
      state: "pending"
    };
    this.pendingPublication = publication;
    this.publications.add(publication);
    STAGE_RUNTIME.set(handle as object, { store: this, publication });

    let rolledBack = false;
    const rollback = (): void => {
      if (rolledBack || publication.state !== "pending") return;
      rolledBack = true;
      publication.state = "aborted";
      for (const slot of slots) {
        this.textureFallbackSlots.delete(slot);
        this.samplerFallbackSlots.delete(slot);
        this.freeSlots.push(slot);
      }
      this.publications.delete(publication);
      STAGE_RUNTIME.delete(handle as object);
      if (this.pendingPublication === publication) this.pendingPublication = null;
    };
    command.onAborted.addOne(rollback);

    try {
      for (let index = 0; index < associations.length; index++) {
        const association = associations[index]!;
        const slot = slots[index]!;
        const textureRefs = textureRefsByMaterial.get(association.material)!;
        const textureRef = (texture: ShadeTexture | undefined): number =>
          texture === undefined
            ? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
            : textureRefs.get(texture) ?? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
        const source = materialVisibilitySource(association.material, {
          baseColor: textureRef(association.material.texture_albedo),
          normal: textureRef(association.material.texture_normal),
          orm: textureRef(association.material.texture_orm),
          emissive: textureRef(association.material.texture_emissive),
          occlusion: textureRef(association.material.texture_occlusion)
        }, slot, association.textureBindingSetId);
        const packed = packGpuShadingMaterialRecord({
          programId: association.programId,
          textureBindingSetId: association.textureBindingSetId,
          materialGeneration: generation,
          textureGeneration: generation,
          publicationRevision: generation,
          flags: 0
        }, source.packed);
        command.writeBuffer(
          this.materialRecords,
          slot * GPU_SHADING_MATERIAL_RECORD_STRIDE,
          packed.buffer,
          packed.byteOffset,
          packed.byteLength
        );
        const routeRefs = [
          source.packed.textureRef,
          source.packed.normalTextureRef,
          source.packed.ormTextureRef,
          source.packed.emissiveTextureRef,
          source.packed.occlusionTextureRef
        ];
        for (let routeIndex = 0; routeIndex < routeRefs.length; routeIndex++) {
          const route = packGpuShadingTextureRoute({
            textureRef: routeRefs[routeIndex]!,
            textureGeneration: generation,
            publicationRevision: generation,
            textureBindingSetId: association.textureBindingSetId
          });
          const routeSlot = slot * GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL + routeIndex;
          command.writeBuffer(
            this.textureRouteRecords,
            routeSlot * GPU_SHADING_TEXTURE_ROUTE_STRIDE,
            route.buffer,
            route.byteOffset,
            route.byteLength
          );
        }
        writeSet(this.textureFallbackSlots, slot, source.textureFallback);
        writeSet(this.samplerFallbackSlots, slot, source.samplerFallback);
      }
      command.onFinished.addOne(() => {
        if (publication.state !== "pending") return;
        publication.state = "resident";
        this.committedGeneration = generation;
        if (this.pendingPublication === publication) this.pendingPublication = null;
      });
      return Object.freeze({
        handle,
        bindings: this.bindings(),
        associationSlots: slots,
        materialGeneration: generation,
        textureGeneration: generation,
        publicationRevision: generation
      });
    } catch (error) {
      rollback();
      throw error;
    }
  }

  release(handle: GpuMaterialStageHandle, command: ShadeGPUCommandContext): void {
    this.assertAlive();
    if (command.device !== this.device) {
      throw new Error("GpuMaterialStore release command belongs to another GPUDevice");
    }
    const runtime = STAGE_RUNTIME.get(handle as object);
    if (runtime === undefined || runtime.store !== this ||
        runtime.publication.state !== "resident") {
      throw new Error("GpuMaterialStageHandle is stale or not resident");
    }
    const publication = runtime.publication;
    publication.state = "pending-release";
    command.onAborted.addOne(() => {
      if (publication.state === "pending-release") publication.state = "resident";
    });
    command.onFinished.addOne(() => {
      if (publication.state !== "pending-release") return;
      publication.state = "retiring";
      const retire = (): void => this.retire(publication);
      void command.gpuDone.then(retire, retire);
    });
  }

  bindings(): GpuMaterialBindings {
    this.assertAlive();
    return Object.freeze({
      abiVersion: GPU_SHADING_MATERIAL_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_CAPACITY,
      materialRecords: this.materialRecords,
      textureRouteRecords: this.textureRouteRecords
    });
  }

  evidence(): GpuMaterialStoreEvidence {
    let residentPublicationCount = 0;
    let retiringPublicationCount = 0;
    let residentMaterialSlotCount = 0;
    let retiringMaterialSlotCount = 0;
    for (const publication of this.publications) {
      if (publication.state === "resident" || publication.state === "pending-release") {
        residentPublicationCount++;
        residentMaterialSlotCount += publication.slots.length;
      } else if (publication.state === "retiring") {
        retiringPublicationCount++;
        retiringMaterialSlotCount += publication.slots.length;
      }
    }
    return Object.freeze({
      schemaVersion: 2,
      abiVersion: GPU_SHADING_MATERIAL_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_CAPACITY,
      residentPublicationCount,
      retiringPublicationCount,
      residentMaterialSlotCount,
      retiringMaterialSlotCount,
      freeMaterialSlotCount: this.freeSlots.length,
      textureFallbackCount: this.textureFallbackSlots.size,
      samplerFallbackCount: this.samplerFallbackSlots.size,
      allocatedBytes:
        GPU_MATERIAL_CAPACITY * GPU_SHADING_MATERIAL_RECORD_STRIDE +
        GPU_MATERIAL_CAPACITY * GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL *
          GPU_SHADING_TEXTURE_ROUTE_STRIDE,
      privateSubmitCount: 0
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.materialRecords.destroy();
    this.textureRouteRecords.destroy();
    for (const publication of this.publications) {
      publication.state = "released";
      STAGE_RUNTIME.delete(publication.handle as object);
    }
    this.publications.clear();
    this.freeSlots.length = 0;
    this.textureFallbackSlots.clear();
    this.samplerFallbackSlots.clear();
    this.pendingPublication = null;
  }

  private preflight(
    associations: readonly GpuMaterialAssociationSource[],
    textureRefsByMaterial: ReadonlyMap<StandardShadeMaterial, ReadonlyMap<ShadeTexture, number>>
  ): void {
    if (associations.length === 0) {
      throw new RangeError("GpuMaterialStore requires at least one shading association");
    }
    if (associations.length > this.freeSlots.length) {
      throw new RangeError(
        `GpuMaterialStore requires ${associations.length} association slots but only ` +
        `${this.freeSlots.length} of ${GPU_MATERIAL_CAPACITY} are free`
      );
    }
    for (const association of associations) {
      if (!textureRefsByMaterial.has(association.material)) {
        throw new Error(
          `GpuMaterialStore is missing TextureBindingSet routing for '${association.material.name}'`
        );
      }
      const source = materialVisibilitySource(
        association.material,
        GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
        0,
        association.textureBindingSetId
      );
      // Header validation is deliberately part of preflight, before slots are reserved.
      packGpuShadingMaterialRecord({
        programId: association.programId,
        textureBindingSetId: association.textureBindingSetId,
        materialGeneration: 1,
        textureGeneration: 1,
        publicationRevision: 1,
        flags: 0
      }, source.packed);
    }
  }

  private retire(publication: ResidentPublication): void {
    if (this.destroyed || publication.state !== "retiring") return;
    publication.state = "released";
    for (const slot of publication.slots) {
      this.textureFallbackSlots.delete(slot);
      this.samplerFallbackSlots.delete(slot);
      this.freeSlots.push(slot);
    }
    this.publications.delete(publication);
    STAGE_RUNTIME.delete(publication.handle as object);
  }

  private assertStageCommand(command: ShadeGPUCommandContext): void {
    this.assertAlive();
    if (command.device !== this.device) {
      throw new Error("GpuMaterialStore stage command belongs to another GPUDevice");
    }
    if (this.pendingPublication !== null) {
      throw new Error("GpuMaterialStore already has a pending publication");
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("GpuMaterialStore has been destroyed");
  }
}

function createZeroBuffer(device: GPUDevice, label: string, size: number): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint8Array(buffer.getMappedRange()).fill(0);
  buffer.unmap();
  return buffer;
}

function nextGeneration(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function writeSet(set: Set<number>, value: number, present: boolean): void {
  if (present) set.add(value);
  else set.delete(value);
}
