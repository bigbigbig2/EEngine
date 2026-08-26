/** Canonical topology key for reusable main-frame compiled graphs. */
export type FrameGraphKey = {
  readonly capabilityProfile: string;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly viewCount: number;
  readonly sampleCount: number;
  readonly enabledFeatureBits: number;
  readonly visibilityImplementation: string;
  readonly historyFormatRevision: number;
  readonly outputFormat: GPUTextureFormat;
  readonly instrumentationMode: string;
  readonly instrumentationRevision: number;
};

export function canonicalFrameGraphKey(key: FrameGraphKey): string {
  const integers = [
    key.internalWidth,
    key.internalHeight,
    key.outputWidth,
    key.outputHeight,
    key.viewCount,
    key.sampleCount,
    key.enabledFeatureBits,
    key.historyFormatRevision,
    key.instrumentationRevision
  ];
  for (const value of integers) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`FrameGraphKey contains invalid integer '${value}'`);
    }
  }
  return JSON.stringify([
    key.capabilityProfile,
    key.internalWidth,
    key.internalHeight,
    key.outputWidth,
    key.outputHeight,
    key.viewCount,
    key.sampleCount,
    key.enabledFeatureBits,
    key.visibilityImplementation,
    key.historyFormatRevision,
    key.outputFormat,
    key.instrumentationMode,
    key.instrumentationRevision
  ]);
}
