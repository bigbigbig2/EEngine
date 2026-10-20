import { spawnSync } from "node:child_process";

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function normal(values, at) {
  const x = values[at] * 2 - 1,
    y = values[at + 1] * 2 - 1;
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/** Geometry-specific diagnostics, not a replacement perceptual metric.
 * The material probes are evaluated by the unchanged engine GPU BRDF. */
export class ImageQualityMetrics {
  constructor(semantic) {
    this.semantic = semantic;
    this.max = [0, 0, 0, 0];
    this.materialError = 0;
    this.boundaryMax = 0;
    this.lengthMax = 0;
    this.angleHistogram = new Uint32Array(180001);
    this.angleMax = 0;
    this.pixels = 0;
    this.ssimSum = 0;
    this.ssimPixels = 0;
  }

  add(reference, candidate, chunk, ssim = null) {
    if (reference.length !== candidate.length || reference.length !== chunk.width * chunk.height * 28) {
      throw new Error("GPU metric backing/domain mismatch");
    }
    if (ssim !== null && (!Number.isFinite(ssim) || ssim < -1 || ssim > 1))
      throw new Error("Invalid native SSIM result");
    for (let at = 0; at < reference.length; at += 28) {
      for (let channel = 0; channel < 4; channel++) {
        const delta = Math.abs(reference[at + channel] - candidate[at + channel]);
        this.max[channel] = Math.max(this.max[channel], delta);
        // All source texels and all gutter texels participate, not just a
        // single one-pixel boundary that could hide cell-side artifacts.
        this.boundaryMax = Math.max(this.boundaryMax, delta);
      }
      for (let probe = 1; probe < 7; probe++) {
        for (let channel = 0; channel < 3; channel++) {
          this.materialError = Math.max(
            this.materialError,
            Math.abs(reference[at + probe * 4 + channel] - candidate[at + probe * 4 + channel])
          );
        }
      }
      if (this.semantic === "normal-xy") {
        const a = normal(reference, at),
          b = normal(candidate, at);
        const angle = (Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) * 180) / Math.PI;
        this.angleHistogram[Math.min(180000, Math.round(angle * 1000))]++;
        this.angleMax = Math.max(this.angleMax, angle);
      }
      if (this.semantic === "moment-xyz") {
        const length = (data) => Math.hypot(data[at] * 2 - 1, data[at + 1] * 2 - 1, data[at + 2] * 2 - 1);
        this.lengthMax = Math.max(this.lengthMax, Math.abs(length(reference) - length(candidate)));
      }
    }
    const pixels = reference.length / 28;
    this.pixels += pixels;
    if (ssim !== null) {
      this.ssimSum += ssim * pixels;
      this.ssimPixels += pixels;
    }
  }

  vector() {
    if (!this.pixels) throw new Error("No actual GPU output was evaluated");
    const common = { materialError: this.materialError, boundaryMax: this.boundaryMax };
    if (this.semantic.startsWith("color-")) {
      if (!this.ssimPixels) throw new Error("Color evaluation requires the native perceptual metric");
      return { ...common, perceptual: this.ssimSum / this.ssimPixels, alphaMax: this.max[3] };
    }
    if (this.semantic === "normal-xy") {
      const quantile = (q) => {
        let total = 0;
        for (let index = 0; index < this.angleHistogram.length; index++) {
          total += this.angleHistogram[index];
          if (total >= Math.ceil(this.pixels * q)) return index / 1000;
        }
        throw new Error("Normal histogram lost its complete pixel domain");
      };
      return {
        ...common,
        angleP50: quantile(0.5),
        angleP95: quantile(0.95),
        angleP99: quantile(0.99),
        angleMax: this.angleMax
      };
    }
    if (this.semantic === "moment-xyz")
      return { ...common, xyzMax: Math.max(...this.max.slice(0, 3)), lengthMax: this.lengthMax };
    return { ...common, channelR: this.max[0], channelG: this.max[1], channelB: this.max[2] };
  }

  addPerceptual(ssim, pixels) {
    if (!Number.isFinite(ssim) || ssim < -1 || ssim > 1 || !Number.isSafeInteger(pixels) || pixels < 1) {
      throw new Error("Invalid native SSIM window receipt");
    }
    this.ssimSum += ssim * pixels;
    this.ssimPixels += pixels;
  }
}

export function metricRgbFrame(input, width, height) {
  const w = Math.max(8, width), h = Math.max(8, height);
  const bytes = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 28;
      for (let channel = 0; channel < 3; channel++) {
        const linear = input[at + channel];
        const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
        bytes[(y * w + x) * 3 + channel] = Math.round(clamp(encoded, 0, 1) * 255);
      }
    }
  }
  return bytes;
}

/** Each pair remains one independent SSIM frame/window. This only amortizes
 * process startup; framesync pairs even reference and odd candidate frames. */
export function nativeSsimBatch(executable, frames, width, height) {
  const frameBytes = Math.max(8, width) * Math.max(8, height) * 3;
  if (!frames.length || frames.length % 2 || frames.some((frame) => frame.length !== frameBytes)) {
    throw new Error("Invalid native SSIM batch extent");
  }
  const count = frames.length / 2;
  const run = spawnSync(executable, [
    "-hide_banner", "-f", "rawvideo", "-pixel_format", "rgb24",
    "-video_size", `${Math.max(8, width)}x${Math.max(8, height)}`, "-i", "pipe:0",
    "-filter_complex",
    "[0:v]split[a][b];[a]select=not(mod(n\\,2)),setpts=N,format=gbrp[r];[b]select=mod(n\\,2),setpts=N,format=gbrp[c];[r][c]ssim=stats_file=-",
    "-frames:v", String(count), "-f", "null", "-"
  ], { input: Buffer.concat(frames), encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`Native SSIM batch failed: ${run.error?.message ?? run.stderr}`);
  const scores = [...run.stdout.matchAll(/All:([\d.+-e]+)/g)].map((match) => Number(match[1]));
  if (scores.length !== count || scores.some((score) => !Number.isFinite(score))) {
    throw new Error("Native SSIM batch lost a complete metric window");
  }
  return scores;
}

/** Actual FFmpeg libavfilter SSIM, not a local SSIM approximation. Each fixed
 * 32-row GPU stripe is a metric window; tiny windows replicate edge pixels to
 * 8x8 so the native 8x8 SSIM kernel is defined. Original pixels retain weights. */
export function nativeSsim(executable, reference, candidate, width, height) {
  const w = Math.max(8, width),
    h = Math.max(8, height);
  const run = spawnSync(
    executable,
    [
      "-hide_banner",
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgb24",
      "-video_size",
      `${w}x${h}`,
      "-i",
      "pipe:0",
      "-filter_complex",
      "[0:v]split[a][b];[a]select=eq(n\\,0),setpts=PTS-STARTPTS,format=gbrp[r];[b]select=eq(n\\,1),setpts=PTS-STARTPTS,format=gbrp[c];[r][c]ssim",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-"
    ],
    {
      input: Buffer.concat([metricRgbFrame(reference, width, height), metricRgbFrame(candidate, width, height)]),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    }
  );
  if (run.status !== 0)
    throw new Error(`Native perceptual metric failed: ${run.error?.message ?? run.stderr}`);
  const match = /All:([\d.+-e]+)/.exec(run.stderr);
  if (!match || !Number.isFinite(Number(match[1])))
    throw new Error("Native SSIM did not return a finite metric");
  return Number(match[1]);
}
