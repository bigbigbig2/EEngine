import {
  validateAssetCodecTask,
  validateAssetCodecWorkerResult,
  type AssetCodecTaskResult,
  type AssetCodecWorkerMessage,
  type Ktx2TranscodeTask
} from "./AssetCodecTypes.js";
import { AssetWorkerPool } from "./AssetWorkerPool.js";

export interface AssetCodecServiceOptions {
  readonly maxWorkers?: number;
  readonly maxInFlightEstimatedBytes?: number;
  readonly maxQueuedTasks?: number;
  readonly maxConsecutiveWorkerFailures?: number;
  readonly hardwareConcurrency?: number;
  readonly createWorker: () => Worker | Promise<Worker>;
  readonly now?: () => number;
}

export interface AssetCodecServiceEvidence {
  readonly schemaVersion: 2;
  readonly tasksQueued: number;
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  readonly tasksCancelled: number;
  readonly activeWorkers: number;
  readonly peakActiveWorkers: number;
  readonly queuedTasks: number;
  readonly inFlightEstimatedBytes: number;
  readonly peakInFlightEstimatedBytes: number;
  readonly queueWaitMs: number;
  readonly workerMs: number;
  readonly wallMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  /** Total ownership transferred across the Worker boundary in both directions. */
  readonly transferBytes: number;
  readonly workerFailures: number;
  readonly directPathCount: number;
  readonly workerPathCount: number;
  readonly uncompressedPathCount: number;
  readonly codecIdentities: readonly AssetCodecIdentityEvidence[];
}

export interface AssetCodecIdentityEvidence {
  readonly codecId: string;
  readonly codecRevision: string;
  readonly codecBinaryHash: string;
  readonly completedTaskCount: number;
}

export class AssetCodecService {
  readonly maxWorkers: number;
  private readonly pool: AssetWorkerPool;
  private readonly now: () => number;
  private tasksQueued = 0;
  private tasksCompleted = 0;
  private tasksFailed = 0;
  private tasksCancelled = 0;
  private queueWaitMs = 0;
  private workerMs = 0;
  private wallMs = 0;
  private inputBytes = 0;
  private outputBytes = 0;
  private workerPathCount = 0;
  private readonly codecIdentities = new Map<string, AssetCodecIdentityEvidence>();
  private destroyed = false;

  constructor(options: AssetCodecServiceOptions) {
    const hardwareConcurrency = options.hardwareConcurrency ??
      (typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency);
    this.maxWorkers = options.maxWorkers ?? defaultAssetCodecWorkerCount(hardwareConcurrency);
    this.now = options.now ?? (() => performance.now());
    this.pool = new AssetWorkerPool({
      maxWorkers: this.maxWorkers,
      maxInFlightEstimatedBytes: options.maxInFlightEstimatedBytes ?? 256 * 1024 * 1024,
      maxQueuedTasks: options.maxQueuedTasks,
      maxConsecutiveWorkerFailures: options.maxConsecutiveWorkerFailures,
      createWorker: options.createWorker
    });
  }

