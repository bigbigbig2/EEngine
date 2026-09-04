import type { MetricSample } from "./Metric.js";
import type { ProfileFrame } from "./ProfileFrame.js";

export interface ChromeTraceEvent {
  readonly name: string;
  readonly cat: string;
  readonly ph: "X" | "C";
  readonly ts: number;
  readonly dur?: number;
  readonly pid: string;
  readonly tid: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface ChromeTraceDocument {
  readonly traceEvents: readonly ChromeTraceEvent[];
  readonly metadata: { readonly cpuGpuClockAligned: false };
}

export function exportChromeTrace(input: {
  frames: readonly Pick<ProfileFrame, "frameIndex" | "spans" | "samples">[];
}): ChromeTraceDocument {
  const events: ChromeTraceEvent[] = [];
  for (const frame of input.frames) {
    for (const span of frame.spans) {
      if (span.availability !== "available" || span.duration === null) continue;
      const args = { frameIndex: frame.frameIndex, instrumented: span.instrumented };
      if (span.start === null) {
        events.push({
          name: span.name,
          cat: span.category,
          ph: "C",
          ts: frame.frameIndex,
          pid: "oengine",
          tid: span.clockDomain,
          args: { ...args, durationMs: span.duration }
        });
      } else {
        events.push({
          name: span.name,
          cat: span.category,
          ph: "X",
          ts: span.start * 1000,
          dur: span.duration * 1000,
          pid: "oengine",
          tid: span.clockDomain,
          args
        });
      }
    }
    for (const sample of Object.values(frame.samples)) addSampleEvent(events, sample);
  }
  return Object.freeze({
    traceEvents: Object.freeze(events),
    metadata: Object.freeze({ cpuGpuClockAligned: false })
  });
}

function addSampleEvent(events: ChromeTraceEvent[], sample: MetricSample): void {
  if (sample.availability !== "available" || sample.value === null) return;
  events.push({
    name: sample.metricId,
    cat: "metric",
    ph: "C",
    ts: sample.sourceFrameIndex,
    pid: "oengine",
    tid: "metrics",
    args: {
      value: sample.value,
      sourceFrameIndex: sample.sourceFrameIndex,
      resolvedAtFrameIndex: sample.resolvedAtFrameIndex,
      instrumented: sample.instrumented
    }
  });
}
