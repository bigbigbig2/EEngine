import type { AssetCodecPriority } from "./AssetCodecTypes.js";

export interface AssetWorkerPoolOptions {
  readonly maxWorkers: number;
  readonly maxInFlightEstimatedBytes: number;
  readonly maxQueuedTasks?: number;
  readonly maxConsecutiveWorkerFailures?: number;
  readonly createWorker: () => Worker | Promise<Worker>;
}

export interface AssetWorkerTask<TRequest> {
  readonly request: TRequest;
  readonly transfer: readonly Transferable[];
  readonly estimatedPeakBytes: number;
  readonly priority: AssetCodecPriority;
  readonly signal?: AbortSignal;
}

export interface AssetWorkerPoolEvidence {
  readonly activeWorkers: number;
  readonly peakActiveWorkers: number;
  readonly inFlightEstimatedBytes: number;
  readonly peakInFlightEstimatedBytes: number;
  readonly queuedTasks: number;
  readonly workerFailures: number;
}

interface QueueEntry<TRequest, TResult> {
  readonly task: AssetWorkerTask<TRequest>;
  readonly resolve: (value: TResult) => void;
  readonly reject: (reason: unknown) => void;
  readonly abort: () => void;
}

interface WorkerSlot {
  readonly worker: Worker;
  busy: boolean;
  entry: QueueEntry<any, any> | null;
}

export class AssetWorkerPool {
  private readonly queues: [QueueEntry<any, any>[], QueueEntry<any, any>[], QueueEntry<any, any>[]] = [[], [], []];
  private readonly workers: WorkerSlot[] = [];
  private creatingWorkers = 0;
  private activeWorkers = 0;
  private peakActiveWorkers = 0;
  private inFlightEstimatedBytes = 0;
  private peakInFlightEstimatedBytes = 0;
  private workerFailures = 0;
  private consecutiveWorkerFailures = 0;
  private disposed = false;

  constructor(private readonly options: AssetWorkerPoolOptions) {
    assertPositiveInteger(options.maxWorkers, "maxWorkers");
    assertPositiveInteger(options.maxInFlightEstimatedBytes, "maxInFlightEstimatedBytes");
    assertPositiveInteger(options.maxQueuedTasks ?? 256, "maxQueuedTasks");
    assertPositiveInteger(options.maxConsecutiveWorkerFailures ?? 3, "maxConsecutiveWorkerFailures");
  }

  submit<TRequest, TResult>(task: AssetWorkerTask<TRequest>): Promise<TResult> {
    if (this.disposed) return Promise.reject(new Error("AssetWorkerPool is disposed"));
    assertPositiveInteger(task.estimatedPeakBytes, "estimatedPeakBytes");
    if (task.estimatedPeakBytes > this.options.maxInFlightEstimatedBytes) {
      return Promise.reject(new RangeError(
        `Asset worker task requires ${task.estimatedPeakBytes} estimated bytes, budget is ${this.options.maxInFlightEstimatedBytes}`
      ));
    }
    if (task.priority !== 0 && task.priority !== 1 && task.priority !== 2) {
      return Promise.reject(new RangeError("Asset worker task priority must be 0, 1, or 2"));
    }
    if (task.signal?.aborted) return Promise.reject(abortError());
    if (this.queuedCount() >= (this.options.maxQueuedTasks ?? 256)) {
      return Promise.reject(new RangeError("Asset worker queue capacity exceeded"));
    }
    return new Promise<TResult>((resolve, reject) => {
      const entry: QueueEntry<TRequest, TResult> = {
        task,
        resolve,
        reject,
        abort: () => this.cancelEntry(entry)
      };
      task.signal?.addEventListener("abort", entry.abort, { once: true });
      this.queues[task.priority].push(entry);
      this.pump();
    });
  }

