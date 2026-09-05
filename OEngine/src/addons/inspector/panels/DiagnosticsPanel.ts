import type { FrameProfilerDiagnostics } from "../../../debug/FrameProfiler.js";
import type { MetricDescriptor } from "../../../debug/profiling/Metric.js";
import type { ProfileFrame } from "../../../debug/profiling/ProfileFrame.js";

export interface DiagnosticsInput {
  readonly diagnostics: FrameProfilerDiagnostics | null;
  readonly metricCatalog: readonly MetricDescriptor[];
  readonly frame: ProfileFrame | undefined;
  readonly mode: string;
  readonly gpuTimestampAvailable: boolean;
  readonly gpuSampleInterval: number;
  readonly gpuCounterSampleInterval: number;
  readonly inspectorOverheadMs: number | null;
}

export interface DiagnosticRow {
  readonly label: string;
  readonly value: string;
  readonly severity: "info" | "warning" | "error";
}

export function buildDiagnostics(input: DiagnosticsInput): readonly DiagnosticRow[] {
  const rows: DiagnosticRow[] = [
    { label: "Mode", value: input.mode, severity: "info" },
    { label: "GPU timestamps", value: input.gpuTimestampAvailable ? "available" : "unsupported", severity: input.gpuTimestampAvailable ? "info" : "warning" },
    { label: "Timestamp cadence", value: `${input.gpuSampleInterval} frame(s)`, severity: "info" },
    { label: "Counter cadence", value: `${input.gpuCounterSampleInterval} frame(s)`, severity: "info" }
  ];
  const diagnostics = input.diagnostics;
  if (diagnostics !== null) {
    rows.push(
      { label: "Validation errors", value: String(diagnostics.validationErrorCount), severity: diagnostics.validationErrorCount > 0 ? "error" : "info" },
      { label: "Uncaptured errors", value: String(diagnostics.uncapturedErrorCount), severity: diagnostics.uncapturedErrorCount > 0 ? "error" : "info" },
      { label: "Device lost", value: String(diagnostics.deviceLostCount), severity: diagnostics.deviceLostCount > 0 ? "error" : "info" },
      { label: "GPU timestamp failures", value: String(diagnostics.failedGpuTimestampBatches), severity: diagnostics.failedGpuTimestampBatches > 0 ? "warning" : "info" },
      { label: "Dropped counters", value: String(diagnostics.droppedGpuCounterSamples), severity: diagnostics.droppedGpuCounterSamples > 0 ? "warning" : "info" },
      { label: "Failed counters", value: String(diagnostics.failedGpuCounterSamples), severity: diagnostics.failedGpuCounterSamples > 0 ? "warning" : "info" }
    );
  }
  const unsupported = input.frame === undefined
    ? []
    : input.metricCatalog.filter((descriptor) => {
      const sample = input.frame!.samples[descriptor.id];
      return sample === undefined || sample.availability === "unsupported";
    });
  if (unsupported.length > 0) {
    rows.push({ label: "Unsupported metrics", value: unsupported.map((metric) => `${metric.id}: ${input.frame!.samples[metric.id] === undefined ? "not sampled in this frame" : metric.description}`).join("; "), severity: "warning" });
  }
  const pending = input.frame === undefined
    ? []
    : Object.values(input.frame.samples).filter((sample) => sample.availability === "pending");
  if (pending.length > 0) {
    const age = Math.max(...pending.map((sample) => input.frame!.frameIndex - sample.sourceFrameIndex));
    rows.push({ label: "Pending age", value: `${age} frame(s)`, severity: "warning" });
  }
  rows.push({
    label: "Inspector overhead",
    value: input.inspectorOverheadMs === null ? "unsupported" : `${input.inspectorOverheadMs.toFixed(3)} ms`,
    severity: input.inspectorOverheadMs === null ? "warning" : "info"
  });
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export class DiagnosticsPanel {
  readonly element: HTMLElement;
  private readonly table: HTMLElement;

  constructor(document: Document) {
    this.element = document.createElement("section");
    this.element.className = "domain-panel diagnostics-panel";
    const heading = document.createElement("h3");
    heading.textContent = "Diagnostics";
    this.table = document.createElement("pre");
    this.element.append(heading, this.table);
  }

  update(input: DiagnosticsInput): void {
    this.table.textContent = buildDiagnostics(input)
      .map((row) => `${row.label}: ${row.value}`)
      .join("\n");
  }
}
