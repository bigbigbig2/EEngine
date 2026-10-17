import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type {
  CommandSubmissionObserver,
  ShadeGPUCommandContext,
} from "../../framegraph/ShadeGPUCommandContext.js";
import { SCGI_CELL_EMPTY } from "./ScgiAbi.js";
import {
  assertScgiCacheCapabilities,
  assertScgiAnchorCapabilities,
  planScgiAllocation,
  scgiExecutionProfile,
  scgiInteger,
  type ScgiAllocationPlan,
  type ScgiAllocationProfile,
} from "./ScgiCapacity.js";
import type { ScgiBufferProduct, ScgiFieldProduct, ScgiFramePublication } from "./ScgiPublication.js";

interface Allocation {
  readonly products: readonly ScgiBufferProduct[];
  readonly handles: readonly ResourceHandle[];
  lastFence: Promise<void> | null;
  fenceComplete: boolean;
  retired: boolean;
  accountedRetired: boolean;
  destroyed: boolean;
}

interface Workset {
  readonly plan: ScgiAllocationPlan;
  readonly world: Allocation;
  readonly screen: Allocation;
  readonly scratch: Allocation;
  readonly fields: readonly [ScgiFieldProduct, ScgiFieldProduct];
  readonly fieldScales: [number, number];
  worldRole: number;
  screenRole: number;
  worldValid: boolean;
  screenValid: boolean;
  sceneEpoch: number;
  viewEpoch: number;
}

/** Borrowed scene/query resources remain owned by their existing producer.
 * Static AS can share an immutable lease; dynamic AS publishes a candidate lease.
 * release receives the last consumer fence even on submitted failures. */
export interface ScgiBorrowedLease {
  readonly deviceEpoch: number;
  readonly kind: "scene" | "static-as" | "dynamic-as" | "material" | "environment";
  release(lastConsumer: Promise<void> | null): void;
}

export interface ScgiDemand {
  readonly enabled: boolean;
  readonly hasGeometry: boolean;
  readonly hasLitMaterials: boolean;
}

export class ScgiFrameTransaction implements CommandSubmissionObserver {
  readonly publication: ScgiFramePublication;
  readonly completion: Promise<void>;
  readonly replaced: readonly Allocation[];
  state: "prepared" | "encoded" | "submitted" | "aborted" = "prepared";
  failure: unknown;
  leasesReleased = false;

  constructor(
    readonly owner: ScgiRuntime,
    readonly command: ShadeGPUCommandContext,
    readonly workset: Workset,
    readonly leases: readonly ScgiBorrowedLease[],
    publication: ScgiFramePublication,
    replaced: readonly Allocation[],
  ) {
    this.publication = publication;
    this.replaced = replaced;
    this.completion = command.gpuDone;
  }

  /** Only bookkeeping: no GPU work, allocation, callbacks or throwing asserts. */
  submitted(fence: Promise<void>): void {
    this.owner.commit(this, fence);
  }

  aborted(cause: unknown): void {
    if (this.state === "submitted" || this.state === "aborted") {
      return;
    }
    this.failure = cause;
    this.state = "aborted";
    this.publication.status = "aborted";
    this.owner.aborted(this);
  }

  failed(cause: unknown): void {
    this.failure = cause;
    this.owner.poison(cause, this.publication.deviceEpoch);
  }

  /** Called by the real field writer after complete field+guide+identity writes. */
  markFieldComplete(coefficientScale = 1): void {
    if (this.state !== "encoded" || !Number.isFinite(coefficientScale) || coefficientScale <= 0) {
      throw new Error("SCGI field can only publish after transaction initialization");
    }
    this.publication.coefficientScale = coefficientScale;
    this.publication.fieldComplete = true;
  }
}

/** Per-view owner. Configuration can allocate, encode can record commands,
 * commit only advances already-prepared roles. No submits or readbacks here. */
export class ScgiRuntime {
  #active: Workset | null = null;
  #configured: Workset | null = null;
  #pending: ScgiFrameTransaction | null = null;
  #allocations: Allocation[] = [];
  #publications: ScgiFramePublication[] = [];
  #generation = 0;
  #sampleSerial = 0;
  #addressGeneration = 0;
  #configurationSerial = 0;
  #poisoned = false;
  #destroyed = false;
  #deviceLost = false;
  #configuring = false;
  #lastFailure: unknown;
  #liveBytes = 0;
  #peakBytes = 0;
  readonly #errorListener: (event: GPUUncapturedErrorEvent) => void;

