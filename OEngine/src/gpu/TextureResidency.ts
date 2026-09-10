import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { TextureFilterType } from "../texture/TextureFilterType.js";
import type { CachedRenderPipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  GPU_TEXTURE_BANK_COUNT,
  GPU_TEXTURE_BANK_MAX_CAPACITIES,
  GPU_TEXTURE_BANK_SIZES,
  encodeGpuTextureRef
} from "./GpuTextureRefAbi.js";
import {
  decodeTextureHandle,
  encodeTextureHandle,
  nextTextureHandleGeneration
} from "./TextureHandleAbi.js";
import {
  estimateTextureBytes,
  type ResourceHandle as AccountingResourceHandle
} from "../debug/profiling/ResourceAccounting.js";

export const TEXTURE_RESIDENCY_BASE_SIZE = GPU_TEXTURE_BANK_SIZES[0];
export const TEXTURE_RESIDENCY_BASE_CAPACITY = GPU_TEXTURE_BANK_MAX_CAPACITIES[0];
export const TEXTURE_RESIDENCY_BASE_MIP_COUNT = mipCount(TEXTURE_RESIDENCY_BASE_SIZE);
export const TEXTURE_RESIDENCY_MAX_SIZE = GPU_TEXTURE_BANK_SIZES[GPU_TEXTURE_BANK_COUNT - 1]!;
export const TEXTURE_RESIDENCY_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export interface TextureResidencyBindings {
  readonly textureCapacity: number;
  /** Five explicit WebGPU bindings, not a binding array. */
  readonly textureBanks: readonly [GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView];
}

export interface TextureResidencyStage {
  readonly bindings: TextureResidencyBindings;
  /** Stable logical slot+generation identity. Never encodes a physical bank/layer. */
  readonly textureRefs: ReadonlyMap<ShadeTexture, number>;
  /** Derived GPU routing published in the same stage transaction as textureRefs. */
  readonly textureRoutingRefs: ReadonlyMap<ShadeTexture, number>;
}

export interface TextureResidencyDescriptor {
  readonly slot: number;
  readonly generation: number;
  readonly formatClass: "rgba8";
  readonly sizeClass: number;
  readonly segment: number;
  readonly layer: number;
  readonly logicalSize: readonly [number, number];
  readonly uvScaleBias: readonly [number, number, number, number];
  readonly residentMipRange: readonly [number, number];
}

export interface TextureBankEvidence {
  readonly segment: number;
  readonly bankClass: number;
  /** Logical size class encoded by TextureRef. */
  readonly size: number;
  /** Allocated resolution after the configured quality/device cap. */
  readonly physicalSize: number;
  readonly maxCapacity: number;
  readonly allocatedCapacity: number;
  readonly residentTextureCount: number;
  readonly retiringTextureCount: number;
  readonly freeLayerCount: number;
  readonly allocatedBytes: number;
}

export interface TextureResidencyEvidence {
  readonly schemaVersion: 3;
  readonly textureCapacity: number;
  readonly residentTextureCount: number;
  readonly retiringTextureCount: number;
  readonly allocatedBytes: number;
  readonly allocatedPeakBytes: number;
  readonly residentTextureBytes: number;
  readonly retiringTextureBytes: number;
  readonly bankGrowCount: number;
  readonly abortedBankGrowCount: number;
  readonly resizeDispatchCount: number;
  readonly runtimeMipGenerationCount: number;
  readonly bankCopyOperationCount: number;
  readonly segmentCount: number;
  readonly bindingSetCount: number;
  readonly bindingSlotUtilization: number;
  readonly bindingSetPreflightFailures: number;
  readonly highResolutionArrayAllocated: boolean;
  readonly banks: readonly TextureBankEvidence[];
  readonly privateSubmitCount: 0;
}

