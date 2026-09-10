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
  readonly capacity?: string;
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
    label: "Selected meshlets",
    current: "gpu.counter.geometryMeshletsSelected",
    capacity: "packed.visibility.meshletWorkCapacity"
  },
  {
    label: "Meshlet work",
    current: "gpu.counter.geometryMeshletWorksProduced",
    capacity: "packed.visibility.meshletWorkCapacity"
  },
  {
    label: "TriangleSetup candidates",
    current: "gpu.counter.setupWritten",
    overflow: "gpu.counter.setupOverflow"
  }
]);

const FUNNEL_SPECS = Object.freeze([
  ["Candidate instances", "gpu.counter.candidateInstances", "instances"],
  ["Visible instances", "gpu.counter.visibleInstances", "instances"],
  ["Hierarchy nodes tested", "gpu.counter.geometryNodesTested", "geometry"],
  ["Clusters accepted", "gpu.counter.geometryClustersAccepted", "geometry"],
  ["Meshlets selected", "gpu.counter.geometryMeshletsSelected", "geometry"],
  ["Candidate triangles", "gpu.counter.geometryCandidateTriangles", "triangles"],
  ["Risky triangles", "gpu.counter.geometryRiskyTriangles", "triangles"],
  ["Exact survived", "gpu.counter.geometryExactSurvivedTriangles", "triangles"],
  ["Raster triangles", "gpu.counter.geometryRasterTriangles", "triangles"],
  ["Visible pixels", "gpu.counter.geometryVisiblePixels", "pixels"]
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
    const capacity = spec.capacity === undefined
      ? { value: null, availability: "unsupported" as const }
      : read(frame, spec.capacity);
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
    const queueLines = buildQueueSummaries(focused).map((queue) =>
      `${queue.label}: current ${queue.current ?? "unsupported"} / capacity ${queue.capacity ?? "unsupported"} / peak ${queue.peak ?? "unsupported"} / overflow ${queue.overflow ?? "unsupported"}`
    );
    queueLines.push(triangleSetupHitRatio(focused[0]));
    queueLines.push(geometryAmplificationSummary(focused[0]));
    this.queues.textContent = queueLines.join("\n");
  }
}

function geometryAmplificationSummary(frame: ProfileFrame | undefined): string {
  const queueBytes = read(frame, "gpu.counter.geometryQueueBytes").value;
  const meshlets = read(frame, "gpu.counter.geometryMeshletsSelected").value;
  const rasterTriangles = read(frame, "gpu.counter.geometryRasterTriangles").value;
  const paddedVertices = read(frame, "gpu.counter.geometryPaddedVertices").value;
  if (queueBytes === null || meshlets === null || rasterTriangles === null || paddedVertices === null) {
    return "Geometry amplification: unsupported";
  }
  const bytesPerMeshlet = meshlets > 0 ? queueBytes / meshlets : 0;
  const rasterVertices = rasterTriangles * 3;
  const paddingRatio = rasterVertices + paddedVertices > 0
    ? paddedVertices / (rasterVertices + paddedVertices)
    : 0;
  return `Geometry amplification: ${queueBytes} queue B · ${bytesPerMeshlet.toFixed(1)} B/meshlet · ${(paddingRatio * 100).toFixed(1)}% padding`;
}

function triangleSetupHitRatio(frame: ProfileFrame | undefined): string {
  const hits = read(frame, "gpu.counter.setupVisiblePixelHits").value;
  const fallbacks = read(frame, "gpu.counter.setupVisiblePixelFallbacks").value;
  if (hits === null || fallbacks === null) return "TriangleSetup visible hit ratio: unsupported";
  const samples = hits + fallbacks;
  return `TriangleSetup visible hit ratio: ${samples > 0 ? `${((hits / samples) * 100).toFixed(1)}%` : "0.0%"} (${hits} hit / ${fallbacks} fallback)`;
}
