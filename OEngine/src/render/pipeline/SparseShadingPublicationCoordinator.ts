import type { GpuRenderWorldShadingPublication } from "../../gpu/GpuRenderWorld.js";
import {
  GpuShadingPublicationStore,
  type ActiveShadingSummary,
  type GpuShadingPublicationContext
} from "../../gpu/GpuShadingPublicationPlan.js";
import {
  SparseShadingGpuRevisionOwner,
  type SparseShadingGpuRevision,
  type SparseShadingGpuRevisionEvidence,
  type SparseShadingGpuRevisionFactory
} from "./SparseShadingGpuRevision.js";

export interface SparseShadingPublicationCoordinatorEvidence {
  readonly activeSceneRevision: number | null;
  readonly activePublicationRevision: number | null;
  readonly stableHits: number;
  readonly prepareCount: number;
  readonly publishCount: number;
  readonly failureCount: number;
  readonly pending: boolean;
  readonly deviceLost: boolean;
  readonly gpu: Readonly<SparseShadingGpuRevisionEvidence>;
}

type PendingPublication = Readonly<{
  scene: Readonly<GpuRenderWorldShadingPublication>;
  contextKey: string;
  result: Promise<Readonly<SparseShadingGpuRevision>>;
}>;

export type SparseShadingSubmissionBoundary = number | (() => number);

/**
 * Converts the RenderWorld's immutable scene source plus render-context state
 * into the sole snapshot accepted by SparseShadingGpuRevisionOwner.
 *
 * Pipeline compilation remains outside the synchronous frame loop. Repeated
 * requests for the same scene object/context share one promise, while a newer
 * request waits for the in-flight atomic publication before preparing its own
 * revision. No provisional CPU snapshot is visible through active().
 */
export class SparseShadingPublicationCoordinator {
  private readonly gpuOwner: SparseShadingGpuRevisionOwner;
  private store: GpuShadingPublicationStore | null = null;
  private activeScene: Readonly<GpuRenderWorldShadingPublication> | null = null;
  private activeContextKey: string | null = null;
  private pending: PendingPublication | null = null;
  private stableHits = 0;
  private prepareCount = 0;
  private publishCount = 0;
  private failureCount = 0;
  private deviceLost = false;
  private destroyed = false;

  constructor(
    device: GPUDevice,
    diagnostics = false,
    factory?: SparseShadingGpuRevisionFactory
  ) {
    this.gpuOwner = new SparseShadingGpuRevisionOwner(device, diagnostics, factory);
  }

  reconcile(
    scene: Readonly<GpuRenderWorldShadingPublication>,
    context: Readonly<GpuShadingPublicationContext>,
    retireAfterSubmission: SparseShadingSubmissionBoundary
  ): Promise<Readonly<SparseShadingGpuRevision>> {
    this.requireAlive();
    assertScenePublication(scene);
    if (this.deviceLost) {
      return Promise.reject(new Error(
        "Sparse shading publication requires rebuildAfterDeviceLoss after device loss"
      ));
    }
    const contextKey = publicationContextKey(context);
    if (this.pending !== null) {
      if (sameScenePublication(this.pending.scene, scene) &&
          this.pending.contextKey === contextKey) {
        return this.pending.result;
      }
      return this.pending.result.then(
        () => this.reconcile(scene, context, retireAfterSubmission),
        () => this.reconcile(scene, context, retireAfterSubmission)
      );
    }
    if (this.activeScene !== null && sameScenePublication(this.activeScene, scene) &&
        this.activeContextKey === contextKey) {
      this.stableHits++;
      this.activeScene = scene;
      return Promise.resolve(this.gpuOwner.active(this.store!.currentSnapshot()));
    }

    const result = this.prepareAndPublish(scene, context, retireAfterSubmission);
    const pending = Object.freeze({ scene, contextKey, result });
    this.pending = pending;
    void result.finally(() => {
      if (this.pending === pending) this.pending = null;
    }).catch(() => {});
    return result;
  }

