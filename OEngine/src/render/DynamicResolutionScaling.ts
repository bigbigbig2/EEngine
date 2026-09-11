/** Stateful delayed-GPU-timing controller owned by TemporalFeature. */
export const DYNAMIC_RESOLUTION_SCALE_BUCKETS = Object.freeze([
  0.67, 0.75, 0.8, 0.9, 1
] as const);

export type DynamicResolutionMode = "fixed" | "adaptive";

export interface DynamicResolutionScalingConfiguration {
  readonly mode: DynamicResolutionMode;
  readonly targetFrameRate: number;
  readonly minimumScale: number;
  readonly maximumScale: number;
  readonly tolerance: number;
  readonly settleFrames: number;
  readonly scaleBuckets?: readonly number[];
}

export type DynamicResolutionDecision =
  | "fixed"
  | "waiting-for-gpu"
  | "warmup"
  | "within-budget"
  | "scale-up"
  | "scale-down"
  | "boundary-lock"
  | "ineffective-probe";

export interface DynamicResolutionScalingEvidence {
  readonly mode: DynamicResolutionMode;
  readonly targetFrameRate: number;
  readonly targetFrameTimeMs: number;
  readonly minimumScale: number;
  readonly maximumScale: number;
  readonly scaleBuckets: readonly number[];
  readonly currentScale: number;
  readonly fastMeanGpuMs: number;
  readonly slowMeanGpuMs: number;
  readonly acceptedGpuSamples: number;
  readonly scaleChanges: number;
  readonly lastDecision: DynamicResolutionDecision;
  readonly lastGpuFrameTimeMs: number;
  readonly lastFeedbackLatencyFrames: number;
}

/**
 * Only completed timestamp samples enter this controller. RenderSettings owns
 * its policy, so fixed benchmark mode cannot accidentally react to timing.
 */
export class DynamicResolutionScaling {
  get_scale: () => number = null!;
  set_scale: (value: number) => void = null!;

  private modeValue: DynamicResolutionMode = "fixed";
  private targetFrameTimeSeconds = 1 / 60;
  private minimumScaleValue = 0.67;
  private maximumScaleValue = 1;
  private toleranceValue = 0.1;
  private settleFramesValue = 30;
  private scaleBucketsValue: readonly number[] = DYNAMIC_RESOLUTION_SCALE_BUCKETS;
  private readonly probeStep = 0.05;
  private readonly minimumUsefulSlope = 0.005;
  private readonly boundaryLockoutFrames = 600;
  private readonly anomalyClampMultiplier = 6;
  private readonly fastHalfLifeFrames = 8;
  private readonly slowHalfLifeFrames = 120;
  private readonly warmupFrames = 30;

  #fastMean = 0;
  #slowMean = 0;
  #sampleCount = 0;
  #previousScale = 0;
  #previousFastMean = 0;
  #hasProbePair = false;
  #settleCount = 0;
  #lockout = 0;
  #lastGpuSampleFrame = -1;
  #lastFeedbackLatencyFrames = 0;
  #lastGpuFrameTimeMs = 0;
  #pendingGpuSampleFrame = -1;
  #pendingGpuFrameTimeMs = 0;
  #acceptedGpuSamples = 0;
  #scaleChanges = 0;
  #lastDecision: DynamicResolutionDecision = "fixed";

  configure(configuration: DynamicResolutionScalingConfiguration): void {
    validateConfiguration(configuration);
    const buckets = normalizeBuckets(
      configuration.scaleBuckets ?? DYNAMIC_RESOLUTION_SCALE_BUCKETS,
      configuration.minimumScale,
      configuration.maximumScale
    );
    const policyChanged =
      this.targetFrameTimeSeconds !== 1 / configuration.targetFrameRate ||
      this.minimumScaleValue !== configuration.minimumScale ||
      this.maximumScaleValue !== configuration.maximumScale ||
      this.toleranceValue !== configuration.tolerance ||
      this.settleFramesValue !== configuration.settleFrames ||
      !sameNumbers(this.scaleBucketsValue, buckets);
    const modeChanged = this.modeValue !== configuration.mode;
    this.modeValue = configuration.mode;
    this.targetFrameTimeSeconds = 1 / configuration.targetFrameRate;
    this.minimumScaleValue = configuration.minimumScale;
    this.maximumScaleValue = configuration.maximumScale;
    this.toleranceValue = configuration.tolerance;
    this.settleFramesValue = configuration.settleFrames;
    this.scaleBucketsValue = buckets;
    if (modeChanged || policyChanged) {
      this.resetControlWindow();
      this.#lastDecision = this.adaptive ? "waiting-for-gpu" : "fixed";
    }
  }

  get mode(): DynamicResolutionMode { return this.modeValue; }
  get adaptive(): boolean { return this.modeValue === "adaptive"; }

