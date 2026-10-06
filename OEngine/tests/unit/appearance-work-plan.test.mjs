import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import {
  compileAppearanceExecutionPlan,
  APPEARANCE_DAG_OPS as OP
} from "../../.test-dist/material/ExactAppearanceDag.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

function make(spatial) {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  const coordinate = spatial ? uv : graph.constant([0.25, 0.75]);
  const sample = graph.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), coordinate);
  const factor = graph.operation("sin", graph.swizzle(sample, [0]));
  graph.output("roughness", graph.operation("multiply", graph.swizzle(uv, [0]), factor));
  graph.output("emissive", graph.swizzle(sample, [0, 1, 2]));
  const program = compileAppearanceGraph(graph.build());
  return compileAppearanceExecutionPlan(program, lowerAppearanceWgsl(program));
}
const records = (tape) =>
  Array.from({ length: tape.instructions.length / 8 }, (_, index) =>
    Array.from(tape.instructions.slice(index * 8, index * 8 + 8))
  );

test("uniform resource query and nonlinear ancestors move to material work, while UV consumer stays sample-dependent", () => {
  const plan = make(false);
  assert.equal(records(plan.update).filter((record) => record[0] === OP.sample).length, 1);
  assert.ok(records(plan.update).some((record) => record[0] === OP.sin));
  assert.ok(!records(plan.varying).some((record) => record[0] === OP.sample || record[0] === OP.sin));
  assert.ok(records(plan.varying).some((record) => record[0] === OP.uniformLoad));
  assert.deepEqual(Array.from(plan.workPlan.uniformTextureQueries), [0]);
  assert.equal(plan.workPlan.sampleTextureQueries.length, 0);
  assert.ok((plan.constantFields & (1 << 5)) !== 0, "emissive resolves from one material-domain value");
  assert.ok((plan.varying.geometryMask & (1 << 1)) !== 0, "varying roughness still consumes original UV");
  const emissive = plan.workPlan.fields.find((work) => work.field === 5);
  assert.equal(emissive.category, "update");
  assert.equal(emissive.value, "uniform");
  assert.deepEqual(Array.from(emissive.textureQueries), [0]);
  assert.ok(emissive.invalidation.includes("residency"));
  const roughness = plan.workPlan.fields.find((work) => work.field === 3);
  assert.equal(roughness.value, "sample-indexed");
  assert.ok(roughness.inputs.includes("uv0"));
  assert.equal(roughness.fallback, "complete-direct");
});

test("spatial footprint keeps the full original query and nonlinear work in the sample domain", () => {
  const plan = make(true);
  assert.ok(records(plan.varying).some((record) => record[0] === OP.sample));
  assert.ok(records(plan.varying).some((record) => record[0] === OP.sin));
  assert.equal(plan.workPlan.uniformTextureQueries.length, 0);
  assert.deepEqual(Array.from(plan.workPlan.sampleTextureQueries), [0]);
  assert.ok((plan.varying.neighborMask & (1 << 1)) !== 0, "original CXY footprint remains required");
});
