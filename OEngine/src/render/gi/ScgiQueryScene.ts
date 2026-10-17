import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuScene } from "../../gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import { GeometryQueryInstanceSnapshot } from "../../gpu/GeometryQueryInstanceSnapshot.js";
import { GeometryQueryCoverage } from "../../gpu/GeometryQueryCoverage.js";
import { GeometryQueryInstances } from "../../gpu/GeometryQueryInstances.js";
import { GpuQueryMaterialPublication } from "../../gpu/GpuQueryMaterialPublication.js";
import type { NativeSceneQueryLease } from "../../gpu/GpuNativeMaterialScene.js";
import type {
  GeometryQueryGeometryLease,
  GeometryQueryGeometrySegment,
  VirtualGeometryResidency
} from "../../gpu/VirtualGeometryResidency.js";
import { GeometryQueryTransforms } from "../../gpu/GeometryQueryTransforms.js";
import { ScgiQueryBlas } from "./ScgiQueryBlas.js";
import { ScgiBvhBuild } from "./ScgiBvhBuild.js";
import { planScgiBvh, type ScgiBvhPlan } from "./ScgiBvhLayout.js";
import { ScgiQueryGeometry } from "./ScgiQueryGeometry.js";
import { scgiInteger } from "./ScgiCapacity.js";
import { geometryQueryDomain, type GeometryQueryDomain } from "../../gpu/GeometryQueryDomain.js";
import type { GeometryPageStreamingRuntimeV1 } from "../../gpu/GeometryPageStreamingRuntime.js";
import { geometryQueryCut, type GeometryQueryCut } from "../../gpu/GeometryQueryCut.js";

export interface ScgiQuerySceneProfile {
  readonly deviceEpoch: number;
  readonly originEpoch: number;
  readonly primitiveCapacity: number;
  /** Includes AS, build scratch, immutable instance copies and query directory;
   * retained shared geometry/texture payload is charged by its existing owner. */
  readonly maximumBytes: number;
  readonly subgroup: boolean;
  /** Absent means the complete captured world, not a camera-visible domain. */
  readonly domain?: GeometryQueryDomain;
  /** Finite physical directory window; defaults to the negotiated binding limit. */
  readonly directorySegmentBytes?: number;
  /** Source-slot window capacity, independent of BLAS triangle capacity. */
  readonly instanceCapacity?: number;
  /** Complete delayed GPU demand plans, keyed by the admitted descriptor.
   * Absence explicitly requests the full-world exact Product cut. */
  readonly queryCuts?: readonly GeometryQueryCut[];
}

export interface ScgiQuerySceneShard {
  readonly index: number;
  readonly geometry: ScgiQueryGeometry;
  readonly lease: GeometryQueryGeometryLease;
  readonly segment: GeometryQueryGeometrySegment;
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
  private transforms: GeometryQueryTransforms | null = null;
  private readonly staticBlas: Array<{
    entry: ScgiQueryBlas;
    build: boolean;
    geometry: ScgiQueryGeometry;
    count: number;
  }> = [];
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
  private updateSource: ScgiQueryScene | null = null;

  private constructor(
    private readonly device: GPUDevice,
    readonly profile: ScgiQuerySceneProfile,
    readonly runtime: GpuRenderWorldRuntime,
    source: GpuScene,
    private readonly nativeLease: NativeSceneQueryLease,
    private readonly accounting?: ResourceAccounting,
    command?: ShadeGPUCommandContext
  ) {
    this.sourceInstances = new GeometryQueryInstanceSnapshot(device, source, accounting, command);
    let materials: GpuQueryMaterialPublication | undefined;
    try {
      materials = new GpuQueryMaterialPublication(device, nativeLease, accounting);
      this.materials = materials;
      this.blasPlan = planScgiBvh(device.limits, profile.primitiveCapacity);
      this.tlasPlan = planScgiBvh(
        device.limits,
        Math.max(1, Math.min(this.sourceInstances.count, profile.instanceCapacity ?? 4096))
      );
    } catch (error) {
      materials?.destroy();
      this.sourceInstances.destroy();
      throw error;
    }
    this.bytes =
      this.sourceInstances.sourceSnapshot.size +
      this.sourceInstances.identitySnapshot.size +
      this.materials.byteLength;
    void device.lost.then(() => this.destroyResources());
  }