  evidence(): AssetWorkerPoolEvidence {
    return Object.freeze({
      activeWorkers: this.activeWorkers,
      peakActiveWorkers: this.peakActiveWorkers,
      inFlightEstimatedBytes: this.inFlightEstimatedBytes,
      peakInFlightEstimatedBytes: this.peakInFlightEstimatedBytes,
      queuedTasks: this.queuedCount(),
      workerFailures: this.workerFailures
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("AssetWorkerPool is disposed");
    for (const queue of this.queues) {
      for (const entry of queue.splice(0)) {
        this.detachAbort(entry);
        entry.reject(error);
      }
    }
    for (const slot of [...this.workers]) {
      if (slot.entry !== null) {
        const entry = slot.entry;
        this.release(slot);
        entry.reject(error);
      }
      slot.worker.terminate();
    }
    this.workers.length = 0;
  }

  private pump(): void {
    if (this.disposed) return;
    for (const slot of this.workers) {
      if (!slot.busy) this.assign(slot);
    }
    while (this.hasAdmissibleTask() &&
      this.workers.length + this.creatingWorkers < this.options.maxWorkers &&
      this.creatingWorkers < this.queuedCount()) {
      this.creatingWorkers++;
      void Promise.resolve(this.options.createWorker()).then((worker) => {
        this.creatingWorkers--;
        if (this.disposed) {
          worker.terminate();
          return;
        }
        const slot: WorkerSlot = { worker, busy: false, entry: null };
        worker.onmessage = (event: MessageEvent<unknown>) => this.finish(slot, event.data);
        worker.onerror = (event: ErrorEvent) => {
          event.preventDefault?.();
          this.failWorker(slot, new Error(event.message || "Asset codec Worker failed"));
        };
        worker.onmessageerror = () => this.failWorker(slot, new Error("Asset codec Worker message deserialization failed"));
        this.workers.push(slot);
        this.assign(slot);
        this.pump();
      }, (error: unknown) => {
        this.creatingWorkers--;
        this.workerFailures++;
        this.consecutiveWorkerFailures++;
        if (this.consecutiveWorkerFailures >= (this.options.maxConsecutiveWorkerFailures ?? 3)) {
          this.rejectAll(new Error(`Asset codec Worker initialization failed repeatedly: ${errorMessage(error)}`));
        } else {
          this.pump();
        }
      });
    }
  }

  private assign(slot: WorkerSlot): void {
    if (slot.busy || this.disposed) return;
    const entry = this.takeAdmissible();
    if (entry === null) return;
    slot.busy = true;
    slot.entry = entry;
    this.activeWorkers++;
    this.peakActiveWorkers = Math.max(this.peakActiveWorkers, this.activeWorkers);
    this.inFlightEstimatedBytes += entry.task.estimatedPeakBytes;
    this.peakInFlightEstimatedBytes = Math.max(
      this.peakInFlightEstimatedBytes,
      this.inFlightEstimatedBytes
    );
    try {
      slot.worker.postMessage(entry.task.request, [...entry.task.transfer]);
    } catch (error) {
      this.release(slot);
      entry.reject(error);
      this.removeWorker(slot, true);
      this.pump();
    }
  }

  private finish(slot: WorkerSlot, result: unknown): void {
    const entry = slot.entry;
    if (entry === null) return;
    this.release(slot);
    this.consecutiveWorkerFailures = 0;
    entry.resolve(result);
    this.pump();
  }

  private failWorker(slot: WorkerSlot, error: Error): void {
    const entry = slot.entry;
    if (entry !== null) {
      this.release(slot);
      entry.reject(error);
    }
    this.workerFailures++;
    this.consecutiveWorkerFailures++;
    this.removeWorker(slot, true);
    if (this.consecutiveWorkerFailures >= (this.options.maxConsecutiveWorkerFailures ?? 3)) {
      this.rejectAll(new Error("Asset codec Workers exceeded the consecutive failure limit"));
      return;
    }
    this.pump();
  }

  private cancelEntry(entry: QueueEntry<any, any>): void {
    for (const queue of this.queues) {
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
        this.detachAbort(entry);
        entry.reject(abortError());
        return;
      }
    }
    const slot = this.workers.find((candidate) => candidate.entry === entry);
    if (slot === undefined) return;
    this.release(slot);
    entry.reject(abortError());
    this.removeWorker(slot, true);
    this.pump();
  }

  private release(slot: WorkerSlot): void {
    const entry = slot.entry;
    if (entry === null) return;
    this.detachAbort(entry);
    this.activeWorkers--;
    this.inFlightEstimatedBytes -= entry.task.estimatedPeakBytes;
    slot.entry = null;
    slot.busy = false;
  }

  private detachAbort(entry: QueueEntry<any, any>): void {
    entry.task.signal?.removeEventListener("abort", entry.abort);
  }

  private removeWorker(slot: WorkerSlot, terminate: boolean): void {
    const index = this.workers.indexOf(slot);
    if (index >= 0) this.workers.splice(index, 1);
    if (terminate) slot.worker.terminate();
  }

  private takeAdmissible(): QueueEntry<any, any> | null {
    for (const queue of this.queues) {
      const entry = queue[0];
      if (entry === undefined) continue;
      if (this.inFlightEstimatedBytes + entry.task.estimatedPeakBytes <= this.options.maxInFlightEstimatedBytes) {
        return queue.shift()!;
      }
    }
    return null;
  }

  private hasAdmissibleTask(): boolean {
    return this.queues.some((queue) => {
      const entry = queue[0];
      return entry !== undefined &&
        this.inFlightEstimatedBytes + entry.task.estimatedPeakBytes <= this.options.maxInFlightEstimatedBytes;
    });
  }

  private queuedCount(): number {
    return this.queues.reduce((sum, queue) => sum + queue.length, 0);
  }

  private rejectAll(error: Error): void {
    for (const queue of this.queues) {
      for (const entry of queue.splice(0)) {
        this.detachAbort(entry);
        entry.reject(error);
      }
    }
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

function abortError(): Error {
  return new DOMException("Asset codec task was aborted", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
