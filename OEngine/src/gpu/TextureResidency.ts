import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  selectTextureAssetVariantV2,
  stageTextureAssetPackageV2ToLayer,
  type SelectedTextureVariantV2,
  type TextureAssetLayerUploadV2,
  type TextureAssetPackageV2
} from "../assets/TextureAssetPackage.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { TextureFilterType } from "../texture/TextureFilterType.js";
import type { CachedRenderPipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  GPU_TEXTURE_BANK_COUNT,
  GPU_TEXTURE_BANK_MAX_CAPACITIES,
  GPU_TEXTURE_BANK_SIZES,
  GPU_TEXTURE_PACKAGE_BANK_BEGIN,
  GPU_TEXTURE_PACKAGE_BANK_COUNT,
  GPU_TEXTURE_REF_ROUTING,
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
import {
  TEXTURE_BINDING_SET_MAX_RESIDENT_SETS,
  textureBindingSetPolicy
} from "./TextureBindingSetPolicy.js";

export const TEXTURE_RESIDENCY_BASE_SIZE = GPU_TEXTURE_BANK_SIZES[0];
export const TEXTURE_RESIDENCY_BASE_CAPACITY = GPU_TEXTURE_BANK_MAX_CAPACITIES[0];
export const TEXTURE_RESIDENCY_BASE_MIP_COUNT = mipCount(TEXTURE_RESIDENCY_BASE_SIZE);
export const TEXTURE_RESIDENCY_MAX_SIZE = GPU_TEXTURE_BANK_SIZES[GPU_TEXTURE_BANK_SIZES.length - 1]!;
export const TEXTURE_RESIDENCY_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export interface TextureResidencyBindings {
  readonly textureCapacity: number;
  readonly bindingSets: readonly TextureBindingSet[];
}

export interface TextureBindingSet {
  readonly id: number;
  readonly generation: number;
  /** Nine explicit WebGPU bindings, not an unsized binding array. */
  readonly textureBanks: readonly [
    GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView,
    GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView
  ];
  readonly bankDescriptors: readonly TextureBindingSetBankDescriptor[];
}

export interface TextureBindingSetBankDescriptor {
  readonly bindingSlot: number;
  readonly formatClass: GPUTextureFormat;
  readonly sizeClass: number;
  /** Physical package segment id, or -1 for shared uncooked banks/fallback. */
  readonly segment: number;
}

export interface TextureResidencyStage {
  readonly bindings: TextureResidencyBindings;
  readonly materialBindingSetIds: ReadonlyMap<StandardShadeMaterial, number>;
  /** Stable logical slot+generation identity. Never encodes a physical bank/layer. */
  readonly textureRefs: ReadonlyMap<ShadeTexture, number>;
  /** Material-local routing because one physical segment may occupy different set slots. */
  readonly materialTextureRoutingRefs: ReadonlyMap<StandardShadeMaterial, ReadonlyMap<ShadeTexture, number>>;
}

export interface TextureResidencyDescriptor {
  readonly slot: number;
  readonly generation: number;
  readonly formatClass: GPUTextureFormat;
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

export interface TexturePackageSegmentEvidence {
  readonly segment: number;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
  readonly allocatedCapacity: number;
  readonly residentTextureCount: number;
  readonly retiringTextureCount: number;
  readonly freeLayerCount: number;
  readonly allocatedBytes: number;
}

export interface TextureFormatDistributionEvidence {
  readonly format: GPUTextureFormat;
  readonly residentTextureCount: number;
  readonly residentBytes: number;
}

export interface TextureResidencyEvidence {
  readonly schemaVersion: 5;
  readonly textureCapacity: number;
  readonly residentTextureCount: number;
  readonly retiringTextureCount: number;
  readonly allocatedBytes: number;
  readonly allocatedPeakBytes: number;
  readonly residentTextureBytes: number;
  readonly retiringTextureBytes: number;
  /** Logical source texels currently referenced by published materials. */
  readonly logicalResidentBytes: number;
  /** Physical immutable segment allocation, including free/default layers. */
  readonly physicalAllocatedBytes: number;
  readonly retiringBytes: number;
  readonly transactionPeakBytes: number;
  /** Direct package bytes written by the production residency owner. */
  readonly uploadBytes: number;
  readonly copyBytes: 0;
  /** Resident payload bytes produced by the Worker transcode path. */
  readonly transcodeBytes: number;
  readonly directPackageCount: number;
  readonly workerTranscodeCount: number;
  readonly uncompressedFallbackCount: number;
  readonly formatDistribution: readonly TextureFormatDistributionEvidence[];
  readonly bankGrowCount: number;
  readonly abortedBankGrowCount: number;
  readonly resizeDispatchCount: number;
  readonly runtimeMipGenerationCount: number;
  readonly cookedResidentTextureCount: number;
  readonly compressedResidentTextureCount: number;
  readonly cookedRuntimeMipGenerationCount: 0;
  readonly bankCopyOperationCount: number;
  readonly segmentCount: number;
  readonly bindingSetCount: number;
  readonly bindingSlotUtilization: number;
  readonly bindingSetPreflightFailures: number;
  readonly highResolutionArrayAllocated: boolean;
  readonly banks: readonly TextureBankEvidence[];
  readonly packageSegments: readonly TexturePackageSegmentEvidence[];
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

interface TexturePackageSegment {
  readonly id: number;
  key: string | null;
  format: GPUTextureFormat;
  width: number;
  height: number;
  mipLevelCount: number;
  capacity: number;
  texture: GPUTexture | null;
  view: GPUTextureView | null;
  accounting: AccountingResourceHandle | null;
  freeLayers: number[];
}

interface ResidentTextureBindingSet {
  readonly id: number;
  generation: number;
  materialCount: number;
  packageSlots: Array<TexturePackageSegment | null>;
}

interface ResidentTexture {
  readonly slot: number;
  readonly generation: number;
  readonly layer: number;
  readonly segment: number;
  readonly bankClass: number;
  readonly source: ShadeTexture;
  readonly cooked: boolean;
  readonly physicalFormat: GPUTextureFormat;
  readonly preparationPath: "direct-package" | "worker-transcode" | "uncompressed-fallback";
  readonly routing: number;
  readonly residentBytes: number;
  readonly uploadBytes: number;
  refCount: number;
  retireGeneration: number;
}

interface ResidentMaterialTextures {
  refCount: number;
  retireGeneration: number;
  textures: ResidentTexture[];
  bindingSetId: number;
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
  readonly previousBindingSetId: number;
  readonly activated: boolean;
}

interface TextureTransition {
  readonly material: ResidentMaterialTextures;
  readonly previous: readonly ResidentTexture[];
  readonly added: readonly TextureRetainOperation[];
  readonly removed: readonly ResidentTexture[];
}

interface BankGrowthPlan {
  readonly bank: TextureBank;
  readonly nextCapacity: number;
}

interface TexturePackageAssignment {
  readonly segment: TexturePackageSegment;
  readonly asset: TextureAssetPackageV2;
  readonly variant: SelectedTextureVariantV2;
}

interface TexturePackageSegmentPlan {
  readonly segment: TexturePackageSegment;
  readonly key: string;
  readonly variant: SelectedTextureVariantV2;
  readonly freshCount: number;
}

interface TextureBindingSetPlan {
  readonly set: ResidentTextureBindingSet;
  readonly previousGeneration: number;
  readonly previousSlots: readonly (TexturePackageSegment | null)[];
  readonly nextSlots: readonly (TexturePackageSegment | null)[];
}

interface TexturePreflight {
  readonly bankPlans: readonly BankGrowthPlan[];
  readonly packagePlans: readonly TexturePackageSegmentPlan[];
  readonly packageAssignments: ReadonlyMap<ShadeTexture, TexturePackageAssignment>;
  readonly bindingSetPlans: readonly TextureBindingSetPlan[];
  readonly materialBindingSetIds: ReadonlyMap<StandardShadeMaterial, number>;
}

interface TexturePackageSegmentGrowth {
  readonly segment: TexturePackageSegment;
  readonly texture: GPUTexture;
  readonly accounting: AccountingResourceHandle | undefined;
}

interface BankGrowth {
  readonly bank: TextureBank;
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
  private readonly packageSegments: readonly TexturePackageSegment[];
  private readonly bindingSets: readonly ResidentTextureBindingSet[];
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
  private cookedUploadBytes = 0;
  private bankCopyOperationCount = 0;
  private bindingSetPreflightFailures = 0;
  private transactionPeakBytes = 0;
  private destroyed = false;

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly highResolutionMaxSize: number = TEXTURE_RESIDENCY_MAX_SIZE
  ) {
    if (!(GPU_TEXTURE_BANK_SIZES as readonly number[]).includes(highResolutionMaxSize)) {
      throw new RangeError("TextureResidency highResolutionMaxSize must be a supported size class");
    }
    const limits = graphics.device.limits;
    textureBindingSetPolicy(limits);
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
        descriptor: bankDescriptor(bindingSlot, size, physicalSize, 1),
        texture: null,
        view: null,
        accounting: null,
        freeLayers: []
      };
    });
    this.packageSegments = Array.from(
      { length: GPU_TEXTURE_PACKAGE_BANK_COUNT * TEXTURE_BINDING_SET_MAX_RESIDENT_SETS },
      (_, index): TexturePackageSegment => ({
        id: index,
        key: null,
        format: "rgba8unorm",
        width: 1,
        height: 1,
        mipLevelCount: 1,
        capacity: 0,
        texture: null,
        view: null,
        accounting: null,
        freeLayers: []
      })
    );
    this.bindingSets = Array.from(
      { length: TEXTURE_BINDING_SET_MAX_RESIDENT_SETS },
      (_, id): ResidentTextureBindingSet => ({
        id,
        generation: 1,
        materialCount: 0,
        packageSlots: Array.from({ length: GPU_TEXTURE_PACKAGE_BANK_COUNT }, () => null)
      })
    );
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
    this.transactionPeakBytes = this.allocatedPeakBytes;
  }

  stage(materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext): TextureResidencyStage {
    this.assertAlive();
    const preflight = this.preflight(materials);
    const growths = this.applyGrowthPlans(preflight.bankPlans, command);
    let packageGrowths: TexturePackageSegmentGrowth[] = [];
    try {
      packageGrowths = this.applyPackageSegmentPlans(preflight.packagePlans);
    } catch (error) {
      this.rollbackGrowths(growths);
      throw error;
    }
    this.applyBindingSetPlans(preflight.bindingSetPlans);
    const materialOperations = this.retainMaterials(materials, preflight.materialBindingSetIds);
    const transitions: TextureTransition[] = [];
    const newTextures: ResidentTexture[] = [];
    const packageUploads: TextureAssetLayerUploadV2[] = [];
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
        operation.entry.bindingSetId = operation.previousBindingSetId;
        if (operation.activated) this.bindingSets[preflight.materialBindingSetIds.get(operation.material)!]!.materialCount--;
        if (operation.created && operation.entry.refCount === 0 && this.materials.get(operation.material) === operation.entry) {
          this.materials.delete(operation.material);
        }
      }
      for (const upload of packageUploads) upload.abort();
      this.rollbackBindingSetPlans(preflight.bindingSetPlans);
      this.rollbackPackageSegmentGrowths(packageGrowths);
      this.rollbackGrowths(growths);
    };
    command.onAborted.addOne(rollback);
    try {
      const transitioned = new Set<ResidentMaterialTextures>();
      for (let index = 0; index < materials.length; index++) {
        const resident = materialOperations[index]!.entry;
        if (transitioned.has(resident)) continue;
        transitioned.add(resident);
        const transition = this.transition(
          resident,
          materials[index]!,
          preflight.packageAssignments
        );
        transitions.push(transition);
        for (const operation of transition.added) if (operation.created) newTextures.push(operation.entry);
      }
      this.graphics.textures.mipmaps.flush(command);
      const uncookedTextures = newTextures.filter((entry) => !entry.cooked);
      const cookedTextures = newTextures.filter((entry) => entry.cooked);
      for (const texture of uncookedTextures) this.encodeResizeCopy(command, texture);
      for (const bankClass of new Set(uncookedTextures.map((entry) => entry.bankClass))) {
        const bank = this.banks[bankClass]!;
        this.graphics.textures.mipmaps.generateMipmap(requireBankTexture(bank), bank.descriptor, TextureFilterType.Linear, command);
        this.runtimeMipGenerationCount++;
      }
      for (const entry of cookedTextures) {
        const assignment = preflight.packageAssignments.get(entry.source);
        if (assignment === undefined) {
          throw new Error("TextureResidency lost a cooked package preflight assignment");
        }
        packageUploads.push(stageTextureAssetPackageV2ToLayer(
          this.graphics.device,
          assignment.asset,
          requirePackageSegmentTexture(assignment.segment),
          entry.layer
        ));
      }
      command.onFinished.addOne(() => {
        if (settled) return;
        settled = true;
        for (let index = 0; index < packageUploads.length; index++) {
          const entry = cookedTextures[index]!;
          packageUploads[index]!.commit(
            `TextureResidency/package-segment-${entry.bankClass}-layer-${entry.layer}`
          );
          this.cookedUploadBytes += packageUploads[index]!.evidence.uploadBytes;
        }
        for (const entry of newTextures) {
          this.descriptors.set(entry.slot, this.createDescriptor(entry));
        }
        for (const transition of transitions) this.releaseTextureRefs(transition.removed, command.gpuDone);
        this.commitGrowths(growths, command.gpuDone);
      });
      return Object.freeze({
        bindings: this.bindings(),
        materialBindingSetIds: preflight.materialBindingSetIds,
        textureRefs: this.textureRefs(),
        materialTextureRoutingRefs: this.materialTextureRoutingRefs(materials)
      });
    } catch (error) {
      rollback();
      throw error;
    }
  }

  release(materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext): void {
    this.assertAlive();
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
          if (this.materials.get(material) !== entry) return;
          this.materials.delete(material);
          const set = this.bindingSets[entry.bindingSetId]!;
          set.materialCount--;
          if (set.materialCount < 0) throw new Error("TextureBindingSet material count underflow");
          if (set.materialCount === 0) this.retireBindingSet(set);
        };
        void command.gpuDone.then(retire, retire);
      }
    });
  }

  bindings(): TextureResidencyBindings {
    const fallback = this.banks[0]!.view!;
    const active = this.bindingSets.filter((set) => set.materialCount > 0);
    return Object.freeze({
      textureCapacity: this.logicalCapacity(),
      bindingSets: Object.freeze(active.map((set): TextureBindingSet => {
        const views = [
          ...this.banks.map((bank) => bank.view ?? fallback),
          ...set.packageSlots.map((segment) => segment?.view ?? fallback)
        ] as unknown as TextureBindingSet["textureBanks"];
        const bankDescriptors: TextureBindingSetBankDescriptor[] = [
          ...this.banks.map((bank) => Object.freeze({
            bindingSlot: bank.bindingSlot,
            formatClass: "rgba8unorm" as GPUTextureFormat,
            sizeClass: bank.bankClass,
            segment: -1
          })),
          ...set.packageSlots.map((segment, index) => Object.freeze({
            bindingSlot: GPU_TEXTURE_PACKAGE_BANK_BEGIN + index,
            formatClass: segment?.format ?? "rgba8unorm",
            sizeClass: segment === null ? 0 : textureSizeClass(segment.width, segment.height),
            segment: segment?.id ?? -1
          }))
        ];
        return Object.freeze({
          id: set.id,
          generation: set.generation,
          textureBanks: Object.freeze(views),
          bankDescriptors: Object.freeze(bankDescriptors)
        });
      }))
    });
  }

  descriptor(handleValue: number): TextureResidencyDescriptor | null {
    if (this.destroyed) return null;
    const handle = decodeTextureHandle(handleValue);
    if (handle === null) return null;
    const descriptor = this.descriptors.get(handle.slot);
    if (descriptor === undefined || descriptor.generation !== handle.generation) return null;
    return descriptor;
  }

  evidence(): TextureResidencyEvidence {
    const counts = Array.from(
      { length: GPU_TEXTURE_BANK_COUNT },
      () => ({ resident: 0, retiring: 0 })
    );
    const packageCounts = this.packageSegments.map(() => ({ resident: 0, retiring: 0 }));
    let residentTextureCount = 0;
    let retiringTextureCount = 0;
    let residentTextureBytes = 0;
    let retiringTextureBytes = 0;
    let logicalResidentBytes = 0;
    let cookedResidentTextureCount = 0;
    let compressedResidentTextureCount = 0;
    let transcodeBytes = 0;
    let directPackageCount = 0;
    let workerTranscodeCount = 0;
    let uncompressedFallbackCount = 0;
    const formatDistribution = new Map<GPUTextureFormat, { count: number; bytes: number }>();
    for (const entry of this.textures.values()) {
      const bytes = entry.residentBytes;
      if (entry.refCount > 0) {
        residentTextureCount++;
        residentTextureBytes += bytes;
        logicalResidentBytes += logicalTextureBytes(entry.source);
        if (entry.cooked) cookedResidentTextureCount++;
        if (entry.cooked && entry.physicalFormat.startsWith("bc")) {
          compressedResidentTextureCount++;
        }
        const distribution = formatDistribution.get(entry.physicalFormat) ?? { count: 0, bytes: 0 };
        distribution.count++;
        distribution.bytes += bytes;
        formatDistribution.set(entry.physicalFormat, distribution);
        if (entry.preparationPath === "worker-transcode") {
          workerTranscodeCount++;
          transcodeBytes += bytes;
        } else if (entry.preparationPath === "direct-package") {
          directPackageCount++;
        } else {
          uncompressedFallbackCount++;
        }
        if (entry.cooked) packageCounts[entry.segment]!.resident++;
        else counts[entry.bankClass]!.resident++;
      } else {
        retiringTextureCount++;
        retiringTextureBytes += bytes;
        if (entry.cooked) packageCounts[entry.segment]!.retiring++;
        else counts[entry.bankClass]!.retiring++;
      }
    }
    const banks = this.banks.map((bank): TextureBankEvidence => Object.freeze({
      segment: 0,
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
    const packageSegments = this.packageSegments.map(
      (segment): TexturePackageSegmentEvidence => Object.freeze({
        segment: segment.id,
        format: segment.format,
        width: segment.width,
        height: segment.height,
        mipLevelCount: segment.mipLevelCount,
        allocatedCapacity: segment.capacity,
        residentTextureCount: packageCounts[segment.id]!.resident,
        retiringTextureCount: packageCounts[segment.id]!.retiring,
        freeLayerCount: segment.freeLayers.length,
        allocatedBytes: segment.texture === null ? 0 : texturePackageSegmentBytes(
          segment.format,
          segment.width,
          segment.height,
          segment.mipLevelCount,
          segment.capacity
        )
      })
    );
    const allocatedSegmentCount = this.banks.filter((bank) => bank.texture !== null).length +
      this.packageSegments.filter((segment) => segment.texture !== null).length;
    const activeBindingSets = this.bindingSets.filter((set) => set.materialCount > 0);
    const usedBindingSlots = activeBindingSets.reduce(
      (sum, set) => sum + this.banks.length + set.packageSlots.filter((segment) => segment !== null).length,
      0
    );
    return Object.freeze({
      schemaVersion: 5,
      textureCapacity: this.logicalCapacity(),
      residentTextureCount,
      retiringTextureCount,
      allocatedBytes: this.allocatedBytes(),
      allocatedPeakBytes: this.allocatedPeakBytes,
      residentTextureBytes,
      retiringTextureBytes,
      logicalResidentBytes,
      physicalAllocatedBytes: this.allocatedBytes(),
      retiringBytes: retiringTextureBytes,
      transactionPeakBytes: this.transactionPeakBytes,
      uploadBytes: this.cookedUploadBytes,
      copyBytes: 0,
      transcodeBytes,
      directPackageCount,
      workerTranscodeCount,
      uncompressedFallbackCount,
      formatDistribution: Object.freeze(
        [...formatDistribution]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([format, value]): TextureFormatDistributionEvidence => Object.freeze({
            format,
            residentTextureCount: value.count,
            residentBytes: value.bytes
          }))
      ),
      bankGrowCount: this.bankGrowCount,
      abortedBankGrowCount: this.abortedBankGrowCount,
      resizeDispatchCount: this.resizeDispatchCount,
      runtimeMipGenerationCount: this.runtimeMipGenerationCount,
      cookedResidentTextureCount,
      compressedResidentTextureCount,
      cookedRuntimeMipGenerationCount: 0,
      bankCopyOperationCount: this.bankCopyOperationCount,
      segmentCount: allocatedSegmentCount,
      bindingSetCount: activeBindingSets.length,
      bindingSlotUtilization: activeBindingSets.length === 0
        ? 0
        : usedBindingSlots / (activeBindingSets.length * GPU_TEXTURE_BANK_COUNT),
      bindingSetPreflightFailures: this.bindingSetPreflightFailures,
      highResolutionArrayAllocated: this.banks.slice(1).some((bank) => bank.texture !== null),
      banks: Object.freeze(banks),
      packageSegments: Object.freeze(packageSegments),
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
    for (const segment of this.packageSegments) {
      segment.texture?.destroy();
      if (segment.accounting !== null) {
        this.graphics.resource_accounting?.destroyed(segment.accounting);
      }
      resetPackageSegment(segment);
    }
    for (const set of this.bindingSets) resetBindingSet(set);
    this.textures.clear();
    this.materials.clear();
    this.descriptors.clear();
    this.freeDescriptorSlots.length = 0;
    this.resizePipeline = null;
  }

  private preflight(materials: readonly StandardShadeMaterial[]): TexturePreflight {
    const freshByBank = this.banks.map(() => new Set<ShadeTexture>());
    const freshPackages = new Map<ShadeTexture, Readonly<{
      asset: TextureAssetPackageV2;
      variant: SelectedTextureVariantV2;
      key: string;
    }>>();
    for (const material of materials) {
      for (const { texture, role } of materialTextureEntries(material)) {
        const asset = texture.runtime_asset_package_v2;
        if (asset !== undefined) validatePackageSemantic(asset, role, material.name);
        if (this.textures.has(texture)) continue;
        if (asset !== undefined) {
          const variant = selectTextureAssetVariantV2(
            asset,
            this.graphics.device.features,
            this.graphics.device.limits
          );
          freshPackages.set(texture, {
            asset,
            variant,
            key: texturePackageSegmentKey(asset, variant)
          });
        } else if (canStageTexture(texture)) {
          freshByBank[textureBankClass(texture)]!.add(texture);
        }
      }
    }
    const freshDescriptorCount = freshPackages.size + freshByBank.reduce(
      (sum, textures) => sum + textures.size,
      0
    );
    if (freshDescriptorCount > this.freeDescriptorSlots.length) {
      this.bindingSetPreflightFailures++;
      throw new RangeError(
        `TextureResidency requires ${freshDescriptorCount} logical descriptor slots but only ` +
        `${this.freeDescriptorSlots.length} remain`
      );
    }
    const bankPlans: BankGrowthPlan[] = [];
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
      if (bank.texture === null) bankPlans.push({ bank, nextCapacity: bank.maxCapacity });
    }

    const packagePlans: TexturePackageSegmentPlan[] = [];
    const packageAssignments = new Map<ShadeTexture, TexturePackageAssignment>();
    const groups = new Map<string, Array<Readonly<{
      texture: ShadeTexture;
      asset: TextureAssetPackageV2;
      variant: SelectedTextureVariantV2;
    }>>>();
    for (const [texture, entry] of freshPackages) {
      const group = groups.get(entry.key) ?? [];
      group.push({ texture, asset: entry.asset, variant: entry.variant });
      groups.set(entry.key, group);
    }
    const claimedEmptySegments = new Set<TexturePackageSegment>();
    for (const [key, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
      const variant = group[0]!.variant;
      let segment = this.packageSegments.find(
        (candidate) => candidate.key === key && candidate.freeLayers.length >= group.length
      );
      if (segment === undefined) {
        segment = this.packageSegments.find(
          (candidate) => candidate.key === null && !claimedEmptySegments.has(candidate)
        );
        if (segment === undefined) {
          this.bindingSetPreflightFailures++;
          throw new RangeError(
            `TextureResidency requires another cooked package segment for '${key}', ` +
            `but ${TEXTURE_BINDING_SET_MAX_RESIDENT_SETS} binding sets permit only ` +
            `${this.packageSegments.length} resident physical segments`
          );
        }
        const capacity = group.length + 1;
        if (capacity > Number(this.graphics.device.limits.maxTextureArrayLayers)) {
          this.bindingSetPreflightFailures++;
          throw new RangeError(
            `TextureResidency cooked package segment requires ${capacity} layers but the device permits ` +
            `${Number(this.graphics.device.limits.maxTextureArrayLayers)}`
          );
        }
        claimedEmptySegments.add(segment);
        packagePlans.push({ segment, key, variant, freshCount: group.length });
      }
      for (const entry of group) {
        packageAssignments.set(entry.texture, {
          segment,
          asset: entry.asset,
          variant: entry.variant
        });
      }
    }

    const simulatedSlots = this.bindingSets.map((set) => [...set.packageSlots]);
    const materialBindingSetIds = new Map<StandardShadeMaterial, number>();
    for (const material of [...new Set(materials)]) {
      const requiredSegments = [...new Set(materialTextureEntries(material).flatMap(({ texture }) => {
        const assignment = packageAssignments.get(texture);
        if (assignment !== undefined) return [assignment.segment];
        const resident = this.textures.get(texture);
        return resident?.cooked === true ? [this.packageSegments[resident.segment]!] : [];
      }))];
      if (requiredSegments.length > GPU_TEXTURE_PACKAGE_BANK_COUNT) {
        this.bindingSetPreflightFailures++;
        throw new RangeError(
          `Material '${material.name}' requires ${requiredSegments.length} cooked segments, ` +
          `one TextureBindingSet permits ${GPU_TEXTURE_PACKAGE_BANK_COUNT}`
        );
      }
      const current = this.materials.get(material);
      let set: ResidentTextureBindingSet | undefined;
      if (current !== undefined && current.refCount > 0) {
        const candidate = this.bindingSets[current.bindingSetId];
        if (candidate !== undefined && canCoverSegments(simulatedSlots[candidate.id]!, requiredSegments)) {
          set = candidate;
        }
      } else if (requiredSegments.length === 0) {
        set = this.bindingSets[0];
      } else {
        set = [...this.bindingSets]
          .filter((candidate) => canCoverSegments(simulatedSlots[candidate.id]!, requiredSegments))
          .sort((left, right) => {
            const leftMissing = missingSegmentCount(simulatedSlots[left.id]!, requiredSegments);
            const rightMissing = missingSegmentCount(simulatedSlots[right.id]!, requiredSegments);
            return leftMissing - rightMissing || right.materialCount - left.materialCount || left.id - right.id;
          })[0];
      }
      if (set === undefined) {
        this.bindingSetPreflightFailures++;
        throw new RangeError(
          `Material '${material.name}' cannot be colocated in ${TEXTURE_BINDING_SET_MAX_RESIDENT_SETS} bounded TextureBindingSets`
        );
      }
      const slots = simulatedSlots[set.id]!;
      for (const segment of requiredSegments) {
        if (slots.includes(segment)) continue;
        const slot = slots.indexOf(null);
        if (slot < 0) throw new Error("TextureBindingSet preflight admitted an over-capacity material");
        slots[slot] = segment;
      }
      materialBindingSetIds.set(material, set.id);
    }
    const bindingSetPlans = this.bindingSets.flatMap((set): TextureBindingSetPlan[] => {
      const nextSlots = simulatedSlots[set.id]!;
      return sameSegmentSlots(set.packageSlots, nextSlots) ? [] : [{
        set,
        previousGeneration: set.generation,
        previousSlots: Object.freeze([...set.packageSlots]),
        nextSlots: Object.freeze([...nextSlots])
      }];
    });

    const transactionPeakBytes = this.allocatedBytes() + bankPlans.reduce(
      (sum, plan) => sum + arrayBytes(plan.bank.physicalSize, plan.nextCapacity),
      0
    ) + packagePlans.reduce(
      (sum, plan) => sum + texturePackageSegmentBytes(
        plan.variant.format,
        plan.variant.mips[0]!.logicalWidth,
        plan.variant.mips[0]!.logicalHeight,
        plan.variant.mips.length,
        plan.freshCount + 1
      ),
      0
    );
    if (transactionPeakBytes > TEXTURE_RESIDENCY_BUDGET_BYTES) {
      throw new RangeError(
        `TextureResidency transaction peak ${transactionPeakBytes} bytes exceeds the ${TEXTURE_RESIDENCY_BUDGET_BYTES} byte budget`
      );
    }
    return Object.freeze({
      bankPlans: Object.freeze(bankPlans),
      packagePlans: Object.freeze(packagePlans),
      packageAssignments,
      bindingSetPlans: Object.freeze(bindingSetPlans),
      materialBindingSetIds
    });
  }

  private applyBindingSetPlans(plans: readonly TextureBindingSetPlan[]): void {
    for (const plan of plans) {
      plan.set.packageSlots = [...plan.nextSlots];
      plan.set.generation = nextBindingSetGeneration(plan.set.generation);
    }
  }

  private rollbackBindingSetPlans(plans: readonly TextureBindingSetPlan[]): void {
    for (let index = plans.length - 1; index >= 0; index--) {
      const plan = plans[index]!;
      plan.set.packageSlots = [...plan.previousSlots];
      plan.set.generation = plan.previousGeneration;
    }
  }

  private applyPackageSegmentPlans(
    plans: readonly TexturePackageSegmentPlan[]
  ): TexturePackageSegmentGrowth[] {
    const growths: TexturePackageSegmentGrowth[] = [];
    try {
      for (const plan of plans) {
        const { segment, variant } = plan;
        if (segment.texture !== null || segment.key !== null) {
          throw new Error("TextureResidency attempted to replace an immutable cooked segment");
        }
        const width = variant.mips[0]!.logicalWidth;
        const height = variant.mips[0]!.logicalHeight;
        const capacity = plan.freshCount + 1;
        const descriptor: GPUTextureDescriptor = {
          label: `TextureResidency/package-segment-${segment.id}-${variant.format}-${width}x${height}`,
          size: [width, height, capacity],
          format: variant.format,
          mipLevelCount: variant.mips.length,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        };
        const texture = this.graphics.device.createTexture(descriptor);
        const bytes = texturePackageSegmentBytes(
          variant.format,
          width,
          height,
          variant.mips.length,
          capacity
        );
        const accounting = this.graphics.resource_accounting?.created({
          kind: "texture",
          category: "resident",
          owner: `TextureResidency/package-segment-${segment.id}`,
          bytes,
          label: descriptor.label
        });
        segment.key = plan.key;
        segment.format = variant.format;
        segment.width = width;
        segment.height = height;
        segment.mipLevelCount = variant.mips.length;
        segment.capacity = capacity;
        segment.texture = texture;
        segment.view = texture.createView({ dimension: "2d-array" });
        segment.accounting = accounting ?? null;
        for (let layer = capacity - 1; layer >= 1; layer--) segment.freeLayers.push(layer);
        growths.push({ segment, texture, accounting });
        this.bankGrowCount++;
      }
      this.allocatedPeakBytes = Math.max(this.allocatedPeakBytes, this.allocatedBytes());
      this.transactionPeakBytes = Math.max(this.transactionPeakBytes, this.allocatedBytes());
      return growths;
    } catch (error) {
      this.rollbackPackageSegmentGrowths(growths);
      throw error;
    }
  }

  private rollbackPackageSegmentGrowths(
    growths: readonly TexturePackageSegmentGrowth[]
  ): void {
    for (let index = growths.length - 1; index >= 0; index--) {
      const growth = growths[index]!;
      growth.texture.destroy();
      if (growth.accounting !== undefined) {
        this.graphics.resource_accounting?.destroyed(growth.accounting);
      }
      resetPackageSegment(growth.segment);
      this.abortedBankGrowCount++;
    }
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
    this.transactionPeakBytes = Math.max(
      this.transactionPeakBytes,
      this.allocatedBytes() + arrayBytes(bank.physicalSize, nextCapacity)
    );
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

  private retainMaterials(
    materials: readonly StandardShadeMaterial[],
    bindingSetIds: ReadonlyMap<StandardShadeMaterial, number>
  ): MaterialRetainOperation[] {
    for (const material of materials) {
      const bindingSetId = bindingSetIds.get(material);
      if (bindingSetId === undefined || this.bindingSets[bindingSetId] === undefined) {
        throw new Error(`Missing valid TextureBindingSet for '${material.name}'`);
      }
      const entry = this.materials.get(material);
      if (entry !== undefined && entry.refCount > 0 && entry.bindingSetId !== bindingSetId) {
        throw new Error(`Resident material '${material.name}' cannot change TextureBindingSet while referenced`);
      }
    }
    const result: MaterialRetainOperation[] = [];
    for (const material of materials) {
      const bindingSetId = bindingSetIds.get(material);
      if (bindingSetId === undefined) throw new Error(`Missing TextureBindingSet for '${material.name}'`);
      let entry = this.materials.get(material);
      let created = false;
      if (entry === undefined) {
        entry = { refCount: 0, retireGeneration: 0, textures: [], bindingSetId };
        this.materials.set(material, entry);
        created = true;
      }
      const previousRetireGeneration = entry.retireGeneration;
      const previousBindingSetId = entry.bindingSetId;
      const activated = entry.refCount === 0;
      if (!created && activated) {
        entry.retireGeneration++;
        entry.bindingSetId = bindingSetId;
      } else if (entry.bindingSetId !== bindingSetId) {
        throw new Error(`Resident material '${material.name}' cannot change TextureBindingSet while referenced`);
      }
      if (activated) this.bindingSets[bindingSetId]!.materialCount++;
      entry.refCount++;
      result.push({
        material,
        entry,
        created,
        previousRetireGeneration,
        previousBindingSetId,
        activated
      });
    }
    return result;
  }

  private transition(
    resident: ResidentMaterialTextures,
    material: StandardShadeMaterial,
    packageAssignments: ReadonlyMap<ShadeTexture, TexturePackageAssignment>
  ): TextureTransition {
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
      const operation = this.retainTexture(texture, packageAssignments.get(texture));
      if (operation !== null) {
        next.push(operation.entry);
        added.push(operation);
      }
    }
    const removed = previous.filter(({ source }) => !desiredSet.has(source));
    resident.textures = next;
    return { material: resident, previous, added, removed };
  }

  private retainTexture(
    texture: ShadeTexture,
    packageAssignment?: TexturePackageAssignment
  ): TextureRetainOperation | null {
    if (!canStageTexture(texture)) return null;
    let entry = this.textures.get(texture);
    let created = false;
    if (entry === undefined) {
      let bankClass: number;
      let segmentIndex: number;
      let layer: number | undefined;
      let physicalFormat: GPUTextureFormat;
      let routing: number;
      let residentBytes: number;
      if (packageAssignment !== undefined) {
        const segment = packageAssignment.segment;
        bankClass = GPU_TEXTURE_PACKAGE_BANK_BEGIN;
        segmentIndex = segment.id;
        layer = segment.freeLayers.pop();
        physicalFormat = packageAssignment.variant.format;
        routing = packageRouting(packageAssignment.asset, packageAssignment.variant);
        residentBytes = packageAssignment.variant.payloads.reduce(
          (sum, payload) => sum + payload.byteLength,
          0
        );
      } else {
        try {
          this.graphics.textures.obtain(texture);
        } catch {
          return null;
        }
        bankClass = textureBankClass(texture);
        segmentIndex = 0;
        const bank = this.banks[bankClass]!;
        layer = bank.freeLayers.pop();
        physicalFormat = "rgba8unorm";
        routing = GPU_TEXTURE_REF_ROUTING.Identity;
        residentBytes = arrayBytes(bank.physicalSize, 1);
      }
      if (layer === undefined) {
        throw new RangeError(`TextureResidency binding slot ${bankClass} layer overflow`);
      }
      const slot = this.freeDescriptorSlots.pop();
      if (slot === undefined) throw new RangeError("TextureResidency logical descriptor slot overflow");
      const generation = this.descriptorGenerations[slot] ?? 1;
      entry = {
        slot,
        generation,
        layer,
        segment: segmentIndex,
        bankClass,
        source: texture,
        cooked: packageAssignment !== undefined,
        physicalFormat,
        preparationPath: packageAssignment === undefined
          ? "uncompressed-fallback"
          : packageAssignment.variant.profile === "worker-transcoded"
            ? "worker-transcode"
            : "direct-package",
        routing,
        residentBytes,
        uploadBytes: packageAssignment === undefined ? 0 : residentBytes,
        refCount: 0,
        retireGeneration: 0
      };
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
    this.descriptors.delete(entry.slot);
    this.freeDescriptorSlots.push(entry.slot);
    this.freePhysicalLayer(entry);
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
        this.freePhysicalLayer(entry);
        if (entry.cooked) this.reclaimPackageSegmentIfUnused(entry.segment);
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

  private materialTextureRoutingRefs(
    materials: readonly StandardShadeMaterial[]
  ): ReadonlyMap<StandardShadeMaterial, ReadonlyMap<ShadeTexture, number>> {
    const result = new Map<StandardShadeMaterial, ReadonlyMap<ShadeTexture, number>>();
    for (const material of new Set(materials)) {
      const resident = this.materials.get(material);
      if (resident === undefined || resident.refCount <= 0) continue;
      const set = this.bindingSets[resident.bindingSetId]!;
      const refs = new Map<ShadeTexture, number>();
      for (const entry of resident.textures) {
        if (entry.cooked) {
          const segment = this.packageSegments[entry.segment]!;
          const localSlot = set.packageSlots.indexOf(segment);
          if (localSlot < 0) {
            throw new Error(`TextureBindingSet ${set.id} lost package segment ${segment.id}`);
          }
          refs.set(entry.source, encodeGpuTextureRef(
            GPU_TEXTURE_PACKAGE_BANK_BEGIN + localSlot,
            entry.layer,
            entry.routing
          ));
        } else {
          refs.set(entry.source, encodeGpuTextureRef(entry.bankClass, entry.layer, entry.routing));
        }
      }
      result.set(material, refs);
    }
    return result;
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
    return this.banks.reduce(
      (sum, bank) => sum + arrayBytes(bank.physicalSize, bank.capacity),
      0
    ) + this.packageSegments.reduce(
      (sum, segment) => sum + (segment.texture === null ? 0 : texturePackageSegmentBytes(
        segment.format,
        segment.width,
        segment.height,
        segment.mipLevelCount,
        segment.capacity
      )),
      0
    );
  }

  private logicalCapacity(): number {
    return this.banks.reduce((sum, bank) => sum + Math.max(0, bank.maxCapacity - 1), 0);
  }

  private freePhysicalLayer(entry: ResidentTexture): void {
    if (entry.cooked) {
      this.packageSegments[entry.segment]!.freeLayers.push(entry.layer);
    } else {
      this.banks[entry.bankClass]!.freeLayers.push(entry.layer);
    }
  }

  /** Reclaims immutable cooked storage only after every referencing GPU submission completed. */
  private reclaimPackageSegmentIfUnused(segmentIndex: number): void {
    if ([...this.textures.values()].some((entry) => entry.cooked && entry.segment === segmentIndex)) return;
    const segment = this.packageSegments[segmentIndex]!;
    if (this.bindingSets.some((set) => set.materialCount > 0 && set.packageSlots.includes(segment))) return;
    segment.texture?.destroy();
    if (segment.accounting !== null) this.graphics.resource_accounting?.destroyed(segment.accounting);
    resetPackageSegment(segment);
  }

  private retireBindingSet(set: ResidentTextureBindingSet): void {
    const segments = [...new Set(set.packageSlots.filter(
      (segment): segment is TexturePackageSegment => segment !== null
    ))];
    resetBindingSet(set);
    for (const segment of segments) this.reclaimPackageSegmentIfUnused(segment.id);
  }

  private createDescriptor(entry: ResidentTexture): TextureResidencyDescriptor {
    if (entry.cooked) {
      const asset = entry.source.runtime_asset_package_v2!;
      const segment = this.packageSegments[entry.segment]!;
      return Object.freeze({
        slot: entry.slot,
        generation: entry.generation,
        formatClass: entry.physicalFormat,
        sizeClass: textureSizeClass(asset.width, asset.height),
        segment: entry.segment,
        layer: entry.layer,
        logicalSize: Object.freeze([asset.width, asset.height]) as readonly [number, number],
        uvScaleBias: Object.freeze([1, 1, 0, 0]) as readonly [number, number, number, number],
        residentMipRange: Object.freeze([0, segment.mipLevelCount - 1]) as readonly [number, number]
      });
    }
    const image = entry.source.image!;
    const bank = this.banks[entry.bankClass]!;
    return Object.freeze({
      slot: entry.slot,
      generation: entry.generation,
      formatClass: "rgba8unorm",
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

  private assertAlive(): void {
    if (this.destroyed) throw new Error("TextureResidency is destroyed");
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

function canStageTexture(texture: ShadeTexture): boolean {
  if (texture.runtime_asset_package_v2 !== undefined) return true;
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

function logicalTextureBytes(texture: ShadeTexture): number {
  const asset = texture.runtime_asset_package_v2;
  if (asset !== undefined) return asset.evidence.sourceBytes;
  const image = texture.image;
  if (image === undefined) return 0;
  return estimateTextureBytes({
    format: "rgba8unorm",
    width: image.width,
    height: image.height,
    depthOrArrayLayers: 1,
    mipLevelCount: mipCount(Math.max(image.width, image.height))
  });
}

function requirePackageSegmentTexture(segment: TexturePackageSegment): GPUTexture {
  if (segment.texture === null) {
    throw new Error(`TextureResidency cooked segment ${segment.id} was not preflighted`);
  }
  return segment.texture;
}

function resetPackageSegment(segment: TexturePackageSegment): void {
  segment.key = null;
  segment.format = "rgba8unorm";
  segment.width = 1;
  segment.height = 1;
  segment.mipLevelCount = 1;
  segment.capacity = 0;
  segment.texture = null;
  segment.view = null;
  segment.accounting = null;
  segment.freeLayers.length = 0;
}

function resetBindingSet(set: ResidentTextureBindingSet): void {
  set.generation = nextBindingSetGeneration(set.generation);
  set.materialCount = 0;
  set.packageSlots = Array.from({ length: GPU_TEXTURE_PACKAGE_BANK_COUNT }, () => null);
}

function nextBindingSetGeneration(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function canCoverSegments(
  slots: readonly (TexturePackageSegment | null)[],
  required: readonly TexturePackageSegment[]
): boolean {
  return missingSegmentCount(slots, required) <= slots.filter((segment) => segment === null).length;
}

function missingSegmentCount(
  slots: readonly (TexturePackageSegment | null)[],
  required: readonly TexturePackageSegment[]
): number {
  return required.reduce((count, segment) => count + (slots.includes(segment) ? 0 : 1), 0);
}

function sameSegmentSlots(
  left: readonly (TexturePackageSegment | null)[],
  right: readonly (TexturePackageSegment | null)[]
): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function texturePackageSegmentKey(
  asset: TextureAssetPackageV2,
  variant: SelectedTextureVariantV2
): string {
  return `${variant.format}:${asset.width}x${asset.height}:mips-${variant.mips.length}`;
}

function texturePackageSegmentBytes(
  format: GPUTextureFormat,
  width: number,
  height: number,
  mipLevelCount: number,
  capacity: number
): number {
  return estimateTextureBytes({
    format,
    width,
    height,
    depthOrArrayLayers: capacity,
    mipLevelCount
  });
}

function packageRouting(
  asset: TextureAssetPackageV2,
  variant: SelectedTextureVariantV2
): number {
  if (asset.semantic !== "alpha-mask") return GPU_TEXTURE_REF_ROUTING.Identity;
  return variant.format === "bc4-r-unorm"
    ? GPU_TEXTURE_REF_ROUTING.AlphaFromRed
    : GPU_TEXTURE_REF_ROUTING.AlphaFromAlpha;
}

type MaterialTextureRole = "base-color" | "normal" | "orm" | "emissive";

function materialTextureEntries(
  material: StandardShadeMaterial
): readonly Readonly<{ texture: ShadeTexture; role: MaterialTextureRole }>[] {
  const entries: Array<Readonly<{ texture: ShadeTexture; role: MaterialTextureRole }>> = [];
  if (material.texture_albedo !== undefined) {
    entries.push({ texture: material.texture_albedo, role: "base-color" });
  }
  if (!material.is_unlit && material.texture_normal !== undefined) {
    entries.push({ texture: material.texture_normal, role: "normal" });
  }
  if (!material.is_unlit && material.texture_orm !== undefined) {
    entries.push({ texture: material.texture_orm, role: "orm" });
  }
  if (!material.is_unlit && material.texture_emissive !== undefined) {
    entries.push({ texture: material.texture_emissive, role: "emissive" });
  }
  return entries;
}

function validatePackageSemantic(
  asset: TextureAssetPackageV2,
  role: MaterialTextureRole,
  materialName: string
): void {
  const valid = role === "base-color"
    ? asset.semantic === "base-color-srgb" || asset.semantic === "alpha-mask"
    : role === "normal"
      ? asset.semantic === "normal-linear"
      : role === "orm"
        ? asset.semantic === "orm-linear"
        : asset.semantic === "emissive-srgb";
  if (!valid) {
    throw new Error(
      `Material '${materialName}' binds Texture Package semantic '${asset.semantic}' as ${role}`
    );
  }
}

function textureSizeClass(width: number, height: number): number {
  const required = Math.min(TEXTURE_RESIDENCY_MAX_SIZE, nextPowerOfTwo(Math.max(width, height)));
  const result = GPU_TEXTURE_BANK_SIZES.findIndex((size) => size >= required);
  return Math.max(0, result);
}

function countMaterials(materials: readonly StandardShadeMaterial[]): Map<StandardShadeMaterial, number> {
  const counts = new Map<StandardShadeMaterial, number>();
  for (const material of materials) counts.set(material, (counts.get(material) ?? 0) + 1);
  return counts;
}
