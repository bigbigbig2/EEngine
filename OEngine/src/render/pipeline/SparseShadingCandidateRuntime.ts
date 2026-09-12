import {
  GpuShadingPublicationStore,
  type GpuShadingPublicationContext,
  type GpuShadingPublicationSnapshot,
  type GpuShadingPublicationTransaction
} from "../../gpu/GpuShadingPublicationPlan.js";
import {
  createSparseShadingCandidatePlan,
  type SparseShadingCandidateFeatureInput,
  type SparseShadingCandidatePlan
} from "./SparseShadingCandidatePipeline.js";

export interface SparseShadingCandidateLifecycleEvidence {
  readonly activeRevision: number | null;
  readonly deviceEpoch: number;
  readonly frameEncodes: number;
  readonly submittedFrames: number;
  readonly abortedFrames: number;
  readonly pendingFrames: number;
  readonly planCacheHits: number;
  readonly planCacheMisses: number;
  readonly historyGeneration: number;
  readonly lastSubmittedSerial: number;
  readonly retiredRevisions: readonly number[];
  readonly destroyed: boolean;
}

export interface SparseShadingCandidateFrameTicket {
  readonly frameId: number;
  readonly snapshot: Readonly<GpuShadingPublicationSnapshot>;
  readonly plan: Readonly<SparseShadingCandidatePlan>;
  readonly historyGeneration: number;
}

/** Candidate-only bridge between publication transactions and frame recipes. */
export class SparseShadingCandidateRuntime {
  private readonly plans = new Map<string, Readonly<SparseShadingCandidatePlan>>();
  private readonly pendingFrames = new Map<number, Readonly<{
    publicationRevision: number;
    hasHistories: boolean;
  }>>();
  private activeRevision: number | null = null;
  private nextFrameId = 1;
  private deviceEpoch = 1;
  private frameEncodes = 0;
  private submittedFrames = 0;
  private abortedFrames = 0;
  private planCacheHits = 0;
  private planCacheMisses = 0;
  private historyGeneration = 1;
  private lastSubmittedSerial = 0;
  private retiredRevisions: number[] = [];
  private destroyed = false;

  constructor(readonly publications: GpuShadingPublicationStore) {}

  beginMutation(): GpuShadingPublicationTransaction {
    this.requireAlive();
    return this.publications.beginTransaction();
  }

  prepareMutation(
    transaction: GpuShadingPublicationTransaction,
    features: Readonly<SparseShadingCandidateFeatureInput>
  ): Readonly<SparseShadingCandidatePlan> {
    this.requireAlive();
    // Prepared snapshots are provisional. Caching them by future revision would
    // let an aborted transaction poison a later commit that reuses that revision.
    return createSparseShadingCandidatePlan(transaction.prepare(), features);
  }

  commitMutation(
    transaction: GpuShadingPublicationTransaction,
    submissionSerial: number,
    features: Readonly<SparseShadingCandidateFeatureInput>
  ): Readonly<SparseShadingCandidatePlan> {
    this.requireAlive();
    const snapshot = transaction.commit(submissionSerial);
    const plan = this.planFor(snapshot, features);
    this.activeRevision = snapshot.revision;
    return plan;
  }

  abortMutation(transaction: GpuShadingPublicationTransaction): void {
    this.requireAlive();
    transaction.abort();
  }

  beginFrame(
    features: Readonly<SparseShadingCandidateFeatureInput>
  ): Readonly<SparseShadingCandidateFrameTicket> {
    this.requireAlive();
    const snapshot = this.publications.currentSnapshot();
    const plan = this.planFor(snapshot, features);
    this.activeRevision = snapshot.revision;
    if (plan.histories.length > 0 &&
        [...this.pendingFrames.values()].some((pending) => pending.hasHistories)) {
      throw new Error("Sparse shading permits only one pending history-writing frame");
    }
    const frameId = this.nextFrameId;
    this.nextFrameId = nextGeneration(this.nextFrameId);
    if (this.pendingFrames.has(frameId)) {
      throw new Error("Sparse shading frame id space is exhausted");
    }
    this.pendingFrames.set(frameId, Object.freeze({
      publicationRevision: snapshot.revision,
      hasHistories: plan.histories.length > 0
    }));
    this.frameEncodes++;
    return Object.freeze({ frameId, snapshot, plan, historyGeneration: this.historyGeneration });
  }

