import assert from "node:assert/strict";
import test from "node:test";
import { encodeMetricValues, decodeMetricValues } from "../../tools/extreme-web-asset/metric-transport.mjs";
import { nativeSsim, nativeSsimBatch, metricRgbFrame } from "../../tools/extreme-web-asset/metrics.mjs";

test("offline metric transport preserves every F32 bit in an offset stripe", () => {
  const backing = new Float32Array(7 * 5 * 28 + 2);
  const values = backing.subarray(1, backing.length - 1);
  for (let i = 0; i < values.length; i++) values[i] = Math.sin(i) * 1e6;
  values[0] = -0;
  values[1] = 1.401298464324817e-45;
  const decoded = decodeMetricValues({ width: 7, height: 5, valuesBase64: encodeMetricValues(values) });
  assert.deepEqual(new Uint8Array(decoded.buffer), new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
});

test("metric transport rejects truncated, nonfinite and out-of-domain stripes", () => {
  const values = new Float32Array(28);
  const chunk = { width: 1, height: 1, valuesBase64: encodeMetricValues(values) };
  assert.throws(() => decodeMetricValues({ ...chunk, valuesBase64: chunk.valuesBase64.slice(4) }), /extent/);
  assert.throws(() => decodeMetricValues({ ...chunk, height: 33 }), /domain/);
  values[3] = NaN;
  assert.throws(() => decodeMetricValues({ ...chunk, valuesBase64: encodeMetricValues(values) }), /Nonfinite/);
});

test("batched native SSIM preserves independent legacy windows and tiny edge extension", () => {
  const executable = process.env.EENGINE_FFMPEG ?? "ffmpeg";
  for (const [width, height] of [[32, 32], [7, 5]]) {
    const frames = [], expected = [];
    for (const scale of [0, 0.01, 0.15]) {
      const reference = Float32Array.from({ length: width * height * 28 }, (_, i) => (Math.sin(i) + 1) / 2);
      const candidate = Float32Array.from(reference, (value) => Math.min(1, value + scale));
      expected.push(nativeSsim(executable, reference, candidate, width, height));
      frames.push(metricRgbFrame(reference, width, height), metricRgbFrame(candidate, width, height));
    }
    assert.deepEqual(nativeSsimBatch(executable, frames, width, height), expected);
  }
});
