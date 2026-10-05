import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";

function program(factor, binding) {
  const g = new AppearanceGraphBuilder();
  const uv = g.input("uv", 2, "surface", undefined, "uv0");
  const sample = g.texture(binding, uv);
  g.output("value", g.operation("multiply", g.swizzle(sample, [1, 2]), g.constant(factor)));
  g.output("alpha", g.swizzle(sample, [3]));
  return lowerAppearanceWgsl(compileAppearanceGraph(g.build()));
}

test("straight-line WGSL uses one decoded fetch, parameter data, and exact output slots", () => {
  const binding = snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb");
  const p = program(0.4, binding);
  assert.deepEqual(p.outputSlots, { value: [0, 1], alpha: [2] });
  assert.equal(p.outputCount, 3);
  assert.equal((p.source.match(/appearance_sample_0\(/g) ?? []).length, 1);
  assert.ok(!/\b(for|loop|switch|atomic)\b/.test(p.source));
  assert.ok(p.source.includes("array<f32, 3>"));
  assert.ok(p.constants.includes(Math.fround(0.4)));
});

test("the same optimized profile reuses shader topology across instance factor/texture changes", () => {
  const p = program(0.4, snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"));
  const q = program(0.7, snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb", [0.2, 0.3]));
  assert.equal(p.templateKey, q.templateKey);
  assert.notDeepEqual(p.constants, q.constants);
  assert.notEqual(
    p.templateKey,
    program(0.4, snapshotAppearanceTexture(new ShadeTexture(), "srgb-rgb")).templateKey,
  );
});

test("zero demanded outputs produce a legal non-dispatched WGSL shape", () => {
  const g = new AppearanceGraphBuilder();
  g.output("value", g.constant(1));
  const p = lowerAppearanceWgsl(compileAppearanceGraph(g.build(), {}));
  assert.equal(p.outputCount, 0);
  assert.deepEqual(p.outputSlots, {});
  assert.ok(p.source.includes("array<f32, 1>(0.0)"));
});

test("material data provenance prevents numeric coincidences from creating per-instance shader shapes", () => {
  const a = new StandardShadeMaterial(),
    b = new StandardShadeMaterial();
  a.diffuse_color.set(0.5, 0.5, 0.5, 0.5);
  a.specular_color_factor.set(0.5, 0.5, 0.5);
  b.diffuse_color.set(0.2, 0.3, 0.4, 0.8);
  b.specular_color_factor.set(0.6, 0.7, 0.9);
  const p = lowerAppearanceWgsl(compileCanonicalMaterial(a).appearance);
  const q = lowerAppearanceWgsl(compileCanonicalMaterial(b).appearance);
  assert.equal(p.templateKey, q.templateKey);
  assert.notDeepEqual(p.constants, q.constants);
  assert.deepEqual(p.parameterSlots, q.parameterSlots);
  assert.ok(p.parameterSlots["base color 0"]);
  assert.ok(p.parameterSlots["specular color 0"]);
});
