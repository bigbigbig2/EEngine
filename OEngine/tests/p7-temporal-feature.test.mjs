import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("P7 TemporalFeature is the single TAA, classification and history owner", async () => {
  const feature = await readFile(new URL("../src/render/features/TemporalFeature.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(feature, /class TemporalFeature/);
  assert.match(feature, /TemporalAntiAliasingPass/);
  assert.match(feature, /TemporalClassificationPass/);
  assert.match(feature, /DynamicResolutionScaling/);
  assert.match(feature, /colorHistory/);
  assert.match(renderer, /new TemporalFeature\(\)/);
  assert.doesNotMatch(renderer, /new TemporalAntiAliasingPass\(/);
  assert.doesNotMatch(renderer, /new TemporalClassificationPass\(/);
  assert.doesNotMatch(renderer, /new DynamicResolutionScaling\(/);
});

test("P7 preserves TAAU inputs and independent AO/SSR history", async () => {
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  const feature = await readFile(new URL("../src/render/features/TemporalFeature.ts", import.meta.url), "utf8");
  const registry = await readFile(new URL("../src/render/TemporalHistoryRegistry.ts", import.meta.url), "utf8");
  assert.match(renderer, /addClassificationToGraph/);
  assert.match(renderer, /addTaaToGraph/);
  assert.match(renderer, /disocclusionConfidence/);
  assert.match(renderer, /transparentReactive/);
  assert.match(feature, /rgba16float/);
  assert.match(feature, /GPUTextureUsage\.STORAGE_BINDING/);
  assert.match(renderer, /new TemporalHistoryRegistry\(\["color", "ssao", "ssr"\]\)/);
  assert.match(renderer, /this\._temporalHistories\.beginFrame/);
  assert.match(renderer, /this\._temporalHistories\.commitFrame/);
  assert.match(renderer, /this\._temporalHistories\.abortFrame/);
});

test("P7 history lifecycle is submission-safe and feature-off is lazy", async () => {
  const feature = await readFile(new URL("../src/render/features/TemporalFeature.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  const history = await readFile(new URL("../src/render/TemporalHistoryRegistry.ts", import.meta.url), "utf8");
  assert.match(feature, /retireAfterSubmittedWork/);
  assert.match(feature, /onSubmittedWorkDone/);
  assert.match(feature, /retireColorHistory/);
  assert.match(renderer, /if \(topology\.temporal\)/);
  assert.match(renderer, /retireColorHistory/);
  assert.match(history, /invalidationReason/);
  assert.match(history, /output-resize/);
  assert.match(history, /internal-resize/);
  assert.match(history, /camera-cut/);
  assert.match(history, /lighting-change/);
  assert.match(history, /abort/);
  assert.match(renderer, /light:\s*scene\.lights\.version/);
});
