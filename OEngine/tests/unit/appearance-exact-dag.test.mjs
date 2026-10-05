import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import {
  compileExactAppearanceDag,
  planExactAppearanceLanes,
  APPEARANCE_DAG_OPS,
} from "../../.test-dist/material/ExactAppearanceDag.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

test("complete long graph reuses dead live slots without truncating instructions", () => {
  const graph = new AppearanceGraphBuilder();
  let value = graph.input("gain", 1, "dynamic", { low: 0, high: 1 });
  const step = graph.parameter("step", 0.01);
  for (let index = 0; index < 1024; index++) {
    value = graph.operation("add", value, step);
  }
  graph.output("roughness", value);
  const program = compileAppearanceGraph(graph.build());
  const dag = compileExactAppearanceDag(program, lowerAppearanceWgsl(program));
  assert.equal(dag.instructions.length / 8, 1026);
  assert.equal(dag.liveSlots, 3, "step, incoming value and distinct destination");
  assert.equal(dag.outputs.length, 4);
  const constrained = planExactAppearanceLanes(dag.liveSlots, 64, 4096);
  assert.equal(constrained.lanes, 1);
  assert.equal(constrained.bytes, 48);
  assert.throws(() => planExactAppearanceLanes(5, 64), /one lane/);
});

test("nested texture coordinates retain neighbors and one shared sample per source", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv2", 2, "surface", undefined, "uv2");
  const first = graph.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv);
  const nested = graph.operation("sin", graph.swizzle(first, [0, 1]));
  const second = graph.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), nested);
  graph.output("baseColor", graph.swizzle(second, [0, 1, 2]));
  graph.output("roughness", graph.swizzle(first, [2]));
  const program = compileAppearanceGraph(graph.build());
  const dag = compileExactAppearanceDag(program, lowerAppearanceWgsl(program));
  const instructions = Array.from({ length: dag.instructions.length / 8 }, (_, index) =>
    dag.instructions.slice(index * 8, index * 8 + 8),
  );
  const samples = instructions.filter((record) => record[0] === APPEARANCE_DAG_OPS.sample);
  assert.equal(samples.length, 2);
  assert.equal(samples[0][7] >>> 16, 1, "nested coordinate sampling requires C/X/Y");
  assert.equal(samples[1][7] >>> 16, 0, "final source only samples C");
  assert.equal(dag.geometryMask, 1 << 3);
  assert.equal(dag.neighborMask, 1 << 3);
  assert.equal(dag.fieldMask, (1 << 0) | (1 << 3));
  assert.ok(samples[0][5] & (1 << 3));
  assert.ok(samples[0][5] & 1);
});

test("malformed forward coordinate reference is rejected before publication", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  const sample = graph.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv);
  graph.output("baseColor", graph.swizzle(sample, [0, 1, 2]));
  const program = compileAppearanceGraph(graph.build());
  const bad = { ...program, samples: [{ ...program.samples[0], uv: [program.instructions.length, 0] }] };
  assert.throws(() => compileExactAppearanceDag(bad, lowerAppearanceWgsl(program)), /topologically ordered/);
});