  reset(): void {
    this.resetControlWindow();
    this.#acceptedGpuSamples = 0;
    this.#scaleChanges = 0;
    this.#lastGpuFrameTimeMs = 0;
    this.#lastFeedbackLatencyFrames = 0;
    this.#lastDecision = this.adaptive ? "waiting-for-gpu" : "fixed";
  }

  evidence(): DynamicResolutionScalingEvidence {
    const currentScale = typeof this.get_scale === "function"
      ? this.get_scale()
      : this.maximumScaleValue;
    return Object.freeze({
      mode: this.modeValue,
      targetFrameRate: 1 / this.targetFrameTimeSeconds,
      targetFrameTimeMs: this.targetFrameTimeSeconds * 1000,
      minimumScale: this.minimumScaleValue,
      maximumScale: this.maximumScaleValue,
      scaleBuckets: this.scaleBucketsValue,
      currentScale,
      fastMeanGpuMs: this.#fastMean * 1000,
      slowMeanGpuMs: this.#slowMean * 1000,
      acceptedGpuSamples: this.#acceptedGpuSamples,
      scaleChanges: this.#scaleChanges,
      lastDecision: this.#lastDecision,
      lastGpuFrameTimeMs: this.#lastGpuFrameTimeMs,
      lastFeedbackLatencyFrames: this.#lastFeedbackLatencyFrames
    });
  }

  notify_gpu_timing(sample: {
    readonly sampleFrameIndex: number;
    readonly currentFrameIndex: number;
    readonly gpuFrameTimeMs: number;
  }): boolean {
    if (!this.adaptive) return false;
    if (!Number.isInteger(sample.sampleFrameIndex) || sample.sampleFrameIndex < 0 ||
        !Number.isInteger(sample.currentFrameIndex) ||
        sample.sampleFrameIndex <= this.#lastGpuSampleFrame ||
        !Number.isFinite(sample.gpuFrameTimeMs) || sample.gpuFrameTimeMs <= 0) return false;
    if (sample.currentFrameIndex <= sample.sampleFrameIndex) {
      if (sample.sampleFrameIndex >= this.#pendingGpuSampleFrame) {
        this.#pendingGpuSampleFrame = sample.sampleFrameIndex;
        this.#pendingGpuFrameTimeMs = sample.gpuFrameTimeMs;
      }
      return false;
    }
    if (this.#pendingGpuSampleFrame === sample.sampleFrameIndex) {
      this.#pendingGpuSampleFrame = -1;
      this.#pendingGpuFrameTimeMs = 0;
    }
    return this.#consumeGpuTiming(
      sample.sampleFrameIndex, sample.currentFrameIndex, sample.gpuFrameTimeMs
    );
  }

  consume_delayed_gpu_timing(currentFrameIndex: number): boolean {
    if (!this.adaptive || !Number.isInteger(currentFrameIndex) || currentFrameIndex < 0 ||
        this.#pendingGpuSampleFrame < 0 || currentFrameIndex <= this.#pendingGpuSampleFrame) return false;
    const sampleFrameIndex = this.#pendingGpuSampleFrame;
    const gpuFrameTimeMs = this.#pendingGpuFrameTimeMs;
    this.#pendingGpuSampleFrame = -1;
    this.#pendingGpuFrameTimeMs = 0;
    return this.#consumeGpuTiming(sampleFrameIndex, currentFrameIndex, gpuFrameTimeMs);
  }

  private notifyFrame(frameTimeSeconds: number): void {
    if (!this.adaptive || !Number.isFinite(frameTimeSeconds) || frameTimeSeconds <= 0) return;
    this.#sampleCount++;
    if (this.#sampleCount === 1) {
      this.#fastMean = frameTimeSeconds;
      this.#slowMean = frameTimeSeconds;
      this.#lastDecision = "warmup";
      return;
    }
    if (this.#sampleCount <= this.warmupFrames) {
      this.#fastMean += this.#alphaFast * (frameTimeSeconds - this.#fastMean);
      this.#slowMean += this.#alphaSlow * (frameTimeSeconds - this.#slowMean);
      this.#lastDecision = "warmup";
      return;
    }
    const clampTime = this.#slowMean * this.anomalyClampMultiplier;
    const anomaly = frameTimeSeconds > clampTime;
    this.#slowMean += this.#alphaSlow * ((anomaly ? clampTime : frameTimeSeconds) - this.#slowMean);
    if (anomaly) return;
    this.#fastMean += this.#alphaFast * (frameTimeSeconds - this.#fastMean);
    if (this.#lockout > 0) { this.#lockout--; return; }
    this.#settleCount++;
    if (this.#settleCount >= this.settleFramesValue) this.#decide();
  }

  get #alphaFast(): number { return 1 - Math.pow(0.5, 1 / this.fastHalfLifeFrames); }
  get #alphaSlow(): number { return 1 - Math.pow(0.5, 1 / this.slowHalfLifeFrames); }

  #decide(): void {
    const fast = this.#fastMean;
    const error = fast - this.targetFrameTimeSeconds;
    const scale = this.get_scale();
    if (Math.abs(error) <= this.targetFrameTimeSeconds * this.toleranceValue) {
      this.#previousScale = scale;
      this.#previousFastMean = fast;
      this.#hasProbePair = true;
      this.#settleCount = 0;
      this.#lastDecision = "within-budget";
      return;
    }
    if (this.#hasProbePair && this.#previousScale !== scale) {
      const slope = (fast - this.#previousFastMean) / (scale - this.#previousScale);
      if (slope >= this.minimumUsefulSlope) {
        const next = this.#clamp(scale - error / slope);
        if (next !== scale) {
          this.#previousScale = scale;
          this.#previousFastMean = fast;
          this.#apply(next, next < scale ? "scale-down" : "scale-up");
          return;
        }
        this.#lockBoundary(scale, fast);
        return;
      }
      if (error > 0) {
        const bailout = this.#clamp(this.#previousScale);
        this.#hasProbePair = false;
        this.#lockout = this.boundaryLockoutFrames;
        this.#lastDecision = "ineffective-probe";
        if (bailout !== scale) this.#apply(bailout, "scale-down");
        else this.#settleCount = 0;
        return;
      }
    }
    const next = this.#clamp(scale + (error > 0 ? -1 : 1) * this.probeStep);
    if (next !== scale) {
      this.#previousScale = scale;
      this.#previousFastMean = fast;
      this.#hasProbePair = true;
      this.#apply(next, next < scale ? "scale-down" : "scale-up");
    } else this.#lockBoundary(scale, fast);
  }

  #lockBoundary(scale: number, fast: number): void {
    this.#previousScale = scale;
    this.#previousFastMean = fast;
    this.#hasProbePair = true;
    this.#lockout = this.boundaryLockoutFrames;
    this.#settleCount = 0;
    this.#lastDecision = "boundary-lock";
  }

  #clamp(value: number): number {
    const clamped = Math.max(this.minimumScaleValue, Math.min(this.maximumScaleValue, value));
    return this.scaleBucketsValue.reduce((closest, bucket) =>
      Math.abs(bucket - clamped) < Math.abs(closest - clamped) ? bucket : closest
    );
  }

  #apply(value: number, decision: "scale-up" | "scale-down"): void {
    this.set_scale(value);
    this.#scaleChanges++;
    this.#settleCount = 0;
    this.#lastDecision = decision;
  }

  #consumeGpuTiming(sampleFrameIndex: number, currentFrameIndex: number, gpuFrameTimeMs: number): boolean {
    if (sampleFrameIndex <= this.#lastGpuSampleFrame) return false;
    this.#lastGpuSampleFrame = sampleFrameIndex;
    this.#lastFeedbackLatencyFrames = currentFrameIndex - sampleFrameIndex;
    this.#lastGpuFrameTimeMs = gpuFrameTimeMs;
    this.#acceptedGpuSamples++;
    this.notifyFrame(gpuFrameTimeMs / 1000);
    return true;
  }

  private resetControlWindow(): void {
    this.#fastMean = 0;
    this.#slowMean = 0;
    this.#sampleCount = 0;
    this.#hasProbePair = false;
    this.#settleCount = 0;
    this.#lockout = 0;
    this.#lastGpuSampleFrame = -1;
    this.#pendingGpuSampleFrame = -1;
    this.#pendingGpuFrameTimeMs = 0;
  }
}

