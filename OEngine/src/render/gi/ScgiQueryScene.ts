import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuScene } from "../../gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import { GeometryQueryInstanceSnapshot } from "../../gpu/GeometryQueryInstanceSnapshot.js";
import { GeometryQueryCoverage } from "../../gpu/GeometryQueryCoverage.js";
import { ScgiQueryArena } from "./ScgiQueryArena.js";
import { GpuQueryMaterialPublication } from "../../gpu/GpuQueryMaterialPublication.js";
import type { NativeSceneQueryLease } from "../../gpu/GpuNativeMaterialScene.js";
import type {
  GeometryQueryGeometryLease,
  GeometryQueryGeometrySegment,
  VirtualGeometryResidency,
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
import { GeometryQueryWorkingSet } from "../../gpu/GeometryQueryWorkingSet.js";

/** Keep the shared BVH shader bounded for scenes made of many small assets.
 * Larger Products are split into complete physical shards; this does not
 * reduce query coverage or change the admitted primitive ceiling. */
export const SCGI_QUERY_BUILD_MAX_PRIMITIVES = 4096;

function scgiQueryBuildCapacity(maximumShard: number, primitiveCapacity: number): number {
  let capacity = Math.min(Math.max(1, maximumShard), primitiveCapacity, SCGI_QUERY_BUILD_MAX_PRIMITIVES);
  let classCapacity = 1;
  while (classCapacity < capacity) {
    classCapacity *= 2;
  }
  return classCapacity;
}

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
  /** Complete delayed GPU demand plans, keyed by the admitted descriptor.
   * Absence explicitly requests the full-world exact Product cut. */
  readonly queryCuts?: readonly GeometryQueryCut[];
  readonly workingSet?: { readonly voxelSize: number; readonly receiver: readonly [number, number, number] };
}

export interface ScgiQuerySceneGeometry {
  readonly index: number;
  readonly geometry: ScgiQueryGeometry;
  readonly lease: GeometryQueryGeometryLease;
  readonly segment: GeometryQueryGeometrySegment;
  readonly asset: number;
  readonly primitiveOffset: number;
  readonly primitiveCount: number;
  readonly blas: GPUBuffer;
  readonly entry: ScgiQueryBlas;
}

/** Immutable candidate over existing Product/GpuScene/native material owners.
 * No import, private mesh, visibility readback or frame submit lives here.
 * The publication is usable only after every AS shard has been encoded. */
export class ScgiQueryScene {
  readonly geometries: ScgiQuerySceneGeometry[] = [];
  readonly arenas: ScgiQueryArena[] = [];
  readonly materials: GpuQueryMaterialPublication;
  readonly sourceInstances: GeometryQueryInstanceSnapshot;
  blasPlan: ScgiBvhPlan;
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
  private blasBuildHierarchy!: GPUBuffer;
  private poisonSettlement: Promise<unknown> | null = null;
  private poisonCause: unknown;
  private coverage: GeometryQueryCoverage | null = null;
  private buildCommand: ShadeGPUCommandContext | null = null;
  private retiring = false;
  private readonly consumers = new Map<ShadeGPUCommandContext, Promise<void>>();
  private updateSource: ScgiQueryScene | undefined;
  private readonly workingSets: GeometryQueryWorkingSet[] = [];
  private completedCuts: readonly GeometryQueryCut[] | undefined;
  private demandFrame = 0;
  private demandFailure: unknown;
  private feedbackTail: Promise<void> = Promise.resolve();

