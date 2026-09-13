import type { GpuShadingPublicationSnapshot } from "../../gpu/GpuShadingPublicationPlan.js";
import { ShadingBinPass } from "../passes/ShadingBinPass.js";
import { SparseShadingResolvePass } from "../passes/SparseShadingResolvePass.js";

export interface SparseShadingCandidateGpuRevision {
  readonly snapshot: Readonly<GpuShadingPublicationSnapshot>;
  readonly bins: ShadingBinPass | null;
  readonly resolve: SparseShadingResolvePass | null;
  readonly heapBytes: number;
  readonly indirectBytes: number;
}

export interface SparseShadingCandidateGpuRevisionEvidence {
  readonly activeRevision: number | null;
  readonly activeDeviceEpoch: number | null;
  readonly activeHeapBytes: number;
  readonly activeIndirectBytes: number;
  readonly retiringRevisions: readonly number[];
  readonly retiringBytes: number;
  readonly pendingPreparations: number;
  readonly createCount: number;
  readonly publishCount: number;
  readonly abortCount: number;
  readonly retireCount: number;
  readonly deviceLossCount: number;
  readonly destroyed: boolean;
}

export type SparseShadingCandidateGpuRevisionFactory = (
  device: GPUDevice,
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  diagnostics: boolean
) => Promise<Readonly<SparseShadingCandidateGpuRevision>>;

/**
 * A fully-created but unpublished GPU revision. Publication and abort are
 * deliberately owned by SparseShadingCandidateGpuRevisionOwner so a failed or
 * stale CPU publication cannot leak a provisional heap/args/pipeline set.
 */
export class SparseShadingCandidatePreparedGpuRevision {
  private closed = false;

  constructor(
    readonly ownerIdentity: SparseShadingCandidateGpuRevisionOwner,
    readonly resources: Readonly<SparseShadingCandidateGpuRevision>
  ) {}

  _close(): void {
    if (this.closed) throw new Error("Sparse shading prepared GPU revision is already closed");
    this.closed = true;
  }

  _requireOpen(): void {
    if (this.closed) throw new Error("Sparse shading prepared GPU revision is already closed");
  }
}

/**
 * Candidate-only owner for immutable, revision-scoped GPU resources.
 *
 * Resize and summary mutations first create a complete replacement. The owner
 * publishes it only after the matching CPU transaction commits, then keeps the
 * previous resources alive until the last submission that can reference them
 * has completed. Stable frames only read active(); they allocate nothing.
 */
export class SparseShadingCandidateGpuRevisionOwner {
  private activeValue: Readonly<SparseShadingCandidateGpuRevision> | null = null;
  private retiring: Array<Readonly<{
    resources: Readonly<SparseShadingCandidateGpuRevision>;
    retireAfterSubmission: number;
  }>> = [];
  private readonly pending = new Set<SparseShadingCandidatePreparedGpuRevision>();
  private createCount = 0;
  private publishCount = 0;
  private abortCount = 0;
  private retireCount = 0;
  private deviceLossCount = 0;
  private lastCompletedSubmission = 0;
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly diagnostics = false,
    private readonly factory: SparseShadingCandidateGpuRevisionFactory = createGpuRevision
  ) {}

  async prepare(
    snapshot: Readonly<GpuShadingPublicationSnapshot>
  ): Promise<SparseShadingCandidatePreparedGpuRevision> {
    this.requireAlive();
    if (this.pending.size !== 0) {
      throw new Error("Sparse shading permits only one provisional GPU revision");
    }
    const resources = await this.factory(this.device, snapshot, this.diagnostics);
    validateRevisionResources(resources, snapshot, this.diagnostics);
    const prepared = new SparseShadingCandidatePreparedGpuRevision(this, resources);
    this.pending.add(prepared);
    this.createCount++;
    return prepared;
  }

  publish(
    prepared: SparseShadingCandidatePreparedGpuRevision,
    publishedSnapshot: Readonly<GpuShadingPublicationSnapshot>,
    retireAfterSubmission: number
  ): Readonly<SparseShadingCandidateGpuRevision> {
    this.requireAlive();
    this.requirePrepared(prepared);
    assertSubmissionSerial(retireAfterSubmission, "Sparse shading GPU revision retirement serial");
    if (retireAfterSubmission < this.lastCompletedSubmission) {
      throw new Error("Sparse shading GPU revision cannot retire before already completed work");
    }
    if (prepared.resources.snapshot !== publishedSnapshot) {
      throw new Error("Sparse shading GPU revision does not match the committed publication snapshot");
    }
    prepared._close();
    this.pending.delete(prepared);
    const previous = this.activeValue;
    this.activeValue = prepared.resources;
    this.publishCount++;
    if (previous !== null) {
      this.retiring.push(Object.freeze({ resources: previous, retireAfterSubmission }));
    }
    return prepared.resources;
  }

  abort(prepared: SparseShadingCandidatePreparedGpuRevision): void {
    this.requireAlive();
    this.requirePrepared(prepared);
    prepared._close();
    this.pending.delete(prepared);
    destroyRevision(prepared.resources);
    this.abortCount++;
  }

  active(
    snapshot: Readonly<GpuShadingPublicationSnapshot>
  ): Readonly<SparseShadingCandidateGpuRevision> {
    this.requireAlive();
    const active = this.activeValue;
    if (active === null || active.snapshot !== snapshot) {
      throw new Error("Sparse shading active GPU revision does not match the frame snapshot");
    }
    return active;
  }

  completeSubmittedWork(completedSubmission: number): readonly number[] {
    this.requireAlive();
    assertSubmissionSerial(completedSubmission, "Sparse shading completed submission serial");
    if (completedSubmission < this.lastCompletedSubmission) {
      throw new Error("Sparse shading completed submission serial must be monotonic");
    }
    this.lastCompletedSubmission = completedSubmission;
    const retired: number[] = [];
    this.retiring = this.retiring.filter((entry) => {
      if (entry.retireAfterSubmission > completedSubmission) return true;
      retired.push(entry.resources.snapshot.revision);
      destroyRevision(entry.resources);
      this.retireCount++;
      return false;
    });
    return Object.freeze(retired);
  }

  markDeviceLost(): void {
    this.requireAlive();
    for (const prepared of this.pending) {
      prepared._close();
      destroyRevision(prepared.resources);
    }
    this.pending.clear();
    if (this.activeValue !== null) destroyRevision(this.activeValue);
    for (const entry of this.retiring) destroyRevision(entry.resources);
    this.activeValue = null;
    this.retiring = [];
    this.deviceLossCount++;
  }

  evidence(): Readonly<SparseShadingCandidateGpuRevisionEvidence> {
    const active = this.activeValue;
    return Object.freeze({
      activeRevision: active?.snapshot.revision ?? null,
      activeDeviceEpoch: active?.snapshot.deviceEpoch ?? null,
      activeHeapBytes: active?.heapBytes ?? 0,
      activeIndirectBytes: active?.indirectBytes ?? 0,
      retiringRevisions: Object.freeze(this.retiring.map((entry) => entry.resources.snapshot.revision)),
      retiringBytes: this.retiring.reduce(
        (sum, entry) => sum + entry.resources.heapBytes + entry.resources.indirectBytes,
        0
      ),
      pendingPreparations: this.pending.size,
      createCount: this.createCount,
      publishCount: this.publishCount,
      abortCount: this.abortCount,
      retireCount: this.retireCount,
      deviceLossCount: this.deviceLossCount,
      destroyed: this.destroyed
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const prepared of this.pending) {
      prepared._close();
      destroyRevision(prepared.resources);
    }
    this.pending.clear();
    if (this.activeValue !== null) destroyRevision(this.activeValue);
    for (const entry of this.retiring) destroyRevision(entry.resources);
    this.activeValue = null;
    this.retiring = [];
    this.destroyed = true;
  }

  private requirePrepared(prepared: SparseShadingCandidatePreparedGpuRevision): void {
    if (prepared.ownerIdentity !== this || !this.pending.has(prepared)) {
      throw new Error("Sparse shading prepared GPU revision is foreign or no longer pending");
    }
    prepared._requireOpen();
  }

  private requireAlive(): void {
    if (this.destroyed) throw new Error("Sparse shading GPU revision owner is destroyed");
  }
}

