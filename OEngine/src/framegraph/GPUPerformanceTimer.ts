import { ChangeSignal } from "../core/Signal.js";
import type { ShadeGPUCommandContext } from "./ShadeGPUCommandContext.js";
import { GPUFrameTimingRing, type GPUFrameTimingSession } from "./GPUFrameTiming.js";

export class GPUPerformanceTimerData {
  start = 0n;
  end = 0n;
  available = false;
  get duration(): number | null {
    return this.available ? Number(this.end - this.start) : null;
  }
}
export class GPUStatisticsHistory {
  #history = new Float64Array(64);
  #cursor = -1;
  #count = 0;
  #sum = 0;
  get history_length(): number {
    return this.#history.length;
  }
  set history_length(value: number) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError("Invalid history capacity");
    }
    if (value !== this.#history.length) {
      this.#history = new Float64Array(value);
      this.#cursor = -1;
      this.#count = 0;
      this.#sum = 0;
    }
  }
  get average(): number {
    return this.#count ? this.#sum / this.#count : 0;
  }
  get last(): number {
    return this.#cursor < 0 ? 0 : this.#history[this.#cursor]!;
  }
  record(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("Invalid timestamp duration");
    }
    const next = (this.#cursor + 1) % this.#history.length;
    this.#sum += value - this.#history[next]!;
    this.#history[next] = value;
    this.#cursor = next;
    this.#count = Math.min(this.#count + 1, this.#history.length);
  }
}
/** Standalone pass timer using the same persistent ring. No extra submit. */
export class GPUPerformanceTimer {
  readonly onResults = new ChangeSignal();
  readonly data = new GPUPerformanceTimerData();
  readonly stats = new GPUStatisticsHistory();
  private readonly ring: GPUFrameTimingRing;
  private session: GPUFrameTimingSession | null = null;
  private pending: Promise<void> = Promise.resolve();
  private events = 0;
  constructor(
    readonly device: GPUDevice,
    readonly name = "Timer",
  ) {
    this.ring = new GPUFrameTimingRing(device, 3, 2);
  }
  get event_count(): number {
    return this.events;
  }
  getComputeWrites(): GPUComputePassTimestampWrites | undefined {
    return this.writes("compute");
  }
  getRenderWrites(): GPURenderPassTimestampWrites | undefined {
    return this.writes("render");
  }
  resolve(command: ShadeGPUCommandContext): void {
    const session = this.session;
    this.session = null;
    if (!session) {
      return;
    }
    session.resolve(command.gpu_encoder);
    command.recordReadback("gpu-performance-timer", session.evidence().readbackBytes);
    command.onAborted.addOne(() => session.abort());
    const result = command.submitted.then(async () => {
      const [timing] = await session.download();
      if (!timing) {
        return;
      }
      this.data.start = timing.start;
      this.data.end = timing.end;
      this.data.available = true;
      this.stats.record(Number(timing.end - timing.start));
      this.events++;
      this.onResults.send1(this);
    });
    this.pending = Promise.all([this.pending, result]).then(() => {});
    void this.pending.catch(() => {});
  }
  update(command: ShadeGPUCommandContext): void {
    this.resolve(command);
  }
  async getResults(): Promise<GPUPerformanceTimerData> {
    await this.pending;
    return this.data;
  }
  buildLogTextAverage(): string {
    return this.data.available
      ? `${this.name} : ${(this.stats.average * 1e-6).toFixed(2)} ms`
      : `${this.name} : unavailable`;
  }
  destroy(): void {
    this.session?.abort();
    this.session = null;
    this.ring.destroy();
  }
  private writes(type: "compute" | "render") {
    this.session ??= this.ring.acquire("full");
    return this.session?.writes(this.name, type);
  }
}
