import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeMetricValues,
  decodeMetricValues,
  MetricStripeEmitter
} from "../../tools/extreme-web-asset/metric-transport.mjs";
import {
  nativeSsim,
  nativeSsimBatch,
  metricRgbFrame,
  NativeSsimWindows
} from "../../tools/extreme-web-asset/metrics.mjs";

test("offline metric transport preserves every F32 bit in an offset stripe", () => {
  const backing = new Float32Array(7 * 5 * 28 + 2);
  const values = backing.subarray(1, backing.length - 1);
  for (let i = 0; i < values.length; i++) values[i] = Math.sin(i) * 1e6;
  values[0] = -0;
  values[1] = 1.401298464324817e-45;
  const decoded = decodeMetricValues({ width: 7, height: 5, valuesBase64: encodeMetricValues(values) });
  assert.deepEqual(
    new Uint8Array(decoded.buffer),
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
  );
});

test("metric transport rejects truncated, nonfinite and out-of-domain stripes", () => {
  const values = new Float32Array(28);
  const chunk = { width: 1, height: 1, valuesBase64: encodeMetricValues(values) };
  assert.throws(() => decodeMetricValues({ ...chunk, valuesBase64: chunk.valuesBase64.slice(4) }), /extent/);
  assert.throws(() => decodeMetricValues({ ...chunk, height: 33 }), /domain/);
  values[3] = NaN;
  assert.throws(
    () => decodeMetricValues({ ...chunk, valuesBase64: encodeMetricValues(values) }),
    /Nonfinite/
  );
});

test("metric transport batches complete original stripes in order and awaits host backpressure", async () => {
  const batches = [],
    result = [];
  const transport = new MetricStripeEmitter(
    async (chunks) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      batches.push(chunks.length);
      for (const chunk of chunks) result.push(chunk);
    },
    { maxBytes: 600, maxChunks: 3 }
  );
  const expected = [];
  for (let index = 0; index < 12; index++) {
    const values = new Float32Array(28).fill(index);
    const chunk = { index, width: 1, height: 1, valuesBase64: encodeMetricValues(values) };
    expected.push(chunk);
    await transport.add(chunk);
    assert.ok(transport.bytes <= transport.maxBytes);
    assert.ok(transport.chunks.length <= transport.maxChunks);
  }
  await transport.flush();
  assert.deepEqual(result, expected);
  assert.deepEqual(batches, [3, 3, 3, 3]);
  const failing = new MetricStripeEmitter(async () => {
    throw new Error("injected receiver failure");
  });
  await failing.add(expected[0]);
  await assert.rejects(failing.flush(), /receiver failure/);
  assert.throws(() => new MetricStripeEmitter(() => {}, { maxChunks: 17 }), /capacity/);
  await assert.rejects(new MetricStripeEmitter(() => {}, { maxBytes: 1 }).add(expected[0]), /capacity/);
});

test("metric batch retains an entire 2048-wide resident stripe without splitting SSIM windows", async () => {
  let received;
  const transport = new MetricStripeEmitter(async (chunks) => {
    received = chunks;
  });
  const values = new Float32Array(2048 * 32 * 28);
  const chunk = { width: 2048, height: 32, valuesBase64: encodeMetricValues(values) };
  assert.ok(chunk.valuesBase64.length > 8 * 1024 * 1024);
  await transport.add(chunk);
  await transport.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0], chunk);
  assert.deepEqual(decodeMetricValues(received[0]), values);
});

test("batched native SSIM preserves independent legacy windows and tiny edge extension", () => {
  const executable = process.env.EENGINE_FFMPEG ?? "ffmpeg";
  for (const [width, height] of [
    [32, 32],
    [7, 5]
  ]) {
    const frames = [],
      expected = [];
    for (const scale of [0, 0.01, 0.15]) {
      const reference = Float32Array.from({ length: width * height * 28 }, (_, i) => (Math.sin(i) + 1) / 2);
      const candidate = Float32Array.from(reference, (value) => Math.min(1, value + scale));
      expected.push(nativeSsim(executable, reference, candidate, width, height));
      frames.push(metricRgbFrame(reference, width, height), metricRgbFrame(candidate, width, height));
    }
    assert.deepEqual(nativeSsimBatch(executable, frames, width, height), expected);
  }
});

test("mixed-extent SSIM batches preserve every score and accumulation order within bounded storage", () => {
  const executable = process.env.EENGINE_FFMPEG ?? "ffmpeg";
  const expected = [],
    actual = [];
  let invocations = 0;
  const windows = new NativeSsimWindows(
    (frames, width, height) => {
      invocations++;
      return nativeSsimBatch(executable, frames, width, height);
    },
    (score, pixels) => actual.push({ score, pixels }),
    { maxBytes: 32 * 32 * 6 * 4, maxWindows: 8 }
  );
  for (let index = 0; index < 12; index++) {
    const [width, height] = index % 3 === 2 ? [7, 5] : [32, 32];
    const reference = Float32Array.from(
      { length: width * height * 28 },
      (_, i) => (Math.sin(i + index) + 1) / 2
    );
    const candidate = Float32Array.from(reference, (value) => Math.min(1, value + index / 100));
    expected.push({
      score: nativeSsim(executable, reference, candidate, width, height),
      pixels: width * height
    });
    windows.add(reference, candidate, width, height);
    assert.ok(windows.bytes <= windows.maxBytes);
    assert.ok(windows.windows.length <= windows.maxWindows);
  }
  windows.flush();
  assert.deepEqual(actual, expected);
  assert.ok(invocations < expected.length);
  assert.equal(windows.bytes, 0);
  assert.equal(windows.windows.length, 0);
  assert.throws(() => windows.add(new Float32Array(28), new Float32Array(28), 2, 1), /domain/);
  assert.throws(
    () =>
      new NativeSsimWindows(
        () => [],
        () => {},
        { maxWindows: 65 }
      ),
    /capacity/
  );
  const invalid = new NativeSsimWindows(
    () => [],
    () => {}
  );
  invalid.add(new Float32Array(28), new Float32Array(28), 1, 1);
  assert.throws(() => invalid.flush(), /independent window/);
});