  static async create(
    device: GPUDevice,
    profile: ScgiQuerySceneProfile,
    runtime: GpuRenderWorldRuntime,
    scene: GpuScene,
    products: readonly VirtualGeometryResidency[],
    accounting?: ResourceAccounting,
    command?: ShadeGPUCommandContext,
    streaming?: GeometryPageStreamingRuntimeV1,
    previous?: ScgiQueryScene
  ): Promise<ScgiQueryScene> {
    scgiInteger(profile.deviceEpoch, "query device epoch");
    scgiInteger(profile.originEpoch, "query origin epoch", 0);
    scgiInteger(profile.primitiveCapacity, "query primitive shard capacity");
    scgiInteger(profile.maximumBytes, "query maximum bytes");
    if (profile.instanceCapacity !== undefined) {
      scgiInteger(profile.instanceCapacity, "query instance window capacity");
    }
    profile = Object.freeze({
      ...profile,
      ...(profile.domain === undefined ? {} : { domain: geometryQueryDomain([profile.domain], 0) })
    });
    if (runtime.nativeMaterials === null || runtime.virtualGeometry === null || products.length === 0) {
      throw new Error("Query scene requires the existing Product and native material runtime");
    }
    const cuts = products.map((product) => {
      const selected = profile.queryCuts?.filter((cut) => cut.descriptor === product.descriptor);
      if (selected !== undefined && selected.length !== 1) {
        throw new Error("Query scene requires exactly one cut for every admitted Product");
      }
      return selected?.[0] ?? geometryQueryCut(product.descriptor);
    });
    if (profile.queryCuts !== undefined && profile.queryCuts.length !== products.length) {
      throw new Error("Query cut publication contains an unrelated Product");
    }
    // Request every Product before attempting any lease. A missing early
    // Product must not starve all later Products' coverage IO.
    if (streaming !== undefined) {
      for (let index = 0; index < products.length; index++) {
        streaming.requestQueryCut(products[index]!, cuts[index]!);
      }
    }
    const nativeLease = runtime.nativeMaterials.retainQuery(command);
    let owner: ScgiQueryScene | undefined;
    try {
      owner = new ScgiQueryScene(device, profile, runtime, scene, nativeLease, accounting, command);
      const signatures = new Set<string>();
      for (let index = 0; index < products.length; index++) {
        const product = products[index]!;
        if (!product.publicationActive) {
          throw new Error("Query scene cannot publish a dormant Product generation");
        }
        const key = `${product.productTableSlot}/${product.productGeneration}`;
        if (signatures.has(key)) {
          throw new Error("Query scene Product identity is duplicated");
        }
        signatures.add(key);
        owner.geometryLeases.push(
          product.retainQueryGeometry(command, profile.directorySegmentBytes, cuts[index])
        );
      }
      // Preflight the complete shard domain, including kernel-owned parameter
      // buffers. Admission never drops an asset or truncates its primitives.
      let shardCount = 0;
      let geometryCount = 0;
      for (const lease of owner.geometryLeases) {
        owner.bytes += lease.metadataByteLength;
        for (const segment of lease.segments) {
          for (const asset of segment.queryAssets) {
            geometryCount += Math.ceil(asset.primitiveCount / profile.primitiveCapacity);
            shardCount +=
              Math.ceil(asset.primitiveCount / profile.primitiveCapacity) *
              Math.max(1, Math.ceil(owner.sourceInstances.count / owner.tlasPlan.primitiveCapacity));
          }
        }
      }
      const builderBytes =
        shardCount === 0
          ? 0
          : 4 * device.limits.minUniformBufferOffsetAlignment * 512 +
            owner.blasPlan.scratch.ranges.indirect!.bytes +
            owner.tlasPlan.scratch.ranges.indirect!.bytes;
      const instanceBytes = 64;
      const sharedTransformBytes =
        shardCount === 0
          ? 0
          : Math.max(128, owner.sourceInstances.count * 128) + Math.max(32, owner.sourceInstances.count * 32);
      const coverageBytes =
        Math.max(48, owner.geometryLeases.reduce((count, lease) => count + lease.cut.assets.length, 0) * 48) +
        48;
      const scratchBytes = shardCount === 0 ? 0 : owner.blasPlan.scratch.bytes + owner.tlasPlan.scratch.bytes;
      const finalBytes =
        owner.bytes +
        sharedTransformBytes +
        coverageBytes +
        builderBytes +
        scratchBytes +
        geometryCount * (owner.blasPlan.hierarchy.bytes + 48) +
        shardCount * (owner.tlasPlan.hierarchy.bytes + instanceBytes);
      if (!Number.isSafeInteger(finalBytes) || finalBytes > profile.maximumBytes) {
        throw new RangeError("Complete query AS publication exceeds the admitted working-set budget");
      }
      owner.bytes += builderBytes;
      const coverage = await GeometryQueryCoverage.create(
        device,
        owner.sourceInstances,
        owner.geometryLeases,
        owner.materials.directory,
        accounting,
        profile.domain
      );
      if (owner.destroyed) {
        coverage.destroy();
        throw new Error("Query device was lost during coverage preparation");
      }
      owner.coverage = coverage;
      owner.bytes += coverage.byteLength;
      if (shardCount === 0) {
        owner.assertBudget();
        owner.state = "ready";
        return owner;
      }
      const transforms = await GeometryQueryTransforms.create(device, owner.sourceInstances, accounting);
      if (owner.destroyed) {
        transforms.destroy();
        throw new Error("Query device was lost during shared transform preparation");
      }
      owner.transforms = transforms;
      owner.bytes += owner.transforms.byteLength;
      owner.blasScratch = owner.allocate(
        "SCGI/query BLAS build scratch",
        owner.blasPlan.scratch.bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      );
      owner.tlasScratch = owner.allocate(
        "SCGI/query TLAS build scratch",
        owner.tlasPlan.scratch.bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      );
      for (const plan of [owner.blasPlan, owner.tlasPlan]) {
        const builder = await ScgiBvhBuild.create(device, plan, profile.subgroup, accounting);
        if (owner.destroyed) {
          builder.destroy();
          throw new Error("Query device was lost during AS preparation");
        }
        owner.builders.push(builder);
      }
      for (const lease of owner.geometryLeases) {
        for (const segment of lease.segments) {
          for (let asset = 0; asset < segment.queryAssets.length; asset++) {
            const range = segment.queryAssets[asset]!;
            for (let offset = 0; offset < range.primitiveCount; offset += profile.primitiveCapacity) {
              const count = Math.min(profile.primitiveCapacity, range.primitiveCount - offset);
              const acquired = ScgiQueryBlas.acquire(
                device,
                owner.blasPlan,
                lease,
                lease.segments.indexOf(segment),
                asset,
                offset,
                count,
                accounting
              );
              let geometry: ScgiQueryGeometry;
              try {
                geometry = await ScgiQueryGeometry.create(
                  device,
                  owner.blasPlan,
                  owner.blasScratch,
                  lease,
                  asset,
                  segment,
                  offset,
                  count
                );
              } catch (error) {
                acquired.entry.release();
                throw error;
              }
              if (owner.destroyed) {
                geometry.destroy();
                acquired.entry.release();
                throw new Error("Query device was lost during BLAS preparation");
              }
              owner.staticBlas.push({ ...acquired, geometry, count });
              owner.bytes += acquired.entry.buffer.size + 48;
              for (
                let first = 0;
                first < Math.max(1, owner.sourceInstances.count);
                first += owner.tlasPlan.primitiveCapacity
              ) {
                const index = owner.shards.length;
                const tlas = owner.allocate(
                  `SCGI/query TLAS ${index}`,
                  owner.tlasPlan.hierarchy.bytes,
                  GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                );
                const instanceCount = Math.min(
                  owner.tlasPlan.primitiveCapacity,
                  owner.sourceInstances.count - first
                );
                const instances = await GeometryQueryInstances.create(
                  device,
                  owner.tlasPlan,
                  owner.tlasScratch,
                  owner.sourceInstances,
                  {
                    productTableSlot: lease.productTableSlot,
                    productGeneration: lease.productGeneration,
                    assetReference: lease.assetReferenceBegin + asset,
                    root: 0,
                    shard: index,
                    asGeneration: 1
                  },
                  accounting,
                  profile.domain,
                  owner.transforms,
                  first,
                  instanceCount
                );
                if (owner.destroyed) {
                  instances.destroy();
                  throw new Error("Query device was lost during instance preparation");
                }
                owner.shards.push(
                  Object.freeze({
                    index,
                    geometry,
                    lease,
                    segment,
                    asset,
                    primitiveOffset: offset,
                    primitiveCount: count,
                    blas: acquired.entry.buffer,
                    tlas,
                    instances
                  })
                );
                owner.bytes += 64;
                owner.assertBudget();
              }
            }
          }
        }
      }
      owner.assertBudget();
      if (
        previous?.state === "submitted" &&
        !previous.retiring &&
        previous.device === device &&
        previous.tlasPlan.primitiveCapacity === owner.tlasPlan.primitiveCapacity &&
        previous.shards.length === owner.shards.length &&
        previous.shards.every((shard, index) => {
          const next = owner!.shards[index]!;
          return (
            shard.blas === next.blas &&
            shard.instances.first === next.instances.first &&
            shard.instances.count === next.instances.count
          );
        })
      ) {
        owner.updateSource = previous;
      }
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
      this.handles.push(
        this.accounting.created(
          { kind: "buffer", category: "resident", owner: "SCGI/query scene", label, bytes },
          buffer
        )
      );
    }
    return buffer;
  }

