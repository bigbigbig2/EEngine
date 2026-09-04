export type MetricUnit =
  | "ms"
  | "bytes"
  | "count"
  | "ratio"
  | "pixels"
  | "triangles";

export type MetricSource =
  | "cpu-clock"
  | "gpu-timestamp"
  | "gpu-counter"
  | "engine-accounting"
  | "browser-observer";

export type MetricMeasurement = "measured" | "counted" | "derived" | "estimated";
export type MetricCost = "none" | "low" | "instrumented";
export type MetricScope = "frame" | "pass" | "resource-lifetime" | "capture";
export type MetricAggregation = "last" | "sum" | "max" | "min" | "mean" | "percentile";

export interface MetricDescriptor {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly unit: MetricUnit;
  readonly source: MetricSource;
  readonly measurement: MetricMeasurement;
  readonly cost: MetricCost;
  readonly scope: MetricScope;
  readonly aggregation: MetricAggregation;
  readonly description: string;
}

export type MetricSampleAvailability =
  | "available"
  | "pending"
  | "unsupported"
  | "invalid"
  | "dropped";

export interface MetricSample {
  readonly metricId: string;
  readonly value: number | null;
  readonly availability: MetricSampleAvailability;
  readonly sourceFrameIndex: number;
  readonly resolvedAtFrameIndex: number | null;
  readonly instrumented: boolean;
}

export function freezeMetricDescriptor(descriptor: MetricDescriptor): MetricDescriptor {
  return Object.freeze({ ...descriptor });
}

export function freezeMetricSample(sample: MetricSample): MetricSample {
  return Object.freeze({ ...sample });
}