interface TextureBank {
  /** Fixed shader binding slot; bankClass is the logical size class currently assigned. */
  readonly bindingSlot: number;
  bankClass: number;
  size: number;
  physicalSize: number;
  mipLevelCount: number;
  maxCapacity: number;
  capacity: number;
  descriptor: GPUTextureDescriptor;
  texture: GPUTexture | null;
  view: GPUTextureView | null;
  accounting: AccountingResourceHandle | null;
  freeLayers: number[];
}

interface ResidentTexture {
  readonly slot: number;
  readonly generation: number;
  readonly layer: number;
  readonly segment: number;
  readonly bankClass: number;
  readonly source: ShadeTexture;
  refCount: number;
  retireGeneration: number;
}

interface ResidentMaterialTextures {
  refCount: number;
  retireGeneration: number;
  textures: ResidentTexture[];
}

interface TextureRetainOperation {
  readonly entry: ResidentTexture;
  readonly created: boolean;
  readonly previousRetireGeneration: number;
}

interface MaterialRetainOperation {
  readonly material: StandardShadeMaterial;
  readonly entry: ResidentMaterialTextures;
  readonly created: boolean;
  readonly previousRetireGeneration: number;
}

interface TextureTransition {
  readonly material: ResidentMaterialTextures;
  readonly previous: readonly ResidentTexture[];
  readonly added: readonly TextureRetainOperation[];
  readonly removed: readonly ResidentTexture[];
}

interface BankGrowthPlan {
  readonly bank: TextureBank;
  readonly bankClass: number;
  readonly logicalSize: number;
  readonly physicalSize: number;
  readonly nextCapacity: number;
}

interface BankGrowth {
  readonly bank: TextureBank;
  readonly previousBankClass: number;
  readonly previousSize: number;
  readonly previousPhysicalSize: number;
  readonly previousMipLevelCount: number;
  readonly previousMaxCapacity: number;
  readonly previousCapacity: number;
  readonly previousDescriptor: GPUTextureDescriptor;
  readonly previousTexture: GPUTexture | null;
  readonly previousView: GPUTextureView | null;
  readonly previousAccounting: AccountingResourceHandle | null;
  readonly previousFreeLayers: readonly number[];
  readonly nextTexture: GPUTexture;
  readonly nextAccounting: AccountingResourceHandle | undefined;
}

