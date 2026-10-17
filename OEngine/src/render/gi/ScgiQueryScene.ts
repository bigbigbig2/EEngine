import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuScene } from "../../gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import { GeometryQueryInstanceSnapshot } from "../../gpu/GeometryQueryInstanceSnapshot.js";
import { GeometryQueryCoverage } from "../../gpu/GeometryQueryCoverage.js";
import { GeometryQueryInstances } from "../../gpu/GeometryQueryInstances.js";
import { GpuQueryMaterialPublication } from "../../gpu/GpuQueryMaterialPublication.js";
import type { NativeSceneQueryLease } from "../../gpu/GpuNativeMaterialScene.js";
import type { GeometryQueryGeometryLease, VirtualGeometryResidency } from "../../gpu/VirtualGeometryResidency.js";
import { ScgiBvhBuild } from "./ScgiBvhBuild.js";
import { planScgiBvh, type ScgiBvhPlan } from "./ScgiBvhLayout.js";
import { ScgiQueryGeometry } from "./ScgiQueryGeometry.js";
import { scgiInteger } from "./ScgiCapacity.js";

export interface ScgiQuerySceneProfile {
  readonly deviceEpoch: number;
  readonly originEpoch: number;
  readonly primitiveCapacity: number;
  /** Includes AS, build scratch, immutable instance copies and query directory;
   * retained shared geometry/texture payload is charged by its existing owner. */
  readonly maximumBytes: number;
  readonly subgroup: boolean;
}

export interface ScgiQuerySceneShard {
  readonly index: number;
  readonly geometry: ScgiQueryGeometry;
  readonly lease: GeometryQueryGeometryLease;
  readonly asset: number;
  readonly primitiveOffset: number;
  readonly primitiveCount: number;
  readonly blas: GPUBuffer;
  readonly tlas: GPUBuffer;
  readonly instances: GeometryQueryInstances;
}

/** Immutable candidate over existing Product/GpuScene/native material owners.
 * No import, private mesh, visibility readback or frame submit lives here.
 * The publication is usable only after every AS shard has been encoded. */
