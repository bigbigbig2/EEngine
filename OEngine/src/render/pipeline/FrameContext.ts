import {
  preExposureContract,
  type PreExposureContract
} from "./FrameProducts.js";

/**
 * Immutable, per-frame inputs consumed by the main render recipe.
 *
 * GPU owners stay outside this value contract. Scene bindings are stable
 * references for the duration of one encode and cannot be replaced by a pass.
 */
export interface FrameResolutionDomains {
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
}

export interface FrameHistoryValidity {
  readonly formatRevision: number;
  readonly color: number;
  readonly gtao: number;
  readonly ssgi: number;
  readonly ssr: number;
  readonly nssFeedback: number;
  readonly exposure: number;
}

export interface FrameInstrumentation {
  readonly sampleGpuTimestamps: boolean;
  readonly sampleGpuCounters: boolean;
  readonly debugFrameIndex: number | null;
}

export interface FrameContextInit<
  TCamera,
  TView,
  TFeatureTopology,
  TSceneBindings,
  TCapture
> {
  readonly frameIndex: number;
  readonly timeDeltaSeconds: number;
  readonly camera: TCamera;
  readonly view: TView;
  readonly resolution: FrameResolutionDomains;
  readonly featureTopology: TFeatureTopology;
  readonly history: FrameHistoryValidity;
  readonly preExposure: PreExposureContract;
  readonly scene: TSceneBindings;
  readonly instrumentation: FrameInstrumentation;
  readonly capture: TCapture;
}

export type FrameContext<
  TCamera,
  TView,
  TFeatureTopology,
  TSceneBindings,
  TCapture
> = Readonly<FrameContextInit<TCamera, TView, TFeatureTopology, TSceneBindings, TCapture>>;

export function createFrameContext<
  TCamera,
  TView,
  TFeatureTopology,
  TSceneBindings,
  TCapture
>(
  init: FrameContextInit<TCamera, TView, TFeatureTopology, TSceneBindings, TCapture>
): FrameContext<TCamera, TView, TFeatureTopology, TSceneBindings, TCapture> {
  return Object.freeze({
    ...init,
    resolution: Object.freeze({ ...init.resolution }),
    history: Object.freeze({ ...init.history }),
    preExposure: preExposureContract(init.preExposure),
    instrumentation: Object.freeze({ ...init.instrumentation })
  });
}
