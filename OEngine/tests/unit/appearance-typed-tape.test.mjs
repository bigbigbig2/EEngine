import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import {
  compileExactAppearanceDag,
  planExactAppearanceLanes
} from "../../.test-dist/material/ExactAppearanceDag.js";
import * as execution from "../../.test-dist/material/ExactAppearanceDag.js";
import { packAppearanceDagPublication } from "../../.test-dist/gpu/GpuAppearanceDagAbi.js";

test("typed temporary capacity counts f32 words rather than vec4 padding", () => {
  const plan = planExactAppearanceLanes(3, 64, 7);
  assert.equal(plan.stride, 12);
  assert.equal(plan.lanes, 5);
  assert.equal(plan.bytes, 60);
});

test("varying graphs extract internal uniform operations into GPU update tape", () => {
  assert.equal(typeof execution.compileAppearanceExecutionPlan, "function");
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  const factor = graph.operation("sin", graph.parameter("phase", 0.5));
  graph.output("roughness", graph.operation("multiply", graph.swizzle(uv, [0]), factor));
  const program = compileAppearanceGraph(graph.build());
  const plan = execution.compileAppearanceExecutionPlan(program, lowerAppearanceWgsl(program));
  const opcodes = (tape) =>
    Array.from({ length: tape.instructions.length / 8 }, (_, i) => tape.instructions[i * 8]);
  assert.ok(opcodes(plan.update).includes(13), "sin must preserve GPU math in update tape");
  assert.ok(!opcodes(plan.varying).includes(13), "sin must disappear from per-sample evaluation");
  assert.ok(opcodes(plan.varying).includes(21), "varying consumer reads the published uniform boundary");
  assert.equal(plan.uniformWords, 1, "only the live uniform boundary is persistent");
});

test("field sinks release roots while preserving later internal users", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  const x = graph.swizzle(uv, [0]);
  graph.output("alpha", graph.operation("sin", x));
  graph.output("metallic", graph.operation("cos", x));
  graph.output("roughness", graph.operation("abs", x));
  graph.output("occlusion", graph.operation("sqrt", x));
  graph.output("ior", graph.operation("add", x, graph.constant(1)));
  const program = compileAppearanceGraph(graph.build());
  const tape = compileExactAppearanceDag(program, lowerAppearanceWgsl(program));
  const sinks = [];
  for (let at = 0; at < tape.instructions.length; at += 8) {
    if (tape.instructions[at] === 20) {
      sinks.push(tape.instructions[at + 6]);
    }
  }
  assert.deepEqual(
    sinks.sort((a, b) => a - b),
    [1, 2, 3, 4, 7]
  );
  assert.ok(tape.liveWords <= 3, "independent output roots must not all survive until tape end");
});

test("different numeric snapshots share immutable tape but retain their uniform products", () => {
  const sources = [0.25, 0.5].map((phase, index) => {
    const graph = new AppearanceGraphBuilder();
    const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
    graph.output(
      "roughness",
      graph.operation(
        "multiply",
        graph.swizzle(uv, [0]),
        graph.operation("sin", graph.parameter("phase", phase))
      )
    );
    const program = compileAppearanceGraph(graph.build());
    return {
      program,
      lowered: lowerAppearanceWgsl(program),
      constantBase: index,
      routeBase: 0,
      inputBase: index,
      textureBindingSetId: 0
    };
  });
  const publication = packAppearanceDagPublication(sources, 65536);
  assert.equal(publication.templateCount, 1);
  assert.equal(publication.code[0], publication.code[16], "immutable sample tape is physically shared");
  const firstPlan = publication.code[2],
    secondPlan = publication.code[18];
  assert.equal(
    publication.code[firstPlan],
    publication.code[secondPlan],
    "GPU update tape is physically shared"
  );
  assert.notEqual(
    publication.code[firstPlan + 4],
    publication.code[secondPlan + 4],
    "uniform values retain snapshot ownership"
  );
});

test("a normal moment is decoded once for direction roughness and validity readers", () => {
  const program = {
    instructions: Array.from({ length: 5 }, (_, channel) => ({
      kind: "normal-product",
      args: [],
      product: 0,
      channel
    })),
    inputs: [],
    samples: [],
    outputs: { normalTS: [0, 1, 2], roughness: [3], normalTSValidity: [4] },
    productReads: [{ field: { width: 3, constant: [0.3, 0.4, 0.5] }, uv: null }]
  };
  const tape = compileExactAppearanceDag(program, lowerAppearanceWgsl(program));
  const opcodes = Array.from({ length: tape.instructions.length / 8 }, (_, i) => tape.instructions[i * 8]);
  assert.equal(opcodes.filter((op) => op === 23).length, 1, "one shared decoded semantic tuple");
  assert.equal(opcodes.filter((op) => op === 24).length, 5, "all semantic readers remain complete");
});

