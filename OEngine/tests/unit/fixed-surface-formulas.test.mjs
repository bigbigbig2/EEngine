import assert from "node:assert/strict";
import test from "node:test";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "../../.test-dist/material/AppearanceGraph.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { compileFixedSurfaceFormulas, FIXED_SURFACE_PLAN_WORDS, FIXED_SURFACE_SAMPLE_COUNT } from "../../.test-dist/material/FixedSurfaceFormulas.js";

const compile = (graph) => {
  const program = compileAppearanceGraph(graph);
  return { program, plan: compileFixedSurfaceFormulas(program, lowerAppearanceWgsl(program)) };
};

test("ordinary PBR and unlit use complete fixed formulas regardless of parameter values", () => {
  for (const unlit of [false, true]) {
    for (const value of [0, .4, 1]) {
      const material = new StandardShadeMaterial();
      material.is_unlit = unlit;
      material.diffuse_color.r = value;
      material.roughness_factor = value;
      material.clearcoat_factor = unlit ? 0 : value;
      const program = compileCanonicalMaterial(material).appearance;
      const plan = compileFixedSurfaceFormulas(program, lowerAppearanceWgsl(program));
      assert.equal(plan?.length, FIXED_SURFACE_PLAN_WORDS);
    }
  }
});

test("nonlinear and unrecognized coordinate graphs remain complete Generic", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  graph.output("roughness", graph.operation("sin", graph.swizzle(uv, [0])));
  const { program, plan } = compile(graph.build());
  assert.equal(plan, null);
  assert.ok(program.instructions.some((node) => node.op === "sin"));
});

test("all current standard texture roles, normals, coat and three UV sets match fixed formulas", () => {
  const material = new StandardShadeMaterial();
  const roles = ["albedo", "normal", "orm", "occlusion", "emissive", "specular", "specular_color", "clearcoat", "clearcoat_roughness", "clearcoat_normal"];
  for (const role of roles) {
    material[`texture_${role}`] = new ShadeTexture();
  }
  material.normal_uv_set = 1;
  material.clearcoat_normal_uv_set = 2;
  material.clearcoat_factor = .7;
  const program = compileCanonicalMaterial(material).appearance;
  const plan = compileFixedSurfaceFormulas(program, lowerAppearanceWgsl(program));
  assert.ok(plan, "every standard feature must have a fixed formula, including signed normal XY scale");
  const semantics = new Set(Array.from({ length: FIXED_SURFACE_SAMPLE_COUNT }, (_, slot) => plan[slot * 4 + 2]));
  assert.ok(semantics.has(1) && semantics.has(2) && semantics.has(3));
});

test("shared source sample has one slot and complete field consumers, including UV2", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv2", 2, "surface", undefined, "uv2");
  const texture = graph.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv);
  graph.output("baseColor", graph.swizzle(texture, [0, 1, 2]));
  graph.output("emissive", graph.swizzle(texture, [0, 1, 2]));
  const { plan } = compile(graph.build());
  assert.ok(plan);
  assert.equal(plan[2], 3);
  assert.equal(plan[3], (1 << 0) | (1 << 5));
  assert.equal(plan[7], 0);
});

test("sample plan capacity never truncates legal graphs", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  let value = graph.constant(0);
  for (let index = 0; index <= FIXED_SURFACE_SAMPLE_COUNT; index++) {
    const sample = graph.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv);
    value = graph.operation("add", value, graph.swizzle(sample, [0]));
  }
  graph.output("roughness", value);
  const { program, plan } = compile(graph.build());
  assert.equal(plan, null);
  assert.equal(program.samples.length, FIXED_SURFACE_SAMPLE_COUNT + 1);
});

test("fixed reference tags never truncate a complete Generic constant address", () => {
  const graph = new AppearanceGraphBuilder();
  graph.output("roughness", graph.constant(.5));
  const program = compileAppearanceGraph(graph.build());
  const lowered = lowerAppearanceWgsl(program);
  const slots = [...lowered.instructionConstantSlots];
  slots[program.outputs.roughness[0]] = 0x10000000;
  assert.equal(compileFixedSurfaceFormulas(program, { ...lowered, instructionConstantSlots: slots }), null);
});
