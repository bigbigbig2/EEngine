import type { MetricSampleAvailability } from "./Metric.js";

export type ProfileClockDomain = "cpu-main" | "gpu-device";

export interface ProfileSpan {
  readonly id: number;
  readonly parentId: number | null;
  readonly frameIndex: number;
  readonly name: string;
  readonly category: string;
  readonly clockDomain: ProfileClockDomain;
  readonly start: number | null;
  readonly duration: number | null;
  readonly availability: MetricSampleAvailability;
  readonly instrumented: boolean;
}