export class ScgiQueryScene {
  readonly shards: ScgiQuerySceneShard[] = [];
  readonly materials: GpuQueryMaterialPublication;
  readonly sourceInstances: GeometryQueryInstanceSnapshot;
  readonly blasPlan: ScgiBvhPlan;
  readonly tlasPlan: ScgiBvhPlan;
  private readonly geometryLeases: GeometryQueryGeometryLease[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private readonly handles: ResourceHandle[] = [];
  private readonly builders: ScgiBvhBuild[] = [];
  private state: "preparing" | "ready" | "encoded" | "submitted" | "poisoned" | "destroyed" = "preparing";
  private bytes = 0;
  private blasScratch!: GPUBuffer;
  private tlasScratch!: GPUBuffer;
  private poisonSettlement: Promise<unknown> | null = null;
  private poisonCause: unknown;
  private coverage: GeometryQueryCoverage | null = null;
  private buildCommand: ShadeGPUCommandContext | null = null;
  private retiring = false;
  private readonly consumers = new Map<ShadeGPUCommandContext, Promise<void>>();

  private constructor(
    private readonly device: GPUDevice,
    readonly profile: ScgiQuerySceneProfile,
    readonly runtime: GpuRenderWorldRuntime,
    source: GpuScene,
    private readonly nativeLease: NativeSceneQueryLease,
    private readonly accounting?: ResourceAccounting,
    command?: ShadeGPUCommandContext,
  ) {
    this.sourceInstances = new GeometryQueryInstanceSnapshot(device, source, accounting, command);
    let materials: GpuQueryMaterialPublication | undefined;
    try {
      materials = new GpuQueryMaterialPublication(device, nativeLease, accounting);
      this.materials = materials;
      this.blasPlan = planScgiBvh(device.limits, profile.primitiveCapacity);
      this.tlasPlan = planScgiBvh(device.limits, Math.max(1, this.sourceInstances.count));
    } catch (error) {
      materials?.destroy();
      this.sourceInstances.destroy();
      throw error;
    }
    this.bytes = this.sourceInstances.sourceSnapshot.size + this.sourceInstances.identitySnapshot.size +
      this.materials.byteLength;
    void device.lost.then(() => this.destroyResources());
  }

  static async create(device: GPUDevice, profile: ScgiQuerySceneProfile,
    runtime: GpuRenderWorldRuntime, scene: GpuScene, products: readonly VirtualGeometryResidency[],
    accounting?: ResourceAccounting, command?: ShadeGPUCommandContext): Promise<ScgiQueryScene> {
    scgiInteger(profile.deviceEpoch, "query device epoch");
    scgiInteger(profile.originEpoch, "query origin epoch", 0);
    scgiInteger(profile.primitiveCapacity, "query primitive shard capacity");
    scgiInteger(profile.maximumBytes, "query maximum bytes");
    if (runtime.nativeMaterials === null || runtime.virtualGeometry === null || products.length === 0) {
      throw new Error("Query scene requires the existing Product and native material runtime");
    }
    const nativeLease = runtime.nativeMaterials.retainQuery(command);
    let owner: ScgiQueryScene | undefined;
    try {
      owner = new ScgiQueryScene(device, profile, runtime, scene, nativeLease, accounting, command);
      const signatures = new Set<string>();
      for (const product of products) {
        const key = `${product.productTableSlot}/${product.productGeneration}`;
        if (signatures.has(key)) {
          throw new Error("Query scene Product identity is duplicated");
        }
        signatures.add(key);
        owner.geometryLeases.push(product.retainQueryGeometry(command));
      }
      // Preflight the complete shard domain, including kernel-owned parameter
      // buffers. Admission never drops an asset or truncates its primitives.
      let shardCount = 0;
      for (const lease of owner.geometryLeases) {
        owner.bytes += lease.metadataByteLength;
        for (const asset of lease.queryAssets) {
          shardCount += Math.ceil(asset.primitiveCount / profile.primitiveCapacity);
        }
      }
      const builderBytes = 2 * device.limits.minUniformBufferOffsetAlignment * 512 +
        owner.blasPlan.scratch.ranges.indirect!.bytes + owner.tlasPlan.scratch.ranges.indirect!.bytes;
      const instanceBytes = Math.max(4, owner.sourceInstances.count * 128) + 32;
      const coverageBytes = Math.max(16, owner.geometryLeases.length * 16) + 16;
      const finalBytes = owner.bytes + coverageBytes + builderBytes + owner.blasPlan.scratch.bytes +
        owner.tlasPlan.scratch.bytes + shardCount * (owner.blasPlan.hierarchy.bytes +
          owner.tlasPlan.hierarchy.bytes + instanceBytes + 32);
      if (!Number.isSafeInteger(finalBytes) || finalBytes > profile.maximumBytes) {
        throw new RangeError("Complete query AS publication exceeds the admitted working-set budget");
      }
      owner.bytes += builderBytes;
      const coverage = await GeometryQueryCoverage.create(device, owner.sourceInstances,
        owner.geometryLeases, owner.materials.directory, accounting);
      if (owner.destroyed) {
        coverage.destroy();
        throw new Error("Query device was lost during coverage preparation");
      }
      owner.coverage = coverage;
      owner.bytes += coverage.byteLength;
      owner.blasScratch = owner.allocate("SCGI/query BLAS build scratch", owner.blasPlan.scratch.bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
      owner.tlasScratch = owner.allocate("SCGI/query TLAS build scratch", owner.tlasPlan.scratch.bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
      for (const plan of [owner.blasPlan, owner.tlasPlan]) {
        const builder = await ScgiBvhBuild.create(device, plan, profile.subgroup, accounting);
        if (owner.destroyed) {
          builder.destroy();
          throw new Error("Query device was lost during AS preparation");
        }
        owner.builders.push(builder);
      }
      for (const lease of owner.geometryLeases) {
        for (let asset = 0; asset < lease.queryAssets.length; asset++) {
          const range = lease.queryAssets[asset]!;
          for (let offset = 0; offset < range.primitiveCount; offset += profile.primitiveCapacity) {
            const count = Math.min(profile.primitiveCapacity, range.primitiveCount - offset);
            const index = owner.shards.length;
            const blas = owner.allocate(`SCGI/query BLAS ${index}`, owner.blasPlan.hierarchy.bytes,
              GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
            const tlas = owner.allocate(`SCGI/query TLAS ${index}`, owner.tlasPlan.hierarchy.bytes,
              GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
            const geometry = await ScgiQueryGeometry.create(device, owner.blasPlan,
              owner.blasScratch, lease, asset, offset, count);
            if (owner.destroyed) {
              geometry.destroy();
              throw new Error("Query device was lost during geometry preparation");
            }
            let instances: GeometryQueryInstances;
            try {
              instances = await GeometryQueryInstances.create(device, owner.tlasPlan,
                owner.tlasScratch, owner.sourceInstances, {
                  productTableSlot: lease.productTableSlot, productGeneration: lease.productGeneration,
                  assetReference: lease.assetReferenceBegin + asset, root: 0, shard: index, asGeneration: 1,
                }, accounting);
            } catch (error) {
              geometry.destroy();
              throw error;
            }
            if (owner.destroyed) {
              geometry.destroy();
              instances.destroy();
              throw new Error("Query device was lost during instance preparation");
            }
            owner.shards.push(Object.freeze({ index, geometry, lease, asset,
              primitiveOffset: offset, primitiveCount: count, blas, tlas, instances }));
            owner.bytes += instances.records.size + 64;
            owner.assertBudget();
          }
        }
      }
      owner.assertBudget();
      if (!nativeLease.valid || owner.geometryLeases.some((lease) => !lease.valid)) {
        throw new Error("Query source changed during asynchronous AS preparation");
      }
      owner.state = "ready";
      return owner;
    } catch (error) {
      if (owner !== undefined) {
        owner.destroy();
      } else {
        nativeLease.release();
      }
      throw error;
    }
  }

  private assertBudget(): void {
    if (this.bytes > this.profile.maximumBytes) {
      throw new RangeError("Complete query AS publication exceeds the admitted working-set budget");
    }
  }

  private allocate(label: string, bytes: number, usage: GPUBufferUsageFlags): GPUBuffer {
    if (this.state === "destroyed") {
      throw new Error("Query scene resources cannot be allocated after device teardown");
    }
    this.bytes += bytes;
    this.assertBudget();
    const buffer = this.device.createBuffer({ label, size: bytes, usage });
    this.buffers.push(buffer);
    if (this.accounting !== undefined) {
      this.handles.push(this.accounting.created({ kind: "buffer", category: "resident",
        owner: "SCGI/query scene", label, bytes }, buffer));
    }
    return buffer;
  }

  get valid(): boolean {
    return !this.retiring && (this.state === "encoded" || this.state === "submitted") && this.nativeLease.valid &&
      this.sourceInstances.valid && this.geometryLeases.every((lease) => lease.valid);
  }

  get byteLength(): number {
    return this.bytes;
  }

  get coverageStatus(): GPUBuffer {
    if (this.coverage === null || this.destroyed) {
      throw new Error("Query scene has no live coverage certificate");
    }
    return this.coverage.status;
  }

  get materialPublication() {
    return this.nativeLease.publication;
  }

  get prepared(): boolean {
    return this.state === "ready" && this.nativeLease.valid && this.materials.valid &&
      this.sourceInstances.valid && this.geometryLeases.every((lease) => lease.valid);
  }

  private get destroyed(): boolean {
    return this.state === "destroyed";
  }

  private poison(cause: unknown): void {
    if (this.state === "destroyed" || this.poisonSettlement !== null) {
      return;
    }
    this.state = "poisoned";
    this.poisonCause = cause;
    // Failed submission never grants reuse to shared material or geometry
    // owners. Consume these rejection futures without masking the command's
    // own failure; its caller still receives the original error.
    this.poisonSettlement = Promise.allSettled([
      this.nativeLease.releaseAfter(Promise.reject(cause)),
      ...this.geometryLeases.map((lease) => lease.releaseAfter(Promise.reject(cause))),
    ]);
  }

  /** Register every command that reads the immutable AS/material/page closure.
   * An external retirement fence alone cannot cover another encoded command
   * that has not reached queue submission yet. Aborted consumers release their
   * registration; failed submissions quarantine the entire shared closure. */
  observeUse(command: ShadeGPUCommandContext): void {
    if (!this.valid || command.closed || command.device !== this.device ||
        (this.state === "encoded" && command !== this.buildCommand)) {
      throw new Error("Query consumer requires its submitted scene or the scene build command");
    }
    if (this.consumers.has(command)) {
      return;
    }
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => { settle = resolve; });
    this.consumers.set(command, completion);
    command.observeSubmission({
      submitted: (fence) => {
        void fence.then(() => {
          this.consumers.delete(command);
          settle();
        }, (cause) => {
          this.poison(cause);
          settle();
        });
      },
      aborted: () => {
        this.consumers.delete(command);
        settle();
      },
      failed: (cause) => {
        this.poison(cause);
        settle();
      },
    });
  }

  encode(command: ShadeGPUCommandContext): void {
    if (this.state !== "ready" || command.closed || command.device !== this.device || !this.nativeLease.valid ||
        !this.materials.valid || this.geometryLeases.some((lease) => !lease.valid)) {
      throw new Error("Query scene encoding requires its complete unused candidate");
    }
    command.observeSubmission({
      submitted: (fence) => {
        this.state = "submitted";
        void fence.catch((cause) => this.poison(cause));
      },
      aborted: () => this.destroyResources(),
      failed: (cause) => this.poison(cause),
    });
    this.sourceInstances.encode(command);
    this.coverage!.encode(command);
    for (const shard of this.shards) {
      shard.geometry.encodeBounds(command);
      this.builders[0]!.encode(command, shard.blas, this.blasScratch, shard.primitiveCount);
      shard.instances.encode(command);
      this.builders[1]!.encode(command, shard.tlas, this.tlasScratch, shard.instances.count);
    }
    this.buildCommand = command;
    this.state = "encoded";
    this.observeUse(command);
  }

  async releaseAfter(completion: PromiseLike<void>): Promise<void> {
    if (this.state !== "submitted" && this.state !== "poisoned") {
      throw new Error("Query publication retirement requires a submitted consumer");
    }
    this.retiring = true;
    try {
      await Promise.all([completion, ...this.consumers.values()]);
    } catch (error) {
      this.poison(error);
      await this.poisonSettlement;
      throw error;
    }
    if (this.state === "poisoned") {
      await this.poisonSettlement;
      throw this.poisonCause;
    }
    this.destroyResources();
  }

  /** Cancel preparation. Encoded/submitted resources require the command's
   * abort notification, final successful consumer fence, or device loss. */
  destroy(): void {
    if (this.state === "encoded" || this.state === "submitted" || this.state === "poisoned") {
      throw new Error("Query publication is retained by a GPU command or failed submission");
    }
    this.destroyResources();
  }

  private destroyResources(): void {
    if (this.state === "destroyed") {
      return;
    }
    this.state = "destroyed";
    for (const shard of this.shards) {
      shard.geometry.destroy();
      shard.instances.destroy();
    }
    for (const builder of this.builders) {
      builder.destroy();
    }
    this.materials.destroy();
    this.coverage?.destroy();
    this.nativeLease.release();
    this.sourceInstances.destroy();
    for (const lease of this.geometryLeases) {
      lease.release();
    }
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
    for (const handle of this.handles) {
      this.accounting!.destroyed(handle);
    }
  }
}