  commitSubmittedFrame(submissionSerial: number, frameId: number): void {
    this.requireAlive();
    assertSerial(submissionSerial);
    const pending = this.requirePendingFrame(frameId);
    if (submissionSerial <= this.lastSubmittedSerial) {
      throw new Error("Sparse shading submission serial must increase monotonically");
    }
    this.pendingFrames.delete(frameId);
    this.lastSubmittedSerial = submissionSerial;
    this.submittedFrames++;
    if (pending.hasHistories) this.historyGeneration = nextGeneration(this.historyGeneration);
  }

  abortEncodedFrame(frameId: number): void {
    this.requireAlive();
    this.requirePendingFrame(frameId);
    this.pendingFrames.delete(frameId);
    this.abortedFrames++;
  }

  completeSubmittedWork(completedSerial: number): readonly number[] {
    this.requireAlive();
    assertSerial(completedSerial);
    const retired = this.publications.completeSubmittedWork(completedSerial);
    this.retiredRevisions.push(...retired);
    return retired;
  }

  invalidateCameraHistory(): number {
    this.requireAlive();
    this.historyGeneration = nextGeneration(this.historyGeneration);
    return this.historyGeneration;
  }

  markDeviceLost(): void {
    this.requireAlive();
    this.publications.markDeviceLost();
    this.plans.clear();
    this.activeRevision = null;
    this.abortedFrames += this.pendingFrames.size;
    this.pendingFrames.clear();
    this.deviceEpoch = nextGeneration(this.deviceEpoch);
    this.historyGeneration = nextGeneration(this.historyGeneration);
  }

  rebuildAfterDeviceLoss(
    context: GpuShadingPublicationContext,
    features: Readonly<SparseShadingCandidateFeatureInput>
  ): Readonly<SparseShadingCandidatePlan> {
    this.requireAlive();
    const snapshot = this.publications.rebuildAfterDeviceLoss(context);
    const plan = this.planFor(snapshot, features);
    this.activeRevision = snapshot.revision;
    return plan;
  }

  evidence(): Readonly<SparseShadingCandidateLifecycleEvidence> {
    return Object.freeze({
      activeRevision: this.activeRevision,
      deviceEpoch: this.deviceEpoch,
      frameEncodes: this.frameEncodes,
      submittedFrames: this.submittedFrames,
      abortedFrames: this.abortedFrames,
      pendingFrames: this.pendingFrames.size,
      planCacheHits: this.planCacheHits,
      planCacheMisses: this.planCacheMisses,
      historyGeneration: this.historyGeneration,
      lastSubmittedSerial: this.lastSubmittedSerial,
      retiredRevisions: Object.freeze([...this.retiredRevisions]),
      destroyed: this.destroyed
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.plans.clear();
    this.abortedFrames += this.pendingFrames.size;
    this.pendingFrames.clear();
    this.activeRevision = null;
    this.destroyed = true;
  }

  private planFor(
    snapshot: Readonly<GpuShadingPublicationSnapshot>,
    features: Readonly<SparseShadingCandidateFeatureInput>
  ): Readonly<SparseShadingCandidatePlan> {
    const key = `${snapshot.deviceEpoch}:${snapshot.revision}:${featureKey(features)}`;
    const cached = this.plans.get(key);
    if (cached !== undefined) {
      this.planCacheHits++;
      return cached;
    }
    const plan = createSparseShadingCandidatePlan(snapshot, features);
    this.plans.set(key, plan);
    this.planCacheMisses++;
    return plan;
  }

  private requireAlive(): void {
    if (this.destroyed) throw new Error("Sparse shading candidate runtime is destroyed");
  }

  private requirePendingFrame(frameId: number): Readonly<{
    publicationRevision: number;
    hasHistories: boolean;
  }> {
    if (!Number.isSafeInteger(frameId) || frameId <= 0) {
      throw new RangeError("Sparse shading frame id must be a positive safe integer");
    }
    const pending = this.pendingFrames.get(frameId);
    if (pending === undefined) {
      throw new Error("Sparse shading frame is not pending or was already closed");
    }
    return pending;
  }
}

function featureKey(features: Readonly<SparseShadingCandidateFeatureInput>): string {
  return [
    features.screenSpaceDiffuseMode,
    Number(features.ssr),
    Number(features.temporal),
    Number(features.shadows),
    Number(features.post),
    Number(features.diagnostics)
  ].join(":");
}

function nextGeneration(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function assertSerial(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Sparse shading submission serial must be a non-negative safe integer");
  }
}