  constructor(
    readonly device: GPUDevice,
    readonly deviceEpoch: number,
    readonly accounting?: ResourceAccounting,
  ) {
    scgiInteger(deviceEpoch, "device epoch");
    this.#errorListener = (event) => this.poison(event.error, deviceEpoch);
    device.addEventListener("uncapturederror", this.#errorListener);
    void device.lost.then((info) => {
      this.#deviceLost = true;
      this.poison(info, deviceEpoch);
      this.destroy();
      this.collect();
    });
  }

  get activeGeneration(): number {
    return this.#generation;
  }
  get sampleSerial(): number {
    return this.#sampleSerial;
  }
  get poisoned(): boolean {
    return this.#poisoned;
  }
  get lastFailure(): unknown {
    return this.#lastFailure;
  }

  /** Allocation failures leave active and its history unchanged. Error scopes
   * settle before a replacement can be prepared or published. */
  async configure(demand: ScgiDemand, profile: ScgiAllocationProfile): Promise<ScgiAllocationPlan | null> {
    if (this.#pending !== null || this.#destroyed || this.#poisoned || this.#configuring) {
      throw new Error("SCGI configuration requires a live owner with no open transaction");
    }
    const serial = ++this.#configurationSerial;
    if (!demand.enabled || !demand.hasGeometry || !demand.hasLitMaterials) {
      this.disable();
      return null;
    }
    const plan = planScgiAllocation(this.device.limits, profile);
    scgiExecutionProfile(this.device);
    assertScgiCacheCapabilities(this.device.limits, plan);
    assertScgiAnchorCapabilities(this.device.limits, plan);
    const previous = this.#active;
    const same = (a: ScgiBufferProduct, b: { bytes: number; ranges: unknown }) =>
      a.plan.bytes === b.bytes && JSON.stringify(a.plan.ranges) === JSON.stringify(b.ranges);
    const created: Allocation[] = [];
    this.#configuring = true;
    this.device.pushErrorScope("out-of-memory");
    this.device.pushErrorScope("validation");
    let workset: Workset | null = null;
    let failure: unknown;
    try {
      const world =
        previous !== null &&
        previous.plan.profile.resolution === profile.resolution &&
        previous.plan.profile.cascades === profile.cascades &&
        same(previous.world.products[0]!, plan.world)
          ? previous.world
          : this.#allocate("world", [plan.world, plan.world], created);
      const screen =
        previous !== null &&
        previous.plan.profile.width === profile.width &&
        previous.plan.profile.height === profile.height
          ? previous.screen
          : this.#allocate("screen", [...plan.screen, ...plan.screen], created);
      const scratch =
        previous !== null &&
        same(previous.scratch.products[0]!, plan.scratch) &&
        same(previous.scratch.products[1]!, plan.batch) &&
        previous.plan.profile.width === profile.width &&
        previous.plan.profile.height === profile.height
          ? previous.scratch
          : this.#allocate("scratch", [plan.scratch, plan.batch, ...plan.anchors], created);
      const fields: readonly [ScgiFieldProduct, ScgiFieldProduct] =
        screen === previous?.screen
          ? previous.fields
          : [
              { segments: screen.products.slice(0, plan.screen.length) },
              { segments: screen.products.slice(plan.screen.length) },
            ];
      workset = {
        plan,
        world,
        screen,
        scratch,
        fields,
        fieldScales: screen === previous?.screen ? previous.fieldScales : [1, 1],
        worldRole: world === previous?.world ? previous.worldRole : 0,
        screenRole: screen === previous?.screen ? previous.screenRole : 0,
        worldValid: world === previous?.world && previous.worldValid,
        screenValid: screen === previous?.screen && previous.screenValid,
        sceneEpoch: previous?.sceneEpoch ?? 0,
        viewEpoch: previous?.viewEpoch ?? 0,
      };
    } catch (cause) {
      failure = cause;
    }
    const validation = this.device.popErrorScope();
    const memory = this.device.popErrorScope();
    try {
      const errors = await Promise.all([validation, memory]);
      failure ??= errors[0] ?? errors[1];
    } catch (cause) {
      failure ??= cause;
    }
    this.#configuring = false;
    if (serial !== this.#configurationSerial || this.#destroyed || this.#poisoned) {
      failure ??= new Error("SCGI configuration belongs to an expired owner/configuration");
    }
    if (failure !== undefined && failure !== null) {
      for (const allocation of created) {
        allocation.retired = true;
      }
      this.collect();
      throw failure;
    }
    const abandoned = this.#configured;
    this.#configured = workset!;
    if (abandoned !== null && abandoned !== previous) {
      this.#retireUnused(abandoned, workset!, previous);
    }
    this.collect();
    return plan;
  }

  #allocate(label: string, plans: readonly ScgiAllocationPlan["world"][], created: Allocation[]): Allocation {
    const products: ScgiBufferProduct[] = [];
    const handles: ResourceHandle[] = [];
    const allocation: Allocation = {
      products,
      handles,
      lastFence: null,
      fenceComplete: true,
      retired: false,
      accountedRetired: false,
      destroyed: false,
    };
    created.push(allocation);
    this.#allocations.push(allocation);
    for (let role = 0; role < plans.length; role++) {
      const plan = plans[role]!;
      const buffer = this.device.createBuffer({
        label: `SCGI/${label}/${role}`,
        size: plan.bytes,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST |
          (label === "scratch" ? GPUBufferUsage.INDIRECT : 0),
      });
      products.push({ buffer, plan });
      this.#liveBytes += plan.bytes;
      this.#peakBytes = Math.max(this.#peakBytes, this.#liveBytes);
      if (this.accounting !== undefined) {
        handles.push(
          this.accounting.created(
            {
              kind: "buffer",
              owner: "SCGI",
              category: label === "screen" ? "history" : label === "world" ? "work-cache" : "transient",
              bytes: plan.bytes,
              label: buffer.label,
            },
            buffer,
          ),
        );
      }
    }
    return allocation;
  }

