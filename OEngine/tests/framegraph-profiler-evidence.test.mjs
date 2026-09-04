import test from "node:test";
import assert from "node:assert/strict";

import { FrameGraph } from "../.test-dist/framegraph/FrameGraph.js";

test("frame graph evidence distinguishes compiled executable and culled passes", () => {
  const graph = new FrameGraph("evidence");
  const output = graph.import_resource("output", { kind: "imported" }, {});
  const keptPass = graph.add("kept-pass", {}, () => {});
  const kept = keptPass.create("kept", { kind: "transient_buffer", size: 16, usage: 1 });
  graph.add("culled-pass", {}, () => {})
    .create("unused", { kind: "transient_buffer", size: 16, usage: 1 });
  const present = graph.add("present-pass", {}, () => {});
  present.read(kept);
  present.write(output);
  assert.equal(graph.evidence().compiled, false);
  graph.compile();
  const evidence = graph.evidence();
  assert.equal(evidence.compiled, true);
  assert.equal(evidence.totalPasses, 3);
  assert.equal(evidence.executablePasses, 2);
  assert.equal(evidence.culledPasses, 1);
  assert.equal(evidence.transientResources, 2);
});
