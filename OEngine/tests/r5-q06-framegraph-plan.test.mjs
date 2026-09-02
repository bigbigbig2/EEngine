import assert from "node:assert/strict";
import test from "node:test";

const { FrameGraph, FrameGraphContext } = await import(
  "../.test-dist/framegraph/FrameGraph.js"
);
const { FramePlan, createRendererFramePlan } = await import(
  "../.test-dist/render/pipeline/FramePlan.js"
);

test("Q06 FrameGraph validates read-before-write and resolution domains", () => {
  const invalid = new FrameGraph("read-before-write");
  const orphan = invalid.create_resource("orphan", {
    kind: "transient_texture", width: 8, height: 8, format: "rgba8unorm",
    domain: "internal-half"
  });
  const sink = invalid.import_resource("sink", {
    kind: "imported", domain: "output-full"
  }, {});
  const reader = invalid.add("reader", {}, () => {});
  reader.read(orphan);
  reader.write(sink);
  assert.throws(() => invalid.compile(), /before it is written/);

  const domains = new FrameGraph("domain-validation");
  const half = domains.import_resource("half", {
    kind: "imported", domain: "internal-half"
  }, {});
  const output = domains.import_resource("output", {
    kind: "imported", domain: "output-full"
  }, {});
  const mismatch = domains.add("mismatch", {}, () => {});
  mismatch.readDomain(half, "output-full");
  mismatch.write(output);
  assert.throws(() => domains.compile(), /without a conversion owner/);

  const converted = new FrameGraph("domain-conversion");
  const convertedHalf = converted.import_resource("half", {
    kind: "imported", domain: "internal-half"
  }, {});
  const convertedOutput = converted.import_resource("output", {
    kind: "imported", domain: "output-full"
  }, {});
  const conversion = converted.add("joint bilateral upscale", {}, () => {});
  conversion.readDomain(convertedHalf, "output-full", "SSR joint bilateral upscale");
  conversion.write(convertedOutput);
  assert.doesNotThrow(() => converted.compile());
});

test("Q06 FrameGraph detects cycles and uses stable dependency scheduling", () => {
  const execution = [];
  const graph = new FrameGraph("stable-topology");
  const consumer = graph.add("consumer", {}, () => execution.push("consumer"));
  consumer.make_side_effect();
  const producer = graph.add("producer", {}, () => execution.push("producer"));
  producer.make_side_effect();
  consumer.dependsOn(producer);
  consumer.declareEncoderWork({ renderPasses: 1, draws: 1 });
  const compiled = graph.compile();
  assert.deepEqual(compiled.dump().executablePassOrder, [1, 0]);
  assert.deepEqual(compiled.dump().passes[0].dependencies, [1]);
  assert.deepEqual(compiled.dump().passes[0].encoderWork, {
    renderPasses: 1, computePasses: 0, dispatches: 0, draws: 1
  });
  compiled.execute(new FrameGraphContext(), undefined);
  assert.deepEqual(execution, ["producer", "consumer"]);

  const cyclic = new FrameGraph("cycle");
  const a = cyclic.add("A", {}, () => {});
  const b = cyclic.add("B", {}, () => {});
  a.make_side_effect();
  b.make_side_effect();
  a.dependsOn(b);
  b.dependsOn(a);
  assert.throws(() => cyclic.compile(), /dependency cycle/);
});

test("Q06 FramePlan owns one validated cross-graph schedule", () => {
  const plan = createRendererFramePlan(7, { lpv: true, shadows: true });
  const observed = [];
  plan.execute("scene-update", () => observed.push("scene"));
  assert.throws(() => plan.execute("main-view-graph", () => {}), /before dependency/);
  plan.execute("lpv-update", () => observed.push("lpv"));
  plan.execute("shadow-update", () => observed.push("shadow"));
  plan.execute("main-view-graph", () => observed.push("main"));
  plan.assertComplete();
  const dump = plan.dump();
  assert.equal(dump.complete, true);
  assert.deepEqual(observed, ["scene", "lpv", "shadow", "main"]);
  assert.deepEqual(dump.order, [
    "scene-update", "lpv-update", "shadow-update", "main-view-graph"
  ]);

  const cycle = [
    { id: "scene-update", dependencies: ["main-view-graph"], enabled: true,
      frequency: "per-frame", dirtyCondition: "test", persistentOutputs: [], gpuTimingLabel: "scene" },
    { id: "main-view-graph", dependencies: ["scene-update"], enabled: true,
      frequency: "per-frame", dirtyCondition: "test", persistentOutputs: [], gpuTimingLabel: "main" }
  ];
  assert.throws(() => new FramePlan(0, cycle), /dependency cycle/);
});
