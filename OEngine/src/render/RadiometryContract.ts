/** Neutral HDR radiometry contract shared by Surface, environment and temporal owners. */
export interface PreExposureContract {
  readonly multiplier: number;
  readonly generation: number;
  readonly colorSpace: "working-linear";
}

/** CPU temporal epoch marker. Physical P/E values live in GPU radiometry buffers. */
export class RadiometryRuntime {
  private generationValue = 0;
  private environmentGeneration: number | null = null;

  beginFrame(environmentGeneration: number | null): PreExposureContract {
    if (this.environmentGeneration !== environmentGeneration) {
      this.environmentGeneration = environmentGeneration;
      // Lighting changes are local temporal evidence, not a change to the
      // meaning of this multiplier. Keep the history rescale epoch stable.
    }
    return Object.freeze({
      multiplier: 1,
      generation: this.generationValue,
      colorSpace: "working-linear" as const,
    });
  }

  invalidate(): void {
    this.environmentGeneration = null;
    this.generationValue++;
  }
}