  prepare(
    command: ShadeGPUCommandContext,
    epochs: { readonly scene: number; readonly view: number },
    leases: readonly ScgiBorrowedLease[] = [],
  ): ScgiFrameTransaction | null {
    if (
      this.#destroyed ||
      this.#poisoned ||
      this.#configuring ||
      this.#pending !== null ||
      command.closed ||
      command.device !== this.device
    ) {
      throw new Error("SCGI cannot prepare an expired, overlapping or foreign-device transaction");
    }
    const workset = this.#configured ?? this.#active;
    if (workset === null) {
      return null;
    }
    scgiInteger(epochs.scene, "scene epoch");
    scgiInteger(epochs.view, "view epoch");
    scgiInteger(this.#generation + 1, "generation");
    scgiInteger(this.#sampleSerial + 1, "sample serial");
    for (const lease of leases) {
      if (lease.deviceEpoch !== this.deviceEpoch) {
        throw new Error("SCGI borrowed lease belongs to another device epoch");
      }
    }
    const active = this.#active;
    const replaced: Allocation[] = [];
    if (active !== null) {
      for (const key of ["world", "screen", "scratch"] as const) {
        if (active[key] !== workset[key]) {
          replaced.push(active[key]);
        }
      }
    }
    const worldRole = workset.worldValid ? 1 - workset.worldRole : 0;
    const screenRole = workset.screenValid ? 1 - workset.screenRole : 0;
    const worldCompatible = workset.worldValid && workset.sceneEpoch === epochs.scene;
    const screenCompatible = workset.screenValid && worldCompatible && workset.viewEpoch === epochs.view;
    const publication: ScgiFramePublication = {
      deviceEpoch: this.deviceEpoch,
      sceneEpoch: epochs.scene,
      viewEpoch: epochs.view,
      addressGeneration:
        this.#addressGeneration +
        Number(
          active === null ||
            active.world !== workset.world ||
            active.screen !== workset.screen ||
            active.scratch !== workset.scratch,
        ),
      generation: this.#generation + 1,
      sampleSerial: this.#sampleSerial,
      extent: [workset.plan.profile.width, workset.plan.profile.height],
      halfExtent: [workset.plan.halfWidth, workset.plan.halfHeight],
      radianceDomain: "linear-rec709-unexposed",
      coefficientScale: 1,
      previousCoefficientScale: screenCompatible ? workset.fieldScales[workset.screenRole]! : 1,
      activeWorld: worldCompatible ? workset.world.products[workset.worldRole]! : null,
      candidateWorld: workset.world.products[worldRole]!,
      previousWorldField: screenCompatible ? workset.fields[workset.screenRole]! : null,
      candidateWorldField: workset.fields[screenRole]!,
      privateScratch: workset.scratch.products[0]!,
      queryBatch: workset.scratch.products[1]!,
      anchors: workset.scratch.products.slice(2),
      status: "prepared",
      fieldComplete: false,
      cacheComplete: false,
      estimateComplete: false,
      filteredComplete: false
    };
    const transaction = new ScgiFrameTransaction(this, command, workset, leases, publication, replaced);
    this.#pending = transaction;
    this.#publications.push(publication);
    command.observeSubmission(transaction);
    command.onBeforeFinish.addOne(() => {
      if (transaction.state !== "encoded" || this.#poisoned || this.#destroyed) {
        throw new Error("SCGI transaction was not initialized before submit");
      }
    });
    void transaction.completion.then(
      () => {
        for (const allocation of [workset.world, workset.screen, workset.scratch]) {
          if (allocation.lastFence === transaction.completion) {
            allocation.fenceComplete = true;
          }
        }
        this.#releaseLeases(transaction);
        this.#forgetPublication(publication);
        this.collect();
      },
      (cause: unknown) => {
        if (transaction.state === "submitted") {
          this.poison(cause, publication.deviceEpoch);
        }
        this.#releaseLeases(transaction);
        this.#forgetPublication(publication);
        this.collect();
      },
    );
    return transaction;
  }

  /** Full bank copy includes allocator, statistics, both A0/A2 and bounce queue.
   * Initial map uses EMPTY, never zero. All writes are encoder ordered. */
  encode(transaction: ScgiFrameTransaction): void {
    if (transaction !== this.#pending || transaction.state !== "prepared") {
      throw new Error("SCGI transaction does not own this encoding boundary");
    }
    const { command, publication, workset } = transaction;
    const world = publication.candidateWorld;
    if (publication.activeWorld !== null) {
      command.copyBufferToBuffer(publication.activeWorld.buffer, 0, world.buffer, 0, world.plan.bytes);
    } else {
      command.clearBuffer(world.buffer);
      const map = world.plan.ranges.map!;
      const initialMap = new Uint32Array(map.bytes / 4);
      for (let cell = 0; cell < map.count; cell++) {
        initialMap[cell * 2] = SCGI_CELL_EMPTY;
      }
      command.uploadRegions([
        {
          destination: world.buffer,
          destinationOffset: map.offset,
          bytes: new Uint8Array(initialMap.buffer),
        },
      ]);
    }
    command.clearBuffer(publication.privateScratch.buffer);
    command.clearBuffer(publication.queryBatch.buffer);
    for (const segment of publication.candidateWorldField.segments) {
      command.clearBuffer(segment.buffer);
    }
    // Header lanes not owned by this transaction remain part of the full copy.
    // First frame clear initialized all other allocator/cascade state.
    const header = new Uint32Array([
      publication.generation,
      this.deviceEpoch,
      publication.sceneEpoch,
      publication.viewEpoch,
    ]);
    command.uploadRegions([
      { destination: world.buffer, destinationOffset: 0, bytes: new Uint8Array(header.buffer) },
    ]);
    // Header58/59 belong to GPU field scale/filter configuration, copied with
    // the world bank. They must survive prepare for post-filter reset checks.
    const serial = new Uint32Array([publication.addressGeneration, publication.sampleSerial]);
    command.uploadRegions([
      { destination: world.buffer, destinationOffset: 224, bytes: new Uint8Array(serial.buffer) },
    ]);
    const ranges = world.plan.ranges;
    if (publication.activeWorld === null) {
      const capacities = new Uint32Array([
        workset.plan.profile.patches,
        workset.plan.cells,
        workset.plan.profile.bounceRequests,
        0,
      ]);
      command.uploadRegions([
        {
          destination: world.buffer,
          destinationOffset: ranges.header!.offset + 48,
          bytes: new Uint8Array(capacities.buffer),
        },
      ]);
    }
    transaction.state = "encoded";
    publication.status = "encoded";
  }

  /** Idempotent and allocation-free. No external release/accounting callbacks. */
  commit(transaction: ScgiFrameTransaction, _fence: Promise<void>): void {
    if (
      transaction !== this.#pending ||
      transaction.state !== "encoded" ||
      !transaction.command.wasSubmitted
    ) {
      return;
    }
    const { workset, publication } = transaction;
    transaction.state = "submitted";
    publication.status = this.#poisoned ? "poisoned" : "submitted";
    workset.worldRole = workset.world.products[0] === publication.candidateWorld ? 0 : 1;
    workset.screenRole = workset.fields[0] === publication.candidateWorldField ? 0 : 1;
    workset.fieldScales[workset.screenRole] = publication.coefficientScale;
    workset.worldValid = !this.#poisoned;
    workset.screenValid = publication.fieldComplete && !this.#poisoned;
    workset.sceneEpoch = publication.sceneEpoch;
    workset.viewEpoch = publication.viewEpoch;
    workset.world.lastFence = transaction.completion;
    workset.world.fenceComplete = false;
    workset.screen.lastFence = transaction.completion;
    workset.screen.fenceComplete = false;
    workset.scratch.lastFence = transaction.completion;
    workset.scratch.fenceComplete = false;
    for (let index = 0; index < transaction.replaced.length; index++) {
      transaction.replaced[index]!.retired = true;
    }
    this.#active = workset;
    this.#configured = null;
    this.#pending = null;
    this.#generation = publication.generation;
    this.#sampleSerial++;
    this.#addressGeneration = publication.addressGeneration;
  }

  aborted(transaction: ScgiFrameTransaction): void {
    if (this.#pending === transaction) {
      this.#pending = null;
    }
    this.#releaseLeases(transaction);
  }

  #releaseLeases(transaction: ScgiFrameTransaction): void {
    if (transaction.leasesReleased) {
      return;
    }
    transaction.leasesReleased = true;
    for (const lease of transaction.leases) {
      try {
        lease.release(transaction.state === "submitted" ? transaction.completion : null);
      } catch (cause) {
        // Retain failure and invalidate the owner, but still release other leases
        // and run retirement. This callback never participates in CPU commit.
        transaction.failure = cause;
        this.poison(cause, transaction.publication.deviceEpoch);
      }
    }
  }

  #forgetPublication(publication: ScgiFramePublication): void {
    const index = this.#publications.indexOf(publication);
    if (index >= 0) {
      this.#publications.splice(index, 1);
    }
  }

