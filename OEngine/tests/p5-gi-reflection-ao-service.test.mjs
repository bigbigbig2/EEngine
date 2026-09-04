import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("P5 services own GI, reflection correction and GTAO without duplicating Surface", async () => {
  const gi = await readFile(new URL("../src/render/features/GIService.ts", import.meta.url), "utf8");
  const reflection = await readFile(new URL("../src/render/features/ReflectionService.ts", import.meta.url), "utf8");
  const ao = await readFile(new URL("../src/render/features/AOService.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(gi, /IBL diffuse\/specular 基线/);
  assert.match(gi, /OpaqueLightingPipeline/);
  assert.match(reflection, /置信度的修正结果/);
  assert.match(reflection, /SpecularCorrectionPass/);
  assert.match(reflection, /lastCorrectionRan/);
  assert.match(ao, /Material AO 之外的 GTAO visibility/);
  assert.match(ao, /ScreenSpaceAmbientOcclusionPass/);
  assert.match(renderer, /new GIService\(this\._graphics\)/);
  assert.match(renderer, /new AOService\(/);
  assert.match(renderer, /new ReflectionService\(/);
  assert.doesNotMatch(renderer, /new OpaqueLightingPipeline\(/);
  assert.doesNotMatch(renderer, /new ScreenSpaceAmbientOcclusionPass\(/);
  assert.doesNotMatch(renderer, /new ScreenSpaceReflectionsPass\(/);
  assert.doesNotMatch(renderer, /new SpecularCorrectionPass\(/);
});

test("P5 preserves fallback and independent AO/SSR products", async () => {
  const pipeline = await readFile(new URL("../src/render/pipeline/OpaqueLightingPipeline.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(pipeline, /resolveIblBaseline/);
  assert.match(pipeline, /indirectDiffuse/);
  assert.match(pipeline, /indirectSpecular/);
  assert.match(renderer, /ambientVisibilityRes = ssao\.frame\.visibility/);
  assert.match(renderer, /bentNormalRes = ssao\.frame\.bentNormal/);
  assert.match(renderer, /baselineSpecular/);
  assert.match(renderer, /resolvedSpecular: ssr\.denoised/);
  assert.match(renderer, /hdrRes = this\._reflectionService!\.addCorrection/);
  assert.doesNotMatch(renderer, /albedoAo\.a\s*=\s*.*GTAO/);
});

test("P5 service lifecycle keeps feature-off resources lazy", async () => {
  const renderer = await readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(renderer, /this\._aoService = null/);
  assert.match(renderer, /this\._reflectionService = null/);
  assert.match(renderer, /retireAfterSubmittedWork\(this\._aoService\)/);
  assert.match(renderer, /retireAfterSubmittedWork\(this\._reflectionService\)/);
  assert.match(renderer, /if \(topology\.ssao\)/);
  assert.match(renderer, /if \(topology\.ssr\)/);
});