  active(
    scene: Readonly<GpuRenderWorldShadingPublication>,
    context: Readonly<GpuShadingPublicationContext>
  ): Readonly<SparseShadingGpuRevision> {
    this.requireAlive();
    if (this.deviceLost || this.store === null || this.activeScene === null ||
        !sameScenePublication(this.activeScene, scene) ||
        this.activeContextKey !== publicationContextKey(context)) {
      throw new Error("Sparse shading production publication is not active for this scene/context");
    }
    this.activeScene = scene;
    return this.gpuOwner.active(this.store.currentSnapshot());
  }

  /**
   * Removes the active Scene from the publication domain by atomically
   * publishing an empty GPU closure. The previous pipelines/bins remain in
   * the normal retirement queue until the caller proves the submission
   * boundary complete; release never destroys possibly in-flight resources.
   */
  async release(
    scene: Readonly<GpuRenderWorldShadingPublication>,
    retireAfterSubmission: SparseShadingSubmissionBoundary
  ): Promise<boolean> {
    this.requireAlive();
    assertScenePublication(scene);
    const pending = this.pending;
    if (pending !== null) {
      try { await pending.result; } catch { /* release still reconciles live state */ }
      if (this.pending === pending) this.pending = null;
      return this.release(scene, retireAfterSubmission);
    }
    if (this.activeScene === null || !sameScenePublication(this.activeScene, scene)) {
      return false;
    }
    if (this.deviceLost) {
      this.activeScene = null;
      this.activeContextKey = null;
      return true;
    }
    const store = this.store!;
    const transaction = store.beginTransaction().replaceAll({
      materials: [],
      geometries: [],
      instances: []
    });
    let prepared: Awaited<ReturnType<SparseShadingGpuRevisionOwner["prepare"]>> | null = null;
    let transactionClosed = false;
    try {
      const snapshot = transaction.prepare();
      this.prepareCount++;
      prepared = await this.gpuOwner.prepare(snapshot);
      this.requireAlive();
      const retirementSerial = resolveSubmissionBoundary(retireAfterSubmission);
      const committed = transaction.commit(retirementSerial);
      transactionClosed = true;
      this.gpuOwner.publish(prepared, committed, retirementSerial);
      prepared = null;
      this.activeScene = null;
      this.activeContextKey = null;
      this.publishCount++;
      return true;
    } catch (error) {
      if (prepared !== null) {
        try { this.gpuOwner.abort(prepared); } catch { /* owner already closed/destroyed */ }
      }
      if (!transactionClosed) {
        try { transaction.abort(); } catch { /* transaction already closed */ }
      }
      this.failureCount++;
      throw error;
    }
  }

  completeSubmittedWork(completedSubmission: number): Readonly<{
    cpu: readonly number[];
    gpu: readonly number[];
  }> {
    this.requireAlive();
    if (this.deviceLost || this.store === null) {
      return Object.freeze({ cpu: Object.freeze([]), gpu: Object.freeze([]) });
    }
    return Object.freeze({
      cpu: this.store.completeSubmittedWork(completedSubmission),
      gpu: this.gpuOwner.completeSubmittedWork(completedSubmission)
    });
  }

  markDeviceLost(): void {
    this.requireAlive();
    if (this.deviceLost) return;
    this.store?.markDeviceLost();
    this.gpuOwner.markDeviceLost();
    this.activeContextKey = null;
    this.deviceLost = true;
  }

