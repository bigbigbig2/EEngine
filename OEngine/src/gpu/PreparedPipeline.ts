import { PipelineCompilationQueue } from "./PipelineCompilationQueue.js";

/** Exact native descriptor owned by its pass. No automatic compilation in encode,
 * no descriptor scan, and no GPU work. Repeated preparation shares one job. */
export class PreparedComputePipeline {
  private pipeline: GPUComputePipeline | null = null;
  private pending: Promise<void> | null = null;
  private readonly queue: PipelineCompilationQueue;

  constructor(
    private readonly device: GPUDevice,
    private readonly descriptor: GPUComputePipelineDescriptor,
  ) {
    this.queue = PipelineCompilationQueue.forDevice(device);
  }

  prepare(): Promise<void> {
    this.queue.assertAlive();
    if (this.pipeline) {
      return Promise.resolve();
    }
    return (this.pending ??= this.queue
      .run(() => this.device.createComputePipelineAsync(this.descriptor))
      .then((pipeline) => {
        this.queue.assertAlive();
        this.pipeline = pipeline;
      })
      .finally(() => {
        this.pending = null;
      }));
  }

  requirePrepared(): GPUComputePipeline {
    this.queue.assertAlive();
    if (!this.pipeline) {
      throw new Error(
        `Compute pipeline requires completed owner preparation: ${this.descriptor.label ?? this.descriptor.compute.entryPoint ?? ""}`,
      );
    }
    return this.pipeline;
  }

  get label(): string {
    return this.descriptor.label ?? "";
  }
}

export class PreparedRenderPipeline {
  private pipeline: GPURenderPipeline | null = null;
  private pending: Promise<void> | null = null;
  private readonly queue: PipelineCompilationQueue;

  constructor(
    private readonly device: GPUDevice,
    private readonly descriptor: GPURenderPipelineDescriptor,
  ) {
    this.queue = PipelineCompilationQueue.forDevice(device);
  }

  prepare(): Promise<void> {
    this.queue.assertAlive();
    if (this.pipeline) {
      return Promise.resolve();
    }
    return (this.pending ??= this.queue
      .run(() => this.device.createRenderPipelineAsync(this.descriptor))
      .then((pipeline) => {
        this.queue.assertAlive();
        this.pipeline = pipeline;
      })
      .finally(() => {
        this.pending = null;
      }));
  }

  requirePrepared(): GPURenderPipeline {
    this.queue.assertAlive();
    if (!this.pipeline) {
      throw new Error(
        `Render pipeline requires completed owner preparation: ${this.descriptor.label ?? this.descriptor.vertex.entryPoint ?? ""}`,
      );
    }
    return this.pipeline;
  }
}
