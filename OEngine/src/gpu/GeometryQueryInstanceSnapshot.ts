import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { GPU_INSTANCE_IDENTITY_STRIDE, GPU_INSTANCE_RECORD_STRIDE } from "./GpuInstanceAbi.js";
import type { GpuScene, GpuSceneQueryBindings } from "./GpuScene.js";

/** One immutable copy of scene instance truth, shared by every query AS shard.
 * It contains no geometry payload and never selects camera-visible instances.
 * The caller retains this owner through the last query consumer fence. */
export class GeometryQueryInstanceSnapshot {
  readonly sourceSnapshot: GPUBuffer;
  readonly identitySnapshot: GPUBuffer;
  readonly count: number;
  readonly contentRevision: number;
  private readonly source: GpuSceneQueryBindings;
  private readonly handles: ResourceHandle[] = [];
  private encodedCommand: ShadeGPUCommandContext | null = null;
  private publishedRevision: number | null = null;
  private destroyed = false;
  private poisoned = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly scene: GpuScene,
    private readonly accounting?: ResourceAccounting,
    private readonly mutationCommand?: ShadeGPUCommandContext,
  ) {
    this.source = scene.queryBindings(mutationCommand);
    this.count = this.source.highWaterCount;
    this.contentRevision = this.source.contentRevision;
    const maximum = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    if (!Number.isSafeInteger(this.count) || this.count < 0 ||
        this.count * GPU_INSTANCE_RECORD_STRIDE > maximum ||
        this.source.instances.size < this.count * GPU_INSTANCE_RECORD_STRIDE ||
        this.source.identities.size < this.count * GPU_INSTANCE_IDENTITY_STRIDE) {
      throw new RangeError("Query source snapshot exceeds the negotiated instance domain");
    }
    const buffers: GPUBuffer[] = [];
    const allocate = (label: string, bytes: number) => {
      const buffer = device.createBuffer({
        label,
        size: Math.max(4, bytes),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      buffers.push(buffer);
      if (accounting !== undefined) {
        this.handles.push(accounting.created({ kind: "buffer", category: "transient",
          owner: "Geometry/query source snapshot", label, bytes: buffer.size }, buffer));
      }
      return buffer;
    };
    try {
      this.sourceSnapshot = allocate("Geometry/query immutable source instances",
        this.count * GPU_INSTANCE_RECORD_STRIDE);
      this.identitySnapshot = allocate("Geometry/query immutable instance lineage",
        this.count * GPU_INSTANCE_IDENTITY_STRIDE);
    } catch (error) {
      for (const buffer of buffers) {
        buffer.destroy();
      }
      for (const handle of this.handles) {
        accounting!.destroyed(handle);
      }
      throw error;
    }
    void device.lost.then(() => this.destroy());
  }

  get valid(): boolean {
    return !this.destroyed && !this.poisoned;
  }

  /** Resource validity preserves a historical snapshot. New transport work
   * additionally requires the current scene publication; retaining old pages
   * cannot make a newly added raster occluder disappear from query truth. */
  assertCurrent(command: ShadeGPUCommandContext): void {
    if (!this.valid || command.closed || command.device !== this.device) {
      throw new Error("Query source requires its live current scene and command");
    }
    const current = this.scene.queryBindings(command);
    if (current.instances !== this.source.instances || current.identities !== this.source.identities ||
        current.contentRevision !== (this.publishedRevision ?? this.contentRevision) ||
        current.highWaterCount !== this.count || current.mutationSerial !== this.source.mutationSerial) {
      throw new Error("GpuScene changed after query capture; prepare a fresh candidate");
    }
  }

  /** The first shard records the copy; other shards in that command share it.
   * A later command may only use the already submitted immutable snapshot. */
  encode(command: ShadeGPUCommandContext): void {
    if (!this.valid || command.closed || command.device !== this.device) {
      throw new Error("Query source snapshot requires its live device and command");
    }
    if (this.encodedCommand !== null) {
      if (this.encodedCommand !== command && !this.encodedCommand.closed) {
        throw new Error("Query source snapshot has an unsubmitted producer");
      }
      return;
    }
    if (this.mutationCommand !== undefined && command !== this.mutationCommand) {
      throw new Error("Query source candidate must be copied in its mutation command");
    }
    const current = this.scene.queryBindings(this.mutationCommand);
    if (current.instances !== this.source.instances || current.identities !== this.source.identities ||
        current.contentRevision !== this.contentRevision || current.highWaterCount !== this.count ||
        current.mutationSerial !== this.source.mutationSerial) {
      throw new Error("GpuScene changed while preparing the query snapshot; prepare a fresh candidate");
    }
    this.encodedCommand = command;
    command.onBeforeFinish.addOne(() => this.assertCurrent(command));
    // GpuScene registers its publication before consumers capture it. Capture
    // the committed revision after that callback; candidate admission itself
    // already checked buffer identity, count and the non-ABA mutation serial.
    command.onFinished.addOne(() => {
      this.publishedRevision = this.scene.queryBindings().contentRevision;
    });
    command.observeSubmission({
      submitted: (fence) => {
        void fence.catch(() => { this.poisoned = true; });
      },
      aborted: () => this.destroy(),
      failed: () => { this.poisoned = true; },
    });
    if (this.count !== 0) {
      command.copyBufferToBuffer(this.source.instances, 0, this.sourceSnapshot, 0,
        this.count * GPU_INSTANCE_RECORD_STRIDE);
      command.copyBufferToBuffer(this.source.identities, 0, this.identitySnapshot, 0,
        this.count * GPU_INSTANCE_IDENTITY_STRIDE);
    }
  }

  /** Final successful consumer fence, pre-submit cancellation, or device loss. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.sourceSnapshot.destroy();
    this.identitySnapshot.destroy();
    for (const handle of this.handles) {
      this.accounting!.destroyed(handle);
    }
  }
}
