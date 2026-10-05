import assert from "node:assert/strict";
import test from "node:test";
import {
  referenceWickedHistogram,
  referenceWickedAdaptation,
} from "../../.test-dist/render/temporal/GpuRadiometryOracle.js";
import {
  buildHdrDisplayLut,
  buildSdrDisplayLut,
  gradeHdrP3,
  gradeSdrRec2020,
  gt7SdrRec2020,
  linearToLogC,
  logCToLinear,
} from "../../.test-dist/render/surface/DisplayColorGrading.js";

test("Wicked meter sees the same scene luminance under different GPU P values", () => {
  const pixels = new Float32Array(4 * 4 * 4);
  for (let p = 0; p < pixels.length; p += 4) {
    pixels[p] = 0.8;
    pixels[p + 1] = 0.4;
    pixels[p + 2] = 0.2;
    pixels[p + 3] = 1;
  }
  const first = referenceWickedHistogram(pixels, 4, 4, 1);
  const scaled = pixels.map((x, i) => (i % 4 === 3 ? x : x * 2));
  const second = referenceWickedHistogram(scaled, 4, 4, 2);
  assert.deepEqual(first.bins, second.bins);
  assert.equal(first.nonBlackPixels, 4);
  assert.equal(
    first.bins.reduce((a, b) => a + b, 0),
    4,
  );
});

test("Wicked black bin is ignored and adaptation remains finite", () => {
  const black = referenceWickedHistogram(new Float32Array(16), 2, 2, 1);
  assert.equal(black.bins[0], 1);
  assert.equal(black.nonBlackPixels, 0);
  const bootstrap = referenceWickedAdaptation(black, 0, 1 / 60, false);
  assert.ok(Math.abs(bootstrap.luminance - 0.18) < 1e-6);
  assert.ok(Math.abs(bootstrap.exposure - 1) < 1e-6);
  const lit = new Float32Array([1, 1, 1, 1]);
  const histogram = referenceWickedHistogram(lit, 1, 1, 1);
  const short = referenceWickedAdaptation(histogram, 0.18, 1 / 120, true);
  const long = referenceWickedAdaptation(histogram, 0.18, 1 / 15, true);
  assert.ok(long.luminance > short.luminance);
  assert.ok(short.exposure > 0 && Number.isFinite(short.exposure));
});

test("Filament LogC grid, neutral grade and GT7 SDR target stay ordered", () => {
  for (const value of [0, 0.18, 1, 4, 16]) {
    assert.ok(Math.abs(logCToLinear(linearToLogC(value)) - value) < 1e-5);
  }
  const gray = gt7SdrRec2020([1, 1, 1]);
  assert.ok(Math.abs(gray[0] - 0.4) < 0.002);
  assert.ok(gray.every((channel) => channel > 0 && channel < 1));
  const white = gt7SdrRec2020([4, 4, 4]);
  assert.ok(white.every((channel) => channel <= 1));
  const warm = gradeSdrRec2020([0.4, 0.3, 0.2], { temperature: 0.15 });
  const neutral = gradeSdrRec2020([0.4, 0.3, 0.2]);
  assert.notDeepEqual(warm, neutral);
  const lut = buildSdrDisplayLut(32);
  assert.equal(lut.byteLength, 32 ** 3 * 4);
  assert.equal(lut[3], 255);
});

test("GT7 grade covers skin, clipping and extended HDR paper white", () => {
  const skin = gradeSdrRec2020([0.7, 0.36, 0.2]);
  assert.ok(skin[0] > skin[1] && skin[1] > skin[2]);
  assert.ok(skin.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1));
  assert.deepEqual(gradeSdrRec2020([-2, 0, 0]), [0, 0, 0]);
  const clipped = gradeSdrRec2020([32, 16, 8]);
  assert.ok(clipped.every((channel) => channel <= 1));
  const hdrGray = gradeHdrP3([4, 4, 4]);
  assert.ok(hdrGray.every((channel) => Math.abs(channel - 1.6) < 0.002));
  const hdrWhite = gradeHdrP3([16, 16, 16]);
  assert.ok(hdrWhite.every((channel) => Math.abs(channel - 4) < 0.002));
  const hdrLut = buildHdrDisplayLut(32);
  assert.equal(hdrLut.byteLength, 32 ** 3 * 8);
  assert.equal(hdrLut[3], 0x3c00);
  assert.ok(hdrLut[hdrLut.length - 4] > 0x3c00); // Extended output is not clipped to SDR white.
  assert.notDeepEqual(buildHdrDisplayLut(2, { temperature: 0.15 }), buildHdrDisplayLut(2));
});
