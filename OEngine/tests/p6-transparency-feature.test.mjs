import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("P6 TransparencyFeature is the single Renderer transparency owner", async () => {
  const feature = await readFile(new URL("../src/render/features/TransparencyFeature.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(feature, /class TransparencyFeature/);
  assert.match(feature, /PackedTransparentOitPass/);
  assert.match(feature, /TransparentOitPass/);
  assert.match(feature, /addPackedToGraph/);
  assert.match(feature, /reactive\/counters/);
  assert.match(renderer, /new TransparencyFeature\(this\._graphics\)/);
  assert.doesNotMatch(renderer, /new PackedTransparentOitPass\(/);
  assert.doesNotMatch(renderer, /new TransparentOitPass\(/);
});

test("P6 keeps GPU OIT contracts and explicit lifecycle", async () => {
  const packed = await readFile(new URL("../src/render/passes/PackedTransparentOitPass.ts", import.meta.url), "utf8");
  const feature = await readFile(new URL("../src/render/features/TransparencyFeature.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(packed, /drawIndirect/);
  assert.match(packed, /transparentQueueOverflowMask/);
  assert.match(packed, /transparentReactivePixels/);
  assert.match(feature, /retirePacked/);
  assert.match(feature, /releasePacked/);
  assert.match(feature, /不会创建任何 GPU pass/);
  assert.match(renderer, /this\._transparencyFeature\?\.releasePacked/);
  assert.match(renderer, /this\._transparencyFeature\?\.destroy/);
  assert.match(renderer, /this\._transparencyFeature!\.addPackedToGraph/);
  assert.match(renderer, /this\._transparencyFeature!\.addLegacyToGraph/);
});

test("P6 scope explicitly excludes transmission, refraction and transparent dynamic GI", async () => {
  const design = await readFile(new URL("../../docs/implementation/13-product-render-pipeline-redesign.md", import.meta.url), "utf8");
  assert.match(design, /不实现 Transmission、Refraction 和透明对象动态 GI/);
});
