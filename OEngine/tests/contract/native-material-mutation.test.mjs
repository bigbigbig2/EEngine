import assert from "node:assert/strict";
import test from "node:test";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { Color } from "../../.test-dist/core/Color.js";
import { observeNativeMaterial } from "../../.test-dist/material/NativeMaterialMutation.js";

test("shared authored components, replacement, numeric inputs and detachment notify live scenes", () => {
  const a = new StandardShadeMaterial(),
    b = new StandardShadeMaterial();
  b.diffuse_color = a.diffuse_color;
  let first = 0,
    second = 0;
  const detachA = observeNativeMaterial(a, () => first++);
  const detachB = observeNativeMaterial(b, () => second++);
  a.diffuse_color.r = 0.5;
  assert.deepEqual([first, second], [1, 1]);
  a.diffuse_color.r = 0.5;
  assert.deepEqual([first, second], [1, 1]);
  const shared = a.diffuse_color;
  a.diffuse_color = new Color(0.2, 0.3, 0.4);
  shared.g = 0.4;
  assert.deepEqual([first, second], [2, 2]);
  a.diffuse_color.b = 0.8;
  a.ambient_factors.a = 0.3;
  a.appearance_inputs.set("gain", [0.7]);
  assert.equal(first, 5);
  a.appearance_inputs.get("gain")[0] = 0;
  assert.equal(
    a.appearance_inputs.get("gain")[0],
    Math.fround(0.7),
    "get must not expose mutable owner storage",
  );
  a.appearance_inputs.set("gain", [0.7]);
  assert.equal(first, 5);
  detachA();
  detachB();
  a.diffuse_color.r = 0.9;
  shared.a = 0.2;
  assert.deepEqual([first, second], [5, 2]);
});
