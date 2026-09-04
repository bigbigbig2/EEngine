import type { MetricDescriptor } from "./Metric.js";
import type { ProfileFrame } from "./ProfileFrame.js";

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

export function createPerformanceCapture(input: PerformanceCaptureInput): PerformanceCapture {
  validateSampling(input.sampling);
  validateFrames(input.frames);
  return cloneCapture({
    format: "oengine-performance-capture",
    schemaVersion: 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    engine: input.engine ?? {},
    environment: input.environment ?? {},
    sampling: input.sampling,
    metricCatalog: input.metricCatalog,
    frames: input.frames,
    diagnostics: input.diagnostics ?? {}
  });
}

export function serializePerformanceCapture(capture: PerformanceCapture): string {
  validateCapture(capture);
  return `${JSON.stringify(capture, null, 2)}\n`;
}

export function parsePerformanceCapture(serialized: string): PerformanceCapture {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new TypeError(`Invalid performance capture JSON: ${String(error)}`);
  }
  validateCapture(value);
  return cloneCapture(value);
}

function validateCapture(value: unknown): asserts value is PerformanceCapture {
  if (typeof value !== "object" || value === null) throw new TypeError("Capture must be an object");
  const capture = value as Record<string, unknown>;
  if (capture.format !== "oengine-performance-capture") throw new TypeError("Unsupported capture format");
  if (capture.schemaVersion !== 1) throw new RangeError(`Unsupported capture schema ${String(capture.schemaVersion)}`);
  if (typeof capture.createdAt !== "string") throw new TypeError("Capture createdAt is required");
  if (!Array.isArray(capture.metricCatalog) || !Array.isArray(capture.frames)) throw new TypeError("Capture catalog and frames are required");
  validateMetricCatalog(capture.metricCatalog);
  validateSampling(capture.sampling as PerformanceCapture["sampling"]);
  validateFrames(capture.frames as ProfileFrame[]);
}

function validateSampling(sampling: PerformanceCapture["sampling"]): void {
  if (!sampling || !["live", "record", "deep-capture"].includes(sampling.mode)) throw new TypeError("Invalid capture sampling mode");
  for (const name of ["warmupFrames", "timestampInterval", "counterInterval", "historyCapacity"] as const) {
    if (!Number.isInteger(sampling[name]) || sampling[name] <= 0) throw new RangeError(`Invalid sampling ${name}`);
  }
}

function validateFrames(frames: readonly ProfileFrame[]): void {
  let previous = -1;
  for (const frame of frames) {
    if (!Number.isInteger(frame.frameIndex) || frame.frameIndex <= previous) throw new RangeError("Capture frame indexes must be strictly increasing");
    previous = frame.frameIndex;
    for (const sample of Object.values(frame.samples)) {
      if (typeof sample.metricId !== "string" || !/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*$/.test(sample.metricId)) {
        throw new TypeError("Capture sample metric ID is invalid");
      }
      if (sample.value !== null && !Number.isFinite(sample.value)) throw new RangeError("Capture samples must be finite or null");
      if (sample.availability !== "available" && sample.value !== null) {
        throw new RangeError("Unavailable capture samples must use null values");
      }
      if (!["available", "pending", "unsupported", "invalid", "dropped"].includes(sample.availability)) {
        throw new TypeError(`Unknown capture sample availability '${String(sample.availability)}'`);
      }
    }
    for (const span of frame.spans) {
      if (span.start !== null && !Number.isFinite(span.start)) throw new RangeError("Capture span start must be finite or null");
      if (span.duration !== null && (!Number.isFinite(span.duration) || span.duration < 0)) throw new RangeError("Capture span duration is invalid");
    }
  }
}

function validateMetricCatalog(catalog: readonly MetricDescriptor[]): void {
  const ids = new Set<string>();
  for (const descriptor of catalog) {
    if (typeof descriptor !== "object" || descriptor === null || typeof descriptor.id !== "string") {
      throw new TypeError("Capture metric descriptor is invalid");
    }
    if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*$/.test(descriptor.id)) {
      throw new TypeError(`Capture metric ID '${descriptor.id}' is invalid`);
    }
    if (ids.has(descriptor.id)) throw new TypeError(`Duplicate capture metric ID '${descriptor.id}'`);
    ids.add(descriptor.id);
  }
}

function cloneCapture<T extends PerformanceCapture>(capture: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(capture)) as T);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
