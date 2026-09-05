import {
  MetricRegistry,
  type MetricDescriptor
} from "./MetricRegistry.js";
import type { MetricSample, MetricSampleAvailability } from "./Metric.js";
import type { ProfileFrame } from "./ProfileFrame.js";
import type { ProfileSpan } from "./ProfileSpan.js";

export interface PerformanceCapture {
  readonly format: "oengine-performance-capture";
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly engine: Readonly<Record<string, unknown>>;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly sampling: {
    readonly mode: "live" | "record" | "deep-capture";
    readonly warmupFrames: number;
    readonly timestampInterval: number;
    readonly counterInterval: number;
    readonly historyCapacity: number;
  };
  readonly metricCatalog: readonly MetricDescriptor[];
  readonly frames: readonly ProfileFrame[];
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

export interface PerformanceCaptureInput {
  engine?: Readonly<Record<string, unknown>>;
  environment?: Readonly<Record<string, unknown>>;
  sampling: PerformanceCapture["sampling"];
  metricCatalog: readonly MetricDescriptor[];
  frames: readonly ProfileFrame[];
  diagnostics?: Readonly<Record<string, unknown>>;
  createdAt?: string;
}

const CAPTURE_FORMAT = "oengine-performance-capture";
const CAPTURE_SCHEMA_VERSION = 1;
const METRIC_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*$/;
const AVAILABILITIES: readonly MetricSampleAvailability[] = [
  "available", "pending", "unsupported", "invalid", "dropped"
];

export function createPerformanceCapture(input: PerformanceCaptureInput): PerformanceCapture {
  return normalizeCapture({
    format: CAPTURE_FORMAT,
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    engine: input.engine ?? {},
    environment: input.environment ?? {},
    sampling: input.sampling,
    metricCatalog: input.metricCatalog,
    frames: input.frames,
    diagnostics: input.diagnostics ?? {}
  });
}

/** Canonical UTF-8 JSON text: stable field, key, metric, sample and span ordering. */
export function serializePerformanceCapture(capture: PerformanceCapture): string {
  return `${JSON.stringify(normalizeCapture(capture), null, 2)}\n`;
}

/** Parses, validates, drops unknown schema fields and returns a deeply frozen capture. */
export function parsePerformanceCapture(serialized: string): PerformanceCapture {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new TypeError(`Invalid performance capture JSON: ${String(error)}`);
  }
  return normalizeCapture(value);
}

