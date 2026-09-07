import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("M4 removes the screen-sized pixel classifier and its shader", () => {
  assert.equal(existsSync(new URL("../src/render/VisiblePixelClassifier.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/shaders/visible_pixel_classification.ts", import.meta.url)), false);
  const resolve = readFileSync(new URL("../src/shaders/packed_material_resolve.ts", import.meta.url), "utf8");
  const pass = readFileSync(new URL("../src/render/passes/PackedMaterialResolvePass.ts", import.meta.url), "utf8");
  assert.doesNotMatch(resolve, /shade_work|drawIndirect/);
  assert.doesNotMatch(pass, /count_visible_pixels|scan_blocks|add_block_prefixes|scatter_visible_pixels|ShadeWork|drawIndirect/);
  assert.match(resolve, /@builtin\(position\)/);
});
