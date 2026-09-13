import type { GpuShadingPublicationSnapshot } from "../../gpu/GpuShadingPublicationPlan.js";
import {
  GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE,
  packGpuShadingBinSettings
} from "../../gpu/GpuShadingBinAbi.js";
import { ShadingBinPass } from "../passes/ShadingBinPass.js";
import { SparseShadingResolvePass } from "../passes/SparseShadingResolvePass.js";

export interface SparseShadingGpuRevision {
  readonly snapshot: Readonly<GpuShadingPublicationSnapshot>;
  readonly bins: ShadingBinPass | null;
  readonly resolve: SparseShadingResolvePass | null;
  readonly settings: GPUBuffer | null;
  readonly heapBytes: number;
  readonly indirectBytes: number;
  readonly settingsBytes: number;
}

export interface SparseShadingGpuRevisionEvidence {
  readonly activeRevision: number | null;
  readonly activeDeviceEpoch: number | null;
  readonly activeHeapBytes: number;
  readonly activeIndirectBytes: number;
  readonly activeSettingsBytes: number;
  readonly activeProducerBindGroupRequests: number;
  readonly activeProducerBindGroupCreations: number;
  readonly activeResolveBindGroupRequests: number;
  readonly activeResolveBindGroupCreations: number;
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

export type SparseShadingGpuRevisionFactory = (
  device: GPUDevice,
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  diagnostics: boolean
) => Promise<Readonly<SparseShadingGpuRevision>>;

/**
 * A fully-created but unpublished GPU revision. Publication and abort are
 * deliberately owned by SparseShadingGpuRevisionOwner so a failed or
 * stale CPU publication cannot leak a provisional heap/args/pipeline set.
 */
export class SparseShadingPreparedGpuRevision {
  private closed = false;

