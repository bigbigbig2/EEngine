import type { FrameGraphKey } from "../../framegraph/FrameGraphKey.js";

/** All dimensions that may change the compiled main-graph topology. */
export interface MainRenderPipelineGraphKeyInput {
  readonly capability: string;
  readonly resolution: Readonly<{
    internalWidth: number;
    internalHeight: number;
    outputWidth: number;
    outputHeight: number;
  }>;
  readonly featureTopology: number;
  readonly visibilityConfiguration: string;
  readonly visibilityWorkCapacity: number;
  readonly instrumentation: string;
  readonly instrumentationRevision: number;
  readonly historyFormat: number;
  readonly outputFormat: GPUTextureFormat;
}

export function createMainRenderPipelineGraphKey(
  input: MainRenderPipelineGraphKeyInput
): FrameGraphKey {
  return {
    capabilityProfile: input.capability,
    internalWidth: input.resolution.internalWidth,
    internalHeight: input.resolution.internalHeight,
    outputWidth: input.resolution.outputWidth,
    outputHeight: input.resolution.outputHeight,
    viewCount: 1,
    sampleCount: 1,
    enabledFeatureBits: input.featureTopology,
    visibilityImplementation: input.visibilityConfiguration,
    visibilityWorkCapacity: input.visibilityWorkCapacity,
    historyFormatRevision: input.historyFormat,
    outputFormat: input.outputFormat,
    instrumentationMode: input.instrumentation,
    instrumentationRevision: input.instrumentationRevision
  };
}