/** Immutable bounded segments with stable logical handles and derived GPU routing. */
export class TextureResidency {
  private readonly banks: readonly TextureBank[];
  private readonly textures = new Map<ShadeTexture, ResidentTexture>();
  private readonly materials = new Map<StandardShadeMaterial, ResidentMaterialTextures>();
  private readonly descriptors = new Map<number, TextureResidencyDescriptor>();
  private readonly freeDescriptorSlots: number[] = [];
  private readonly descriptorGenerations: number[] = [0];
  private resizePipeline: GPURenderPipeline | null = null;
  private allocatedPeakBytes = 0;
  private bankGrowCount = 0;
  private abortedBankGrowCount = 0;
  private resizeDispatchCount = 0;
  private runtimeMipGenerationCount = 0;
  private bankCopyOperationCount = 0;
  private bindingSetPreflightFailures = 0;
  private destroyed = false;

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly highResolutionMaxSize: number = TEXTURE_RESIDENCY_MAX_SIZE
  ) {
    if (!(GPU_TEXTURE_BANK_SIZES as readonly number[]).includes(highResolutionMaxSize)) {
      throw new RangeError("TextureResidency highResolutionMaxSize must be a supported size class");
    }
    const limits = graphics.device.limits;
    const deviceMaxSize = Number(limits.maxTextureDimension2D);
    this.banks = GPU_TEXTURE_BANK_SIZES.map((size, bindingSlot): TextureBank => {
      const physicalSize = Math.min(size, highResolutionMaxSize, deviceMaxSize);
      return {
        bindingSlot,
        bankClass: bindingSlot,
        size,
        physicalSize,
        mipLevelCount: mipCount(physicalSize),
        maxCapacity: Math.min(GPU_TEXTURE_BANK_MAX_CAPACITIES[bindingSlot]!, Number(limits.maxTextureArrayLayers)),
        capacity: 0,
        descriptor: bankDescriptor(bankClass, size, physicalSize, 1),
        texture: null,
        view: null,
        accounting: null,
        freeLayers: []
      };
    });
    const base = this.banks[0]!;
    if (base.maxCapacity < TEXTURE_RESIDENCY_BASE_CAPACITY) {
      throw new RangeError(`TextureResidency base bank requires ${TEXTURE_RESIDENCY_BASE_CAPACITY} layers but the device permits ${base.maxCapacity}`);
    }
    this.allocateInitialBase(base);
    for (let slot = this.logicalCapacity(); slot >= 1; slot--) {
      this.freeDescriptorSlots.push(slot);
      this.descriptorGenerations[slot] = 1;
    }
    this.allocatedPeakBytes = this.allocatedBytes();
  }

  stage(materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext): TextureResidencyStage {
    const growths = this.applyGrowthPlans(this.preflight(materials), command);
    const materialOperations = this.retainMaterials(materials);
    const transitions: TextureTransition[] = [];
    const newTextures: ResidentTexture[] = [];
    let settled = false;
    const rollback = (): void => {
      if (settled) return;
      settled = true;
      for (let index = transitions.length - 1; index >= 0; index--) {
        const transition = transitions[index]!;
        transition.material.textures = [...transition.previous];
        for (let add = transition.added.length - 1; add >= 0; add--) this.rollbackTextureRetain(transition.added[add]!);
      }
      for (let index = materialOperations.length - 1; index >= 0; index--) {
        const operation = materialOperations[index]!;
        operation.entry.refCount--;
        operation.entry.retireGeneration = operation.previousRetireGeneration;
        if (operation.created && operation.entry.refCount === 0 && this.materials.get(operation.material) === operation.entry) {
          this.materials.delete(operation.material);
        }
      }
      this.rollbackGrowths(growths);
    };
    command.onAborted.addOne(rollback);
    try {
      const transitioned = new Set<ResidentMaterialTextures>();
      for (let index = 0; index < materials.length; index++) {
        const resident = materialOperations[index]!.entry;
        if (transitioned.has(resident)) continue;
        transitioned.add(resident);
        const transition = this.transition(resident, materials[index]!);
        transitions.push(transition);
        for (const operation of transition.added) if (operation.created) newTextures.push(operation.entry);
      }
      this.graphics.textures.mipmaps.flush(command);
      for (const texture of newTextures) this.encodeResizeCopy(command, texture);
      for (const bankClass of new Set(newTextures.map((entry) => entry.bankClass))) {
        const bank = this.banks[bankClass]!;
        this.graphics.textures.mipmaps.generateMipmap(requireBankTexture(bank), bank.descriptor, TextureFilterType.Linear, command);
        this.runtimeMipGenerationCount++;
      }
      command.onFinished.addOne(() => {
        if (settled) return;
        settled = true;
        for (const transition of transitions) this.releaseTextureRefs(transition.removed, command.gpuDone);
        this.commitGrowths(growths, command.gpuDone);
      });
      return Object.freeze({
        bindings: this.bindings(),
        textureRefs: this.textureRefs(),
        textureRoutingRefs: this.textureRoutingRefs()
      });
    } catch (error) {
      rollback();
      throw error;
    }
  }

  release(materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext): void {
    const counts = countMaterials(materials);
    for (const [material, count] of counts) {
      const entry = this.materials.get(material);
      if (entry === undefined || entry.refCount < count) {
        throw new Error(`TextureResidency has no matching material reference for '${material.name}'`);
      }
    }
    command.onFinished.addOne(() => {
      for (const [material, count] of counts) {
        const entry = this.materials.get(material);
        if (entry === undefined) continue;
        entry.refCount -= count;
        if (entry.refCount !== 0) continue;
        const generation = ++entry.retireGeneration;
        const textures = entry.textures;
        entry.textures = [];
        this.releaseTextureRefs(textures, command.gpuDone);
        const retire = (): void => {
          if (this.destroyed || entry.refCount !== 0 || entry.retireGeneration !== generation) return;
          if (this.materials.get(material) === entry) this.materials.delete(material);
        };
        void command.gpuDone.then(retire, retire);
      }
    });
  }

  bindings(): TextureResidencyBindings {
    const fallback = this.banks[0]!.view!;
    const views = this.banks.map((bank) => bank.view ?? fallback) as unknown as TextureResidencyBindings["textureBanks"];
    return Object.freeze({
      textureCapacity: this.logicalCapacity(),
      textureBanks: Object.freeze(views)
    });
  }

  descriptor(handleValue: number): TextureResidencyDescriptor | null {
    const handle = decodeTextureHandle(handleValue);
    if (handle === null) return null;
    const descriptor = this.descriptors.get(handle.slot);
    if (descriptor === undefined || descriptor.generation !== handle.generation) return null;
    return descriptor;
  }

  evidence(): TextureResidencyEvidence {
    const counts = this.banks.map(() => ({ resident: 0, retiring: 0 }));
    let residentTextureCount = 0;
    let retiringTextureCount = 0;
    let residentTextureBytes = 0;
    let retiringTextureBytes = 0;
    for (const entry of this.textures.values()) {
      const bytes = arrayBytes(this.banks[entry.bankClass]!.size, 1);
      if (entry.refCount > 0) {
        residentTextureCount++;
        residentTextureBytes += bytes;
        counts[entry.segment]!.resident++;
      } else {
        retiringTextureCount++;
        retiringTextureBytes += bytes;
        counts[entry.segment]!.retiring++;
      }
    }
    const banks = this.banks.map((bank): TextureBankEvidence => Object.freeze({
      segment: bank.bindingSlot,
      bankClass: bank.bankClass,
      size: bank.size,
      physicalSize: bank.physicalSize,
      maxCapacity: bank.maxCapacity,
      allocatedCapacity: bank.capacity,
      residentTextureCount: counts[bank.bindingSlot]!.resident,
      retiringTextureCount: counts[bank.bindingSlot]!.retiring,
      freeLayerCount: bank.freeLayers.length,
      allocatedBytes: arrayBytes(bank.physicalSize, bank.capacity)
    }));
    return Object.freeze({
      schemaVersion: 3,
      textureCapacity: this.logicalCapacity(),
      residentTextureCount,
      retiringTextureCount,
      allocatedBytes: this.allocatedBytes(),
      allocatedPeakBytes: this.allocatedPeakBytes,
      residentTextureBytes,
      retiringTextureBytes,
      bankGrowCount: this.bankGrowCount,
      abortedBankGrowCount: this.abortedBankGrowCount,
      resizeDispatchCount: this.resizeDispatchCount,
      runtimeMipGenerationCount: this.runtimeMipGenerationCount,
      bankCopyOperationCount: this.bankCopyOperationCount,
      segmentCount: this.banks.filter((bank) => bank.texture !== null).length,
      bindingSetCount: 1,
      bindingSlotUtilization: this.banks.filter((bank) => bank.texture !== null).length / GPU_TEXTURE_BANK_COUNT,
      bindingSetPreflightFailures: this.bindingSetPreflightFailures,
      highResolutionArrayAllocated: this.banks.slice(1).some((bank) => bank.texture !== null),
      banks: Object.freeze(banks),
      privateSubmitCount: 0
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const bank of this.banks) {
      bank.texture?.destroy();
      if (bank.accounting !== null) this.graphics.resource_accounting?.destroyed(bank.accounting);
      bank.texture = null;
      bank.view = null;
      bank.accounting = null;
      bank.capacity = 0;
      bank.freeLayers.length = 0;
    }
    this.textures.clear();
    this.materials.clear();
    this.descriptors.clear();
    this.freeDescriptorSlots.length = 0;
    this.resizePipeline = null;
  }

  private preflight(materials: readonly StandardShadeMaterial[]): readonly BankGrowthPlan[] {
    const freshByBank = this.banks.map(() => new Set<ShadeTexture>());
    for (const material of materials) {
      for (const texture of material.textures) {
        if (!canStageTexture(texture) || this.textures.has(texture)) continue;
        freshByBank[textureBankClass(texture)]!.add(texture);
      }
    }
    const plans: BankGrowthPlan[] = [];
    for (const bank of this.banks) {
      const freshCount = freshByBank[bank.bankClass]!.size;
      if (freshCount === 0) continue;
      const occupied = Math.max(0, bank.capacity - 1 - bank.freeLayers.length);
      const exactCapacity = occupied + freshCount + 1;
      if (bank.maxCapacity === 0 || exactCapacity > bank.maxCapacity) {
        this.bindingSetPreflightFailures++;
        throw new RangeError(`TextureResidency ${bank.size}px bank requires ${exactCapacity} layers but policy/device permits ${bank.maxCapacity}`);
      }
      // Each size-class slot owns one immutable segment. Allocate its final bounded
      // capacity once; future loads only consume layers and never relocate it.
      if (bank.texture === null) plans.push({ bank, nextCapacity: bank.maxCapacity });
    }
    const transactionPeakBytes = this.allocatedBytes() + plans.reduce(
      (sum, plan) => sum + arrayBytes(plan.bank.physicalSize, plan.nextCapacity),
      0
    );
    if (transactionPeakBytes > TEXTURE_RESIDENCY_BUDGET_BYTES) {
      throw new RangeError(
        `TextureResidency transaction peak ${transactionPeakBytes} bytes exceeds the ${TEXTURE_RESIDENCY_BUDGET_BYTES} byte budget`
      );
    }
    return plans;
  }

  private applyGrowthPlans(plans: readonly BankGrowthPlan[], command: ShadeGPUCommandContext): BankGrowth[] {
    const growths: BankGrowth[] = [];
    try {
      for (const plan of plans) growths.push(this.growBank(plan.bank, plan.nextCapacity, command));
      return growths;
    } catch (error) {
      this.rollbackGrowths(growths);
      throw error;
    }
  }

  private growBank(bank: TextureBank, nextCapacity: number, _command: ShadeGPUCommandContext): BankGrowth {
    const descriptor = bankDescriptor(bank.bankClass, bank.size, bank.physicalSize, nextCapacity);
    const nextTexture = this.graphics.device.createTexture(descriptor);
    const nextAccounting = this.graphics.resource_accounting?.created({
      kind: "texture",
      category: "resident",
      owner: `TextureResidency/bank-${bank.size}`,
      bytes: arrayBytes(bank.physicalSize, nextCapacity),
      label: descriptor.label
    });
    const growth: BankGrowth = {
      bank,
      previousCapacity: bank.capacity,
      previousDescriptor: bank.descriptor,
      previousTexture: bank.texture,
      previousView: bank.view,
      previousAccounting: bank.accounting,
      previousFreeLayers: [...bank.freeLayers],
      nextTexture,
      nextAccounting
    };
    if (bank.texture !== null) throw new Error(`TextureResidency ${bank.size}px immutable segment cannot grow`);
    for (let layer = nextCapacity - 1; layer >= Math.max(1, bank.capacity); layer--) bank.freeLayers.push(layer);
    bank.capacity = nextCapacity;
    bank.descriptor = descriptor;
    bank.texture = nextTexture;
    bank.view = nextTexture.createView({ dimension: "2d-array" });
    bank.accounting = nextAccounting ?? null;
    this.bankGrowCount++;
    this.allocatedPeakBytes = Math.max(
      this.allocatedPeakBytes,
      this.allocatedBytes()
    );
    return growth;
  }

  private rollbackGrowths(growths: readonly BankGrowth[]): void {
    for (let index = growths.length - 1; index >= 0; index--) {
      const growth = growths[index]!;
      const bank = growth.bank;
      growth.nextTexture.destroy();
      if (growth.nextAccounting !== undefined) this.graphics.resource_accounting?.destroyed(growth.nextAccounting);
      bank.capacity = growth.previousCapacity;
      bank.descriptor = growth.previousDescriptor;
      bank.texture = growth.previousTexture;
      bank.view = growth.previousView;
      bank.accounting = growth.previousAccounting;
      bank.freeLayers = [...growth.previousFreeLayers];
      this.abortedBankGrowCount++;
    }
  }

  private commitGrowths(growths: readonly BankGrowth[], gpuDone: Promise<void>): void {
    for (const growth of growths) {
      if (growth.previousTexture === null) continue;
      const retire = (): void => {
        growth.previousTexture!.destroy();
        if (growth.previousAccounting !== null) this.graphics.resource_accounting?.destroyed(growth.previousAccounting);
      };
      void gpuDone.then(retire, retire);
    }
  }

  private allocateInitialBase(bank: TextureBank): void {
    bank.capacity = TEXTURE_RESIDENCY_BASE_CAPACITY;
    bank.descriptor = bankDescriptor(bank.bankClass, bank.size, bank.physicalSize, bank.capacity);
    bank.texture = this.graphics.device.createTexture(bank.descriptor);
    bank.view = bank.texture.createView({ dimension: "2d-array" });
    bank.accounting = this.graphics.resource_accounting?.created({
      kind: "texture",
      category: "resident",
      owner: `TextureResidency/bank-${bank.size}`,
      bytes: arrayBytes(bank.physicalSize, bank.capacity),
      label: bank.descriptor.label
    }) ?? null;
    for (let layer = bank.capacity - 1; layer >= 1; layer--) bank.freeLayers.push(layer);
  }

  private retainMaterials(materials: readonly StandardShadeMaterial[]): MaterialRetainOperation[] {
    const result: MaterialRetainOperation[] = [];
    for (const material of materials) {
      let entry = this.materials.get(material);
      let created = false;
      if (entry === undefined) {
        entry = { refCount: 0, retireGeneration: 0, textures: [] };
        this.materials.set(material, entry);
        created = true;
      }
      const previousRetireGeneration = entry.retireGeneration;
      if (!created && entry.refCount === 0) entry.retireGeneration++;
      entry.refCount++;
      result.push({ material, entry, created, previousRetireGeneration });
    }
    return result;
  }

  private transition(resident: ResidentMaterialTextures, material: StandardShadeMaterial): TextureTransition {
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
      if (operation !== null) {
        next.push(operation.entry);
        added.push(operation);
      }
    }
    const removed = previous.filter(({ source }) => !desiredSet.has(source));
    resident.textures = next;
    return { material: resident, previous, added, removed };
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
      const bankClass = textureBankClass(texture);
      const bank = this.banks[bankClass]!;
      const layer = bank.freeLayers.pop();
      if (layer === undefined) throw new RangeError(`TextureResidency ${bank.size}px bank layer overflow`);
      const slot = this.freeDescriptorSlots.pop();
      if (slot === undefined) throw new RangeError("TextureResidency logical descriptor slot overflow");
      const generation = this.descriptorGenerations[slot] ?? 1;
      entry = { slot, generation, layer, bankClass, source: texture, refCount: 0, retireGeneration: 0 };
      this.textures.set(texture, entry);
      this.descriptors.set(slot, createDescriptor(entry, bank));
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
    this.descriptors.delete(entry.slot);
    this.freeDescriptorSlots.push(entry.slot);
    this.banks[entry.bankClass]!.freeLayers.push(entry.layer);
  }

  private releaseTextureRefs(textures: readonly ResidentTexture[], gpuDone: Promise<void>): void {
    for (const entry of textures) {
      entry.refCount--;
      if (entry.refCount < 0) throw new Error("TextureResidency refcount underflow");
      if (entry.refCount !== 0) continue;
      const generation = ++entry.retireGeneration;
      const retire = (): void => {
        if (this.destroyed || entry.refCount !== 0 || entry.retireGeneration !== generation) return;
        if (this.textures.get(entry.source) !== entry) return;
        this.textures.delete(entry.source);
        this.descriptors.delete(entry.slot);
        this.descriptorGenerations[entry.slot] = nextTextureHandleGeneration(entry.generation);
        this.freeDescriptorSlots.push(entry.slot);
        this.banks[entry.bankClass]!.freeLayers.push(entry.layer);
      };
      void gpuDone.then(retire, retire);
    }
  }

  private textureRefs(): ReadonlyMap<ShadeTexture, number> {
    const refs = new Map<ShadeTexture, number>();
    for (const entry of this.textures.values()) {
      if (entry.refCount > 0) refs.set(entry.source, encodeTextureHandle(entry.slot, entry.generation));
    }
    return refs;
  }

  private textureRoutingRefs(): ReadonlyMap<ShadeTexture, number> {
    const refs = new Map<ShadeTexture, number>();
    for (const entry of this.textures.values()) {
      if (entry.refCount > 0) refs.set(entry.source, encodeGpuTextureRef(entry.bankClass, entry.layer));
    }
    return refs;
  }

  private encodeResizeCopy(command: ShadeGPUCommandContext, entry: ResidentTexture): void {
    const source = this.graphics.textures.obtain(entry.source);
    const bank = this.banks[entry.bankClass]!;
    const target = requireBankTexture(bank);
    const sourceMip = Math.max(0, Math.floor(Math.min(
      Math.log2(source.width / bank.physicalSize), Math.log2(source.height / bank.physicalSize)
    )));
    const sourceWidth = Math.max(1, source.width >> sourceMip);
    const sourceHeight = Math.max(1, source.height >> sourceMip);
    const clip = new Uint32Array([0, 0, sourceWidth, sourceHeight]);
    const clipBuffer = command.allocateTransientBufferAndLoad(clip.buffer, GPUBufferUsage.UNIFORM);
    const bindGroup = this.graphics.bind_groups.obtain({
      layout: RESIZE_COPY_GROUP_LAYOUT,
      entries: [source.obtainView({ baseMipLevel: sourceMip, mipLevelCount: 1 }), { buffer: clipBuffer }]
    });
    const pass = command.beginRenderPass({
      label: `TextureResidency/upload-${bank.size}-layer`,
      colorAttachments: [{
        view: target.createView({
          dimension: "2d", baseMipLevel: 0, mipLevelCount: 1,
          baseArrayLayer: entry.layer, arrayLayerCount: 1
        }),
        loadOp: "load",
        storeOp: "store"
      }]
    });
    pass.setViewport(0, 0, bank.physicalSize, bank.physicalSize, 0, 1);
    pass.setPipeline(this.resizePipeline ??= this.graphics.render_pipelines.obtain(RESIZE_COPY_PIPELINE));
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    this.resizeDispatchCount++;
  }

  private allocatedBytes(): number {
    return this.banks.reduce((sum, bank) => sum + arrayBytes(bank.physicalSize, bank.capacity), 0);
  }

  private logicalCapacity(): number {
    return this.banks.reduce((sum, bank) => sum + Math.max(0, bank.maxCapacity - 1), 0);
  }
}

