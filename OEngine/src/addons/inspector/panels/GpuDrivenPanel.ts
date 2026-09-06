import type { ProfileFrame } from "../../../debug/profiling/ProfileFrame.js";
import type { MetricSampleAvailability } from "../../../debug/profiling/Metric.js";

export interface FunnelStage {
  readonly label: string;
  readonly metricId: string;
  readonly value: number | null;
  readonly availability: MetricSampleAvailability;
  readonly ratio: number | null;
}

export interface QueueMetricSpec {
  readonly label: string;
  readonly current: string;
  readonly capacity: string;
  readonly peak?: string;
  readonly overflow?: string;
}

export interface QueueSummary {
  readonly label: string;
  readonly current: number | null;
  readonly capacity: number | null;
  readonly peak: number | null;
  readonly overflow: number | null;
  readonly available: boolean;
}

const DEFAULT_QUEUE_SPECS: readonly QueueMetricSpec[] = Object.freeze([
  {
    label: "Selected clusters",
    current: "gpu.counter.selectedClusters",
    capacity: "packed.visibility.rasterWorkCapacity"
  },
  {
    label: "Hardware clusters",
    current: "gpu.counter.hwClusters",
    capacity: "packed.visibility.rasterWorkCapacity"
  }
]);

const FUNNEL_SPECS = Object.freeze([
  ["Candidate instances", "gpu.counter.candidateInstances", "instances"],
  ["Visible instances", "gpu.counter.visibleInstances", "instances"],
  ["Candidate clusters", "gpu.counter.candidateClusters", "clusters"],
  ["Selected clusters", "gpu.counter.selectedClusters", "clusters"],
  ["Hardware clusters", "gpu.counter.hwClusters", "clusters"],
  ["Shaded pixels", "gpu.counter.shadedPixels", "pixels"]
] as const);

function latest(frames: readonly ProfileFrame[]): ProfileFrame | undefined {
  return frames.at(-1);
}

function read(frame: ProfileFrame | undefined, metricId: string): Pick<FunnelStage, "value" | "availability"> {
  const sample = frame?.samples[metricId];
  if (sample === undefined) return { value: null, availability: "not-sampled" };
  return { value: sample.availability === "available" ? sample.value : null, availability: sample.availability };
}

export function buildGpuDrivenFunnel(frames: readonly ProfileFrame[]): readonly FunnelStage[] {
  const frame = latest(frames);
  let previous: number | null = null;
  let previousGroup: string | null = null;
  return FUNNEL_SPECS.map(([label, metricId, group]) => {
    const sample = read(frame, metricId);
    if (group !== previousGroup) previous = null;
    const ratio = sample.value !== null && previous !== null && previous > 0
      ? sample.value / previous
      : null;
    if (sample.value !== null) previous = sample.value;
    previousGroup = group;
    return Object.freeze({ label, metricId, ...sample, ratio });
  });
}

export function buildQueueSummaries(
  frames: readonly ProfileFrame[],
  specs: readonly QueueMetricSpec[] = DEFAULT_QUEUE_SPECS
): readonly QueueSummary[] {
  const frame = latest(frames);
  return specs.map((spec) => {
    const current = read(frame, spec.current);
    const capacity = read(frame, spec.capacity);
    const peak = spec.peak === undefined ? { value: null, availability: "unsupported" as const } : read(frame, spec.peak);
    const overflow = spec.overflow === undefined ? { value: null, availability: "unsupported" as const } : read(frame, spec.overflow);
    return Object.freeze({
      label: spec.label,
      current: current.value,
      capacity: capacity.value,
      peak: peak.value,
      overflow: overflow.value,
      available: current.value !== null || capacity.value !== null || peak.value !== null || overflow.value !== null
    });
  });
}

export class GpuDrivenPanel {
  readonly element: HTMLElement;
  private readonly funnel: HTMLElement;
  private readonly queues: HTMLElement;

  constructor(document: Document) {
    this.element = document.createElement("section");
    this.element.className = "domain-panel gpu-driven-panel";
    const heading = document.createElement("h3");
    heading.textContent = "Visibility & Work";
    this.funnel = document.createElement("div");
    this.queues = document.createElement("div");
    this.element.append(heading, this.funnel, this.queues);
  }

  update(frames: readonly ProfileFrame[], focusFrame: ProfileFrame | undefined = latest(frames)): void {
    const focused = focusFrame === undefined ? [] : [focusFrame];
    this.funnel.textContent = buildGpuDrivenFunnel(focused).map((stage) =>
      `${stage.label}: ${stage.value === null ? stage.availability : stage.value} (${stage.ratio === null ? "—" : `${(stage.ratio * 100).toFixed(1)}%`})`
    ).join("\n");
    this.queues.textContent = buildQueueSummaries(focused).map((queue) =>
      `${queue.label}: current ${queue.current ?? "unsupported"} / capacity ${queue.capacity ?? "unsupported"} / peak ${queue.peak ?? "unsupported"} / overflow ${queue.overflow ?? "unsupported"}`
    ).join("\n");
  }
}