  async rebuildAfterDeviceLoss(
    scene: Readonly<GpuRenderWorldShadingPublication>,
    context: Readonly<GpuShadingPublicationContext>,
    retireAfterSubmission: SparseShadingSubmissionBoundary
  ): Promise<Readonly<SparseShadingGpuRevision>> {
    this.requireAlive();
    assertScenePublication(scene);
    if (!this.deviceLost || this.store === null || this.pending !== null) {
      throw new Error("Sparse shading device-loss rebuild is not available in the current state");
    }
    let snapshot = this.store.rebuildAfterDeviceLoss(context);
    let transaction: ReturnType<GpuShadingPublicationStore["beginTransaction"]> | null = null;
    if (this.activeScene !== scene) {
      transaction = this.store.beginTransaction().replaceAll(scene.source);
      snapshot = transaction.prepare();
    }
    assertSummaryMatchesScene(scene.summary, snapshot.summary);
    try {
      const prepared = await this.gpuOwner.prepare(snapshot);
      const retirementSerial = resolveSubmissionBoundary(retireAfterSubmission);
      if (transaction !== null) snapshot = transaction.commit(retirementSerial);
      const published = this.gpuOwner.publish(prepared, snapshot, retirementSerial);
      this.activeScene = scene;
      this.activeContextKey = publicationContextKey(context);
      this.deviceLost = false;
      this.prepareCount++;
      this.publishCount++;
      return published;
    } catch (error) {
      if (transaction !== null) {
        try { transaction.abort(); } catch { /* transaction already closed */ }
      }
      this.store.markDeviceLost();
      this.failureCount++;
      throw error;
    }
  }