function normalizeCapture(value: unknown): PerformanceCapture {
  const capture = requireRecord(value, "Capture");
  if (capture.format !== CAPTURE_FORMAT) throw new TypeError("Unsupported capture format");
  if (capture.schemaVersion !== CAPTURE_SCHEMA_VERSION) {
    throw new RangeError(`Unsupported capture schema ${String(capture.schemaVersion)}`);
  }
  const createdAt = requireString(capture.createdAt, "Capture createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError("Capture createdAt must be an ISO-compatible date");
  const metricCatalog = normalizeMetricCatalog(capture.metricCatalog);
  const metricIds = new Set(metricCatalog.map(({ id }) => id));
  const frames = normalizeFrames(capture.frames, metricIds);
  const normalized: PerformanceCapture = {
    format: CAPTURE_FORMAT,
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    createdAt,
    engine: canonicalJsonRecord(capture.engine ?? {}, "Capture engine"),
    environment: canonicalJsonRecord(capture.environment ?? {}, "Capture environment"),
    sampling: normalizeSampling(capture.sampling),
    metricCatalog: Object.freeze(metricCatalog),
    frames: Object.freeze(frames),
    diagnostics: canonicalJsonRecord(capture.diagnostics ?? {}, "Capture diagnostics")
  };
  return deepFreeze(normalized);
}

function normalizeSampling(value: unknown): PerformanceCapture["sampling"] {
  const sampling = requireRecord(value, "Capture sampling");
  const mode = sampling.mode;
  if (mode !== "live" && mode !== "record" && mode !== "deep-capture") {
    throw new TypeError("Invalid capture sampling mode");
  }
  return Object.freeze({
    mode,
    warmupFrames: requireNonNegativeInteger(sampling.warmupFrames, "sampling warmupFrames"),
    timestampInterval: requirePositiveInteger(sampling.timestampInterval, "sampling timestampInterval"),
    counterInterval: requirePositiveInteger(sampling.counterInterval, "sampling counterInterval"),
    historyCapacity: requirePositiveInteger(sampling.historyCapacity, "sampling historyCapacity")
  });
}

function normalizeMetricCatalog(value: unknown): MetricDescriptor[] {
  if (!Array.isArray(value)) throw new TypeError("Capture metric catalog is required");
  const registry = new MetricRegistry();
  for (const candidate of value) {
    const descriptor = requireRecord(candidate, "Capture metric descriptor");
    registry.register({
      id: requireString(descriptor.id, "Metric id"),
      label: requireString(descriptor.label, "Metric label"),
      group: requireString(descriptor.group, "Metric group"),
      unit: requireString(descriptor.unit, "Metric unit") as MetricDescriptor["unit"],
      source: requireString(descriptor.source, "Metric source") as MetricDescriptor["source"],
      measurement: requireString(descriptor.measurement, "Metric measurement") as MetricDescriptor["measurement"],
      cost: requireString(descriptor.cost, "Metric cost") as MetricDescriptor["cost"],
      scope: requireString(descriptor.scope, "Metric scope") as MetricDescriptor["scope"],
      aggregation: requireString(descriptor.aggregation, "Metric aggregation") as MetricDescriptor["aggregation"],
      description: requireString(descriptor.description, "Metric description")
    });
  }
  return [...registry.values()];
}

function normalizeFrames(value: unknown, metricIds: ReadonlySet<string>): ProfileFrame[] {
  if (!Array.isArray(value)) throw new TypeError("Capture frames are required");
  const frames: ProfileFrame[] = [];
  let previousFrameIndex = -1;
  for (const candidate of value) {
    const frame = normalizeFrame(candidate, metricIds);
    if (frame.frameIndex <= previousFrameIndex) {
      throw new RangeError("Capture frame indexes must be strictly increasing");
    }
    previousFrameIndex = frame.frameIndex;
    frames.push(frame);
  }
  return frames;
}

function normalizeFrame(value: unknown, metricIds: ReadonlySet<string>): ProfileFrame {
  const frame = requireRecord(value, "Capture frame");
  if (frame.schemaVersion !== 1) throw new RangeError(`Unsupported profile frame schema ${String(frame.schemaVersion)}`);
  const frameIndex = requireNonNegativeInteger(frame.frameIndex, "frameIndex");
  const samples = normalizeSamples(frame.samples, frameIndex, metricIds);
  const spans = normalizeSpans(frame.spans, frameIndex);
  return Object.freeze({
    schemaVersion: 1,
    frameIndex,
    epoch: requireNonNegativeInteger(frame.epoch, "frame epoch"),
    warmup: requireBoolean(frame.warmup, "frame warmup"),
    visibilityState: requireString(frame.visibilityState, "frame visibilityState"),
    samples: Object.freeze(samples),
    spans: Object.freeze(spans),
    gpuCounterSchemaVersion: requireNonNegativeInteger(frame.gpuCounterSchemaVersion, "frame gpuCounterSchemaVersion"),
    timestampInstrumented: requireBoolean(frame.timestampInstrumented, "frame timestampInstrumented"),
    counterInstrumented: requireBoolean(frame.counterInstrumented, "frame counterInstrumented"),
    complete: requireBoolean(frame.complete, "frame complete")
  });
}

function normalizeSamples(
  value: unknown,
  frameIndex: number,
  metricIds: ReadonlySet<string>
): Record<string, MetricSample> {
  const input = requireRecord(value, "Capture frame samples");
  const output: Record<string, MetricSample> = {};
  for (const key of Object.keys(input).sort()) {
    if (!METRIC_ID_PATTERN.test(key)) throw new TypeError(`Capture sample key '${key}' is invalid`);
    if (!metricIds.has(key)) throw new TypeError(`Capture sample '${key}' is missing from the metric catalog`);
    const raw = requireRecord(input[key], `Capture sample '${key}'`);
    const metricId = requireString(raw.metricId, "Capture sample metricId");
    if (metricId !== key) throw new TypeError(`Capture sample key '${key}' does not match metricId '${metricId}'`);
    const availability = requireAvailability(raw.availability);
    const rawValue = raw.value;
    let sampleValue: number | null;
    if (availability === "available") {
      sampleValue = requireFiniteNumber(rawValue, `Capture sample '${key}' value`);
    } else {
      if (rawValue !== null) throw new RangeError("Unavailable capture samples must use null values");
      sampleValue = null;
    }
    const sourceFrameIndex = requireNonNegativeInteger(raw.sourceFrameIndex, "sample sourceFrameIndex");
    if (sourceFrameIndex !== frameIndex) throw new RangeError("Capture sample sourceFrameIndex must match its frame");
    let resolvedAtFrameIndex: number | null = null;
    if (availability === "available") {
      resolvedAtFrameIndex = requireNonNegativeInteger(raw.resolvedAtFrameIndex, "sample resolvedAtFrameIndex");
      if (resolvedAtFrameIndex < sourceFrameIndex) {
        throw new RangeError("Capture sample cannot resolve before its source frame");
      }
    } else if (raw.resolvedAtFrameIndex !== null) {
      throw new RangeError("Unavailable capture samples must not have a resolved frame");
    }
    output[key] = Object.freeze({
      metricId,
      value: sampleValue,
      availability,
      sourceFrameIndex,
      resolvedAtFrameIndex,
      instrumented: requireBoolean(raw.instrumented, "sample instrumented")
    });
  }
  return output;
}

function normalizeSpans(value: unknown, frameIndex: number): ProfileSpan[] {
  if (!Array.isArray(value)) throw new TypeError("Capture frame spans are required");
  const ids = new Set<number>();
  const spans = value.map((candidate) => {
    const raw = requireRecord(candidate, "Capture span");
    const id = requireNonNegativeInteger(raw.id, "span id");
    if (ids.has(id)) throw new TypeError(`Duplicate capture span id '${id}'`);
    ids.add(id);
    const spanFrameIndex = requireNonNegativeInteger(raw.frameIndex, "span frameIndex");
    if (spanFrameIndex !== frameIndex) throw new RangeError("Capture span frameIndex must match its frame");
    const availability = requireAvailability(raw.availability);
    const duration = raw.duration === null
      ? null
      : requireNonNegativeFinite(raw.duration, "span duration");
    if (availability === "available" && duration === null) {
      throw new RangeError("Available capture spans require a duration");
    }
    if (availability !== "available" && duration !== null) {
      throw new RangeError("Unavailable capture spans must use a null duration");
    }
    const clockDomain = raw.clockDomain;
    if (clockDomain !== "cpu-main" && clockDomain !== "gpu-device") {
      throw new TypeError(`Unknown capture span clock domain '${String(clockDomain)}'`);
    }
    const parentId = raw.parentId === null
      ? null
      : requireNonNegativeInteger(raw.parentId, "span parentId");
    return Object.freeze({
      id,
      parentId,
      frameIndex,
      name: requireString(raw.name, "span name"),
      category: requireString(raw.category, "span category"),
      clockDomain,
      start: raw.start === null ? null : requireFiniteNumber(raw.start, "span start"),
      duration,
      availability,
      instrumented: requireBoolean(raw.instrumented, "span instrumented")
    });
  });
  for (const span of spans) {
    if (span.parentId !== null && (!ids.has(span.parentId) || span.parentId === span.id)) {
      throw new RangeError(`Capture span '${span.id}' has an invalid parent`);
    }
  }
  return spans.sort((left, right) => left.id - right.id || left.name.localeCompare(right.name));
}

function canonicalJsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const record = requireRecord(value, label);
  return deepFreeze(canonicalJsonObject(record, label, new Set<object>()));
}