  constructor(
    readonly ownerIdentity: SparseShadingGpuRevisionOwner,
    readonly resources: Readonly<SparseShadingGpuRevision>
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
 * Production owner for immutable, revision-scoped sparse-shading GPU resources.
 *
 * Resize and summary mutations first create a complete replacement. The owner
 * publishes it only after the matching CPU transaction commits, then keeps the
 * previous resources alive until the last submission that can reference them
 * has completed. Stable frames only read active(); they allocate nothing.
 */
export class SparseShadingGpuRevisionOwner {
  private activeValue: Readonly<SparseShadingGpuRevision> | null = null;
  private retiring: Array<Readonly<{
    resources: Readonly<SparseShadingGpuRevision>;
    retireAfterSubmission: number;
  }>> = [];
  private readonly pending = new Set<SparseShadingPreparedGpuRevision>();
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
    private readonly factory: SparseShadingGpuRevisionFactory = createGpuRevision
  ) {}

  async prepare(
    snapshot: Readonly<GpuShadingPublicationSnapshot>
  ): Promise<SparseShadingPreparedGpuRevision> {
    this.requireAlive();
    if (this.pending.size !== 0) {
      throw new Error("Sparse shading permits only one provisional GPU revision");
    }
    const resources = await this.factory(this.device, snapshot, this.diagnostics);
    validateRevisionResources(resources, snapshot, this.diagnostics);
    const prepared = new SparseShadingPreparedGpuRevision(this, resources);
    this.pending.add(prepared);
    this.createCount++;
    return prepared;
  }

  publish(
    prepared: SparseShadingPreparedGpuRevision,
    publishedSnapshot: Readonly<GpuShadingPublicationSnapshot>,
    retireAfterSubmission: number
  ): Readonly<SparseShadingGpuRevision> {
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

  abort(prepared: SparseShadingPreparedGpuRevision): void {
    this.requireAlive();
    this.requirePrepared(prepared);
    prepared._close();
    this.pending.delete(prepared);
    destroyRevision(prepared.resources);
    this.abortCount++;
  }

  active(
    snapshot: Readonly<GpuShadingPublicationSnapshot>
  ): Readonly<SparseShadingGpuRevision> {
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

  evidence(): Readonly<SparseShadingGpuRevisionEvidence> {
    const active = this.activeValue;
    const producerBindings = active?.bins?.bindingCacheEvidence?.();
    const resolveBindings = active?.resolve?.bindingCacheEvidence?.();
    return Object.freeze({
      activeRevision: active?.snapshot.revision ?? null,
      activeDeviceEpoch: active?.snapshot.deviceEpoch ?? null,
      activeHeapBytes: active?.heapBytes ?? 0,
      activeIndirectBytes: active?.indirectBytes ?? 0,
      activeSettingsBytes: active?.settingsBytes ?? 0,
      activeProducerBindGroupRequests: producerBindings?.requests ?? 0,
      activeProducerBindGroupCreations: producerBindings?.creations ?? 0,
      activeResolveBindGroupRequests: resolveBindings?.requests ?? 0,
      activeResolveBindGroupCreations: resolveBindings?.creations ?? 0,
      retiringRevisions: Object.freeze(this.retiring.map((entry) => entry.resources.snapshot.revision)),
      retiringBytes: this.retiring.reduce(
        (sum, entry) => sum + entry.resources.heapBytes + entry.resources.indirectBytes +
          entry.resources.settingsBytes,
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

  private requirePrepared(prepared: SparseShadingPreparedGpuRevision): void {
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
): Promise<Readonly<SparseShadingGpuRevision>> {
  if (snapshot.pipelines.length === 0) {
    return freezeRevision(snapshot, null, null);
  }
  const bins = await ShadingBinPass.create(device, snapshot.sizing, diagnostics);
  let settings: GPUBuffer | null = null;
  try {
    settings = await createSettingsBuffer(device, snapshot);
    const resolve = await SparseShadingResolvePass.create(
      device,
      snapshot.pipelines,
      snapshot.revision,
      diagnostics
    );
    return freezeRevision(snapshot, bins, resolve, settings);
  } catch (error) {
    settings?.destroy();
    bins.destroy();
    throw error;
  }
}

function freezeRevision(
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  bins: ShadingBinPass | null,
  resolve: SparseShadingResolvePass | null,
  settings: GPUBuffer | null = null
): Readonly<SparseShadingGpuRevision> {
  return Object.freeze({
    snapshot,
    bins,
    resolve,
    settings,
    heapBytes: bins?.sizing.heapBytes ?? 0,
    indirectBytes: bins?.sizing.indirectBytes ?? 0,
    settingsBytes: settings?.size ?? 0
  });
}

function validateRevisionResources(
  resources: Readonly<SparseShadingGpuRevision>,
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  diagnostics: boolean
): void {
  if (resources.snapshot !== snapshot) {
    destroyRevision(resources);
    throw new Error("Sparse shading GPU revision factory changed the publication snapshot");
  }
  const hasOpaque = snapshot.pipelines.length > 0;
  if (hasOpaque !== (resources.bins !== null) || hasOpaque !== (resources.resolve !== null) ||
      hasOpaque !== (resources.settings !== null)) {
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
      resources.indirectBytes !== (resources.bins?.sizing.indirectBytes ?? 0) ||
      resources.settingsBytes !== (resources.settings?.size ?? 0)) {
    destroyRevision(resources);
    throw new Error("Sparse shading GPU revision memory evidence is inconsistent");
  }
}

async function createSettingsBuffer(
  device: GPUDevice,
  snapshot: Readonly<GpuShadingPublicationSnapshot>
): Promise<GPUBuffer> {
  const packed = packGpuShadingBinSettings({
    width: snapshot.sizing.width,
    height: snapshot.sizing.height,
    microtilesX: snapshot.sizing.microtilesX,
    generation: snapshot.generation,
    allowedMaskLo: snapshot.sizing.allowedMaskLo,
    allowedMaskHi: snapshot.sizing.allowedMaskHi,
    maxDispatchDimension: snapshot.context.sizingLimits.maxComputeWorkgroupsPerDimension,
    layoutRevision: snapshot.layoutRevision
  });
  device.pushErrorScope("validation");
  let buffer: GPUBuffer | null = null;
  try {
    buffer = device.createBuffer({
      label: `ADR-0013 ShadingBin settings revision ${snapshot.revision}`,
      size: GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint8Array(buffer.getMappedRange()).set(packed);
    buffer.unmap();
  } catch (error) {
    await device.popErrorScope();
    buffer?.destroy();
    throw error;
  }
  const validationError = await device.popErrorScope();
  if (validationError !== null) {
    buffer.destroy();
    throw new Error(
      `Sparse shading settings buffer failed validation: ${validationError.message}`
    );
  }
  return buffer;
}

function destroyRevision(resources: Readonly<SparseShadingGpuRevision>): void {
  resources.resolve?.destroy();
  resources.bins?.destroy();
  resources.settings?.destroy();
}

function assertSubmissionSerial(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} is invalid`);
}
