import type { ProfileFrame } from "../../../debug/profiling/ProfileFrame.js";

export type FrameBarState =
  | "normal"
  | "over-budget"
  | "instrumented"
  | "pending"
  | "unsupported"
  | "invalid"
  | "dropped";

const STATE_CODES: Readonly<Record<FrameBarState, number>> = Object.freeze({
  normal: 0,
  "over-budget": 1,
  instrumented: 2,
  pending: 3,
  unsupported: 4,
  invalid: 5,
  dropped: 6
});

const STATE_COLORS: Readonly<Record<FrameBarState, string>> = Object.freeze({
  normal: "#38bdf8",
  "over-budget": "#f97316",
  instrumented: "#a78bfa",
  pending: "#facc15",
  unsupported: "#94a3b8",
  invalid: "#ef4444",
  dropped: "#dc2626"
});

export function frameStatusColor(state: FrameBarState): string {
  return STATE_COLORS[state];
}

export function frameStatusFromCode(code: number): FrameBarState {
  for (const [state, value] of Object.entries(STATE_CODES)) {
    if (value === code) return state as FrameBarState;
  }
  return "invalid";
}

export function classifyFrame(frame: ProfileFrame, budgetMs: number): FrameBarState {
  const samples = [frame.samples["cpu.frameMs"], frame.samples["gpu.passSumMs"]];
  for (const availability of ["pending", "dropped", "invalid", "unsupported"] as const) {
    if (samples.some((sample) => sample?.availability === availability)) return availability;
  }
  const cpu = frame.samples["cpu.frameMs"];
  if (frame.counterInstrumented || frame.timestampInstrumented) return "instrumented";
  if (cpu?.availability === "available" && cpu.value !== null && cpu.value > budgetMs) {
    return "over-budget";
  }
  return "normal";
}

/** Bounded, allocation-free storage for the frame strip. */
export class FrameChartModel {
  readonly maxFrames: number;
  readonly frameIndices: Uint32Array;
  readonly values: Float32Array;
  readonly statuses: Uint8Array;
  private countValue = 0;

  constructor(maxFrames = 2048) {
    if (!Number.isInteger(maxFrames) || maxFrames <= 0) {
      throw new RangeError("maxFrames must be a positive integer");
    }
    this.maxFrames = maxFrames;
    this.frameIndices = new Uint32Array(maxFrames);
    this.values = new Float32Array(maxFrames);
    this.statuses = new Uint8Array(maxFrames);
  }

  get count(): number {
    return this.countValue;
  }

  setFrames(frames: readonly ProfileFrame[], budgetMs = 16.667): void {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError("budgetMs must be positive");
    const first = Math.max(0, frames.length - this.maxFrames);
    const count = frames.length - first;
    for (let index = 0; index < count; index++) {
      const frame = frames[first + index]!;
      const sample = frame.samples["cpu.frameMs"];
      this.frameIndices[index] = frame.frameIndex;
      this.values[index] = sample?.availability === "available" && sample.value !== null
        ? sample.value
        : Number.NaN;
      this.statuses[index] = STATE_CODES[classifyFrame(frame, budgetMs)];
    }
    this.countValue = count;
  }
}

/** Canvas renderer for a FrameChartModel; DOM is created once by the panel. */
export class FrameChart {
  readonly model: FrameChartModel;
  private readonly canvas: HTMLCanvasElement;
  private cssWidth = 320;
  private cssHeight = 72;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, maxFrames = 2048) {
    this.canvas = canvas;
    this.model = new FrameChartModel(maxFrames);
  }

  resize(cssWidth: number, cssHeight: number, dpr = 1): void {
    if (!Number.isFinite(cssWidth) || cssWidth <= 0 || !Number.isFinite(cssHeight) || cssHeight <= 0) {
      throw new RangeError("Canvas dimensions must be positive");
    }
    if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError("dpr must be positive");
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  setFrames(frames: readonly ProfileFrame[], budgetMs = 16.667): void {
    this.model.setFrames(frames, budgetMs);
  }

  render(): void {
    const context = this.canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    const count = this.model.count;
    if (count === 0) return;
    const barWidth = this.cssWidth / count;
    let maxValue = 1;
    for (let index = 0; index < count; index++) {
      const value = this.model.values[index]!;
      if (Number.isFinite(value)) maxValue = Math.max(maxValue, value);
    }
    for (let index = 0; index < count; index++) {
      const state = frameStatusFromCode(this.model.statuses[index]!);
      const value = this.model.values[index]!;
      const height = Number.isFinite(value) ? Math.max(2, (value / maxValue) * (this.cssHeight - 4)) : 3;
      context.fillStyle = frameStatusColor(state);
      context.fillRect(index * barWidth, this.cssHeight - height, Math.max(1, barWidth - 1), height);
    }
  }
}