function validateConfiguration(configuration: DynamicResolutionScalingConfiguration): void {
  if (configuration.mode !== "fixed" && configuration.mode !== "adaptive") {
    throw new RangeError("dynamic resolution mode must be fixed or adaptive");
  }
  if (!Number.isFinite(configuration.targetFrameRate) || configuration.targetFrameRate <= 0) {
    throw new RangeError("dynamic resolution targetFrameRate must be finite and positive");
  }
  if (!Number.isFinite(configuration.minimumScale) || !Number.isFinite(configuration.maximumScale) ||
      configuration.minimumScale <= 0 || configuration.maximumScale > 1 ||
      configuration.minimumScale > configuration.maximumScale) {
    throw new RangeError("dynamic resolution scale range must satisfy 0 < minimum <= maximum <= 1");
  }
  if (!Number.isFinite(configuration.tolerance) || configuration.tolerance < 0 ||
      configuration.tolerance > 0.5) {
    throw new RangeError("dynamic resolution tolerance must be in [0, 0.5]");
  }
  if (!Number.isSafeInteger(configuration.settleFrames) || configuration.settleFrames < 1) {
    throw new RangeError("dynamic resolution settleFrames must be a positive integer");
  }
}

function normalizeBuckets(input: readonly number[], minimumScale: number, maximumScale: number): readonly number[] {
  const buckets = [...new Set(input)]
    .filter((value) => Number.isFinite(value) && value >= minimumScale && value <= maximumScale)
    .sort((a, b) => a - b);
  if (buckets.length === 0) {
    throw new RangeError("dynamic resolution policy has no scale bucket inside its range");
  }
  return Object.freeze(buckets);
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