  async submit(task: Ktx2TranscodeTask, signal?: AbortSignal): Promise<AssetCodecTaskResult> {
    if (this.destroyed) throw new Error("AssetCodecService is destroyed");
    validateAssetCodecTask(task);
    this.tasksQueued++;
    const inputByteLength = task.input.byteLength;
    this.inputBytes += inputByteLength;
    const submittedAt = this.now();
    try {
      const message = await this.pool.submit<
        { readonly type: "task"; readonly task: Ktx2TranscodeTask },
        AssetCodecWorkerMessage
      >({
        request: { type: "task", task },
        transfer: [task.input],
        estimatedPeakBytes: task.estimatedPeakBytes,
        priority: task.priority,
        signal
      });
      if (message.type !== "result") {
        throw new Error(`Asset codec Worker returned unexpected '${message.type}' message`);
      }
      validateAssetCodecWorkerResult(message.result);
      if (message.result.taskId !== task.taskId) throw new Error("Asset codec Worker returned the wrong task id");
      if (!message.result.ok) {
        throw new AssetCodecTaskError(message.result.code, message.result.message);
      }
      const result = message.result;
      if (result.sourceEncoding !== task.sourceEncoding || result.targetFormat !== task.targetFormat) {
        throw new Error("Asset codec Worker returned result metadata for a different task");
      }
      if (result.evidence.inputBytes !== inputByteLength ||
          result.evidence.estimatedPeakBytes !== task.estimatedPeakBytes) {
        throw new Error("Asset codec Worker returned inconsistent input or memory evidence");
      }
      const elapsedMs = Math.max(result.evidence.wallMs, this.now() - submittedAt, 0);
      const queueWaitMs = Math.max(result.evidence.queueWaitMs, elapsedMs - result.evidence.workerMs, 0);
      const measuredResult: AssetCodecTaskResult = Object.freeze({
        ...result,
        evidence: Object.freeze({
          ...result.evidence,
          queueWaitMs,
          wallMs: elapsedMs
        })
      });
      this.tasksCompleted++;
      this.workerPathCount++;
      this.queueWaitMs += measuredResult.evidence.queueWaitMs;
      this.workerMs += measuredResult.evidence.workerMs;
      this.wallMs += measuredResult.evidence.wallMs;
      this.outputBytes += measuredResult.evidence.outputBytes;
      const identityKey = [
        measuredResult.evidence.codecId,
        measuredResult.evidence.codecRevision,
        measuredResult.evidence.codecBinaryHash.toLowerCase()
      ].join(":");
      const identity = this.codecIdentities.get(identityKey);
      this.codecIdentities.set(identityKey, Object.freeze({
        codecId: measuredResult.evidence.codecId,
        codecRevision: measuredResult.evidence.codecRevision,
        codecBinaryHash: measuredResult.evidence.codecBinaryHash.toLowerCase(),
        completedTaskCount: (identity?.completedTaskCount ?? 0) + 1
      }));
      return measuredResult;
    } catch (error) {
      if (isAbortError(error)) this.tasksCancelled++;
      else this.tasksFailed++;
      this.wallMs += this.now() - submittedAt;
      throw error;
    }
  }

  evidence(): AssetCodecServiceEvidence {
    const pool = this.pool.evidence();
    return Object.freeze({
      schemaVersion: 2,
      tasksQueued: this.tasksQueued,
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      tasksCancelled: this.tasksCancelled,
      activeWorkers: pool.activeWorkers,
      peakActiveWorkers: pool.peakActiveWorkers,
      queuedTasks: pool.queuedTasks,
      inFlightEstimatedBytes: pool.inFlightEstimatedBytes,
      peakInFlightEstimatedBytes: pool.peakInFlightEstimatedBytes,
      queueWaitMs: this.queueWaitMs,
      workerMs: this.workerMs,
      wallMs: this.wallMs,
      inputBytes: this.inputBytes,
      outputBytes: this.outputBytes,
      transferBytes: this.inputBytes + this.outputBytes,
      workerFailures: pool.workerFailures,
      directPathCount: 0,
      workerPathCount: this.workerPathCount,
      uncompressedPathCount: 0,
      codecIdentities: Object.freeze(
        [...this.codecIdentities.values()].sort((left, right) =>
          left.codecId.localeCompare(right.codecId) ||
          left.codecRevision.localeCompare(right.codecRevision) ||
          left.codecBinaryHash.localeCompare(right.codecBinaryHash)
        )
      )
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pool.dispose();
  }
}

export class AssetCodecTaskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AssetCodecTaskError";
  }
}

export function defaultAssetCodecWorkerCount(hardwareConcurrency: number): number {
  if (!Number.isFinite(hardwareConcurrency) || hardwareConcurrency <= 0) return 1;
  return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency * 0.5)));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
