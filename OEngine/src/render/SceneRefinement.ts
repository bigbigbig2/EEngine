/** Completed production observation only; never selects GPU workload. */
export interface SceneRefinementSample {
  readonly frame: number;
  readonly mainFrame: number;
  readonly shadowFrame: number;
  readonly mainComplete: boolean;
  readonly shadowComplete: boolean;
  readonly shadowRequired: boolean;
  readonly vsmFrame: number;
  readonly vsmValid: boolean;
  readonly texturesFull: boolean;
  readonly pendingGeometry: number;
  readonly stagedGeometry: number;
  readonly limited: boolean;
  readonly error: string | null;
}
export type SceneRefinementPhase =
  "bootstrap-ready" | "first-completed" | "refining" | "view-settled" | "limited" | "failed" | "cancelled";

/** A settled result belongs to one view/light/content epoch, not a whole asset.
 * Two complete demand observations after the last publication must agree. */
export class SceneRefinement {
  private key = "";
  private quality = "";
  private minimumFrame = 0;
  private candidateFrame = -1;
  private terminal = false;
  private readonly listeners = new Set<() => void>();
  private state = {
    epoch: 0,
    phase: "bootstrap-ready" as SceneRefinementPhase,
    firstCompletedAtMs: null as number | null,
    settledAtMs: null as number | null,
    completedFrame: -1,
    texturesFull: false,
    geometryTarget: false,
    vsmValid: false,
    error: null as string | null,
  };

  begin(key: string, quality: string, frame: number): void {
    if (this.terminal) {
      return;
    }
    if (key !== this.key) {
      this.key = key;
      this.state.epoch++;
      this.minimumFrame = frame;
      this.candidateFrame = -1;
      this.state.phase = this.state.firstCompletedAtMs === null ? "bootstrap-ready" : "refining";
      this.state.settledAtMs = null;
      this.state.geometryTarget = false;
      this.state.vsmValid = false;
      this.notify();
    }
    if (quality !== this.quality) {
      this.quality = quality;
      this.minimumFrame = frame;
      this.candidateFrame = -1;
      this.state.geometryTarget = false;
      this.state.vsmValid = false;
      if (this.state.firstCompletedAtMs !== null) {
        this.state.phase = "refining";
        this.state.settledAtMs = null;
        this.notify();
      }
    }
  }

  /** Queue completion is independent of delayed demand/readback processing. */
  frameCompleted(nowMs: number): void {
    if (this.terminal || this.state.firstCompletedAtMs !== null) {
      return;
    }
    this.state.firstCompletedAtMs = nowMs;
    this.state.phase = "first-completed";
    this.notify();
  }

  completed(sample: SceneRefinementSample, nowMs: number): void {
    if (this.terminal) {
      return;
    }
    const first = this.state.firstCompletedAtMs === null;
    this.state.firstCompletedAtMs ??= nowMs;
    if (sample.frame < this.minimumFrame) {
      if (first) {
        this.state.phase = "first-completed";
        this.notify();
      }
      return;
    }
    this.state.completedFrame = sample.frame;
    this.state.texturesFull = sample.texturesFull;
    const feedback =
      sample.mainComplete &&
      sample.mainFrame >= this.minimumFrame &&
      (!sample.shadowRequired || (sample.shadowComplete && sample.shadowFrame >= this.minimumFrame));
    this.state.geometryTarget = feedback && sample.pendingGeometry === 0 && sample.stagedGeometry === 0;
    this.state.vsmValid = !sample.shadowRequired || (sample.vsmFrame >= this.minimumFrame && sample.vsmValid);
    if (sample.error) {
      this.state.phase = "failed";
      this.state.error = sample.error;
      this.terminal = true;
    } else if (
      feedback &&
      sample.limited &&
      (!sample.shadowRequired || sample.vsmFrame >= this.minimumFrame)
    ) {
      this.state.phase = "limited";
      this.candidateFrame = -1;
    } else if (this.state.geometryTarget && this.state.vsmValid && sample.texturesFull) {
      const confirmedFrame = Math.min(
        sample.mainFrame,
        sample.shadowRequired ? Math.min(sample.shadowFrame, sample.vsmFrame) : sample.mainFrame,
      );
      if (this.candidateFrame >= 0 && confirmedFrame > this.candidateFrame) {
        this.state.phase = "view-settled";
        this.state.settledAtMs ??= nowMs;
      } else if (this.state.phase !== "view-settled") {
        this.candidateFrame = confirmedFrame;
        this.state.phase = "refining";
      }
    } else {
      this.candidateFrame = -1;
      this.state.phase = first ? "first-completed" : "refining";
      this.state.settledAtMs = null;
    }
    this.notify();
  }

  evidence() {
    return Object.freeze({ ...this.state });
  }

  /** Follows movement into the new epoch. Capacity resolves as limited;
   * release, device loss and failures reject, rather than hanging forever. */
  wait(signal?: AbortSignal): Promise<ReturnType<SceneRefinement["evidence"]>> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.listeners.delete(check);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? new Error("Scene convergence cancelled"));
      };
      const check = () => {
        if (signal?.aborted) {
          abort();
          return;
        }
        if (["view-settled", "limited", "cancelled", "failed"].includes(this.state.phase)) {
          this.listeners.delete(check);
          signal?.removeEventListener("abort", abort);
          if (this.state.phase === "cancelled" || this.state.phase === "failed") {
            reject(new Error(this.state.error ?? "Scene convergence cancelled"));
          } else {
            resolve(this.evidence());
          }
        }
      };
      this.listeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  cancel(): void {
    this.terminal = true;
    this.state.phase = "cancelled";
    this.notify();
  }

  fail(error: unknown): void {
    this.terminal = true;
    this.state.phase = "failed";
    this.state.error = error instanceof Error ? error.message : String(error);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
