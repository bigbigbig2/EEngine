import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../material/CanonicalMaterial.js";
import { materialTextureLeaves } from "../assets/PcMaterialTextures.js";
import {
  assertValidatedTextureProduct,
  type TextureProduct,
  type TextureProductPlane,
  type TextureProductMip,
  type TextureProductMetadata
} from "../assets/TextureProduct.js";
import type { TiledTextureSource } from "../assets/TiledTextureSource.js";
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
  TEXTURE_HANDLE_MAX_SLOT
} from "./TextureHandleAbi.js";
import type { ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { textureBindingSetPolicy } from "./TextureBindingSetPolicy.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_SAMPLER } from "./GpuMaterialVisibilityAbi.js";
import { selectAppearanceProductProgram } from "../material/AppearanceGraphCompiler.js";
import { ShadeTransparencyMode } from "../material/enums.js";
import { loadAssetBatch } from "../assets/AssetLoadBatch.js";

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
/** Resident plane projection. This is not a partially validated TextureProduct:
 * tiled payloads are borrowed from provider leases only while copying. */
interface ResidentSource {
  readonly identity: string;
  readonly metadata: TextureProductMetadata;
  readonly chunks: ReadonlyMap<string, Uint8Array>;
  readonly evidence: Pick<TextureProduct["evidence"], "ownedPayloadBytes" | "rgbaEquivalentBytes">;
  readonly tiled?: TiledTextureSource;
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
interface TextureCopy {
  readonly entry: Entry;
  readonly plane: number;
  readonly mip: TextureProductMip;
  readonly row: number;
  readonly rows: number;
  readonly rowBytes: number;
  readonly pitch: number;
}

const TEXTURE_FRAME_UPLOAD_BYTES = 4 * 1024 ** 2;
const TEXTURE_UPLOAD_IN_FLIGHT_BYTES = 16 * 1024 ** 2;
const TEXTURE_BOOTSTRAP_UPLOAD_BYTES = 256 * 1024 ** 2;
const TEXTURE_COPY_BYTES = 256 * 1024;
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
  private readonly refining = new Set<Entry>();
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
  private readonly tiledSources = new WeakMap<TiledTextureSource, ResidentSource>();
  private virtualValue: VirtualTextureResidency | null = null;
  get virtualTextures(): VirtualTextureResidency | null {
    return this.virtualValue;
  }
  private source(texture: ShadeTexture): ResidentSource {
    const tiled = texture.tiled_source;
    if (!tiled) {
      const product = texture.texture_product;
      if (!product) {
        throw new Error("Material texture requires a final cooked source before GPU staging");
      }
      validateUpload(product, this.graphics.device.limits);
      return product;
    }
    let source = this.tiledSources.get(tiled);
    if (!source) {
      const planes = tiled.metadata.planes.filter((_, index) =>
        tiled.directory.metadata.planes.some(
          (profile) => profile.sourcePlane === index && profile.mode === "resident"
        )
      );
      if (
        planes.some(
          (plane) =>
            plane.mips[0]!.physicalWidth > this.graphics.device.limits.maxTextureDimension2D ||
            plane.mips[0]!.physicalHeight > this.graphics.device.limits.maxTextureDimension2D
        )
      ) {
        throw new RangeError("Mandatory resident texture exceeds device dimensions");
      }
      source = {
        identity: tiled.identity,
        metadata: { ...tiled.metadata, planes },
        chunks: new Map(),
        evidence: {
          ownedPayloadBytes: 0,
          rgbaEquivalentBytes: planes.reduce(
            (sum, plane) => sum + plane.mips.reduce((n, mip) => n + mip.width * mip.height * 4, 0),
            0
          )
        },
        tiled
      };
      this.tiledSources.set(tiled, source);
    }
    return source;
  }
  constructor(
    private readonly graphics: GraphicsContext,
    private readonly virtualSettings?: Partial<import("./VirtualTextureAbi.js").VirtualTextureSettings>
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
    const source = entry.product.tiled!;
    const samplerAddress = encodeSamplerClass(texture).value & GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask;
    const address = samplerAddress === 0 ? "clamp" : samplerAddress === 2 ? "mirror" : "repeat";
    // The sampler ABI admits only matching S/T addressing; reject a cold
    // recipe mismatch instead of sampling gutters for a different address.
    const index = source.directory.metadata.planes.findIndex(
      (profile) => profile.mode === "virtual" && profile.sourcePlane === 0 && profile.address === address
    );
    const route = entry.virtual?.get(index);
    if (!route) {
      throw new Error(`VT directory lacks '${address}' source-plane profile; recook required`);
    }
    return route;
  }

  /** Mandatory planes and protected tails only. Fine pages never enter this
   * preparation barrier. The caller submits the existing scene transaction. */
  async uploadTiled(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext
  ): Promise<void> {
    const entries = new Set(materials.flatMap((material) => this.materials.get(material)?.entries ?? []));
    const tasks: Promise<void>[] = [];
    const pending: { entry: Entry; bootstrap: NonNullable<Entry["bootstrap"]> }[] = [];
    const abort = new AbortController();
    command.onAborted.addOne(() => abort.abort());
    // Four entry jobs share the existing provider's IO/byte/Worker admission.
    // GPU staging retains the same aggregate limit and scene transaction.
    for (const entry of entries) {
      const source = entry.product.tiled;
      if (!source || !entry.staging) {
        continue;
      }
      if (entry.bootstrap) {
        if (entry.bootstrap.command !== command) {
          throw new Error("Tiled bootstrap belongs to another transaction");
        }
        tasks.push(entry.bootstrap.ready);
        continue;
      }
      const bootstrap = { command, complete: false, ready: Promise.resolve() };
      entry.bootstrap = bootstrap;
      command.onBeforeFinish.addOne(() => {
        if (!bootstrap.complete) {
          throw new Error("Scene cannot publish before mandatory texture/tail upload completes");
        }
      });
      pending.push({ entry, bootstrap });
    }
    const ready = loadAssetBatch(pending, 4, abort.signal, async ({ entry, bootstrap }, _index, signal) => {
      const source = entry.product.tiled!;
      if (entry.virtual) {
        await this.virtualValue!.bootstrap(source, command, signal);
      }
      for (const [index, plane] of entry.product.metadata.planes.entries()) {
        const sourcePlane = source.metadata.planes.indexOf(plane);
        const profile = source.directory.metadata.planes.find(
          (value) => value.mode === "resident" && value.sourcePlane === sourcePlane
        )!;
        for (const mip of plane.mips) {
          const rowBytes = textureRowBytes(plane, mip);
          const pitch = Math.ceil(rowBytes / 256) * 256;
          const totalRows = mip.byteLength / rowBytes;
          let row = 0;
          let column = 0;
          let slab: ReturnType<TextureResidency["residentSlab"]> | undefined;
          for (const payload of profile.mips[mip.level]!.payloads) {
            const lease = await source.read([payload], signal, 0);
            try {
              if (command.closed || this.destroyed) {
                throw new Error("Mandatory texture bootstrap was cancelled");
              }
              const bytes = new Uint8Array(lease.payloads[0]!.bytes);
              let offset = 0;
              while (offset < bytes.length) {
                slab ??= this.residentSlab(
                  command,
                  Math.min(totalRows - row, Math.floor(TEXTURE_COPY_BYTES / pitch)),
                  pitch
                );
                const count = Math.min(rowBytes - column, bytes.length - offset);
                slab.mapped.set(bytes.subarray(offset, offset + count), slab.row * pitch + column);
                offset += count;
                column += count;
                if (column === rowBytes) {
                  column = 0;
                  slab.row++;
                  row++;
                  if (slab.row === slab.rows) {
                    const block = plane.format === "r8unorm" ? 1 : 4;
                    slab.buffer.unmap();
                    command.copyBufferToTexture(
                      { buffer: slab.buffer, bytesPerRow: pitch, rowsPerImage: slab.rows },
                      {
                        texture: entry.planes[index]!.segment.texture!,
                        mipLevel: mip.level,
                        origin: [0, (row - slab.rows) * block, entry.planes[index]!.layer]
                      },
                      [mip.physicalWidth, slab.rows * block, 1]
                    );
                    const size = slab.rows * rowBytes;
                    this.uploadBytes += size;
                    this.physicalCopyBytes += slab.rows * pitch;
                    this.copyOperations++;
                    command.onFinished.addOne(() => {
                      this.committedUploadBytes += size;
                    });
                    slab = undefined;
                  }
                }
              }
            } finally {
              lease.release();
            }
          }
          if (row !== totalRows || column !== 0 || slab) {
            throw new Error("Mandatory fragments do not cover the complete mip");
          }
          this.mipUploads++;
        }
      }
      bootstrap.complete = true;
    }).then(() => undefined);
    for (const { bootstrap } of pending) {
      bootstrap.ready = ready;
    }
    tasks.push(ready);
    await Promise.all(tasks);
  }

  private residentSlab(command: ShadeGPUCommandContext, rows: number, pitch: number) {
    const size = rows * pitch;
    if (!rows || size > TEXTURE_COPY_BYTES || this.stagingBytes + size > TEXTURE_BOOTSTRAP_UPLOAD_BYTES) {
      throw new RangeError("Mandatory texture bootstrap staging capacity exceeded");
    }
    const buffer = this.graphics.device.createBuffer({
      label: "TextureResidency/mandatory fragments",
      size,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true
    });
    const accounting = this.graphics.resource_accounting?.created({
      kind: "buffer",
      category: "transient",
      owner: "TextureResidency/mandatory",
      bytes: size
    });
    this.stagingBytes += size;
    this.stagingPeakBytes = Math.max(this.stagingPeakBytes, this.stagingBytes);
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.stagingBytes -= size;
      buffer.destroy();
      if (accounting) {
        this.graphics.resource_accounting?.destroyed(accounting);
      }
    };
    command.onAborted.addOne(release);
    command.onFinished.addOne(() => {
      void command.gpuDone.then(release, release);
    });
    return { buffer, mapped: new Uint8Array(buffer.getMappedRange()), rows, row: 0 };
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
          const tiled = sample.binding.texture.tiled_source;
          if (tiled) {
            const requiresPrimary =
              (sample.readMask & 7) !== 0 ||
              ((sample.readMask & 8) !== 0 &&
                !tiled.metadata.planes.some((plane) => plane.role === "coverage"));
            if (
              requiresPrimary &&
              tiled.directory.metadata.planes.some(
                (profile) => profile.sourcePlane === 0 && profile.mode === "virtual"
              )
            ) {
              throw new Error(
                "Alpha/UV dependency requires a resident primary plane; recook with residentRoles"
              );
            }
          }
          if (sample.binding.texture.texture_product) {
            criticalProducts.add(sample.binding.texture.texture_product.identity);
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
      Array<{ product: ResidentSource; index: number; plane: TextureProductPlane }>
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
          Number(this.graphics.device.limits.maxTextureArrayLayers) - 1
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
          free: Array.from({ length }, (_, index) => length - index)
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
          this.entries.get(this.source(texture).identity)?.planes ??
            assignments.get(this.source(texture).identity)!
        ])
      );
      const tuple = new Set(
        [...allocations.values()].flatMap((planes) => planes.map((plane) => plane.segment))
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
        const mask = sample.readMask,
          coverage = product.metadata.planes.findIndex((plane) => plane.role === "coverage");
        if ((mask & 7) !== 0 || ((mask & 8) !== 0 && coverage < 0)) {
          if (
            planes[0] &&
            !product.tiled?.directory.metadata.planes.some(
              (profile) => profile.sourcePlane === 0 && profile.mode === "virtual"
            )
          ) {
            used.add(planes[0].segment);
          }
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
          texture_product: sample.binding.texture.texture_product
        } as ShadeTexture);
        samplers.add(
          String(
            sampler.value &
              (GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask | GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit)
          )
        );
      }
      const productTexture = graph.productReads?.some((read) => read.field.constant === undefined) ? 1 : 0;
      const virtualFormats = new Set(
        graph.samples.flatMap((sample) => {
          const tiled = sample.binding.texture.tiled_source;
          return (
            tiled?.directory.metadata.planes
              .filter((profile) => profile.mode === "virtual")
              .map((profile) => tiled.metadata.planes[profile.sourcePlane]!.format) ?? []
          );
        })
      );
      if (
        used.size + productTexture + (virtualFormats.size ? virtualFormats.size + 1 : 0) + 7 >
          Number(this.graphics.device.limits.maxSampledTexturesPerShaderStage) ||
        samplers.size + 2 > Number(this.graphics.device.limits.maxSamplersPerShaderStage)
      ) {
        this.failures++;
        throw new RangeError(
          `Material '${material.name}' full native descriptor exceeds negotiated limits before allocation`
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
        this.refining.delete(entry);
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
        }
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
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
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
          label: segment.texture.label
        });
      }
      for (const product of fresh) {
        const planes = assignments.get(product.identity)!,
          mips = product.metadata.planes[0]?.mips.length ?? 1;
        for (const plane of planes) {
          if (!plane.segment.free.includes(plane.layer)) {
            throw new Error("Texture reservation changed after admission");
          }
        }
        const virtual = product.tiled?.directory.metadata.planes.some((profile) => profile.mode === "virtual")
          ? (this.virtualValue ??= new VirtualTextureResidency(this.graphics, this.virtualSettings)).stage(
              product.tiled!,
              command
            )
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
          minMip:
            product.tiled || product.metadata.exactAlpha || criticalProducts.has(product.identity)
              ? 0
              : Math.min(6, mips - 1),
          staging: command
        };
        if (product.tiled) {
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
        if (entry.minMip > 0) {
          this.refining.add(entry);
        }
        created.push(entry);
      }
      const copies: TextureCopy[] = [];
      for (const entry of created) {
        if (entry.product.tiled) {
          continue;
        }
        entry.product.metadata.planes.forEach((plane, index) => {
          for (const mip of plane.mips) {
            if (mip.level >= entry.minMip) {
              const rowBytes = textureRowBytes(plane, mip);
              copies.push({
                entry,
                plane: index,
                mip,
                row: 0,
                rows: mip.byteLength / rowBytes,
                rowBytes,
                pitch: Math.ceil(rowBytes / 256) * 256
              });
            }
          }
        });
      }
      const criticalPromotions = [...products.keys()].flatMap((identity) => {
        const entry = this.entries.get(identity)!;
        return !created.includes(entry) && criticalProducts.has(identity) && entry.minMip > 0 ? [entry] : [];
      });
      for (const entry of criticalPromotions) {
        entry.promotion = command;
        command.onAborted.addOne(() => {
          entry.promotion = undefined;
        });
        const cursor = entry.upload ?? { mip: entry.minMip - 1, plane: 0, row: 0 };
        entry.product.metadata.planes.forEach((plane, index) => {
          for (const mip of plane.mips) {
            if (mip.level > cursor.mip || (mip.level === cursor.mip && index < cursor.plane)) {
              continue;
            }
            const rowBytes = textureRowBytes(plane, mip);
            const row = mip.level === cursor.mip && index === cursor.plane ? cursor.row : 0;
            copies.push({
              entry,
              plane: index,
              mip,
              row,
              rows: mip.byteLength / rowBytes - row,
              rowBytes,
              pitch: Math.ceil(rowBytes / 256) * 256
            });
          }
        });
      }
      this.encodeTextureCopies(copies, command, TEXTURE_BOOTSTRAP_UPLOAD_BYTES);
      command.onFinished.addOne(() => {
        for (const entry of criticalPromotions) {
          entry.minMip = 0;
          entry.upload = undefined;
          entry.promotion = undefined;
          entry.revision = this.nextRevision++;
          this.refining.delete(entry);
        }
      });
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
          staging: command
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
            primary = entry.planes[0];
          const bank = owner.set.bankDescriptors.findIndex(
            (descriptor) => descriptor.segment === primary?.segment.id
          );
          local.set(
            texture,
            primary && !entry.virtual
              ? encodeGpuTextureRef(
                  bank,
                  primary.layer,
                  entry.product.metadata.semantic === "alpha-mask" ? 1 : 0
                )
              : GPU_TEXTURE_REF_INVALID
          );
          refs.set(texture, encodeTextureHandle(entry.slot, entry.generation));
          const ci = entry.product.metadata.planes.findIndex((plane) => plane.role === "coverage"),
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
                if (entry.promotion === command && criticalProducts.has(entry.product.identity)) {
                  return 0;
                }
                return entry.minMip;
              },
              ...(coverage ? { coverage: { segment: coverage.segment.id, layer: coverage.layer } } : {})
            })
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
        surfacePublications: publications
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
    maxBytes = TEXTURE_FRAME_UPLOAD_BYTES
  ): void {
    this.assertCommand(command);
    if (!Number.isInteger(minimumMip) || minimumMip < 0 || minimumMip > 6) {
      throw new RangeError("Invalid mip target");
    }
    if (this.refining.size === 0) {
      return;
    }
    const entries = [
      ...new Set(materials.flatMap((material) => [...(this.materials.get(material)?.entries ?? [])]))
    ];
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 65536 || maxBytes > TEXTURE_FRAME_UPLOAD_BYTES) {
      throw new RangeError("Texture frame upload budget must be 64KiB..4MiB");
    }
    const budget = Math.min(maxBytes, TEXTURE_UPLOAD_IN_FLIGHT_BYTES - this.stagingBytes);
    if (budget < 65536 || entries.length === 0) {
      return;
    }
    const copies: TextureCopy[] = [];
    const candidates = new Map<Entry, { mip: number; plane: number; row: number }>();
    let bytes = 0;
    let idle = 0;
    // One physical block per turn. A large level cannot starve small textures.
    while (copies.length < 128 && idle < entries.length) {
      const entry = entries[this.uploadCursor % entries.length]!;
      this.uploadCursor = (this.uploadCursor + 1) % entries.length;
      const cursor = candidates.get(entry) ?? {
        ...(entry.upload ?? {
          mip: entry.minMip - 1,
          plane: 0,
          row: 0
        })
      };
      if (entry.staging || entry.promotion || cursor.mip < minimumMip) {
        idle++;
        continue;
      }
      const plane = entry.product.metadata.planes[cursor.plane]!;
      const mip = plane.mips[cursor.mip]!;
      const rowBytes = textureRowBytes(plane, mip);
      const pitch = Math.ceil(rowBytes / 256) * 256;
      const totalRows = mip.byteLength / rowBytes;
      const rows = Math.min(
        totalRows - cursor.row,
        Math.floor(Math.min(TEXTURE_COPY_BYTES, budget - bytes) / pitch)
      );
      if (rows === 0) {
        idle++;
        continue;
      }
      copies.push({ entry, plane: cursor.plane, mip, row: cursor.row, rows, rowBytes, pitch });
      bytes += rows * pitch;
      cursor.row += rows;
      if (cursor.row === totalRows) {
        cursor.row = 0;
        cursor.plane++;
        if (cursor.plane === entry.product.metadata.planes.length) {
          cursor.plane = 0;
          cursor.mip--;
        }
      }
      candidates.set(entry, cursor);
      idle = 0;
    }
    if (copies.length === 0) {
      return;
    }
    const pending = [...candidates.keys()];
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
      }
      this.encodeTextureCopies(copies, command, TEXTURE_UPLOAD_IN_FLIGHT_BYTES);
      this.progressiveBytes += copies.reduce((sum, copy) => sum + copy.rowBytes * copy.rows, 0);
      command.onFinished.addOne(() => {
        if (this.destroyed) {
          return;
        }
        let changed = false;
        for (const [entry, cursor] of candidates) {
          if (entry.promotion === command) {
            entry.upload = cursor;
            const completeMinimum = cursor.mip + 1;
            if (completeMinimum < entry.minMip) {
              entry.minMip = completeMinimum;
              entry.revision = this.nextRevision++;
              if (entry.minMip === 0) {
                this.refining.delete(entry);
              }
              changed = true;
            }
            entry.promotion = undefined;
          }
        }
        if (changed) {
          this.promotionCount++;
          this.onPublicationChanged.emit();
        }
      });
    } catch (error) {
      command.abort(error);
      throw error;
    }
  }

  /** Copies and their sampling publication share the caller's transaction.
   * One exact-size mapped staging buffer, retired only by its owning fence. */
  private encodeTextureCopies(
    copies: readonly TextureCopy[],
    command: ShadeGPUCommandContext,
    limit: number
  ): void {
    const size = copies.reduce((sum, copy) => sum + copy.pitch * copy.rows, 0);
    if (size === 0) {
      return;
    }
    if (size + this.stagingBytes > limit || size > this.graphics.device.limits.maxBufferSize) {
      throw new RangeError("Texture critical/staging capacity exceeded before upload");
    }
    const buffer = this.graphics.device.createBuffer({
      label: "TextureResidency/transaction upload",
      size,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true
    });
    const accounting = this.graphics.resource_accounting?.created({
      kind: "buffer",
      category: "transient",
      owner: "TextureResidency/upload",
      bytes: size
    });
    this.stagingBytes += size;
    this.stagingPeakBytes = Math.max(this.stagingPeakBytes, this.stagingBytes);
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      buffer.destroy();
      this.stagingBytes -= size;
      if (accounting) {
        this.graphics.resource_accounting?.destroyed(accounting);
      }
    };
    command.onAborted.addOne(release);
    command.onFinished.addOne(() => {
      this.committedUploadBytes += copies.reduce((sum, copy) => sum + copy.rowBytes * copy.rows, 0);
      void command.gpuDone.then(release, release);
    });
    try {
      const mapped = new Uint8Array(buffer.getMappedRange());
      let offset = 0;
      for (const copy of copies) {
        const source = copy.entry.product.chunks.get(copy.mip.chunkId)!;
        for (let row = 0; row < copy.rows; row++) {
          const begin = (copy.row + row) * copy.rowBytes;
          mapped.set(source.subarray(begin, begin + copy.rowBytes), offset + row * copy.pitch);
        }
        offset += copy.pitch * copy.rows;
      }
      buffer.unmap();
      offset = 0;
      for (const copy of copies) {
        const plane = copy.entry.planes[copy.plane]!;
        const block = plane.segment.plane.format === "r8unorm" ? 1 : 4;
        command.copyBufferToTexture(
          { buffer, offset, bytesPerRow: copy.pitch, rowsPerImage: copy.rows },
          {
            texture: plane.segment.texture!,
            mipLevel: copy.mip.level,
            origin: [0, copy.row * block, plane.layer]
          },
          { width: copy.mip.physicalWidth, height: copy.rows * block, depthOrArrayLayers: 1 }
        );
        offset += copy.pitch * copy.rows;
        this.uploadBytes += copy.rowBytes * copy.rows;
        this.copyOperations++;
        this.physicalCopyBytes += copy.pitch * copy.rows;
        if ((copy.row + copy.rows) * copy.rowBytes === copy.mip.byteLength) {
          this.mipUploads++;
        }
      }
    } catch (error) {
      release();
      throw error;
    }
  }
  /** Retains the exact current allocations, not mutable material identity. The
   * same queue orders finer-mip uploads; coverage uses its resident closure. */
  retainQuery(materials: readonly StandardShadeMaterial[]): TextureQueryLease {
    this.assertAlive();
    const entries = new Set<Entry>();
    for (const material of materials) {
      const owner = this.materials.get(material);
      if (owner === undefined || owner.staging !== undefined || owner.releasing !== undefined || owner.refs === 0) {
        throw new Error("Query textures require a committed resident material tuple");
      }
      for (const entry of owner.entries) { entries.add(entry); }
    }
    for (const entry of entries) { entry.refs++; }
    let released = false;
    let poisoned = false;
    const owner = this;
    const release = () => {
      // A rejected completion is not permission to recycle a physical layer.
      // Keep these references until the residency owner tears down the device.
      if (released || poisoned) { return; }
      released = true;
      if (this.destroyed) { return; }
      for (const entry of entries) {
        entry.refs--;
        if (entry.refs === 0) { this.retireEntry(entry, Promise.resolve()); }
      }
    };
    return Object.freeze({
      get valid() { return !released && !poisoned && !owner.destroyed; },
      release,
      releaseAfter: async (completion: PromiseLike<void>) => {
        try { await completion; }
        catch (error) { poisoned = true; throw error; }
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
          }
        );
      }
    });
  }
  bindings(): TextureResidencyBindings {
    this.assertAlive();
    return (this.cachedBindings ??= Object.freeze({
      textureCapacity: TEXTURE_HANDLE_MAX_SLOT,
      bindingSets: Object.freeze(
        [...this.sets.values()].map((value) => value.set).sort((a, b) => a.id - b.id)
      )
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
    const metadata = entry.product.metadata;
    return {
      slot: entry.slot,
      generation: entry.generation,
      formatClass: plane.segment.plane.format,
      sizeClass: metadata.storageWidth,
      segment: plane.segment.id,
      layer: plane.layer,
      logicalSize: [metadata.sourceWidth, metadata.sourceHeight],
      uvScaleBias: metadata.uvScaleBias,
      residentMipRange: [entry.minMip, plane.segment.plane.mips.length - 1]
    };
  }
  private mipRanges(
    materials: readonly StandardShadeMaterial[]
  ): ReadonlyMap<ShadeTexture, readonly [number, number]> {
    const result = new Map<ShadeTexture, readonly [number, number]>();
    for (const material of materials) {
      for (const texture of this.materials.get(material)?.textures ?? []) {
        const entry = this.entries.get(this.source(texture).identity);
        if (entry) {
          result.set(texture, [
            entry.minMip,
            (entry.product.tiled?.metadata.planes[0]?.mips.length ??
              entry.product.metadata.planes[0]!.mips.length) - 1
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
          sum + entry.planes.reduce((total, plane) => total + planeBytes(plane.segment.plane), 0),
        0
      );
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
        allocatedBytes: segment.bytes
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
      frameUploadBudgetBytes: TEXTURE_FRAME_UPLOAD_BYTES,
      uploadInFlightBudgetBytes: TEXTURE_UPLOAD_IN_FLIGHT_BYTES,
      bootstrapUploadBudgetBytes: TEXTURE_BOOTSTRAP_UPLOAD_BYTES,
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
        0
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
        entry.product.metadata.planes.some((plane) => plane.format.startsWith("bc"))
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
          allocatedBytes: planeBytes(plane.segment.plane)
        }))
      ),
      privateSubmitCount: 0,
      progressiveMipUploadBytes: this.progressiveBytes,
      mipPromotionCount: this.promotionCount,
      mipUploadCount: this.mipUploads
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
    this.refining.clear();
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
            segment: segment.id
          }))
        ),
        textureBankMask: (1 << segments.length) - 1 || 1
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
    if (entry.product.tiled && entry.virtual && this.virtualValue) {
      const virtual = this.virtualValue;
      virtual.releaseCompleted(entry.product.tiled);
      if (virtual.sourceCount === 0 && this.virtualValue === virtual) {
        virtual.destroy();
        this.virtualValue = null;
      }
    }
    this.refining.delete(entry);
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
      }
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
function textureRowBytes(plane: TextureProductPlane, mip: TextureProductMip): number {
  return mip.byteLength / (mip.physicalHeight / (plane.format === "r8unorm" ? 1 : 4));
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
