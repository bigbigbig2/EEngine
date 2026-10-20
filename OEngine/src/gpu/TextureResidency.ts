import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../material/CanonicalMaterial.js";
import { materialTextureLeaves } from "../assets/PcMaterialTextures.js";
import type { ImageTextureSource } from "../assets/ImageTextureSource.js";
import { imageTextureResidentLayout, type ImageTextureResidentLayout } from "./ImageTextureLayout.js";
import { imageGpuFormat, type ImageRecordCommand, type ImageTextureTranscoder } from "./ImageTextureTranscoder.js";
import { VirtualTextureResidency } from "./VirtualTextureResidency.js";
import type { VirtualTextureRoute } from "./VirtualTextureAbi.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { TextureSurfacePublication } from "./TextureSurfacePublication.js";
import { Signal } from "../core/Signal.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import { encodeGpuTextureRef, GPU_TEXTURE_BANK_COUNT, GPU_TEXTURE_REF_INVALID } from "./GpuTextureRefAbi.js";
import {
  decodeTextureHandle,
  encodeTextureHandle,
  nextTextureHandleGeneration,
  TEXTURE_HANDLE_MAX_SLOT,
} from "./TextureHandleAbi.js";
import type { ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { textureBindingSetPolicy } from "./TextureBindingSetPolicy.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_SAMPLER } from "./GpuMaterialVisibilityAbi.js";
import { selectAppearanceProductProgram } from "../material/AppearanceGraphCompiler.js";
import { ShadeTransparencyMode } from "../material/enums.js";

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
  readonly plane: ImageTextureResidentLayout;
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
  readonly layout: ImageTextureResidentLayout;
}
interface ResidentSource {
  readonly identity: string;
  readonly source: ImageTextureSource;
  readonly planes: readonly ImageTextureResidentLayout[];
}
interface Entry {
  readonly product: ResidentSource;
  readonly virtual?: ReadonlyMap<number, VirtualTextureRoute>;
  bootstrap?: { command: ShadeGPUCommandContext; ready: Promise<void>; complete: boolean };
  readonly slot: number;
  readonly generation: number;
  readonly planes: readonly PlaneAllocation[];
  refs: number;
  revision: number;
  minMip: number;
  retirement: number;
  staging?: ShadeGPUCommandContext;
  promotion?: ShadeGPUCommandContext;
  /** Committed copy cursor for the next finer mip; never a sampling clamp. */
  upload?: { mip: number; plane: number; row: number };
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

export interface TextureQueryLease {
  readonly valid: boolean;
  release(): void;
  releaseAfter(completion: PromiseLike<void>): Promise<void>;
}

/** Sole material GPU owner. Immutable segments follow batch demand. Uploads
 * and sampling clamps share a command transaction; retirement waits for its
 * actual queue fence. Handles and material tuples are CPU-owned. */
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
  private uploadCursor = 0;
  private stagingBytes = 0;
  private stagingPeakBytes = 0;
  private copyOperations = 0;
  private physicalCopyBytes = 0;
  private committedUploadBytes = 0;
  private destroyed = false;
  private cachedBindings?: TextureResidencyBindings;
  private readonly imageSources = new WeakMap<ImageTextureSource, ResidentSource>();
  private transcoder: ImageTextureTranscoder | undefined;
  private virtualValue: VirtualTextureResidency | null = null;
  get virtualTextures(): VirtualTextureResidency | null {
    return this.virtualValue;
  }
  private source(texture: ShadeTexture): ResidentSource {
    const image = texture.image_source;
    if (!image) throw new Error("Material texture requires a schema4 image source before staging");
    let product = this.imageSources.get(image);
    if (!product) {
      const planes = image.directory.planes.flatMap((plane, index) => plane.mode === "resident"
        ? [imageTextureResidentLayout(image.directory, index, this.graphics.device.limits,
            this.graphics.device.features.has("texture-compression-unaligned" as GPUFeatureName))]
        : []);
      product = { identity: image.identity, source: image, planes };
      this.imageSources.set(image, product);
    }
    return product;
  }