  get delayedCuts(): readonly GeometryQueryCut[] | undefined {
    if (this.demandFailure !== undefined) {
      throw this.demandFailure;
    }
    return this.completedCuts;
  }

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
    previous?: ScgiQueryScene,
  ): Promise<ScgiQueryScene> {
    scgiInteger(profile.deviceEpoch, "query device epoch");
    scgiInteger(profile.originEpoch, "query origin epoch", 0);
    scgiInteger(profile.primitiveCapacity, "query primitive shard capacity");
    scgiInteger(profile.maximumBytes, "query maximum bytes");
    profile = Object.freeze({
      ...profile,
      ...(profile.domain === undefined ? {} : { domain: geometryQueryDomain([profile.domain], 0) }),
    });
    if (runtime.nativeMaterials === null) {
      throw new Error("Query scene requires the existing native material runtime");
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
    // Negotiate the complete source-instance domain before allocating copies.
    // Raster visibility never limits the captured scene or its TLAS.
    const sourceCount = scene.queryBindings(command).highWaterCount;
    const sourceBytes = Math.max(1, sourceCount) * 192;
    if (
      sourceBytes > profile.maximumBytes ||
      Math.max(1, sourceCount) * 176 >
        Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)
    ) {
      throw new RangeError("Complete immutable query source exceeds admitted capacity before allocation");
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
          product.retainQueryGeometry(command, profile.directorySegmentBytes, cuts[index]),
        );
      }
      for (const lease of owner.geometryLeases) {
        owner.bytes += lease.metadataByteLength;
      }
      // The shared build shader only needs to admit the largest physical
      // shard in this publication. Keeping the user-facing capacity as a
      // shard ceiling is correct, but compiling that worst case for every
      // tiny Product would create a needlessly huge driver workload.
      let largestShard = 1;
      for (const lease of owner.geometryLeases) {
        for (const segment of lease.segments) {
          for (const asset of segment.queryAssets) {
            largestShard = Math.max(largestShard, Math.min(profile.primitiveCapacity, asset.primitiveCount));
          }
        }
      }
      owner.blasPlan = planScgiBvh(
        device.limits,
        scgiQueryBuildCapacity(largestShard, profile.primitiveCapacity),
      );
      owner.assertBudget();
      owner.assertBudget(
        48 +
          Math.max(
            48,
            owner.geometryLeases.reduce((count, lease) => count + lease.cut.assets.length, 0) * 48,
          ),
      );
      const coverage = await GeometryQueryCoverage.create(
        device,
        owner.sourceInstances,
        owner.geometryLeases,
        owner.materials.directory,
        accounting,
        profile.domain,
      );
      if (owner.destroyed) {
        coverage.destroy();
        throw new Error("Query device was lost during coverage preparation");
      }
      owner.coverage = coverage;
      owner.bytes += coverage.byteLength;
      if (profile.workingSet !== undefined) {
        for (const product of products) {
          const workingSet = await GeometryQueryWorkingSet.create(device, owner.sourceInstances, product, {
            ...profile.workingSet,
            errorFraction: 0.1,
            angularFootprint: 0,
            maximumBytes: profile.maximumBytes - owner.bytes,
          });
          owner.workingSets.push(workingSet);
          owner.bytes += workingSet.byteLength;
        }
      }
      if (
        owner.geometryLeases.every((lease) =>
          lease.segments.every((segment) => segment.queryAssets.every((asset) => asset.primitiveCount === 0)),
        )
      ) {
        owner.assertBudget();
        owner.state = "ready";
        return owner;
      }
      owner.assertBudget(Math.max(1, owner.sourceInstances.count) * 160);
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
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      );
      // Build at the shared batch layout, then publish only each chunk's live
      // hierarchy. The admission ceiling is not a per-asset persistent size.
      owner.blasBuildHierarchy = owner.allocate(
        "SCGI/query BLAS build hierarchy",
        owner.blasPlan.hierarchy.bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      );
      for (const plan of [owner.blasPlan]) {
        owner.assertBudget(ScgiBvhBuild.allocationBytes(device, plan));
        const builder = await ScgiBvhBuild.create(device, plan, profile.subgroup, accounting);
        if (owner.destroyed) {
          builder.destroy();
          throw new Error("Query device was lost during AS preparation");
        }
        owner.builders.push(builder);
        owner.bytes += builder.byteLength;
      }
      for (const lease of owner.geometryLeases) {
        for (const segment of lease.segments) {
          for (let asset = 0; asset < segment.queryAssets.length; asset++) {
            const range = segment.queryAssets[asset]!;
            for (let offset = 0; offset < range.primitiveCount; offset += owner.blasPlan.primitiveCapacity) {
              const count = Math.min(owner.blasPlan.primitiveCapacity, range.primitiveCount - offset);
              const publishedPlan = planScgiBvh(device.limits, count);
              owner.assertBudget(publishedPlan.hierarchy.bytes + count * 48 + 64);
              const acquired = ScgiQueryBlas.acquire(
                device,
                publishedPlan,
                lease,
                lease.segments.indexOf(segment),
                asset,
                offset,
                count,
                accounting,
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
                  count,
                  acquired.entry.triangles,
                  accounting,
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
              owner.bytes += acquired.entry.buffer.size + acquired.entry.triangles.size + 64;
              owner.geometries.push(
                Object.freeze({
                  index: owner.geometries.length,
                  geometry,
                  lease,
                  segment,
                  asset,
                  primitiveOffset: offset,
                  primitiveCount: count,
                  blas: acquired.entry.buffer,
                  entry: acquired.entry,
                }),
              );
            }
          }
        }
      }
      owner.assertBudget();
      // Arena boundaries follow actual physical limits, never asset count.
      // Every source chunk is admitted; overflow rejects preparation, not rays.
      const limit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
      const alignment = device.limits.minStorageBufferOffsetAlignment;
      let pending: ScgiQuerySceneGeometry[] = [];
      let arenaBytes = alignment;
      const publishArena = async (): Promise<void> => {
        if (pending.length === 0) {
          return;
        }
        const arena = await ScgiQueryArena.create(
          device,
          pending,
          owner!.sourceInstances,
          transforms,
          owner!.materialPublication,
          profile.subgroup,
          profile.domain,
          previous?.state === "submitted" && !previous.retiring
            ? previous.arenas[owner!.arenas.length]
            : undefined,
          profile.maximumBytes - owner!.bytes,
          accounting,
        );
        if (owner!.destroyed) {
          arena.destroy();
          throw new Error("Query device was lost during shared arena preparation");
        }
        owner!.arenas.push(arena);
        owner!.bytes += arena.byteLength;
        owner!.assertBudget();
        pending = [];
        arenaBytes = alignment;
      };
      for (const geometry of owner.geometries) {
        const added =
          Math.ceil(geometry.entry.buffer.size / alignment) * alignment +
          Math.ceil(geometry.entry.triangles.size / alignment) * alignment +
          alignment;
        if (arenaBytes + added > limit) {
          await publishArena();
        }
        pending.push(geometry);
        arenaBytes += added;
      }
      await publishArena();
      owner.updateSource = previous?.state === "submitted" && !previous.retiring ? previous : undefined;
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

  private assertBudget(additional = 0): void {
    if (this.bytes + additional > this.profile.maximumBytes) {
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
          buffer,
        ),
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

  /** A lease keeps its original pages alive, but a replacement Product must
   * produce a new query publication even when the instance table is unchanged. */
  matchesProducts(products: readonly VirtualGeometryResidency[]): boolean {
    return (
      products.length === this.geometryLeases.length &&
      products.every((product, index) => {
        const lease = this.geometryLeases[index]!;
        return (
          product.publicationActive &&
          lease.valid &&
          lease.cut.descriptor === product.descriptor &&
          lease.productGeneration === product.productGeneration &&
          lease.productTableSlot === product.productTableSlot
        );
      })
    );
  }

  matchesCuts(cuts: readonly GeometryQueryCut[]): boolean {
    return (
      cuts.length === this.geometryLeases.length &&
      cuts.every((cut, index) => {
        const previous = this.geometryLeases[index]!.cut;
        return (
          cut === previous ||
          (cut.descriptor === previous.descriptor &&
            cut.clusters.length === previous.clusters.length &&
            cut.clusters.every((cluster, slot) => cluster === previous.clusters[slot]) &&
            JSON.stringify(cut.assets) === JSON.stringify(previous.assets))
        );
      })
    );
  }

  get byteLength(): number {
    return this.bytes;
  }

  get instanceRecords(): GPUBuffer {
    if (this.transforms === null) {
      throw new Error("Empty query scene has no affine consumer");
    }
    return this.transforms.records;
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
      ...this.geometryLeases.map((lease) => lease.releaseAfter(Promise.reject(cause))),
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
          },
        );
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
      failed: (cause) => this.poison(cause),
    });
    this.sourceInstances.encode(command);
    this.coverage!.encode(command);
    this.transforms?.encode(command);
    for (const blas of this.staticBlas) {
      if (blas.build) {
        blas.geometry.encodeBounds(command);
        this.builders[0]!.encode(command, this.blasBuildHierarchy, this.blasScratch, blas.count);
        for (const name of ["header", "nodes", "links", "references"] as const) {
          const source = this.blasPlan.hierarchy.ranges[name]!;
          const destination = blas.entry.plan.hierarchy.ranges[name]!;
          command.copyBufferToBuffer(
            this.blasBuildHierarchy,
            source.offset,
            blas.entry.buffer,
            destination.offset,
            destination.bytes,
          );
        }
        blas.entry.observeBuild(command);
      }
    }
    const reusePrevious = this.updateSource?.state === "submitted" && !this.updateSource.retiring;
    if (reusePrevious) {
      this.updateSource!.observeResources(command);
    }
    for (const arena of this.arenas) {
      arena.encode(command, reusePrevious);
    }
    this.buildCommand = command;
    this.state = "encoded";
    this.observeUse(command);
  }

  /** Delayed feedback is advisory for the next immutable publication. Current
   * coverage always comes from the GPU certificate, never this readback. */
  encodeWorkingSet(command: ShadeGPUCommandContext): void {
    this.observeUse(command);
    const frame = ++this.demandFrame;
    for (const workingSet of this.workingSets) {
      workingSet.encode(command, frame);
    }
    command.observeSubmission({
      submitted: (fence) => {
        const feedback = this.feedbackTail
          .then(() => fence)
          .then(async () => {
            if (this.retiring || this.destroyed) {
              return;
            }
            const cuts = await Promise.all(
              this.workingSets.map((workingSet) => workingSet.consumeCompleted(frame)),
            );
            if (
              cuts.length > 0 &&
              cuts.every((cut) => cut !== undefined) &&
              !this.retiring &&
              !this.destroyed
            ) {
              this.completedCuts = cuts as GeometryQueryCut[];
            }
          })
          .catch((error) => {
            this.demandFailure = error;
          });
        this.feedbackTail = feedback;
      },
      aborted: () => {},
      failed: (error) => {
        this.demandFailure = error;
      },
    });
  }

  async releaseAfter(completion: PromiseLike<void>): Promise<void> {
    if (this.state !== "submitted" && this.state !== "poisoned") {
      throw new Error("Query publication retirement requires a submitted consumer");
    }
    this.retiring = true;
    try {
      await Promise.all([completion, ...this.consumers.values(), this.feedbackTail]);
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
    for (const workingSet of this.workingSets) {
      workingSet.retire();
    }
    for (const arena of this.arenas) {
      arena.destroy();
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