function canonicalJsonObject(
  record: Record<string, unknown>,
  label: string,
  ancestors: Set<object>
): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain JSON objects`);
  }
  if (ancestors.has(record)) throw new TypeError(`${label} must not contain cycles`);
  ancestors.add(record);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    result[key] = canonicalJsonValue(record[key], `${label}.${key}`, ancestors);
  }
  ancestors.delete(record);
  return result;
}

function canonicalJsonValue(value: unknown, label: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return requireFiniteNumber(value, label);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`);
    ancestors.add(value);
    const result = value.map((child, index) => canonicalJsonValue(child, `${label}[${index}]`, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    return canonicalJsonObject(value as Record<string, unknown>, label, ancestors);
  }
  throw new TypeError(`${label} must contain only JSON values`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function requireNonNegativeFinite(value: unknown, label: string): number {
  const result = requireFiniteNumber(value, label);
  if (result < 0) throw new RangeError(`${label} must be non-negative`);
  return result;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new RangeError(`${label} must be a non-negative integer`);
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value as number;
}

function requireAvailability(value: unknown): MetricSampleAvailability {
  if (!AVAILABILITIES.includes(value as MetricSampleAvailability)) {
    throw new TypeError(`Unknown capture sample availability '${String(value)}'`);
  }
  return value as MetricSampleAvailability;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
