import type { MetricSample } from "./Metric.js";
import type { ProfileFrame } from "./ProfileFrame.js";
import type { ProfileSpan } from "./ProfileSpan.js";

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

export interface ChromeTraceInput {
  readonly frames: readonly Pick<ProfileFrame, "frameIndex" | "spans" | "samples">[];
}

/** Materializes a trace document for callers that need to inspect its events. */
export function exportChromeTrace(input: ChromeTraceInput): ChromeTraceDocument {
  const events = [...traceEvents(input)].map((event) => Object.freeze(event));
  return Object.freeze({
    traceEvents: Object.freeze(events),
    metadata: Object.freeze({ cpuGpuClockAligned: false })
  });
}

/**
 * Serializes a trace incrementally so large captures do not require a second
 * in-memory event array. Each yielded chunk is already valid JSON text.
 */
export function* streamChromeTrace(input: ChromeTraceInput): IterableIterator<string> {
  yield '{"traceEvents":[';
  let first = true;
  for (const event of traceEvents(input)) {
    if (!first) yield ",";
    yield JSON.stringify(event);
    first = false;
  }
  yield '],"metadata":{"cpuGpuClockAligned":false}}\n';
}

export function serializeChromeTrace(input: ChromeTraceInput): string {
  return [...streamChromeTrace(input)].join("");
}

function* traceEvents(input: ChromeTraceInput): IterableIterator<ChromeTraceEvent> {
  const frames = [...input.frames].sort((a, b) => a.frameIndex - b.frameIndex);
  for (const frame of frames) {
    const spans = [...frame.spans].sort(compareSpans);
    for (const span of spans) {
      const event = spanEvent(frame.frameIndex, span);
      if (event !== null) yield event;
    }
    const samples = Object.values(frame.samples).sort((a, b) =>
      a.metricId.localeCompare(b.metricId)
    );
    for (const sample of samples) yield sampleEvent(sample);
  }
}

function spanEvent(frameIndex: number, span: ProfileSpan): ChromeTraceEvent | null {
  if (span.availability !== "available" || span.duration === null) return null;
  const args = {
    frameIndex,
    instrumented: span.instrumented,
    availability: span.availability
  };
  if (span.start === null) {
    return {
      name: span.name,
      cat: span.category,
      ph: "C",
      ts: frameIndex,
      pid: "oengine",
      tid: span.clockDomain,
      args: { ...args, durationMs: span.duration }
    };
  }
  return {
    name: span.name,
    cat: span.category,
    ph: "X",
    ts: span.start * 1000,
    dur: span.duration * 1000,
    pid: "oengine",
    tid: span.clockDomain,
    args
  };
}

function sampleEvent(sample: MetricSample): ChromeTraceEvent {
  return {
    name: sample.metricId,
    cat: "metric",
    ph: "C",
    ts: sample.sourceFrameIndex,
    pid: "oengine",
    tid: "metrics",
    args: {
      value: sample.value,
      frameIndex: sample.sourceFrameIndex,
      sourceFrameIndex: sample.sourceFrameIndex,
      resolvedAtFrameIndex: sample.resolvedAtFrameIndex,
      instrumented: sample.instrumented,
      availability: sample.availability
    }
  };
}

function compareSpans(a: ProfileSpan, b: ProfileSpan): number {
  return a.id - b.id || a.name.localeCompare(b.name);
}
