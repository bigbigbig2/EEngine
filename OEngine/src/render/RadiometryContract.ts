/** Neutral HDR radiometry contract shared by Surface, environment and temporal owners. */
export interface PreExposureContract {
  readonly multiplier: number;
  readonly generation: number;
  readonly colorSpace: "working-linear";
}

/** Renderer-owned radiometry state. GPU exposure adaptation may replace the
 * multiplier later, but all producers consume one immutable frame contract. */
export class RadiometryRuntime {
  private generationValue = 0;
  private multiplierValue = 1;
  private environmentGeneration: number | null = null;

  beginFrame(environmentGeneration: number | null): PreExposureContract {
    if (this.environmentGeneration !== environmentGeneration) {
      this.environmentGeneration = environmentGeneration;
      // Lighting changes are local temporal evidence, not a change to the
      // meaning of this multiplier. Keep the history rescale epoch stable.
    }
    return Object.freeze({
      multiplier: this.multiplierValue,
      generation: this.generationValue,
      colorSpace: "working-linear" as const
    });
  }

  setMultiplier(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new RangeError("Radiometry multiplier must be finite and positive");
    }
    if (multiplier !== this.multiplierValue) {
      this.multiplierValue = multiplier;
    }
  }

  invalidate(): void {
    this.environmentGeneration = null;
    this.generationValue++;
  }
}
