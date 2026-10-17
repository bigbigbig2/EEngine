import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { scgiGatherPrediction, planScgiGather } from "../../.test-dist/render/gi/ScgiGatherLayout.js";
import { planFinalPixelLightingDirectory } from "../../.test-dist/gpu/FinalPixelAbi.js";

const y0 = 1 / Math.sqrt(4 * Math.PI);
const y1 = Math.sqrt(3 / (4 * Math.PI));
const limits = {
  maxBufferSize: 256 * 1024 ** 2,
  maxStorageBufferBindingSize: 128 * 1024 ** 2,
  minStorageBufferOffsetAlignment: 256,
};

test("analytic hemisphere Gram inverse preserves a constant for arbitrary normals and HDR", () => {
  for (const n of [
    [0, 0, 1],
    [1, 0, 0],
    [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
  ]) {
    for (const radiance of [0, 0.01, 10, 1e8]) {
      const c = [0, 1, 2, 3].flatMap((term) =>
        [1, 0.5, 0.2].map((color) => {
          const moment = term === 0 ? 2 * Math.PI * y0 : Math.PI * y1 * n[term - 1];
          return radiance * color * moment * (term === 0 ? Math.PI : (2 * Math.PI) / 3);
        }),
      );
      for (const d of [n, [0.3, 0.4, Math.sqrt(0.75)], [-0.6, 0, 0.8]]) {
        const value = scgiGatherPrediction(c, n, d);
        for (let channel = 0; channel < 3; channel++) {
          assert.ok(
            Math.abs(value[channel] - radiance * [1, 0.5, 0.2][channel]) < Math.max(1e-12, radiance * 1e-13),
          );
        }
      }
    }
  }
});

test("probe query scratch stays batch bounded and residual directory admits full/stripe/remap", () => {
  const small = planScgiGather(limits, 960, 540, 8, 64, 4096);
  const large = planScgiGather(limits, 1920, 1080, 8, 64, 4096);
  assert.equal(small.directionBytes, large.directionBytes);
  assert.equal(small.directionBytes, 4096 * 32);
  assert.equal(large.historyBytes, 240 * 135 * 160 * 2);
  assert.throws(() => planScgiGather(limits, 3840, 2160, 8, 64, 4096), /binding capacity/);
  const full = planFinalPixelLightingDirectory(limits, 1, 1, 0, [1920, 1080], true);
  assert.equal(full.giBytes, 960 * 540 * 200);
  const stripe = planFinalPixelLightingDirectory(limits, 1, 1, 0, [3840, 2160], true);
  assert.ok(stripe.windowRows < 2160 && stripe.bytes <= limits.maxStorageBufferBindingSize);
  const remap = planFinalPixelLightingDirectory(
    limits,
    1,
    Math.floor((128 * 1024 ** 2 - 256 * 1024) / 16),
    0,
    [3840, 2160],
    true,
  );
  assert.ok(remap.remapped && remap.nativeBytes <= limits.maxStorageBufferBindingSize);
  assert.throws(() => planScgiGather(limits, 100, 100, 8, 64, 32), /complete probe/);
});

test("a tilted support hemisphere has measurable prediction error and is not a constant-field proof", () => {
  const support = [0, 0, 1];
  const receiver = [0.6, 0, 0.8];
  const c = [2 * Math.PI * y0, 0, 0, Math.PI * y1].flatMap((moment, term) => [
    moment * (term === 0 ? Math.PI : (2 * Math.PI) / 3),
    0,
    0,
  ]);
  let errorSquared = 0;
  for (let sample = 0; sample < 4096; sample++) {
    const z = (sample + 0.5) / 4096,
      phi = sample * 2.399963229728653;
    const radius = Math.sqrt(1 - z * z);
    const d = [radius * Math.cos(phi), radius * Math.sin(phi), z];
    const correct = scgiGatherPrediction(c, support, d)[0];
    const mixed = scgiGatherPrediction(c, receiver, d)[0];
    assert.ok(Math.abs(correct - 1) < 1e-13);
    errorSquared += (mixed - 1) ** 2 / 4096;
  }
  assert.ok(errorSquared > 0.01, `support mismatch must not be hidden: ${errorSquared}`);
});