  evidence(): Readonly<SparseShadingPublicationCoordinatorEvidence> {
    return Object.freeze({
      activeSceneRevision: this.activeScene?.revision ?? null,
      activePublicationRevision: this.store === null || this.deviceLost || this.activeScene === null
        ? null
        : this.store.currentSnapshot().revision,
      stableHits: this.stableHits,
      prepareCount: this.prepareCount,
      publishCount: this.publishCount,
      failureCount: this.failureCount,
      pending: this.pending !== null,
      deviceLost: this.deviceLost,
      gpu: this.gpuOwner.evidence()
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gpuOwner.destroy();
    this.store = null;
    this.activeScene = null;
    this.activeContextKey = null;
  }

  private async prepareAndPublish(
    scene: Readonly<GpuRenderWorldShadingPublication>,
    context: Readonly<GpuShadingPublicationContext>,
    retireAfterSubmission: SparseShadingSubmissionBoundary
  ): Promise<Readonly<SparseShadingGpuRevision>> {
    const bootstrap = this.store === null;
    const store = this.store ?? new GpuShadingPublicationStore(context);
    const transaction = store.beginTransaction();
    let prepared: Awaited<ReturnType<SparseShadingGpuRevisionOwner["prepare"]>> | null = null;
    let transactionClosed = false;
    try {
      if (this.activeScene !== scene) transaction.replaceAll(scene.source);
      transaction.updateContext(context);
      const snapshot = transaction.prepare();
      assertSummaryMatchesScene(scene.summary, snapshot.summary);
      this.prepareCount++;
      prepared = await this.gpuOwner.prepare(snapshot);
      this.requireAlive();
      const retirementSerial = resolveSubmissionBoundary(retireAfterSubmission);
      const committed = transaction.commit(retirementSerial);
      transactionClosed = true;
      const published = this.gpuOwner.publish(
        prepared,
        committed,
        retirementSerial
      );
      prepared = null;
      // The store's constructor snapshot is an unexposed empty bootstrap, not
      // a frame revision. Retire it immediately at the already-completed
      // boundary instead of reporting it as in-flight production work.
      if (bootstrap) store.completeSubmittedWork(retirementSerial);
      this.store = store;
      this.activeScene = scene;
      this.activeContextKey = publicationContextKey(context);
      this.publishCount++;
      return published;
    } catch (error) {
      if (prepared !== null) {
        try { this.gpuOwner.abort(prepared); } catch { /* owner already closed/destroyed */ }
      }
      if (!transactionClosed) {
        try { transaction.abort(); } catch { /* transaction already closed */ }
      }
      this.failureCount++;
      throw error;
    }
  }

  private requireAlive(): void {
    if (this.destroyed) throw new Error("Sparse shading publication coordinator is destroyed");
  }
}

function publicationContextKey(context: Readonly<GpuShadingPublicationContext>): string {
  return JSON.stringify([
    context.width,
    context.height,
    context.outputDependencyMask,
    Number(context.shadowSamplingEnabled),
    context.capability.fingerprint,
    context.sizingLimits.maxTextureDimension2D,
    context.sizingLimits.maxBufferSize,
    context.sizingLimits.maxStorageBufferBindingSize,
    context.sizingLimits.maxComputeWorkgroupsPerDimension
  ]);
}

function resolveSubmissionBoundary(boundary: SparseShadingSubmissionBoundary): number {
  const value = typeof boundary === "function" ? boundary() : boundary;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Sparse shading retirement submission boundary is invalid");
  }
  return value;
}

function assertSummaryMatchesScene(
  scene: Readonly<ActiveShadingSummary>,
  derived: Readonly<ActiveShadingSummary>
): void {
  const scalarFields = [
    "activeBinMaskLo",
    "activeBinMaskHi",
    "opaqueLitReceiverCount",
    "opaqueUnlitReceiverCount",
    "transparentLitReceiverCount",
    "dependencyMask"
  ] as const;
  for (const field of scalarFields) {
    if (scene[field] !== derived[field]) {
      throw new Error(`Sparse shading scene publication ${field} does not match its source`);
    }
  }
  if (scene.binRefCounts.length !== 64 || derived.binRefCounts.length !== 64) {
    throw new Error("Sparse shading scene publication requires exactly 64 bin refcounts");
  }
  for (let binId = 0; binId < 64; binId++) {
    if (scene.binRefCounts[binId] !== derived.binRefCounts[binId]) {
      throw new Error(`Sparse shading scene publication bin ${binId} refcount does not match its source`);
    }
  }
}

function assertScenePublication(scene: Readonly<GpuRenderWorldShadingPublication>): void {
  if (scene.schemaVersion !== 1 || !Number.isInteger(scene.revision) || scene.revision <= 0 ||
      scene.summary.revision !== scene.revision) {
    throw new Error("Sparse shading scene publication revision contract is invalid");
  }
  for (const material of scene.source.materials) {
    if (material.generation !== scene.materialGeneration ||
        material.textureGeneration !== scene.textureGeneration) {
      throw new Error(
        `Sparse shading material ${material.id} generation is outside the scene publication`
      );
    }
  }
}

/**
 * Previewed patches are immutable value publications. After the matching GPU
 * patch commits, GpuRenderWorld publishes an equivalent object rather than the
 * preview object's identity, so coordinator stability must use the atomic
 * publication identity fields instead of JavaScript reference equality.
 */
function sameScenePublication(
  left: Readonly<GpuRenderWorldShadingPublication>,
  right: Readonly<GpuRenderWorldShadingPublication>
): boolean {
  if (left.revision !== right.revision ||
      left.materialGeneration !== right.materialGeneration ||
      left.textureGeneration !== right.textureGeneration ||
      left.materialPublicationRevision !== right.materialPublicationRevision ||
      left.summary.activeBinMaskLo !== right.summary.activeBinMaskLo ||
      left.summary.activeBinMaskHi !== right.summary.activeBinMaskHi ||
      left.summary.opaqueLitReceiverCount !== right.summary.opaqueLitReceiverCount ||
      left.summary.opaqueUnlitReceiverCount !== right.summary.opaqueUnlitReceiverCount ||
      left.summary.transparentLitReceiverCount !== right.summary.transparentLitReceiverCount ||
      left.summary.dependencyMask !== right.summary.dependencyMask ||
      left.summary.binRefCounts.length !== 64 ||
      right.summary.binRefCounts.length !== 64) {
    return false;
  }
  for (let binId = 0; binId < 64; binId++) {
    if (left.summary.binRefCounts[binId] !== right.summary.binRefCounts[binId]) {
      return false;
    }
  }
  return true;
}
