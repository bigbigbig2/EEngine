import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("Q02 keeps material AO and ambient visibility as separate products", () => {
  const renderer = readFileSync(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  const aoPass = readFileSync(
    new URL("../src/render/passes/ScreenSpaceAmbientOcclusionPass.ts", import.meta.url),
    "utf8"
  );
  assert.match(renderer, /ambientVisibilityRes = ssao\.visibility/);
  assert.doesNotMatch(renderer, /gAlbedoRes = ssao\./);
  assert.doesNotMatch(aoPass, /inputs\.albedoAo/);
  assert.doesNotMatch(aoPass, /alpha-min composite/);
});

test("Q02 traces SSR from Complete Opaque HDR and applies a delta correction", () => {
  const renderer = readFileSync(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  const completeOpaque = renderer.indexOf("this._giService.addIblBaseline");
  const baseline = renderer.indexOf("baselineSpecularRes", completeOpaque);
  const trace = renderer.indexOf("this._reflectionService!.addToGraph", baseline);
  const correction = renderer.indexOf("this._reflectionService!.addCorrection", trace);
  assert.ok(completeOpaque >= 0 && baseline > completeOpaque && trace > baseline && correction > trace);

  const shader = readFileSync(
    new URL("../src/shaders/specular_correction.ts", import.meta.url),
    "utf8"
  );
  assert.match(shader, /\(resolved - baseline\) \* weight \* occlusion/);
});

test("Q02 exposure source is bloom-independent and sharpen follows bloom", () => {
  const renderer = readFileSync(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  const exposure = renderer.indexOf("const exposureSourceHdr = hdrRes");
  const bloom = renderer.indexOf("this._bloom!.addToGraph", exposure);
  const sharpen = renderer.indexOf("this._sharpen!.addToGraph", bloom);
  assert.ok(exposure >= 0 && bloom > exposure && sharpen > bloom);
  assert.doesNotMatch(renderer, /exposureInput = bloom\.downsampled/);
});
