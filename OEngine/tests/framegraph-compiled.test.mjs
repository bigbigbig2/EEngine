import assert from "node:assert/strict";
import test from "node:test";

const {
  FrameGraph,
  FrameGraphBindingLayout,
  FrameGraphContext
} = await import("../.test-dist/framegraph/FrameGraph.js");
const { canonicalFrameGraphKey } = await import(
  "../.test-dist/framegraph/FrameGraphKey.js"
);
const { CompiledFrameGraphCache } = await import(
  "../.test-dist/framegraph/CompiledFrameGraphCache.js"
);

test("CompiledFrameGraph freezes pruning, logical slots and last-use plan", () => {
  const first = {
    input: { frame: 1 },
    output: { frame: 1 },
    job: { marker: "first" }
  };
  const layout = new FrameGraphBindingLayout();
  const graph = new FrameGraph("compiled-test");
  const input = graph.import_resource(
    "input",
    { kind: "imported", label: "input" },
    layout.slot("input", first, (bindings) => bindings.input)
  );
  const output = graph.import_resource(
    "output",
    { kind: "imported", label: "output" },
    layout.slot("output", first, (bindings) => bindings.output)
  );
  const unused = graph.create_resource("unused", {
    kind: "transient_buffer",
    size: 4
  });
  const observed = [];
  const jobSlot = layout.slot("job", first, (bindings) => bindings.job);
  const pass = graph.add(
    "bound-pass",
    { job: jobSlot },
    (data, resources) => {
      observed.push([data.job.marker, resources.get(input), resources.get(output)]);
    }
  );
  pass.read(input);
  pass.write(output);
  const culled = graph.add("culled-pass", {}, () => {
    throw new Error("culled pass executed");
  });
  culled.write(unused);

  const compiled = graph.compile();
  const dump = compiled.dump();
  assert.deepEqual(dump.executablePassOrder, [0]);
  assert.equal(dump.passes[1].culled, true);
  assert.equal(dump.resources[0].binding, "input");
  assert.equal(dump.resources[0].firstUsePass, 0);
  assert.equal(dump.resources[0].lastUsePass, 0);
  assert.equal(Object.isFrozen(dump), true);
  assert.throws(() => graph.add("late", {}, () => {}), /already compiled/);
  assert.throws(() => jobSlot.marker, /only available while building or executing/);

  compiled.execute(new FrameGraphContext(), first);
  const second = {
    input: { frame: 2 },
    output: { frame: 2 },
    job: { marker: "second" }
  };
  compiled.execute(new FrameGraphContext(), second);
  assert.equal(observed[0][0], "first");
  assert.equal(observed[0][1], first.input);
  assert.equal(observed[1][0], "second");
  assert.equal(observed[1][1], second.input);

  compiled.destroy();
  assert.throws(
    () => compiled.execute(new FrameGraphContext(), second),
    /destroyed/
  );
});

test("canonical FrameGraph key excludes dynamic handles and counts", () => {
  const topology = {
    capabilityProfile: "webgpu:subgroups,timestamp-query",
    internalWidth: 960,
    internalHeight: 540,
    outputWidth: 1920,
    outputHeight: 1080,
    viewCount: 1,
    sampleCount: 1,
    enabledFeatureBits: 0b10101,
    visibilityImplementation: "hardware-v1",
    historyFormatRevision: 1,
    outputFormat: "bgra8unorm",
    instrumentationMode: "none",
    instrumentationRevision: 1
  };
  const first = canonicalFrameGraphKey(topology);
  const second = canonicalFrameGraphKey({ ...topology });
  assert.equal(first, second);
  assert.notEqual(
    first,
    canonicalFrameGraphKey({ ...topology, internalWidth: 1280 })
  );
  assert.notEqual(
    first,
    canonicalFrameGraphKey({ ...topology, enabledFeatureBits: 0b10111 })
  );
  assert.notEqual(
    first,
    canonicalFrameGraphKey({ ...topology, instrumentationMode: "timestamps" })
  );
});

test("compiled graph cache reports miss, warm hit and deterministic eviction", () => {
  const events = [];
  const observer = {
    hit: () => events.push("hit"),
    miss: () => events.push("miss"),
    evict: () => events.push("evict")
  };
  const destroyed = [];
  const compiled = (name) => ({
    destroy: () => destroyed.push(name)
  });
  const cache = new CompiledFrameGraphCache(2);
  const first = cache.getOrCreate("A", () => compiled("A"), observer);
  assert.equal(cache.getOrCreate("A", () => compiled("unused"), observer), first);
  cache.getOrCreate("B", () => compiled("B"), observer);
  cache.getOrCreate("C", () => compiled("C"), observer);
  assert.deepEqual(events, ["miss", "hit", "miss", "miss", "evict"]);
  assert.deepEqual(destroyed, ["A"]);
  assert.equal(cache.size, 2);
  cache.destroy();
  assert.deepEqual(destroyed, ["A", "B", "C"]);
  cache.destroy();
  assert.deepEqual(destroyed, ["A", "B", "C"]);

  const failing = new CompiledFrameGraphCache(1);
  assert.throws(
    () => failing.getOrCreate("broken", () => {
      throw new Error("compile failed");
    }, observer),
    /compile failed/
  );
  assert.equal(failing.size, 0);
});

test("disabled feature contributes no pass, resource or history binding", () => {
  const compileRecipe = (enabled) => {
    const graph = new FrameGraph("feature-pruning");
    const swapchain = graph.import_resource(
      "swapchain",
      { kind: "imported", label: "swapchain" },
      {}
    );
    if (enabled) {
      const history = graph.import_resource(
        "taa-history",
        { kind: "imported", label: "taa-history" },
        {}
      );
      const pass = graph.add("TAA", {}, () => {});
      pass.read(history);
      pass.write(swapchain);
    } else {
      const pass = graph.add("Tonemap", {}, () => {});
      pass.write(swapchain);
    }
    return graph.compile().dump();
  };
  const disabled = compileRecipe(false);
  assert.equal(disabled.passes.some((pass) => pass.name === "TAA"), false);
  assert.equal(
    disabled.resources.some((resource) => resource.name === "taa-history"),
    false
  );
  const enabled = compileRecipe(true);
  assert.equal(enabled.passes.some((pass) => pass.name === "TAA"), true);
  assert.equal(
    enabled.resources.some((resource) => resource.name === "taa-history"),
    true
  );
});
