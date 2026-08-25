/**
 * DynamicResolutionScaling：负责渲染管线编排、视图状态或渲染目标管理。
 */

export class DynamicResolutionScaling {
  enabled = true;

  get_scale: () => number = null!;

  set_scale: (v: number) => void = null!;

  target_frame_time_s = 1 / 30;

  set target_frame_rate(v: number) {
    this.target_frame_time_s = 1 / v;
  }

  get target_frame_rate(): number {
    return 1 / this.target_frame_time_s;
  }

  min_scale = 0.65;
  max_scale = 1;
  tolerance = 0.1;
  probe_step = 0.05;
  min_useful_slope = 0.005;
  settle_frames = 30;
  bail_lockout_frames = 600;
  anomaly_clamp_multiplier = 6;
  fast_half_life_frames = 8;
  slow_half_life_frames = 120;
  warmup_frames = 30;

  #fastMean = 0;
  #slowMean = 0;
  #frameIndex = 0;
  #prevScale = 0;
  #prevFastMean = 0;
  #hasPair = false;
  #settleCount = 0;
  #lockout = 0;

  get #alphaFast(): number {
    return 1 - Math.pow(0.5, 1 / this.fast_half_life_frames);
  }

  get #alphaSlow(): number {
    return 1 - Math.pow(0.5, 1 / this.slow_half_life_frames);
  }

  reset(): void {
    this.#fastMean = 0;
    this.#slowMean = 0;
    this.#frameIndex = 0;
    this.#hasPair = false;
    this.#settleCount = 0;
    this.#lockout = 0;
  }

  get fast_mean_frame_time_s(): number {
    return this.#fastMean;
  }

  get slow_mean_frame_time_s(): number {
    return this.#slowMean;
  }

  notify_frame(frame_time_s: number): void {
    if (!this.enabled) return;

    this.#frameIndex++;
    if (this.#frameIndex === 1) {
      this.#fastMean = frame_time_s;
      this.#slowMean = frame_time_s;
      return;
    }

    if (this.#frameIndex <= this.warmup_frames) {
      this.#fastMean += this.#alphaFast * (frame_time_s - this.#fastMean);
      this.#slowMean += this.#alphaSlow * (frame_time_s - this.#slowMean);
      return;
    }

    const clampT = this.#slowMean * this.anomaly_clamp_multiplier;
    const anomaly = frame_time_s > clampT;
    this.#slowMean += this.#alphaSlow * ((anomaly ? clampT : frame_time_s) - this.#slowMean);

    if (anomaly) return;

    this.#fastMean += this.#alphaFast * (frame_time_s - this.#fastMean);

    if (this.#lockout > 0) {
      this.#lockout--;
      return;
    }

    this.#settleCount++;
    if (this.#settleCount >= this.settle_frames) {
      this.#decide();
    }
  }

  #decide(): void {
    const fast = this.#fastMean;
    const target = this.target_frame_time_s;
    const err = fast - target;
    const scale = this.get_scale();

    if (Math.abs(err) <= target * this.tolerance) {
      this.#prevScale = scale;
      this.#prevFastMean = fast;
      this.#hasPair = true;
      return;
    }

    if (this.#hasPair && this.#prevScale !== scale) {
      const slope = (fast - this.#prevFastMean) / (scale - this.#prevScale);
      if (slope >= this.min_useful_slope) {
        const next = this.#clamp(scale - err / slope);
        if (next !== scale) {
          this.#prevScale = scale;
          this.#prevFastMean = fast;
          this.#apply(next);
          return;
        }
        this.#lockBoundary(scale, fast);
        return;
      }
      if (err > 0) {
        const bail = this.#clamp(this.#prevScale);
        this.#hasPair = false;
        this.#lockout = this.bail_lockout_frames;
        if (bail !== scale) {
          this.#apply(bail);
        } else {
          this.#settleCount = 0;
        }
        return;
      }
    }

    const next = this.#clamp(scale + (err > 0 ? -1 : 1) * this.probe_step);
    if (next !== scale) {
      this.#prevScale = scale;
      this.#prevFastMean = fast;
      this.#hasPair = true;
      this.#apply(next);
    } else {
      this.#lockBoundary(scale, fast);
    }
  }

  #lockBoundary(scale: number, fast: number): void {
    this.#prevScale = scale;
    this.#prevFastMean = fast;
    this.#hasPair = true;
    this.#lockout = this.bail_lockout_frames;
    this.#settleCount = 0;
  }

  #clamp(v: number): number {
    return Math.max(this.min_scale, Math.min(this.max_scale, v));
  }

  #apply(v: number): void {
    this.set_scale(v);
    this.#settleCount = 0;
  }
}