  async prepare(): Promise<void> {
    this.transcoder ??= await this.graphics.prepareImageTranscoder();
  }
  constructor(
    private readonly graphics: GraphicsContext,
    private readonly virtualSettings?: Partial<import("./VirtualTextureAbi.js").VirtualTextureSettings>,
  ) {
    if (!graphics.device.features.has("texture-compression-bc")) {
      throw new Error("PC TextureResidency requires texture-compression-bc");
    }
    textureBindingSetPolicy(graphics.device.limits);
    for (let slot = TEXTURE_HANDLE_MAX_SLOT; slot >= 1; slot--) {
      this.freeSlots.push(slot);
    }
  }

  private virtualRoute(texture: ShadeTexture, entry: Entry): VirtualTextureRoute | undefined {
    const source = entry.product.source;
    const sampler = encodeSamplerClass(texture).value;
    const address = (value: number) => value === 0 ? "clamp-to-edge" : value === 2 ? "mirror-repeat" : "repeat";
    const expectedU = address(sampler & GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask);
    const expectedV = address((sampler >> GPU_MATERIAL_VISIBILITY_SAMPLER.AddressVBits) & GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask);
    const plane = source.directory.planes[0]!;
    if (plane.addressU !== expectedU || plane.addressV !== expectedV) {
      throw new Error("VT sampler and immutable image address recipe disagree; recook required");
    }
    const route = entry.virtual?.get(0);
    if (!route) throw new Error("Virtual primary image route is absent");
    return route;
  }

  /** The scene owner submits hidden bounded batches; this owner only records.
   * Publication stays on the original scene command after every mandatory input. */
  async uploadImages(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext,
    batch: (record: (command: ImageRecordCommand) => void) => Promise<void>
  ): Promise<void> {
    const entries = new Set(materials.flatMap((material) => this.materials.get(material)?.entries ?? []));
    if (entries.size === 0) return;
    await this.prepare();
    this.assertCommand(command);
    const abort = new AbortController();
    command.onAborted.addOne(() => abort.abort());
    // Serial recording bounds shared scratch even for many simultaneous scene requests.
    for (const entry of entries) {
      if (!entry.staging) continue;
      if (entry.bootstrap) {
        if (entry.bootstrap.command !== command) throw new Error("Image bootstrap belongs to another transaction");
        await entry.bootstrap.ready;
        continue;
      }
      const bootstrap = { command, complete: false, ready: Promise.resolve() };
      entry.bootstrap = bootstrap;
      bootstrap.ready = (async () => {
        const source = entry.product.source;
        if (entry.virtual) {
          await this.virtualValue!.bootstrap(source, command, batch, abort.signal);
        }
        for (const allocation of entry.planes) {
          const layout = allocation.layout;
          const profile = source.directory.planes[layout.plane]!;
          const items = source.directory.items.filter((item) => item.plane === layout.plane);
          for (const item of items) {
            const leases = await source.read([item.id], abort.signal, 0);
            const lease = leases[0]!;
            try {
              if (command.closed || this.destroyed) throw new Error("Image bootstrap was cancelled");
              const destinations = (profile.mips === "runtime" ? layout.levels : [layout.levels[item.mip]!])
                .map((level) => ({ texture: allocation.segment.texture!, mip: level.mip,
                  layer: allocation.layer, x: item.x, y: item.y }));
              await batch((hidden) => {
                if (command.closed || this.destroyed) throw new Error("Image bootstrap was cancelled before recording");
                if (profile.target === "r8") {
                  this.transcoder!.recordExact(hidden, lease, destinations[0]!);
                } else if (this.transcoder!.record(hidden, lease, destinations) !== "recorded") {
                  throw new RangeError("Complete resident image cannot fit an empty hidden batch");
                }
              });
              this.mipUploads += destinations.length;
              const bytes = profile.mips === "runtime" ? layout.bytesPerLayer : layout.levels[item.mip]!.bytes;
              this.uploadBytes += bytes;
              this.physicalCopyBytes += bytes;
              this.copyOperations += destinations.length;
            } finally {
              for (const input of leases) input.close();
            }
          }
        }
        if (command.closed || this.destroyed) throw new Error("Image bootstrap was cancelled");
        bootstrap.complete = true;
        command.onFinished.addOne(() => {
          this.committedUploadBytes += entry.product.planes.reduce((sum, plane) => sum + plane.bytesPerLayer, 0);
        });
      })();
      await bootstrap.ready;
    }
  }

