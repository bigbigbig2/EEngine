interface CompileJob {
  readonly start: () => void;
  readonly reject: (reason: Error) => void;
}

const deviceQueues = new WeakMap<GPUDevice, PipelineCompilationQueue>();

/** One credit pool per real device, shared by material and fixed-function owners.
 * Cache/material jobs also create modules/layouts inside their credit. Pass-owned
 * explicit layouts may already exist; the driver PSO call always uses a credit. */
export class PipelineCompilationQueue {
  private readonly waiting: CompileJob[] = [];
  private readonly activeRejections = new Set<(reason: Error) => void>();
  private active = 0;
  private completed = 0;
  private failed = 0;
  private queueMs = 0;
  private compileMs = 0;
  private failure: Error | null = null;

  private constructor(device: GPUDevice) {
    void device.lost?.then(
      (info) =>
        this.stop(new Error(`Pipeline device lost: ${info?.reason ?? "unknown"}: ${info?.message ?? ""}`)),
      (cause) => this.stop(new Error("Pipeline device loss promise failed", { cause })),
    );
  }

  static forDevice(device: GPUDevice): PipelineCompilationQueue {
    let queue = deviceQueues.get(device);
    if (!queue) {
      queue = new PipelineCompilationQueue(device);
      deviceQueues.set(device, queue);
    }
    return queue;
  }

  run<T>(compile: () => Promise<T>): Promise<T> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const queuedAt = performance.now();
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        reject,
        start: () => {
          const startedAt = performance.now();
          this.queueMs += startedAt - queuedAt;
          this.active++;
          this.activeRejections.add(reject);
          let result: Promise<T>;
          try {
            result = compile();
          } catch (error) {
            result = Promise.reject(error);
          }
          void result
            .then(
              (value) => {
                if (this.failure) {
                  reject(this.failure);
                } else {
                  this.completed++;
                  resolve(value);
                }
              },
              (error) => {
                this.failed++;
                reject(error);
              },
            )
            .finally(() => {
              this.compileMs += performance.now() - startedAt;
              this.active--;
              this.activeRejections.delete(reject);
              this.pump();
            });
        },
      });
      this.pump();
    });
  }

  evidence() {
    return Object.freeze({
      queued: this.waiting.length,
      active: this.active,
      completed: this.completed,
      failed: this.failed,
      queueMs: this.queueMs,
      compileMs: this.compileMs,
      concurrency: 16,
      stopped: this.failure !== null,
    });
  }

  assertAlive(): void {
    if (this.failure) {
      throw this.failure;
    }
  }

  private pump(): void {
    while (!this.failure && this.active < 16 && this.waiting.length) {
      this.waiting.shift()!.start();
    }
  }

  private stop(reason: Error): void {
    this.failure ??= reason;
    for (const job of this.waiting.splice(0)) {
      job.reject(this.failure);
    }
    for (const reject of this.activeRejections) {
      reject(this.failure);
    }
    this.activeRejections.clear();
  }
}