test("complete vector operations lower once without changing scalar mixed-channel fallback", () => {
  const graph = new AppearanceGraphBuilder();
  const color = graph.input("vertexColor", 3, "surface", undefined, "vertexColor");
  graph.output(
    "baseColor",
    graph.operation("sin", graph.operation("multiply", color, graph.parameter("gain", 0.5)))
  );
  graph.output("roughness", graph.operation("add", graph.swizzle(color, [2]), graph.swizzle(color, [0])));
  const program = compileAppearanceGraph(graph.build());
  const tape = compileExactAppearanceDag(program, lowerAppearanceWgsl(program));
  const records = Array.from({ length: tape.instructions.length / 8 }, (_, i) =>
    tape.instructions.slice(i * 8, i * 8 + 8)
  );
  assert.equal(
    records.filter((record) => record[0] === 8).length,
    1,
    "one RGB multiplication with scalar broadcast"
  );
  assert.equal(
    records.filter((record) => record[0] === 13).length,
    1,
    "one RGB sin preserving each f32 operation"
  );
  assert.equal(
    records.find((record) => record[0] === 8)[7] >>> 28,
    3,
    "semantic width is separate from CXY point bits"
  );
  assert.equal(
    records.find((record) => record[0] === 6)[7] >>> 28,
    1,
    "mixed channel arithmetic keeps exact scalar semantics"
  );
});

test("literal nonlinear subgraphs keep GPU operations instead of JS double folding", () => {
  const graph = new AppearanceGraphBuilder();
  graph.output(
    "roughness",
    graph.operation("sin", graph.operation("pow", graph.constant(0.3), graph.constant(0.7)))
  );
  const program = compileAppearanceGraph(graph.build());
  assert.ok(program.instructions.some((node) => node.op === "sin"));
  assert.ok(program.instructions.some((node) => node.op === "pow"));
  const plan = execution.compileAppearanceExecutionPlan(program, lowerAppearanceWgsl(program));
  const opcodes = Array.from(
    { length: plan.publication.instructions.length / 8 },
    (_, i) => plan.publication.instructions[i * 8]
  );
  assert.ok(opcodes.includes(12) && opcodes.includes(13));
});

test("camera-only ancestors update at frame rate without repeating material math", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  const camera = graph.input("cameraPosition", 3, "view");
  const material = graph.operation("sin", graph.parameter("phase", 0.5));
  const frame = graph.operation("add", graph.swizzle(camera, [0]), material);
  graph.output("roughness", graph.operation("multiply", graph.swizzle(uv, [0]), frame));
  const program = compileAppearanceGraph(graph.build());
  const plan = execution.compileAppearanceExecutionPlan(program, lowerAppearanceWgsl(program));
  const ops = (tape) =>
    Array.from({ length: tape.instructions.length / 8 }, (_, i) => tape.instructions[i * 8]);
  assert.ok(ops(plan.update).includes(13));
  assert.ok(!ops(plan.frameUpdate).includes(13), "unrelated camera motion must not repeat material sin");
  assert.ok(ops(plan.frameUpdate).includes(21), "frame update reads the committed material boundary");
  assert.ok(
    !ops(plan.varying).includes(1) || plan.varying.geometryMask === 2,
    "cameraPosition is absent from per-sample geometry demand"
  );
  assert.equal(plan.varying.geometryMask & (1 << 9), 0);
});

test("coherence is admitted only for multiple General templates in the same resource partition", () => {
  const sources = Array.from({ length: 3 }, (_, index) => {
    const graph = new AppearanceGraphBuilder();
    const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
    let value = graph.swizzle(uv, [0]);
    for (let operation = 0; operation <= index; operation++) value = graph.operation("sin", value);
    graph.output("roughness", value);
    const program = compileAppearanceGraph(graph.build());
    return {
      program,
      lowered: lowerAppearanceWgsl(program),
      constantBase: 0,
      routeBase: 0,
      inputBase: 0,
      textureBindingSetId: index
    };
  });
  assert.equal(
    packAppearanceDagPublication(sources, 65536).coherenceSetMask,
    0,
    "already coherent partitions do not allocate or dispatch sorting"
  );
  sources[1].textureBindingSetId = 0;
  assert.equal(packAppearanceDagPublication(sources, 65536).coherenceSetMask, 1);
});

test("immutable nonlinear ancestors are published once and material edits load their boundary", () => {
  const graph = new AppearanceGraphBuilder();
  const literal = graph.operation("sin", graph.constant(0.5));
  const material = graph.operation("multiply", literal, graph.parameter("gain", 0.75));
  graph.output("roughness", material);
  graph.output("alpha", graph.parameter("alpha", 0.5));
  const program = compileAppearanceGraph(graph.build());
  const lowered = lowerAppearanceWgsl(program);
  const plan = execution.compileAppearanceExecutionPlan(program, lowered);
  const ops = (tape) =>
    Array.from({ length: tape.instructions.length / 8 }, (_, i) => tape.instructions[i * 8]);
  assert.ok(ops(plan.publication).includes(13));
  assert.ok(!ops(plan.update).includes(13));
  assert.ok(ops(plan.update).includes(21));
  const data = packAppearanceDagPublication(
    [{ program, lowered, constantBase: 0, routeBase: 0, inputBase: 0, textureBindingSetId: 0 }],
    65536
  );
  assert.ok(data.uniformDependencies[0].includes(lowered.parameterSlots.gain[0].slot));
  assert.ok(
    !data.uniformDependencies[0].includes(lowered.parameterSlots.alpha[0].slot),
    "Coverage-only numeric edits cannot dirty Surface uniform work"
  );
});
