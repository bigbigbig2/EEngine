import type { ProfileFrame } from "../../../debug/profiling/ProfileFrame.js";
import type { ProfileSpan } from "../../../debug/profiling/ProfileSpan.js";
import { FrameChart, type FrameBarState, classifyFrame, frameStatusColor } from "../charts/FrameChart.js";

export type GpuClockDisplay = "aligned" | "duration-only" | "unsupported";

export function gpuClockDisplay(frame: ProfileFrame | undefined): GpuClockDisplay {
  if (frame === undefined) return "unsupported";
  const gpu = frame.spans.filter((span) => span.clockDomain === "gpu-device");
  if (gpu.length === 0) return "unsupported";
  return gpu.some((span) => span.availability === "available" && span.start === null)
    ? "duration-only"
    : "aligned";
}

function spanText(spans: readonly ProfileSpan[], clock: ProfileSpan["clockDomain"]): string {
  const values = spans
    .filter((span) => span.clockDomain === clock && span.availability === "available" && span.duration !== null)
    .map((span) => `${span.name} ${span.duration!.toFixed(2)} ms`);
  return values.length === 0 ? "unsupported" : values.join(" · ");
}

/** Timeline panel owns stable DOM nodes and a bounded frame-strip canvas. */
export class TimelinePanel {
  readonly element: HTMLElement;
  private readonly details: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly chart: FrameChart;
  private readonly onSelectFrame: (frameIndex: number) => void;
  private readonly onSelectRange: (startFrameIndex: number, endFrameIndex: number) => void;
  private frames: readonly ProfileFrame[] = [];
  private anchorFrameIndex: number | null = null;

  constructor(
    document: Document,
    onSelectFrame: (frameIndex: number) => void,
    onSelectRange: (startFrameIndex: number, endFrameIndex: number) => void
  ) {
    this.onSelectFrame = onSelectFrame;
    this.onSelectRange = onSelectRange;
    this.element = document.createElement("section");
    this.element.className = "timeline-panel";
    const heading = document.createElement("h3");
    heading.textContent = "Timeline";
    this.warning = document.createElement("div");
    this.warning.className = "timeline-warning";
    this.details = document.createElement("pre");
    this.details.className = "timeline-details";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "inspector-chart timeline-strip";
    this.canvas.setAttribute("aria-label", "Frame timeline");
    this.chart = new FrameChart(this.canvas);
    this.chart.resize(420, 72, 1);
    this.canvas.addEventListener("click", (event) => this.selectAt(event));
    this.element.append(heading, this.warning, this.canvas, this.details);
  }

  update(
    frames: readonly ProfileFrame[],
    selectedFrameIndex: number | null,
    range: readonly [number, number] | null
  ): void {
    this.frames = frames;
    this.chart.setFrames(frames);
    this.chart.render();
    const selected = selectedFrameIndex === null
      ? undefined
      : frames.find((frame) => frame.frameIndex === selectedFrameIndex);
    const display = gpuClockDisplay(selected);
    this.warning.textContent = display === "duration-only"
      ? "CPU/GPU clock not aligned"
      : display === "unsupported" && selected !== undefined
        ? "GPU timing unsupported"
        : "";
    if (selected === undefined) {
      this.details.textContent = range === null
        ? "Select a frame or drag with Shift to select a range."
        : `Range ${range[0]}–${range[1]}`;
      return;
    }
    const gpu = selected.spans.filter((span) => span.clockDomain === "gpu-device");
    const gpuLine = display === "duration-only"
      ? `GPU duration table: ${spanText(gpu, "gpu-device")}`
      : `GPU Device: ${spanText(gpu, "gpu-device")}`;
    this.details.textContent = [
      `Frame ${selected.frameIndex}${selected.counterInstrumented ? " · instrumented" : ""}`,
      `CPU Main: ${spanText(selected.spans, "cpu-main")}`,
      gpuLine,
      `Range: ${range === null ? "none" : `${range[0]}–${range[1]}`}`
    ].join("\n");
  }

  private selectAt(event: MouseEvent): void {
    if (this.frames.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const ratio = rect.width <= 0 ? 0 : Math.min(0.999999, Math.max(0, (event.clientX - rect.left) / rect.width));
    const index = Math.min(this.frames.length - 1, Math.floor(ratio * this.frames.length));
    const frameIndex = this.frames[index]!.frameIndex;
    if (event.shiftKey && this.anchorFrameIndex !== null) {
      this.onSelectRange(Math.min(this.anchorFrameIndex, frameIndex), Math.max(this.anchorFrameIndex, frameIndex));
    } else {
      this.anchorFrameIndex = frameIndex;
      this.onSelectFrame(frameIndex);
    }
  }
}

export { classifyFrame, frameStatusColor };
export type { FrameBarState };