  stage(materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext): TextureResidencyStage {
    this.assertCommand(command);
    const counts = countMaterials(materials);
    const leaves = new Map<StandardShadeMaterial, readonly ShadeTexture[]>();
    const products = new Map<string, ResidentSource>();
    const criticalProducts = new Set<string>();
    for (const material of counts.keys()) {
      const textures = materialTextureLeaves(material);
      leaves.set(material, textures);
      if (material.transparency_mode === ShadeTransparencyMode.AlphaTested) {
        const graph = compileCanonicalMaterial(material).appearance;
        const coverage = selectAppearanceProductProgram(graph, { alpha: graph.outputs.alpha! });
        for (const sample of coverage.samples) {
          const image = sample.binding.texture.image_source;
          if (image) {
            const coverage = image.directory.planes.some((plane) => plane.semantic === "exact-r");
            if (((sample.readMask & 7) !== 0 || ((sample.readMask & 8) !== 0 && !coverage)) &&
                image.directory.planes[0]!.mode === "virtual") {
              throw new Error("Alpha/UV dependency requires a resident primary plane; recook required");
            }
            criticalProducts.add(image.identity);
          }
        }
      }
      for (const texture of textures) {
        const product = this.source(texture);
        products.set(product.identity, product);
        const entry = this.entries.get(product.identity);
        if (entry?.staging && entry.staging !== command) {
          throw new Error("Texture has an uncommitted transaction");
        }
        if (entry?.promotion) {
          throw new Error("Texture has an uncommitted promotion");
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
      Array<{ product: ResidentSource; index: number; plane: ImageTextureResidentLayout }>
    >();
    for (const product of fresh) {
      assignments.set(product.identity, []);
      product.planes.forEach((plane, index) => {
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
          assignments.get(item.product.identity)![item.index] = { segment, layer: free.pop()!, layout: item.plane };
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
          bytes: plane.bytesPerLayer * (length + 1),
          free: Array.from({ length }, (_, index) => length - index),
        };
        plans.push(segment);
        for (let layer = 1; layer <= length; layer++) {
          const item = group[position++]!;
          assignments.get(item.product.identity)![item.index] = { segment, layer, layout: item.plane };
        }
      }
    }
    // Full lit descriptor admission is CPU-only, before allocation or writes.
    for (const [material, textures] of leaves) {
      const allocations = new Map(
        textures.map((texture) => [
          texture,
          this.entries.get(this.source(texture).identity)?.planes ??
            assignments.get(this.source(texture).identity)!,
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
        const product = this.source(sample.binding.texture),
          planes = allocations.get(sample.binding.texture)!;
        if ((sample.readMask & 8) !== 0 && product.source.directory.planes.some((plane) =>
          plane.semantic === "exact-r" && plane.mode !== "resident")) {
          throw new Error("Material exact alpha requires a resident coverage plane; recook required");
        }
        const mask = sample.readMask;
        const coverage = product.planes.findIndex((plane) => plane.format === "r8unorm");
        const primary = product.planes.findIndex((plane) => plane.plane === 0);
        if (((mask & 7) !== 0 || ((mask & 8) !== 0 && coverage < 0)) && primary >= 0) {
          used.add(planes[primary]!.segment);
        }
        if ((mask & 8) !== 0 && coverage >= 0) used.add(planes[coverage]!.segment);
        const sampler = encodeSamplerClass({
          wrapS: sample.binding.sampler[4],
          wrapT: sample.binding.sampler[5],
          minFilter: sample.binding.sampler[1],
          magFilter: sample.binding.sampler[2],
          image_source: sample.binding.texture.image_source,
        } as ShadeTexture);
        samplers.add(
          String(
            sampler.value &
              (GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask |
                (GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask << GPU_MATERIAL_VISIBILITY_SAMPLER.AddressVBits) |
                GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit),
          ),
        );
      }
      const productTexture = graph.productReads?.some((read) => read.field.constant === undefined) ? 1 : 0;
      const virtualFormats = new Set(
        graph.samples.flatMap((sample) => {
          const image = sample.binding.texture.image_source;
          return image?.directory.planes.filter((plane) => plane.mode === "virtual")
            .map((plane) => imageGpuFormat(plane.semantic)) ?? [];
        }),
      );
      if (
        // Final Pixel providers: Visibility, three IBL, VSM depth and AO.
        // Solar/GI share the existing directory, with no sampled binding.
        used.size + productTexture + (virtualFormats.size ? virtualFormats.size + 1 : 0) + 6 >
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
      // A publication abort does not stop an already submitted hidden batch.
      // Do not return its destination layers while its producer is unwinding.
      const producersStopped = Promise.all(created.map((entry) =>
        entry.bootstrap?.ready.then(() => undefined, () => undefined)));
      void producersStopped
        .then(() => this.graphics.device.queue.onSubmittedWorkDone())
        .then(() => Promise.all(created.map((entry) => entry.virtual
          ? this.virtualValue?.release(entry.product.source, Promise.resolve())
          : undefined)))
        .then(
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
        segment.texture = this.graphics.device.createTexture({
          label: `TextureResidency/${segment.id}/${segment.key}`,
          size: [segment.plane.width, segment.plane.height, segment.capacity],
          format: segment.plane.format,
          mipLevelCount: segment.plane.mipCount,
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
          mips = product.source.directory.mipCount;
        for (const plane of planes) {
          if (!plane.segment.free.includes(plane.layer)) {
            throw new Error("Texture reservation changed after admission");
          }
        }
        if (!this.transcoder) throw new Error("Prepare image pipelines before staging scene resources");
        const virtual = product.source.directory.planes.some((plane) => plane.mode === "virtual")
          ? (this.virtualValue ??= new VirtualTextureResidency(this.graphics, this.transcoder, this.virtualSettings))
              .stage(product.source, command)
          : undefined;
        const slot = this.freeSlots.pop()!;
        const entry: Entry = {
          product,
          ...(virtual ? { virtual } : {}),
          planes,
          slot,
          generation: this.generations[slot]!,
          refs: 0,
          retirement: 0,
          revision: this.nextRevision++,
          minMip: 0,
          staging: command,
        };
        {
          command.onBeforeFinish.addOne(() => {
            if (!entry.bootstrap?.complete) {
              throw new Error("Scene cannot publish before mandatory texture/tail upload completes");
            }
          });
        }
        for (const plane of planes) {
          const index = plane.segment.free.indexOf(plane.layer);
          plane.segment.free.splice(index, 1);
        }
        this.entries.set(product.identity, entry);
        created.push(entry);
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
          entries = [...new Set(textures.map((texture) => this.entries.get(this.source(texture).identity)!))];
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
          const entry = this.entries.get(this.source(texture).identity)!,
            primary = entry.planes.find((plane) => plane.layout.plane === 0);
          const bank = owner.set.bankDescriptors.findIndex(
            (descriptor) => descriptor.segment === primary?.segment.id,
          );
          local.set(
            texture,
            primary && !entry.virtual
              ? encodeGpuTextureRef(
                  bank,
                  primary.layer,
                  0,
                )
              : GPU_TEXTURE_REF_INVALID,
          );
          refs.set(texture, encodeTextureHandle(entry.slot, entry.generation));
          const ci = entry.product.planes.findIndex((plane) => plane.format === "r8unorm"),
            coverage = ci < 0 ? undefined : entry.planes[ci]!;
          publications.set(
            texture,
            Object.freeze({
              ...(entry.virtual ? { virtual: this.virtualRoute(texture, entry) } : {}),
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

  /** No preview is published in the initial schema4 profile: all mandatory mips
   * are prepared hidden. Frame refinement has no work until an explicit preview product. */
  promote(_materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext,
    _minimumMip = 0, _maxBytes = 4 * 1024 ** 2): void {
    this.assertCommand(command);
  }
  /** Retains the exact current allocations, not mutable material identity. The
   * same queue orders finer-mip uploads; coverage uses its resident closure. */
  retainQuery(materials: readonly StandardShadeMaterial[]): TextureQueryLease {
    this.assertAlive();
    const entries = new Set<Entry>();
    for (const material of materials) {
      const owner = this.materials.get(material);
      if (
        owner === undefined ||
        owner.staging !== undefined ||
        owner.releasing !== undefined ||
        owner.refs === 0
      ) {
        throw new Error("Query textures require a committed resident material tuple");
      }
      for (const entry of owner.entries) {
        entries.add(entry);
      }
    }
    for (const entry of entries) {
      entry.refs++;
    }
    let released = false;
    let poisoned = false;
    const owner = this;
    const release = () => {
      // A rejected completion is not permission to recycle a physical layer.
      // Keep these references until the residency owner tears down the device.
      if (released || poisoned) {
        return;
      }
      released = true;
      if (this.destroyed) {
        return;
      }
      for (const entry of entries) {
        entry.refs--;
        if (entry.refs === 0) {
          this.retireEntry(entry, Promise.resolve());
        }
      }
    };
    return Object.freeze({
      get valid() {
        return !released && !poisoned && !owner.destroyed;
      },
      release,
      releaseAfter: async (completion: PromiseLike<void>) => {
        try {
          await completion;
        } catch (error) {
          poisoned = true;
          throw error;
        }
        release();
      },
    });
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
  /** Scalar owner epoch for material consumers; no ledger/bank enumeration. */
  get publicationRevision(): number {
    return this.nextRevision;
  }
  /** No bank/ledger allocation; only queried by active refinement observation. */
  fullyResident(materials: readonly StandardShadeMaterial[]): boolean {
    for (const material of materials) {
      for (const entry of this.materials.get(material)?.entries ?? []) {
        if (entry.minMip !== 0 || entry.staging || entry.promotion) {
          return false;
        }
      }
    }
    return true;
  }
  descriptor(reference: number): TextureResidencyDescriptor | null {
    const handle = decodeTextureHandle(reference),
      entry = handle ? this.descriptors.get(handle.slot) : undefined;
    if (!entry || entry.generation !== handle!.generation) {
      return null;
    }
    const plane = entry.planes[0];
    if (!plane) {
      return null;
    }
    const metadata = entry.product.source.directory;
    return {
      slot: entry.slot,
      generation: entry.generation,
      formatClass: plane.segment.plane.format,
      sizeClass: plane.segment.plane.width,
      segment: plane.segment.id,
      layer: plane.layer,
      logicalSize: [metadata.width, metadata.height],
      uvScaleBias: [1, 1, 0, 0],
      residentMipRange: [entry.minMip, plane.segment.plane.mipCount - 1],
    };
  }
  private mipRanges(
    materials: readonly StandardShadeMaterial[],
  ): ReadonlyMap<ShadeTexture, readonly [number, number]> {
    const result = new Map<ShadeTexture, readonly [number, number]>();
    for (const material of materials) {
      for (const texture of this.materials.get(material)?.textures ?? []) {
        const entry = this.entries.get(this.source(texture).identity);
        if (entry) {
          result.set(texture, [
            entry.minMip,
            entry.product.source.directory.mipCount - 1,
          ]);
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
      values.reduce(
        (sum, entry) =>
          sum + entry.planes.reduce((total, plane) => total + plane.segment.plane.bytesPerLayer, 0),
        0,
      );
    const distribution = new Map<GPUTextureFormat, { residentTextureCount: number; residentBytes: number }>();
    for (const entry of live) {
      for (const plane of entry.product.planes) {
        const value = distribution.get(plane.format) ?? { residentTextureCount: 0, residentBytes: 0 };
        value.residentTextureCount++;
        value.residentBytes += plane.bytesPerLayer;
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
        width: segment.plane.width,
        height: segment.plane.height,
        mipLevelCount: segment.plane.mipCount,
        allocatedCapacity: segment.capacity,
        residentTextureCount: resident,
        retiringTextureCount: retiring,
        freeLayerCount: segment.free.length,
        allocatedBytes: segment.bytes,
      };
    });
    return {
      schemaVersion: 7 as const,
      virtual: this.virtualValue?.evidence() ?? null,
      textureCapacity: TEXTURE_HANDLE_MAX_SLOT,
      residentTextureCount: live.length,
      retiringTextureCount: retired.length,
      pendingTextureCount: live.filter((entry) => entry.staging).length,
      pendingPromotionTextureCount: live.filter((entry) => entry.promotion).length,
      refiningTextureCount: live.filter((entry) => entry.minMip > 0).length,
      stagingBytes: this.stagingBytes,
      stagingPeakBytes: this.stagingPeakBytes,
      uploadCopyOperations: this.copyOperations,
      physicalCopyBytes: this.physicalCopyBytes,
      committedUploadBytes: this.committedUploadBytes,
      frameUploadBudgetBytes: (4 * 1024 ** 2),
      uploadInFlightBudgetBytes: (16 * 1024 ** 2),
      bootstrapUploadBudgetBytes: (48 * 1024 ** 2),
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
        (sum, entry) => sum + entry.product.source.directory.width * entry.product.source.directory.height * 4 * 4 / 3,
        0,
      ),
      uploadBytes: this.uploadBytes,
      copyBytes: this.uploadBytes,
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
        entry.product.planes.some((plane) => plane.format.startsWith("bc")),
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
          sourceUri: entry.product.source.url,
          state: entry.refs > 0 ? "resident" : "retiring",
          refCount: entry.refs,
          bankClass: index,
          segment: plane.segment.id,
          layer: plane.layer,
          sourceWidth: entry.product.source.directory.width,
          sourceHeight: entry.product.source.directory.height,
          decodedWidth: entry.product.source.directory.width,
          decodedHeight: entry.product.source.directory.height,
          gpuWidth: plane.segment.plane.width,
          gpuHeight: plane.segment.plane.height,
          format: plane.segment.plane.format,
          mipLevelCount: plane.segment.plane.mipCount,
          minimumResidentMip: entry.minMip,
          logicalBytes: entry.product.source.directory.width * entry.product.source.directory.height * 4,
          residentBytes: plane.segment.plane.bytesPerLayer,
          allocatedBytes: plane.segment.plane.bytesPerLayer,
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
    this.virtualValue?.destroy();
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
            sizeClass: segment.plane.width,
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
    if (entry.virtual && this.virtualValue) {
      const virtual = this.virtualValue;
      virtual.releaseCompleted(entry.product.source);
      if (virtual.sourceCount === 0 && this.virtualValue === virtual) {
        virtual.destroy();
        this.virtualValue = null;
      }
    }
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
function segmentKey(plane: ImageTextureResidentLayout) {
  return `${plane.format}/${plane.width}/${plane.height}/${plane.mipCount}`;
}
function sameTextures(a: readonly ShadeTexture[], b: readonly ShadeTexture[]) {
  return a.length === b.length && a.every((texture, index) => texture === b[index]);
}
