/** Dungeon host clocks only. GPU admission and submission remain Renderer-owned. */
export class DungeonFramePacing {
  private interactionAt: number | null = null;
  private submittedAt: number | null = null;
  private paused = false;
  private steps = 0;
  private stepPending = false;
  private visible = true;
  private stopped = false;
  interactionTicks = 0;
  readyWakeups = 0;
  submittedFrames = 0;
  readonly mode: "interactive" | "max-throughput";
  private readonly interact: (deltaSeconds: number) => void;
  private readonly render: (now: number, deltaSeconds: number, source: "raf" | "ready") => boolean;

  constructor(
    mode: "interactive" | "max-throughput",
    interact: (deltaSeconds: number) => void,
    render: (now: number, deltaSeconds: number, source: "raf" | "ready") => boolean
  ) {
    this.mode = mode;
    this.interact = interact;
    this.render = render;
  }

  raf(now: number): void {
    if (this.stopped || !this.visible || (this.paused && this.steps === 0)) {
      return;
    }
    // A deferred single step retries its finalized state, not another input tick.
    if (!this.stepPending) {
      const delta = this.paused ? 1 / 60 : this.delta(now, this.interactionAt);
      this.interactionAt = now;
      this.interact(delta);
      this.interactionTicks++;
      this.stepPending = this.paused;
    }
    this.attempt(now, "raf");
  }

  ready(now: number): void {
    if (this.stopped || !this.visible) {
      return;
    }
    this.readyWakeups++;
    if (this.mode === "max-throughput" && this.interactionAt !== null && (!this.paused || this.stepPending)) {
      this.attempt(now, "ready");
    }
    // Interactive waits for the next display RAF. No timers or CPU spin.
  }

  private attempt(now: number, source: "raf" | "ready"): void {
    const delta = this.paused ? 1 / 60 : this.delta(now, this.submittedAt);
    if (this.render(now, delta, source)) {
      this.submittedAt = now;
      this.submittedFrames++;
      if (this.paused) {
        this.steps--;
        this.stepPending = false;
      }
    }
  }

  private delta(now: number, previous: number | null): number {
    return previous === null ? 1 / 60 : Math.max(0, Math.min(0.1, (now - previous) / 1000));
  }

  setPaused(value: boolean): void {
    this.paused = value;
    this.steps = 0;
    this.stepPending = false;
    this.resetClocks();
  }

  step(): void {
    if (this.paused) {
      this.steps++;
    }
  }

  setVisible(value: boolean): void {
    this.visible = value;
    this.resetClocks();
  }

  private resetClocks(): void {
    this.interactionAt = null;
    this.submittedAt = null;
  }

  dispose(): void {
    this.stopped = true;
  }
}
