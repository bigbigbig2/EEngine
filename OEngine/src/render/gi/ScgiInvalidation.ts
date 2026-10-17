import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import type { GeometryQueryInstanceSnapshot } from "../../gpu/GeometryQueryInstanceSnapshot.js";
import type { ScgiFrameTransaction } from "./ScgiRuntime.js";
import { scgiInteger } from "./ScgiCapacity.js";
import { SCGI_INVALIDATION_WGSL } from "../../shaders/scgi_invalidation.js";

/** Derived 128B world-bounds/identity/affine per source slot, double buffered.
 * No vertices/material evaluation duplicated. Same transaction as cache,
 * committed only on submit; source snapshot remains borrowed until its fence. */
export class ScgiInvalidation {
  readonly dirty: GPUBuffer;
  private readonly banks: readonly [GPUBuffer, GPUBuffer];
  private role = 0;
  private valid = false;
  private pending = false;
  private inFlight = 0;
  private poisoned = false;
  private destroyed = false;
  private constructor(
    private readonly device: GPUDevice,
    readonly capacity: number,
    private readonly pipeline: GPUComputePipeline,
  ) {
    const allocated: GPUBuffer[] = [];
    const allocate = (label: string, size: number) => {
      const buffer = device.createBuffer({
        label,
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      allocated.push(buffer);
      return buffer;
    };
    try {
      this.banks = [
        allocate("SCGI/old dirty facts", capacity * 128),
        allocate("SCGI/new dirty facts", capacity * 128),
      ];
      this.dirty = allocate("SCGI/dirty count overflow regions", 1040);
    } catch (error) {
      for (const buffer of allocated) {
        buffer.destroy();
      }
      throw error;
    }
    void device.lost.then(() => this.release());
  }
  static async create(device: GPUDevice, capacity: number): Promise<ScgiInvalidation> {
    scgiInteger(capacity, "dirty source capacity");
    if (
      capacity * 128 > Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize) ||
      Math.ceil(capacity / 64) > device.limits.maxComputeWorkgroupsPerDimension ||
      device.limits.maxStorageBuffersPerShaderStage < 5 ||
      device.limits.maxUniformBufferBindingSize < 48 ||
      device.limits.maxComputeInvocationsPerWorkgroup < 64 ||
      device.limits.maxComputeWorkgroupSizeX < 64
    ) {
      throw new RangeError("SCGI invalidation source domain exceeds capacity");
    }
    const module = device.createShaderModule({ code: SCGI_INVALIDATION_WGSL });
    const pipeline = await PipelineCompilationQueue.forDevice(device).run(() =>
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      }),
    );
    return new ScgiInvalidation(device, capacity, pipeline);
  }
  get cost() {
    return {
      privateBytes: this.capacity * 256 + 1040,
      bytesPerSource: 256,
      maximumRegions: 32,
      dispatches: 1,
    };
  }
  encode(
    transaction: ScgiFrameTransaction,
    source: GeometryQueryInstanceSnapshot,
    materialEpoch: number,
    guard: number,
  ): GPUBuffer {
    const command = transaction.command;
    if (
      this.destroyed ||
      this.poisoned ||
      this.pending ||
      command.device !== this.device ||
      transaction.state !== "encoded" ||
      transaction.publication.cacheComplete ||
      source.count > this.capacity
    ) {
      throw new Error("SCGI invalidation requires complete current source before cache");
    }
    scgiInteger(materialEpoch, "dirty material epoch");
    if (!Number.isFinite(Math.fround(guard)) || guard < 0) {
      throw new RangeError("Invalid dirty guard");
    }
    source.assertCurrent(command);
    command.onBeforeFinish.addOne(() => source.assertCurrent(command));
    const data = new ArrayBuffer(48),
      u = new Uint32Array(data),
      f = new Float32Array(data);
    u.set([source.count, this.capacity, Number(this.valid), materialEpoch]);
    f[4] = guard;
    const settings = command.allocateTransientBufferAndLoad(data);
    command.clearBuffer(this.dirty);
    const next = 1 - this.role;
    const group = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source.sourceSnapshot } },
        { binding: 1, resource: { buffer: source.identitySnapshot } },
        { binding: 2, resource: { buffer: this.banks[this.role]! } },
        { binding: 3, resource: { buffer: this.banks[next]! } },
        { binding: 4, resource: { buffer: this.dirty } },
        { binding: 5, resource: { buffer: settings, size: 48 } },
      ],
    });
    const pass = command.beginComputePass({ label: "SCGI/old new bounds invalidation" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.capacity / 64));
    pass.end();
    this.pending = true;
    this.inFlight++;
    command.observeSubmission({
      submitted: (fence) => {
        this.role = next;
        this.valid = true;
        this.pending = false;
        void fence.then(
          () => {
            this.inFlight--;
          },
          () => {
            this.poisoned = true;
          },
        );
      },
      aborted: () => {
        this.pending = false;
        this.inFlight--;
      },
      failed: () => {
        this.poisoned = true;
      },
    });
    return this.dirty;
  }
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    if (this.inFlight || this.pending || this.poisoned) {
      throw new Error("SCGI invalidation retained or poisoned");
    }
    this.release();
  }
  retire(completion: Promise<void>): void {
    void completion.then(
      () => {
        if (!this.poisoned) {
          this.destroy();
        }
      },
      () => {
        this.poisoned = true;
      },
    );
  }
  private release(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.dirty.destroy();
    for (const bank of this.banks) {
      bank.destroy();
    }
  }
}
