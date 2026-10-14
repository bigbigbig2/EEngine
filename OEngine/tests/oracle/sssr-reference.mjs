// Independent scalar reference for the selected AMD FP32 reset-frame stages.
// SDK c6efa6bf7f2027b3ec94f28578bb5965eabb9e55, MIT (full notices in assets/sssr).
// Uses double precision, direct image neighborhoods and no GPU shared/remap code.
const to709 = (c) => [
  1.660490394 * c[0] - 0.587639093 * c[1] - 0.072851598 * c[2],
  -0.12454997 * c[0] + 1.13289988 * c[1] - 0.008347965 * c[2],
  -0.018151119 * c[0] - 0.100578725 * c[1] + 1.11872983 * c[2]
];
const to2020 = (c) => [
  0.627404 * c[0] + 0.329282 * c[1] + 0.0433136 * c[2],
  0.069097 * c[0] + 0.91954 * c[1] + 0.0113612 * c[2],
  0.0163916 * c[0] + 0.0880132 * c[1] + 0.895595 * c[2]
];
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map((v) => v * s);
const difference = (a, b) => a.map((v, i) => v - b[i]);
const length = (a) => Math.sqrt(dot(a, a));
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const luma = (rgb, p) => Math.max(dot(rgb, [0.299, 0.587, 0.114]) / p, 0.001);

const half = (word) => {
  const e = (word >>> 10) & 31,
    f = word & 1023;
  return (word & 32768 ? -1 : 1) * (e ? (1 + f / 1024) * 2 ** (e - 15) : f * 2 ** -24);
};
const receiver = (packet, pixel) => {
  const values = [];
  for (const word of packet.subarray(pixel * 8, pixel * 8 + 8))
    values.push(half(word & 65535), half(word >>> 16));
  return values;
};
const clip = (low, high, value, p) => {
  const center = scale(add(low, high), 0.5);
  const extent = high.map((v, i) => (v - low[i]) * 0.5 + 0.001 * p);
  const vector = difference(value, center);
  const unit = Math.max(...vector.map((v, i) => Math.abs(v / extent[i])));
  return unit > 1 ? add(center, scale(vector, 1 / unit)) : value;
};
const image = (values, width, height, channels) => (x, y) => {
  const offset = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * channels;
  return values.slice(offset, offset + channels);
};
const sampleAverage = (values, width, height, x, y) => {
  const load = image(values, width, height, 4);
  const tx = (x + 0.5) / 8 - 0.5,
    ty = (y + 0.5) / 8 - 0.5;
  const ix = Math.floor(tx),
    iy = Math.floor(ty),
    fx = tx - ix,
    fy = ty - iy;
  const c = Array(3).fill(0);
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const tap = load(ix + i, iy + j);
      for (let k = 0; k < 3; k++) c[k] += tap[k] * weight;
    }
  return to709(c);
};

/** Per-stage FP16 absolute allowance: at most four half ULPs at the stage's
 * signal scale plus the F32 source arithmetic allowance. Not an image threshold. */
export function compareSssrStage(actual, expected, name) {
  if (actual.length !== expected.length) throw new Error(`${name} shape mismatch`);
  let maxError = 0,
    maxRatio = 0;
  for (let i = 0; i < expected.length; i++) {
    const magnitude = Math.max(Math.abs(expected[i]), 2 ** -14);
    const ulp = 2 ** (Math.floor(Math.log2(magnitude)) - 10);
    const allowance = Math.max(2 ** -24, 4 * ulp) + 2 ** -20 * magnitude;
    const error = Math.abs(actual[i] - expected[i]);
    maxError = Math.max(maxError, error);
    maxRatio = Math.max(maxRatio, error / allowance);
    if (!Number.isFinite(actual[i]) || !Number.isFinite(expected[i]) || error > allowance)
      throw new Error(`${name}[${i}] actual=${actual[i]} expected=${expected[i]} allowance=${allowance}`);
  }
  return { name, maxError, maxRatio };
}