const RESIZE_COPY_VERTEX_WGSL = /* wgsl */ `
const positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
struct Output { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn main(@builtin(vertex_index) vertex_index: u32) -> Output {
  let ndc = positions[vertex_index];
  return Output(vec4f(ndc, 0.0, 1.0), fma(ndc, vec2f(0.5, -0.5), vec2f(0.5)));
}`;

const RESIZE_COPY_FRAGMENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> source_clip: vec4u;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = max(source_clip.zw, vec2u(1u));
  let pixel = min(vec2u(uv * vec2f(size)), size - vec2u(1u));
  return textureLoad(source, vec2i(source_clip.xy + pixel), 0);
}`;

const RESIZE_COPY_GROUP_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "TextureResidency/upload-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
  ]
};

const RESIZE_COPY_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "TextureResidency/upload",
  layout: { label: "TextureResidency/upload-pipeline-layout", bindGroupLayouts: [RESIZE_COPY_GROUP_LAYOUT] },
  vertex: { module: { label: "TextureResidency/upload-vs", code: RESIZE_COPY_VERTEX_WGSL }, entryPoint: "main", buffers: [] },
  fragment: {
    module: { label: "TextureResidency/upload-fs", code: RESIZE_COPY_FRAGMENT_WGSL },
    entryPoint: "main",
    targets: [{ format: "rgba8unorm" }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  multisample: {}
};

function bankDescriptor(bankClass: number, logicalSize: number, physicalSize: number, capacity: number): GPUTextureDescriptor {
  return {
    label: `TextureResidency/bank-${bankClass}-${logicalSize}-physical-${physicalSize}`,
    size: [physicalSize, physicalSize, capacity],
    format: "rgba8unorm",
    mipLevelCount: mipCount(physicalSize),
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
  };
}

function requireBankTexture(bank: TextureBank): GPUTexture {
  if (bank.texture === null) throw new Error(`TextureResidency ${bank.size}px bank was not preflighted`);
  return bank.texture;
}

function createDescriptor(
  entry: ResidentTexture,
  bank: TextureBank
): TextureResidencyDescriptor {
  const image = entry.source.image!;
  return Object.freeze({
    slot: entry.slot,
    generation: entry.generation,
    formatClass: "rgba8",
    sizeClass: entry.bankClass,
    segment: 0,
    layer: entry.layer,
    logicalSize: Object.freeze([image.width, image.height]) as readonly [number, number],
    uvScaleBias: Object.freeze([
      image.width / bank.physicalSize,
      image.height / bank.physicalSize,
      0,
      0
    ]) as readonly [number, number, number, number],
    residentMipRange: Object.freeze([0, bank.mipLevelCount - 1]) as readonly [number, number]
  });
}

function canStageTexture(texture: ShadeTexture): boolean {
  const image = texture.image;
  return image !== undefined && image.width > 0 && image.height > 0 && image.depth <= 1;
}

function textureBankClass(texture: ShadeTexture): number {
  const image = texture.image;
  if (image === undefined) return 0;
  const required = Math.min(TEXTURE_RESIDENCY_MAX_SIZE, nextPowerOfTwo(Math.max(image.width, image.height)));
  const bankClass = GPU_TEXTURE_BANK_SIZES.findIndex((size) => size >= required);
  if (bankClass < 0) throw new RangeError(`Texture ${image.width}x${image.height} exceeds the texture residency policy`);
  return bankClass;
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

function mipCount(size: number): number {
  return Math.floor(Math.log2(size)) + 1;
}

function arrayBytes(size: number, capacity: number): number {
  if (capacity === 0) return 0;
  return estimateTextureBytes({
    format: "rgba8unorm",
    width: size,
    height: size,
    depthOrArrayLayers: capacity,
    mipLevelCount: mipCount(size)
  });
}

function countMaterials(materials: readonly StandardShadeMaterial[]): Map<StandardShadeMaterial, number> {
  const counts = new Map<StandardShadeMaterial, number>();
  for (const material of materials) counts.set(material, (counts.get(material) ?? 0) + 1);
  return counts;
}