  get valid(): boolean {
    return (
      !this.retiring &&
      (this.state === "encoded" || this.state === "submitted") &&
      this.nativeLease.valid &&
      this.sourceInstances.valid &&
      this.geometryLeases.every((lease) => lease.valid)
    );
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

  get virtualTextures() {
    return this.runtime.nativeMaterials?.queryVirtualTextures ?? null;
  }

  get viewDependent(): boolean {
    return (
      this.nativeLease.materials.some((material) => material.viewDependent) ||
      this.runtime.nativeMaterials?.viewDependentCoverage === true
    );
  }

  get prepared(): boolean {
    return (
      this.state === "ready" &&
      this.nativeLease.valid &&
      this.materials.valid &&
      this.sourceInstances.valid &&
      this.geometryLeases.every((lease) => lease.valid)
    );
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
      ...this.geometryLeases.map((lease) => lease.releaseAfter(Promise.reject(cause)))
    ]);
  }

  /** Register every command that reads the immutable AS/material/page closure.
   * An external retirement fence alone cannot cover another encoded command
   * that has not reached queue submission yet. Aborted consumers release their
   * registration; failed submissions quarantine the entire shared closure. */
  observeUse(command: ShadeGPUCommandContext): void {
    if (
      !this.valid ||
      command.closed ||
      command.device !== this.device ||
      (this.state === "encoded" && command !== this.buildCommand)
    ) {
      throw new Error("Query consumer requires its submitted scene or the scene build command");
    }
    const assertCurrent = (): void => {
      this.sourceInstances.assertCurrent(command);
      if (!this.nativeLease.isCurrent(command)) {
        throw new Error("Native material scene changed after query capture; prepare a fresh candidate");
      }
    };
    assertCurrent();
    this.observeResources(command);
    command.onBeforeFinish.addOne(assertCurrent);
  }

  /** Topology copying is a historical resource consumer. A changed source
   * scene is expected here; the new candidate's GPU policy verifies membership
   * and bounds. It must still retain the old buffers through the copy fence. */
  private observeResources(command: ShadeGPUCommandContext): void {
    if (this.consumers.has(command)) {
      return;
    }
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.consumers.set(command, completion);
    command.observeSubmission({
      submitted: (fence) => {
        void fence.then(
          () => {
            this.consumers.delete(command);
            settle();
          },
          (cause) => {
            this.poison(cause);
            settle();
          }
        );
      },
      aborted: () => {
        this.consumers.delete(command);
        settle();
      },
      failed: (cause) => {
        this.poison(cause);
        settle();
      }
    });
  }

  encode(command: ShadeGPUCommandContext): void {
    if (
      this.state !== "ready" ||
      command.closed ||
      command.device !== this.device ||
      !this.nativeLease.valid ||
      !this.materials.valid ||
      this.geometryLeases.some((lease) => !lease.valid)
    ) {
      throw new Error("Query scene encoding requires its complete unused candidate");
    }
    command.observeSubmission({
      submitted: (fence) => {
        this.state = "submitted";
        void fence.catch((cause) => this.poison(cause));
      },
      aborted: () => this.destroyResources(),
      failed: (cause) => this.poison(cause)
    });
    this.sourceInstances.encode(command);
    this.coverage!.encode(command);
    this.transforms?.encode(command);
    for (const blas of this.staticBlas) {
      if (blas.build) {
        blas.geometry.encodeBounds(command);
        this.builders[0]!.encode(command, blas.entry.buffer, this.blasScratch, blas.count);
        blas.entry.observeBuild(command);
      }
    }
    const previous = this.updateSource;
    const canUpdate = previous?.state === "submitted" && !previous.retiring;
    if (canUpdate) {
      previous.observeResources(command);
    }
    for (const shard of this.shards) {
      shard.instances.encode(command);
      if (canUpdate) {
        command.copyBufferToBuffer(previous.shards[shard.index]!.tlas, 0, shard.tlas, 0, shard.tlas.size);
        this.builders[1]!.encodeUpdate(command, shard.tlas, this.tlasScratch, shard.instances.count);
      } else {
        this.builders[1]!.encode(command, shard.tlas, this.tlasScratch, shard.instances.count, true);
      }
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
      shard.instances.destroy();
    }
    this.transforms?.destroy();
    for (const blas of this.staticBlas) {
      blas.geometry.destroy();
      blas.entry.release();
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