async function createGpuRevision(
  device: GPUDevice,
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  diagnostics: boolean
): Promise<Readonly<SparseShadingCandidateGpuRevision>> {
  if (snapshot.pipelines.length === 0) {
    return freezeRevision(snapshot, null, null);
  }
  const bins = await ShadingBinPass.create(device, snapshot.sizing, diagnostics);
  try {
    const resolve = await SparseShadingResolvePass.create(
      device,
      snapshot.pipelines,
      snapshot.revision,
      diagnostics
    );
    return freezeRevision(snapshot, bins, resolve);
  } catch (error) {
    bins.destroy();
    throw error;
  }
}

function freezeRevision(
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  bins: ShadingBinPass | null,
  resolve: SparseShadingResolvePass | null
): Readonly<SparseShadingCandidateGpuRevision> {
  return Object.freeze({
    snapshot,
    bins,
    resolve,
    heapBytes: bins?.sizing.heapBytes ?? 0,
    indirectBytes: bins?.sizing.indirectBytes ?? 0
  });
}

function validateRevisionResources(
  resources: Readonly<SparseShadingCandidateGpuRevision>,
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  diagnostics: boolean
): void {
  if (resources.snapshot !== snapshot) {
    destroyRevision(resources);
    throw new Error("Sparse shading GPU revision factory changed the publication snapshot");
  }
  const hasOpaque = snapshot.pipelines.length > 0;
  if (hasOpaque !== (resources.bins !== null) || hasOpaque !== (resources.resolve !== null)) {
    destroyRevision(resources);
    throw new Error("Sparse shading GPU revision resource closure does not match active bins");
  }
  if (resources.bins !== null && (
    resources.bins.diagnostics !== diagnostics ||
    resources.bins.sizing !== snapshot.sizing ||
    resources.resolve!.diagnostics !== diagnostics ||
    resources.resolve!.publicationRevision !== snapshot.revision
  )) {
    destroyRevision(resources);
    throw new Error("Sparse shading GPU revision ABI does not match its publication snapshot");
  }
  if (resources.heapBytes !== (resources.bins?.sizing.heapBytes ?? 0) ||
      resources.indirectBytes !== (resources.bins?.sizing.indirectBytes ?? 0)) {
    destroyRevision(resources);
    throw new Error("Sparse shading GPU revision memory evidence is inconsistent");
  }
}

function destroyRevision(resources: Readonly<SparseShadingCandidateGpuRevision>): void {
  resources.resolve?.destroy();
  resources.bins?.destroy();
}

function assertSubmissionSerial(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} is invalid`);
}
