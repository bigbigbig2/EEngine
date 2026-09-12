import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  resolveRendererDebugConfig
} from "../.test-dist/addons/debug/RendererDebugConfig.js";
import { summarizeRafFps } from "../.test-dist/addons/debug/RendererInfoModel.js";
import { mergeRendererConfig } from "../.test-dist/render/RendererConfig.js";

test("debug config is opt-in and normalizes the development defaults", () => {
  assert.deepEqual(resolveRendererDebugConfig(undefined), {
    enabled: false,
    controls: false,
    info: false,
    expanded: false,
    infoRefreshRate: 4
  });
  assert.deepEqual(resolveRendererDebugConfig(true), {
    enabled: true,
    controls: true,
    info: true,
    expanded: false,
    infoRefreshRate: 4
  });
  assert.deepEqual(resolveRendererDebugConfig({ controls: false, infoRefreshRate: 8 }), {
    enabled: true,
    controls: false,
    info: true,
    expanded: false,
    infoRefreshRate: 8
  });
  assert.throws(
    () => resolveRendererDebugConfig({ infoRefreshRate: 0 }),
    /between 1 and 10/
  );
});

test("renderer config keeps every nested RenderSettings section while merging", () => {
  const merged = mergeRendererConfig(
    { renderSettings: { temporal: { historyStrength: 0.5 }, post: { bloomIntensity: 2 } } },
    { renderSettings: { temporal: { varianceGamma: 1.5 }, post: { sharpeningStrength: 0.25 } } }
  );
  assert.deepEqual(merged.renderSettings.temporal, {
    historyStrength: 0.5,
    varianceGamma: 1.5
  });
  assert.deepEqual(merged.renderSettings.post, {
    bloomIntensity: 2,
    sharpeningStrength: 0.25
  });
});

test("Renderer keeps the Tweakpane runtime behind an async addon boundary", async () => {
  const source = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(source, /await import\("\.\.\/addons\/debug\/RendererDebugController\.js"\)/);
  assert.doesNotMatch(source, /from ["']tweakpane["']/);
});

test("Renderer info reports a rolling RAF rate instead of one noisy interval", () => {
  const steadySixtyFps = Array.from({ length: 60 }, () => 1000 / 60);
  assert.ok(Math.abs(summarizeRafFps(steadySixtyFps) - 60) < 0.001);

  const oneSlowFrame = [...steadySixtyFps.slice(1), 100];
  const rollingFps = summarizeRafFps(oneSlowFrame);
  assert.ok(rollingFps > 50 && rollingFps < 60);
  assert.notEqual(rollingFps, 10);

  assert.equal(summarizeRafFps([Number.NaN, -1, 2000]), undefined);
});