export function referenceSssrResetStages({
  width,
  height,
  packet,
  raw,
  average,
  prefilter,
  prefilterVariance,
  exposure,
  lobe,
  stability,
  capturedMoments
}) {
  const rawImage = image(raw, width, height, 4);
  const filtered = image(prefilter, width, height, 4);
  const tilesX = Math.ceil(width / 8),
    tilesY = Math.ceil(height / 8);
  const geometry = (x, y) => receiver(packet, clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1));
  const normal = (x, y) => {
    const n = geometry(x, y).slice(lobe * 4, lobe * 4 + 3);
    return scale(n, 1 / Math.max(length(n), 1e-10));
  };
  const eligible = (r) => ((r[15] | 0) & (2 << lobe)) !== 0 && r[lobe * 4 + 3] < 0.2;
  const expectedAverage = [];
  for (let ty = 0; ty < tilesY; ty++)
    for (let tx = 0; tx < tilesX; tx++) {
      let sum = [0, 0, 0],
        weights = 0;
      let active = false;
      for (let y = ty * 8; y < Math.min(height, ty * 8 + 8); y++)
        for (let x = tx * 8; x < Math.min(width, tx * 8 + 8); x++) {
          const rgb = to709(rawImage(x, y));
          active ||= eligible(geometry(x, y));
          const weight = Math.max(Math.exp(-luma(rgb, exposure) * 0.3), 0.01);
          sum = add(sum, scale(rgb, weight));
          weights += weight;
        }
      expectedAverage.push(...(active ? to2020(scale(sum, 1 / Math.max(weights, 0.001))) : [0, 0, 0]), 0);
    }
  const expectedPrefilter = [],
    expectedVariance = [],
    expectedResolve = [],
    expectedStatistics = [];
  const offsets = [
    [0, 1],
    [-2, 1],
    [2, -3],
    [-3, 0],
    [1, 2],
    [-1, -2],
    [3, 0],
    [-3, 3],
    [0, -3],
    [-1, -1],
    [2, 1],
    [-2, -2],
    [1, 0],
    [0, 2],
    [3, -1]
  ];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const r = geometry(x, y),
        rgb = to709(rawImage(x, y)),
        n = normal(x, y);
      const averageRgb = sampleAverage(average, tilesX, tilesY, x, y);
      let output = rgb,
        variance = eligible(r) ? 1 : 0;
      if (eligible(r) && r[lobe * 4 + 3] >= 0.0001) {
        const radianceWeight = (c) =>
          Math.max(Math.exp((-0.7 * length(difference(averageRgb, c))) / exposure), 0.01);
        let weightSum = radianceWeight(rgb),
          sum = scale(rgb, weightSum),
          varSum = weightSum * weightSum;
        for (const [dx, dy] of offsets) {
          const neighbor = to709(rawImage(x + dx, y + dy));
          const weight =
            Math.max(dot(n, normal(x + dx, y + dy)), 0) ** 512 *
            radianceWeight(neighbor) *
            Math.max(0.1, 1 - Math.exp(-4.4));
          sum = add(sum, scale(neighbor, weight));
          weightSum += weight;
          varSum += weight * weight * (eligible(geometry(x + dx, y + dy)) ? 1 : 0);
        }
        output = scale(sum, 1 / weightSum);
        variance = varSum / weightSum ** 2;
      }
      expectedPrefilter.push(...to2020(output), 0);
      expectedVariance.push(variance);
      const current = to709(filtered(x, y));
      const samples = eligible(r) ? 1 : 0;
      if (current.reduce((s, v) => s + v, 0) < 0.0001 * exposure) {
        expectedResolve.push(0, 0, 0, 0);
        expectedStatistics.push(0, samples);
        continue;
      }
      if (!eligible(r)) {
        expectedResolve.push(...to2020(current), 0);
        expectedStatistics.push(0, 0);
        continue;
      }
      let mean = [0, 0, 0],
        moment2 = [0, 0, 0],
        total = 0;
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const weight = Math.exp((-3 * (dx * dx + dy * dy)) / 25);
          const c = to709(filtered(x + dx, y + dy));
          mean = add(mean, scale(c, weight));
          moment2 = add(
            moment2,
            scale(
              c.map((v) => v * v),
              weight
            )
          );
          total += weight;
        }
      mean = scale(mean, 1 / total);
      let momentVariance = moment2.map((v, i) => Math.abs(v / total - mean[i] ** 2));
      let clippingAverage = averageRgb;
      if (capturedMoments) {
        const offset = (y * width + x) * 12;
        const observedMean = [...capturedMoments.subarray(offset, offset + 3)];
        const observedVariance = [...capturedMoments.subarray(offset + 4, offset + 7)];
        const observedAverage = [...capturedMoments.subarray(offset + 8, offset + 11)];
        // gamma96 covers 81 sequential F32 terms, weight/conversion/division and
        // moment subtraction. Relative error in a tiny variance is unbounded;
        // its ABSOLUTE bound follows the second moment, not the variance itself.
        const gamma = (96 * 2 ** -23) / (1 - 96 * 2 ** -23);
        for (let c = 0; c < 3; c++) {
          const scale = Math.max(Math.abs(mean[c]), Math.sqrt(moment2[c] / total), 0.001 * exposure);
          if (
            Math.abs(observedMean[c] - mean[c]) > 2 * gamma * scale ||
            Math.abs(observedVariance[c] - momentVariance[c]) > 4 * gamma * scale * scale
          ) {
            throw new Error(`independent FP32 moment bound at ${x},${y},${c}`);
          }
        }
        compareSssrStage(observedAverage, averageRgb, `bilinear tile average ${x},${y}`);
        mean = observedMean;
        momentVariance = observedVariance;
        clippingAverage = observedAverage;
      }
      const std = momentVariance.map(Math.sqrt);
      const deviation = std.map((v) => (v + length(difference(mean, clippingAverage))) * stability * 1.4);
      const center = mix(mean, clippingAverage, 0.2);
      const clippedOld = clip(difference(center, deviation), add(center, deviation), [0, 0, 0], exposure);
      const newSignal = clip(
        difference(clippingAverage, deviation),
        add(clippingAverage, deviation),
        mix(current, clippingAverage, 0.5),
        exposure
      );
      expectedResolve.push(...to2020(newSignal), 0);
      const a = luma(newSignal, exposure),
        b = luma(clippedOld, exposure);
      expectedStatistics.push((Math.abs(a - b) / Math.max(a, b, 0.5)) ** 2, 1);
    }
  return { expectedAverage, expectedPrefilter, expectedVariance, expectedResolve, expectedStatistics };
}
