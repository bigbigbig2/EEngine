import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../material/CanonicalMaterial.js";
import { materialTextureLeaves } from "../assets/PcMaterialTextures.js";
import {
  assertValidatedTextureProduct,
  writeTextureProductPlane,
  type TextureProduct,
  type TextureProductPlane,
} from "../assets/TextureProduct.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { TextureSurfacePublication } from "./TextureSurfacePublication.js";
import { Signal } from "../core/Signal.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import { encodeGpuTextureRef, GPU_TEXTURE_BANK_COUNT } from "./GpuTextureRefAbi.js";
import {
  decodeTextureHandle,
  encodeTextureHandle,
  nextTextureHandleGeneration,
  TEXTURE_HANDLE_MAX_SLOT,
} from "./TextureHandleAbi.js";
import type { ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { textureBindingSetPolicy } from "./TextureBindingSetPolicy.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_SAMPLER } from "./GpuMaterialVisibilityAbi.js";

export const TEXTURE_RESIDENCY_MAX_SIZE = 16384;
export const TEXTURE_RESIDENCY_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
export interface TextureBindingSetBankDescriptor {
  readonly bindingSlot: number;
  readonly formatClass: GPUTextureFormat;
  readonly sizeClass: number;
  readonly segment: number;
}
export interface TextureBindingSet {
  readonly id: number;
  readonly generation: number;
  readonly textureBanks: readonly GPUTextureView[];
  readonly bankDescriptors: readonly TextureBindingSetBankDescriptor[];
  readonly textureBankMask: number;
}
export interface TextureResidencyBindings {
  readonly textureCapacity: number;
  readonly bindingSets: readonly TextureBindingSet[];
}
export interface TextureResidencyStage {
  readonly bindings: TextureResidencyBindings;
  readonly materialBindingSetIds: ReadonlyMap<StandardShadeMaterial, number>;
  readonly textureRefs: ReadonlyMap<ShadeTexture, number>;
  readonly materialTextureRoutingRefs: ReadonlyMap<StandardShadeMaterial, ReadonlyMap<ShadeTexture, number>>;
  readonly textureMipRanges: ReadonlyMap<ShadeTexture, readonly [number, number]>;
  readonly surfacePublications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>;
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
interface Segment {
  readonly id: number;
  readonly key: string;
  readonly plane: TextureProductPlane;
  readonly capacity: number;
  readonly bytes: number;
  texture?: GPUTexture;
  view?: GPUTextureView;
  accounting?: ResourceHandle;
  readonly free: number[];
}
interface PlaneAllocation {
  readonly segment: Segment;
  readonly layer: number;
}
interface Entry {
  readonly product: TextureProduct;
  readonly slot: number;
  readonly generation: number;
  readonly planes: readonly PlaneAllocation[];
  refs: number;
  revision: number;
  minMip: number;
  retirement: number;
  staging?: ShadeGPUCommandContext;
  promotion?: ShadeGPUCommandContext;
}
interface MaterialEntry {
  refs: number;
  readonly entries: readonly Entry[];
  readonly textures: readonly ShadeTexture[];
  readonly set: TextureBindingSet;
  retirement: number;
  pendingReleases: number;
  staging?: ShadeGPUCommandContext;
  releasing?: ShadeGPUCommandContext;
}

/** Sole material GPU owner. Immutable segments follow batch demand. Aborted
 * queue-write destinations remain quarantined until actual queue completion;
 * rejection does not grant reuse. Handles and material tuples are CPU-owned. */
export class TextureResidency {
  /** Committed physical/route/mip changes; stable frames perform no ledger scan. */
  readonly onPublicationChanged = new Signal();
  private readonly segments = new Set<Segment>();
  private readonly entries = new Map<string, Entry>();
  private readonly quarantined = new Set<Entry>();
  private readonly materials = new Map<StandardShadeMaterial, MaterialEntry>();
  private readonly descriptors = new Map<number, Entry>();
  private readonly freeSlots: number[] = [];
  private readonly generations = new Uint32Array(TEXTURE_HANDLE_MAX_SLOT + 1).fill(1);
  private readonly sets = new Map<string, { set: TextureBindingSet; refs: number }>();
  private readonly freeSetIds: number[] = [];
  private nextSetId = 0;
  private nextSegmentId = 1;
  private nextRevision = 1;
  private allocated = 0;
  private peak = 0;
  private uploadBytes = 0;
  private progressiveBytes = 0;
  private promotionCount = 0;
  private mipUploads = 0;
  private failures = 0;
  private destroyed = false;
  private cachedBindings?: TextureResidencyBindings;
  constructor(private readonly graphics: GraphicsContext) {
    if (!graphics.device.features.has("texture-compression-bc")) {
      throw new Error("PC TextureResidency requires texture-compression-bc");
    }
    textureBindingSetPolicy(graphics.device.limits);
    for (let slot = TEXTURE_HANDLE_MAX_SLOT; slot >= 1; slot--) {
      this.freeSlots.push(slot);
    }
  }

  stage(materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext): TextureResidencyStage {
    this.assertCommand(command);
    const counts = countMaterials(materials);
    const leaves = new Map<StandardShadeMaterial, readonly ShadeTexture[]>();
    const products = new Map<string, TextureProduct>();
    for (const material of counts.keys()) {
      const textures = materialTextureLeaves(material);
      leaves.set(material, textures);
      for (const texture of textures) {
        const product = texture.texture_product;
        if (!product) {
          throw new Error(`Material '${material.name}' requires a final BC Product before GPU staging`);
        }
        validateUpload(product, this.graphics.device.limits);
        products.set(product.identity, product);
        const entry = this.entries.get(product.identity);
        if (entry?.staging && entry.staging !== command) {
          throw new Error("Texture has an uncommitted transaction");
        }
      }
      const prior = this.materials.get(material);
      if (prior?.staging && prior.staging !== command) {
        throw new Error("Material has an uncommitted transaction");
      }
      if (prior?.releasing && prior.releasing !== command) {
        throw new Error("Material has an uncommitted release");
      }
      if (prior && prior.refs > 0 && !sameTextures(prior.textures, textures)) {
        throw new Error("Withdraw or replace a live immutable material before changing texture resources");
      }
    }
    const fresh = [...products.values()].filter((product) => !this.entries.has(product.identity));
    if (fresh.length > this.freeSlots.length) {
      throw new RangeError("Texture logical descriptor budget exhausted");
    }
    const plans: Segment[] = [];
    const assignments = new Map<string, PlaneAllocation[]>();
    const available = new Map([...this.segments].map((segment) => [segment, [...segment.free]]));
    const groups = new Map<
      string,
      Array<{ product: TextureProduct; index: number; plane: TextureProductPlane }>
    >();
    for (const product of fresh) {
      assignments.set(product.identity, []);
      product.metadata.planes.forEach((plane, index) => {
        const key = segmentKey(plane),
          group = groups.get(key) ?? [];
        group.push({ product, index, plane });
        groups.set(key, group);
      });
    }
    for (const [key, group] of groups) {
      let position = 0;
      for (const [segment, free] of available) {
        if (segment.key !== key) {
          continue;
        }
        while (free.length && position < group.length) {
          const item = group[position++]!;
          assignments.get(item.product.identity)![item.index] = { segment, layer: free.pop()! };
        }
      }
      while (position < group.length) {
        const length = Math.min(
          group.length - position,
          Number(this.graphics.device.limits.maxTextureArrayLayers) - 1,
        );
        if (length <= 0) {
          throw new RangeError("Texture array requires neutral plus live layer");
        }
        const plane = group[position]!.plane;
        const segment: Segment = {
          id: this.nextSegmentId++,
          key,
          plane,
          capacity: length + 1,
          bytes: planeBytes(plane) * (length + 1),
          free: Array.from({ length }, (_, index) => length - index),
        };
        plans.push(segment);
        for (let layer = 1; layer <= length; layer++) {
          const item = group[position++]!;
          assignments.get(item.product.identity)![item.index] = { segment, layer };
        }
      }
    }
    // Full lit descriptor admission is CPU-only, before allocation or writes.
    for (const [material, textures] of leaves) {
      const allocations = new Map(
        textures.map((texture) => [
          texture,
          this.entries.get(texture.texture_product!.identity)?.planes ??
            assignments.get(texture.texture_product!.identity)!,
        ]),
      );
      const tuple = new Set(
        [...allocations.values()].flatMap((planes) => planes.map((plane) => plane.segment)),
      );
      if (tuple.size > GPU_TEXTURE_BANK_COUNT) {
        this.failures++;
        throw new RangeError(`Material '${material.name}' exceeds 16 local slots`);
      }
      const graph = compileCanonicalMaterial(material).appearance,
        used = new Set<Segment>(),
        samplers = new Set<string>();
      for (const sample of graph.samples) {
        const product = sample.binding.texture.texture_product!,
          planes = allocations.get(sample.binding.texture)!;
        const mask = sample.readMask,
          coverage = product.metadata.planes.findIndex((plane) => plane.role === "coverage");
        if ((mask & 7) !== 0 || ((mask & 8) !== 0 && coverage < 0)) {
          used.add(planes[0]!.segment);
        }
        if ((mask & 8) !== 0 && coverage >= 0) {
          used.add(planes[coverage]!.segment);
        }
        if (
          product.metadata.semantic === "occlusion-linear" &&
          (mask & ~(1 << product.metadata.channel)) !== 0
        ) {
          throw new Error("Scalar Product lacks requested channel");
        }
        const sampler = encodeSamplerClass({
          wrapS: sample.binding.sampler[4],
          wrapT: sample.binding.sampler[5],
          minFilter: sample.binding.sampler[1],
          magFilter: sample.binding.sampler[2],
          texture_product: product,
        } as ShadeTexture);
        samplers.add(
          String(
            sampler.value &
              (GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask | GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit),
          ),
        );
      }
      const productTexture = graph.productReads?.some((read) => read.field.constant === undefined) ? 1 : 0;
      if (
        used.size + productTexture + 7 >
          Number(this.graphics.device.limits.maxSampledTexturesPerShaderStage) ||
        samplers.size + 2 > Number(this.graphics.device.limits.maxSamplersPerShaderStage)
      ) {
        this.failures++;
        throw new RangeError(
          `Material '${material.name}' full native descriptor exceeds negotiated limits before allocation`,
        );
      }
    }
    if (
      this.allocated + plans.reduce((sum, segment) => sum + segment.bytes, 0) >
      TEXTURE_RESIDENCY_BUDGET_BYTES
    ) {
      throw new RangeError("Texture transaction peak budget exceeded");
    }
    const created: Entry[] = [];
    const retained: Array<{
      material: StandardShadeMaterial;
      entry: MaterialEntry;
      prior?: MaterialEntry;
      count: number;
      created: boolean;
    }> = [];
    let rolledBack = false;
    const rollback = () => {
      if (rolledBack || this.destroyed) {
        return;
      }
      rolledBack = true;
      for (const operation of retained.reverse()) {
        if (operation.created) {
          if (this.materials.get(operation.material) === operation.entry) {
            if (operation.prior) {
              this.materials.set(operation.material, operation.prior);
            } else {
              this.materials.delete(operation.material);
            }
          }
          for (const entry of operation.entry.entries) {
            entry.refs--;
            if (entry.refs === 0 && !created.includes(entry)) {
              this.retireEntry(entry, this.graphics.device.queue.onSubmittedWorkDone());
            }
          }
          this.releaseSet(operation.entry.set);
        } else {
          operation.entry.refs -= operation.count;
          operation.entry.staging = undefined;
        }
      }
      for (const entry of created) {
        if (this.entries.get(entry.product.identity) === entry) {
          this.entries.delete(entry.product.identity);
        }
        entry.staging = undefined;
        this.quarantined.add(entry);
      }
      this.cachedBindings = undefined;
      void this.graphics.device.queue.onSubmittedWorkDone().then(
        () => {
          if (this.destroyed) {
            return;
          }
          for (const entry of created) {
            this.quarantined.delete(entry);
            this.freeEntry(entry);
          }
          for (const segment of plans) {
            this.reclaim(segment);
          }
        },
        () => {
          /* Rejected fence never grants reuse; destruction owns loss cleanup. */
        },
      );
    };
    command.onAborted.addOne(rollback);
    try {
      for (const segment of plans) {
        const base = segment.plane.mips[0]!;
        segment.texture = this.graphics.device.createTexture({
          label: `TextureResidency/${segment.id}/${segment.key}`,
          size: [base.width, base.height, segment.capacity],
          format: segment.plane.format,
          mipLevelCount: segment.plane.mips.length,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        });
        this.segments.add(segment);
        this.allocated += segment.bytes;
        this.peak = Math.max(this.peak, this.allocated);
        segment.view = segment.texture.createView({ dimension: "2d-array" });
        segment.accounting = this.graphics.resource_accounting?.created({
          kind: "texture",
          category: "resident",
          owner: "TextureResidency",
          bytes: segment.bytes,
          label: segment.texture.label,
        });
      }
      for (const product of fresh) {
        const planes = assignments.get(product.identity)!,
          mips = product.metadata.planes[0]!.mips.length;
        for (const plane of planes) {
          if (!plane.segment.free.includes(plane.layer)) {
            throw new Error("Texture reservation changed after admission");
          }
        }
        const slot = this.freeSlots.pop()!;
        const entry: Entry = {
          product,
          planes,
          slot,
          generation: this.generations[slot]!,
          refs: 0,
          retirement: 0,
          revision: this.nextRevision++,
          minMip: product.metadata.exactAlpha ? 0 : Math.min(6, mips - 1),
          staging: command,
        };
        for (const plane of planes) {
          const index = plane.segment.free.indexOf(plane.layer);
          plane.segment.free.splice(index, 1);
        }
        this.entries.set(product.identity, entry);
        created.push(entry);
        product.metadata.planes.forEach((_plane, index) => {
          writeTextureProductPlane(
            this.graphics.device,
            product,
            index,
            planes[index]!.segment.texture!,
            planes[index]!.layer,
            entry.minMip,
            (bytes) => {
              this.uploadBytes += bytes;
              this.mipUploads++;
            },
          );
        });
      }
      for (const [material, count] of counts) {
        const prior = this.materials.get(material);
        if (prior && prior.refs > 0) {
          prior.refs += count;
          prior.staging = command;
          retained.push({ material, entry: prior, count, created: false });
          continue;
        }
        const textures = leaves.get(material)!,
          entries = [
            ...new Set(textures.map((texture) => this.entries.get(texture.texture_product!.identity)!)),
          ];
        const tuple = [...new Set(entries.flatMap((entry) => entry.planes.map((plane) => plane.segment)))];
        const set = this.retainSet(tuple);
        for (const entry of entries) {
          entry.refs++;
          entry.retirement++;
        }
        const entry: MaterialEntry = {
          refs: count,
          entries,
          textures,
          set,
          retirement: 0,
          pendingReleases: 0,
          staging: command,
        };
        this.materials.set(material, entry);
        retained.push({ material, entry, prior, count, created: true });
      }
      this.cachedBindings = undefined;
      command.onFinished.addOne(() => {
        if (this.destroyed || rolledBack) {
          return;
        }
        for (const entry of created) {
          entry.staging = undefined;
          this.descriptors.set(entry.slot, entry);
        }
        for (const operation of retained) {
          operation.entry.staging = undefined;
        }
        this.onPublicationChanged.emit();
      });
      const refs = new Map<ShadeTexture, number>(),
        publications = new Map<ShadeTexture, TextureSurfacePublication>();
      const routes = new Map<StandardShadeMaterial, ReadonlyMap<ShadeTexture, number>>(),
        materialSets = new Map<StandardShadeMaterial, number>();
      for (const material of counts.keys()) {
        const owner = this.materials.get(material)!,
          local = new Map<ShadeTexture, number>();
        materialSets.set(material, owner.set.id);
        for (const texture of owner.textures) {
          const entry = this.entries.get(texture.texture_product!.identity)!,
            primary = entry.planes[0]!;
          const bank = owner.set.bankDescriptors.findIndex(
            (descriptor) => descriptor.segment === primary.segment.id,
          );
          local.set(
            texture,
            encodeGpuTextureRef(
              bank,
              primary.layer,
              entry.product.metadata.semantic === "alpha-mask" ? 1 : 0,
            ),
          );
          refs.set(texture, encodeTextureHandle(entry.slot, entry.generation));
          const ci = entry.product.metadata.planes.findIndex((plane) => plane.role === "coverage"),
            coverage = ci < 0 ? undefined : entry.planes[ci]!;
          publications.set(
            texture,
            Object.freeze({
              slot: entry.slot,
              generation: entry.generation,
              revision: entry.revision,
              get currentRevision() {
                return entry.revision;
              },
              get currentMinimumMip() {
                return entry.minMip;
              },
              ...(coverage ? { coverage: { segment: coverage.segment.id, layer: coverage.layer } } : {}),
            }),
          );
        }
        routes.set(material, local);
      }
      const residency = this;
      return Object.freeze({
        get bindings() {
          return residency.bindings();
        },
        materialBindingSetIds: materialSets,
        textureRefs: refs,
        materialTextureRoutingRefs: routes,
        get textureMipRanges() {
          return residency.mipRanges([...counts.keys()]);
        },
        surfacePublications: publications,
      });
    } catch (error) {
      rollback();
      if (!command.closed) {
        command.abort(error);
      }
      throw error;
    }
  }

  promote(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext,
    minimumMip = 0,
  ): void {
    this.assertCommand(command);
    if (!Number.isInteger(minimumMip) || minimumMip < 0 || minimumMip > 6) {
      throw new RangeError("Invalid mip target");
    }
    const entries = [
      ...new Set(materials.flatMap((material) => [...(this.materials.get(material)?.entries ?? [])])),
    ];
    const pending = entries.filter((entry) => entry.minMip > minimumMip);
    if (pending.some((entry) => entry.staging || entry.promotion)) {
      throw new Error("Texture has uncommitted upload");
    }
    command.onAborted.addOne(() => {
      for (const entry of pending) {
        if (entry.promotion === command) {
          entry.promotion = undefined;
        }
      }
    });
    try {
      for (const entry of pending) {
        entry.promotion = command;
        entry.product.metadata.planes.forEach((plane, index) => {
          const target = entry.planes[index]!;
          writeTextureProductPlane(
            this.graphics.device,
            entry.product,
            index,
            target.segment.texture!,
            target.layer,
            minimumMip,
            (bytes) => {
              this.uploadBytes += bytes;
              this.progressiveBytes += bytes;
              this.mipUploads++;
            },
          );
        });
      }
      command.onFinished.addOne(() => {
        if (this.destroyed) {
          return;
        }
        for (const entry of pending) {
          if (entry.promotion === command) {
            entry.minMip = minimumMip;
            entry.revision = this.nextRevision++;
            entry.promotion = undefined;
          }
        }
        if (pending.length) {
          this.promotionCount++;
          this.onPublicationChanged.emit();
        }
      });
    } catch (error) {
      command.abort(error);
      throw error;
    }
  }
  release(materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext): void {
    this.assertCommand(command);
    const counts = countMaterials(materials);
    const owners = new Map<StandardShadeMaterial, MaterialEntry>();
    for (const [material, count] of counts) {
      const owner = this.materials.get(material);
      if (!owner || owner.refs - owner.pendingReleases < count) {
        throw new Error("Texture material release underflow");
      }
      if (owner.staging && owner.staging !== command) {
        throw new Error("Texture material has an uncommitted transaction");
      }
      if (owner.releasing && owner.releasing !== command) {
        throw new Error("Texture material has an uncommitted release");
      }
      owners.set(material, owner);
    }
    for (const [material, count] of counts) {
      owners.get(material)!.pendingReleases += count;
      owners.get(material)!.releasing = command;
    }
    command.onAborted.addOne(() => {
      for (const [material, count] of counts) {
        const owner = owners.get(material)!;
        owner.pendingReleases -= count;
        if (owner.pendingReleases === 0) {
          owner.releasing = undefined;
        }
      }
    });
    command.onFinished.addOne(() => {
      if (this.destroyed) {
        return;
      }
      for (const [material, count] of counts) {
        const owner = owners.get(material)!;
        owner.pendingReleases -= count;
        if (owner.pendingReleases === 0) {
          owner.releasing = undefined;
        }
        owner.refs -= count;
        if (owner.refs !== 0) {
          continue;
        }
        const generation = ++owner.retirement;
        for (const entry of owner.entries) {
          entry.refs--;
          if (entry.refs !== 0) {
            continue;
          }
          this.retireEntry(entry, command.gpuDone);
        }
        void command.gpuDone.then(
          () => {
            if (this.destroyed || owner.refs !== 0 || owner.retirement !== generation) {
              return;
            }
            if (this.materials.get(material) === owner) {
              this.materials.delete(material);
            }
            this.releaseSet(owner.set);
            this.cachedBindings = undefined;
            this.onPublicationChanged.emit();
          },
          () => {
            /* Device destruction owns loss cleanup. */
          },
        );
      }
    });
  }
  bindings(): TextureResidencyBindings {
    this.assertAlive();
    return (this.cachedBindings ??= Object.freeze({
      textureCapacity: TEXTURE_HANDLE_MAX_SLOT,
      bindingSets: Object.freeze(
        [...this.sets.values()].map((value) => value.set).sort((a, b) => a.id - b.id),
      ),
    }));
  }
  descriptor(reference: number): TextureResidencyDescriptor | null {
    const handle = decodeTextureHandle(reference),
      entry = handle ? this.descriptors.get(handle.slot) : undefined;
    if (!entry || entry.generation !== handle!.generation) {
      return null;
    }
    const plane = entry.planes[0]!,
      metadata = entry.product.metadata;
    return {
      slot: entry.slot,
      generation: entry.generation,
      formatClass: plane.segment.plane.format,
      sizeClass: metadata.storageWidth,
      segment: plane.segment.id,
      layer: plane.layer,
      logicalSize: [metadata.sourceWidth, metadata.sourceHeight],
      uvScaleBias: metadata.uvScaleBias,
      residentMipRange: [entry.minMip, plane.segment.plane.mips.length - 1],
    };
  }
  private mipRanges(
    materials: readonly StandardShadeMaterial[],
  ): ReadonlyMap<ShadeTexture, readonly [number, number]> {
    const result = new Map<ShadeTexture, readonly [number, number]>();
    for (const material of materials) {
      for (const texture of this.materials.get(material)?.textures ?? []) {
        const entry = this.entries.get(texture.texture_product!.identity);
        if (entry) {
          result.set(texture, [entry.minMip, entry.product.metadata.planes[0]!.mips.length - 1]);
        }
      }
    }
    return result;
  }
  evidence() {
    const entries = [...this.entries.values(), ...this.quarantined],
      live = entries.filter((entry) => entry.refs > 0),
      retired = entries.filter((entry) => entry.refs === 0);
    const bytes = (values: Entry[]) =>
      values.reduce((sum, entry) => sum + entry.product.evidence.ownedPayloadBytes, 0);
    const distribution = new Map<GPUTextureFormat, { residentTextureCount: number; residentBytes: number }>();
    for (const entry of live) {
      for (const plane of entry.product.metadata.planes) {
        const value = distribution.get(plane.format) ?? { residentTextureCount: 0, residentBytes: 0 };
        value.residentTextureCount++;
        value.residentBytes += planeBytes(plane);
        distribution.set(plane.format, value);
      }
    }
    const packageSegments = [...this.segments].map((segment) => {
      let resident = 0,
        retiring = 0;
      for (const entry of entries) {
        for (const plane of entry.planes) {
          if (plane.segment === segment) {
            if (entry.refs > 0) {
              resident++;
            } else {
              retiring++;
            }
          }
        }
      }
      return {
        segment: segment.id,
        format: segment.plane.format,
        width: segment.plane.mips[0]!.width,
        height: segment.plane.mips[0]!.height,
        mipLevelCount: segment.plane.mips.length,
        allocatedCapacity: segment.capacity,
        residentTextureCount: resident,
        retiringTextureCount: retiring,
        freeLayerCount: segment.free.length,
        allocatedBytes: segment.bytes,
      };
    });
    return {
      schemaVersion: 7 as const,
      textureCapacity: TEXTURE_HANDLE_MAX_SLOT,
      residentTextureCount: live.length,
      retiringTextureCount: retired.length,
      pendingTextureCount: live.filter((entry) => entry.staging).length,
      pendingPromotionTextureCount: live.filter((entry) => entry.promotion).length,
      maximumResidentMinimumMip: live.reduce((mip, entry) => Math.max(mip, entry.minMip), 0),
      quarantinedTextureCount: this.quarantined.size,
      allocatedBytes: this.allocated,
      allocatedPeakBytes: this.peak,
      physicalAllocatedBytes: this.allocated,
      transactionPeakBytes: this.peak,
      descriptorBytes: 0,
      residentTextureBytes: bytes(live),
      retiringTextureBytes: bytes(retired),
      retiringBytes: bytes(retired),
      logicalResidentBytes: bytes(live),
      rgbaEquivalentResidentBytes: live.reduce(
        (sum, entry) => sum + entry.product.evidence.rgbaEquivalentBytes,
        0,
      ),
      uploadBytes: this.uploadBytes,
      copyBytes: 0,
      transcodeBytes: 0,
      directPackageCount: live.length,
      workerTranscodeCount: 0,
      uncompressedFallbackCount: 0,
      formatDistribution: [...distribution].map(([format, value]) => ({ format, ...value })),
      resizeDispatchCount: 0,
      runtimeMipGenerationCount: 0,
      cookedRuntimeMipGenerationCount: 0,
      bankCopyOperationCount: 0,
      bankGrowCount: this.nextSegmentId - 1,
      abortedBankGrowCount: 0,
      cookedResidentTextureCount: live.length,
      compressedResidentTextureCount: live.filter((entry) =>
        entry.product.metadata.planes.some((plane) => plane.format.startsWith("bc")),
      ).length,
      segmentCount: this.segments.size,
      bindingSetCount: this.sets.size,
      bindingSlotUtilization: this.sets.size
        ? [...this.sets.values()].reduce((sum, value) => sum + value.set.textureBanks.length, 0) /
          (this.sets.size * GPU_TEXTURE_BANK_COUNT)
        : 0,
      bindingSetPreflightFailures: this.failures,
      highResolutionArrayAllocated: packageSegments.some((segment) => segment.width > 256),
      banks: [],
      packageSegments,
      textureLedger: entries.flatMap((entry) =>
        entry.planes.map((plane, index) => ({
          assetIdentity: entry.product.identity,
          sourceUri: entry.product.metadata.sourceUri,
          state: entry.refs > 0 ? "resident" : "retiring",
          refCount: entry.refs,
          bankClass: index,
          segment: plane.segment.id,
          layer: plane.layer,
          sourceWidth: entry.product.metadata.sourceWidth,
          sourceHeight: entry.product.metadata.sourceHeight,
          decodedWidth: entry.product.metadata.sourceWidth,
          decodedHeight: entry.product.metadata.sourceHeight,
          gpuWidth: plane.segment.plane.mips[0]!.width,
          gpuHeight: plane.segment.plane.mips[0]!.height,
          format: plane.segment.plane.format,
          mipLevelCount: plane.segment.plane.mips.length,
          minimumResidentMip: entry.minMip,
          logicalBytes: entry.product.evidence.rgbaEquivalentBytes,
          residentBytes: planeBytes(plane.segment.plane),
          allocatedBytes: planeBytes(plane.segment.plane),
        })),
      ),
      privateSubmitCount: 0,
      progressiveMipUploadBytes: this.progressiveBytes,
      mipPromotionCount: this.promotionCount,
      mipUploadCount: this.mipUploads,
    };
  }
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.onPublicationChanged.clear();
    for (const segment of this.segments) {
      this.destroySegment(segment);
    }
    this.entries.clear();
    this.quarantined.clear();
    this.materials.clear();
    this.descriptors.clear();
    this.sets.clear();
    this.cachedBindings = undefined;
  }
  private retainSet(segments: readonly Segment[]): TextureBindingSet {
    const key = segments.map((segment) => segment.id).join(",");
    let owner = this.sets.get(key);
    if (!owner) {
      const id = this.freeSetIds.pop() ?? this.nextSetId++;
      const set: TextureBindingSet = Object.freeze({
        id,
        generation: this.nextRevision++,
        textureBanks: Object.freeze(segments.map((segment) => segment.view!)),
        bankDescriptors: Object.freeze(
          segments.map((segment, bindingSlot) => ({
            bindingSlot,
            formatClass: segment.plane.format,
            sizeClass: segment.plane.mips[0]!.width,
            segment: segment.id,
          })),
        ),
        textureBankMask: (1 << segments.length) - 1 || 1,
      });
      owner = { set, refs: 0 };
      this.sets.set(key, owner);
    }
    owner.refs++;
    return owner.set;
  }
  private releaseSet(set: TextureBindingSet): void {
    for (const [key, owner] of this.sets) {
      if (owner.set === set) {
        if (--owner.refs === 0) {
          this.sets.delete(key);
          this.freeSetIds.push(set.id);
        }
        return;
      }
    }
  }
  private freeEntry(entry: Entry): void {
    this.descriptors.delete(entry.slot);
    this.generations[entry.slot] = nextTextureHandleGeneration(entry.generation);
    this.freeSlots.push(entry.slot);
    for (const plane of entry.planes) {
      plane.segment.free.push(plane.layer);
      this.reclaim(plane.segment);
    }
  }
  private retireEntry(entry: Entry, fence: Promise<void>): void {
    const retirement = ++entry.retirement;
    void fence.then(
      () => {
        if (
          this.destroyed ||
          entry.refs !== 0 ||
          entry.retirement !== retirement ||
          this.entries.get(entry.product.identity) !== entry
        ) {
          return;
        }
        this.entries.delete(entry.product.identity);
        this.freeEntry(entry);
      },
      () => {
        /* Rejected completion never grants reuse. */
      },
    );
  }
  private reclaim(segment: Segment): void {
    if (segment.free.length === segment.capacity - 1 && this.segments.has(segment)) {
      this.destroySegment(segment);
    }
  }
  private destroySegment(segment: Segment): void {
    if (!this.segments.delete(segment)) {
      return;
    }
    segment.texture?.destroy();
    if (segment.accounting) {
      this.graphics.resource_accounting?.destroyed(segment.accounting);
    }
    this.allocated -= segment.bytes;
  }
  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error("TextureResidency destroyed");
    }
  }
  private assertCommand(command: ShadeGPUCommandContext): void {
    this.assertAlive();
    if (command.closed || command.device !== this.graphics.device) {
      throw new Error("Texture Residency requires an open same-device transaction");
    }
  }
}
export type TextureResidencyEvidence = ReturnType<TextureResidency["evidence"]>;
function countMaterials(materials: readonly StandardShadeMaterial[]) {
  const counts = new Map<StandardShadeMaterial, number>();
  for (const material of materials) {
    counts.set(material, (counts.get(material) ?? 0) + 1);
  }
  return counts;
}
function planeBytes(plane: TextureProductPlane) {
  return plane.mips.reduce((sum, mip) => sum + mip.byteLength, 0);
}
function segmentKey(plane: TextureProductPlane) {
  return `${plane.format}/${plane.mips[0]!.width}/${plane.mips[0]!.height}/${plane.mips.length}`;
}
function sameTextures(a: readonly ShadeTexture[], b: readonly ShadeTexture[]) {
  return a.length === b.length && a.every((texture, index) => texture === b[index]);
}
function validateUpload(product: TextureProduct, limits: GPUSupportedLimits): void {
  assertValidatedTextureProduct(product);
  const metadata = product.metadata;
  if (
    metadata.schemaVersion !== 3 ||
    metadata.storageWidth > Number(limits.maxTextureDimension2D) ||
    metadata.storageHeight > Number(limits.maxTextureDimension2D)
  ) {
    throw new RangeError("Texture Product/device shape admission failed");
  }
  for (const plane of metadata.planes) {
    for (const mip of plane.mips) {
      if (product.chunks.get(mip.chunkId)?.byteLength !== mip.byteLength) {
        throw new Error("Texture upload chunks missing/detached");
      }
    }
  }
}