  poison(cause: unknown, deviceEpoch: number): void {
    if (deviceEpoch !== this.deviceEpoch || this.#destroyed) {
      return;
    }
    this.#poisoned = true;
    this.#lastFailure = cause;
    for (const publication of this.#publications) {
      if (publication.status !== "aborted") {
        publication.status = "poisoned";
      }
    }
  }

  #retireUnused(workset: Workset, keep: Workset | null, alsoKeep: Workset | null = null): void {
    for (const key of ["world", "screen", "scratch"] as const) {
      if (workset[key] !== keep?.[key] && workset[key] !== alsoKeep?.[key]) {
        workset[key].retired = true;
      }
    }
  }

  disable(): void {
    if (this.#pending !== null) {
      throw new Error("Abort the open SCGI command before disabling its owner");
    }
    this.#configurationSerial++;
    if (this.#active !== null) {
      this.#retireUnused(this.#active, null);
    }
    if (this.#configured !== null) {
      this.#retireUnused(this.#configured, null);
    }
    this.#active = null;
    this.#configured = null;
    this.collect();
  }

  collect(): void {
    for (const allocation of this.#allocations) {
      if (!allocation.retired || allocation.destroyed) {
        continue;
      }
      if (!allocation.accountedRetired) {
        for (const handle of allocation.handles) {
          this.accounting?.setRetired(handle, true);
        }
        allocation.accountedRetired = true;
      }
      if (!allocation.fenceComplete && !this.#deviceLost) {
        continue;
      }
      for (const product of allocation.products) {
        product.buffer.destroy();
        this.#liveBytes -= product.plan.bytes;
      }
      for (const handle of allocation.handles) {
        this.accounting?.destroyed(handle);
      }
      allocation.destroyed = true;
    }
    this.#allocations = this.#allocations.filter((allocation) => !allocation.destroyed);
  }

  snapshot() {
    this.collect();
    let retiredBytes = 0;
    for (const allocation of this.#allocations) {
      if (allocation.retired) {
        for (const product of allocation.products) {
          retiredBytes += product.plan.bytes;
        }
      }
    }
    return Object.freeze({
      generation: this.#generation,
      sampleSerial: this.#sampleSerial,
      deviceEpoch: this.deviceEpoch,
      poisoned: this.#poisoned,
      liveBytes: this.#liveBytes - retiredBytes,
      retiredBytes,
      totalBytes: this.#liveBytes,
      peakBytes: this.#peakBytes,
      pending: this.#pending?.state ?? null,
    });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    if (this.#pending !== null) {
      this.#pending.command.abort(new Error("SCGI owner destroyed"));
    }
    this.disable();
    this.#destroyed = true;
    this.device.removeEventListener("uncapturederror", this.#errorListener);
  }
}
