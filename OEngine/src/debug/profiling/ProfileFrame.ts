import type { MetricSample } from "./Metric.js";
import type { ProfileSpan } from "./ProfileSpan.js";

export interface ProfileFrame {
  readonly schemaVersion: number;
  readonly frameIndex: number;
  readonly epoch: number;
  readonly warmup: boolean;
  readonly visibilityState: DocumentVisibilityState | string;
  readonly samples: Readonly<Record<string, MetricSample>>;
  readonly spans: readonly ProfileSpan[];
  readonly gpuCounterSchemaVersion: number;
  readonly timestampInstrumented: boolean;
  readonly counterInstrumented: boolean;
  readonly complete: boolean;
}

export type ProfileFramePatch = Partial<Omit<ProfileFrame, "frameIndex">>;

export function cloneProfileFrame(frame: ProfileFrame): ProfileFrame {
  return Object.freeze({
    ...frame,
    samples: Object.freeze(Object.fromEntries(
      Object.entries(frame.samples).map(([id, sample]) => [id, Object.freeze({ ...sample })])
    )),
    spans: Object.freeze(frame.spans.map((span) => Object.freeze({ ...span })))
  });
}
