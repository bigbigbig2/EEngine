import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("P8 PostFeature is the single HDR post owner", async () => {
  const feature = await readFile(new URL("../src/render/features/PostFeature.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(feature, /class PostFeature/);
  assert.match(feature, /AutomaticExposurePass/);
  assert.match(feature, /BloomPass/);
  assert.match(feature, /TonemapPass/);
  assert.match(feature, /SharpenPass/);
  assert.match(feature, /MotionBlurPass/);
  assert.match(renderer, /_postFeature/);
  assert.match(renderer, /new PostFeature\(this\._graphics\)/);
});

test("P8 Renderer no longer constructs post passes directly", async () => {
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(renderer, /new AutomaticExposurePass\(/);
  assert.doesNotMatch(renderer, /new BloomPass\(/);
  assert.doesNotMatch(renderer, /new TonemapPass\(/);
  assert.doesNotMatch(renderer, /new SharpenPass\(/);
  assert.doesNotMatch(renderer, /new MotionBlurPass\(/);
});

test("P8 linear-HDR post order: exposure -> bloom -> color grading -> sharpen -> tonemap", async () => {
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  const exposure = renderer.indexOf("exposureRes = this._postFeature!.obtainAutomaticExposure().update(");
  const bloom = renderer.indexOf("this._postFeature!.addBloomToGraph(");
  const colorGrading = renderer.indexOf("this._postFeature!.addColorGradingToGraph(");
  const sharpen = renderer.indexOf("this._postFeature!.addSharpenToGraph(");
  const tonemap = renderer.indexOf("this._postFeature!.obtainTonemap(this._format).addToGraph(");
  assert.ok(exposure !== -1, "exposure stage present");
  assert.ok(bloom !== -1, "bloom stage present");
  assert.ok(colorGrading !== -1, "color grading stage present");
  assert.ok(sharpen !== -1, "sharpen stage present");
  assert.ok(tonemap !== -1, "tonemap stage present");
  assert.ok(exposure < bloom, "exposure precedes bloom");
  assert.ok(bloom < colorGrading, "bloom precedes color grading");
  assert.ok(colorGrading < sharpen, "color grading precedes sharpen");
  assert.ok(sharpen < tonemap, "sharpen precedes tonemap");
});

test("P8 feature-off is lazy and tonemap is destroyed on teardown", async () => {
  const feature = await readFile(new URL("../src/render/features/PostFeature.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(feature, /obtainAutomaticExposure\(\)/);
  assert.match(feature, /retireAutomaticExposure\(\)/);
  assert.match(feature, /retireAfterSubmittedWork/);
  assert.match(feature, /onSubmittedWorkDone/);
  // 修复历史上的 Tonemap 泄漏：destroy() 必须销毁 tonemap。
  assert.match(feature, /this\._tonemap\?\.destroy\(\)/);
  assert.match(feature, /this\._tonemap = null/);
  assert.match(renderer, /this\._postFeature\?\.destroy\(\)/);
});

test("P8 production post shaders are authored source-of-truth", async () => {
  const exposure = await readFile(new URL("../src/shaders/automatic_exposure.ts", import.meta.url), "utf8");
  const bloom = await readFile(new URL("../src/shaders/bloom.ts", import.meta.url), "utf8");
  assert.doesNotMatch(exposure, /temporal_post_legacy\.generated/);
  assert.doesNotMatch(bloom, /temporal_post_legacy\.generated/);
  assert.match(exposure, /EXPOSURE_HISTOGRAM_WGSL/);
  assert.match(exposure, /EXPOSURE_REDUCE_WGSL/);
  assert.match(exposure, /EXPOSURE_ADAPT_WGSL/);
  assert.match(bloom, /BLOOM_PREFILTER_WGSL/);
  assert.match(bloom, /BLOOM_DOWNSAMPLE_WGSL/);
  assert.match(bloom, /BLOOM_UPSAMPLE_WGSL/);
  assert.match(bloom, /BLOOM_COMPOSITE_WGSL/);
});

test("P9 sharpen no longer depends on deleted temporal generated shader", async () => {
  const sharpen = await readFile(new URL("../src/shaders/sharpen.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sharpen, /temporal_post_legacy\.generated/);
  assert.match(sharpen, /SHARPEN_VERTEX_WGSL/);
  assert.match(sharpen, /SHARPEN_WGSL/);
});
