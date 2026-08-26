import test from "node:test";
import assert from "node:assert/strict";

import { counterByteOffset } from "../.test-dist/debug/GpuFrameCounters.js";
import {
  FrameGraph,
  FrameGraphContext
} from "../.test-dist/framegraph/FrameGraph.js";
import {
  addGpuCounterCopyPass
} from "../.test-dist/debug/GpuCounterCopyPass.js";

test("GPU counter copy pass copies a producer count into the fixed ABI", () => {
  const graph = new FrameGraph("gpu-counter-copy-test");
  const source = fakeBuffer(16);
  const counters = fakeBuffer(256);
  new Uint32Array(source.bytes.buffer)[0] = 37;
  const sourceResource = graph.import_resource(
    "active light list",
    { kind: "imported" },
    source
  );
  const counterResource = graph.import_resource(
    "frame counters",
    { kind: "imported" },
    counters
  );

  addGpuCounterCopyPass(
    graph,
    "activeLights",
    sourceResource,
    counterResource
  );
  graph.compile();
  graph.execute(new FrameGraphContext({
    encoder: { gpu_encoder: fakeEncoder() }
  }));

  const values = new Uint32Array(counters.bytes.buffer);
  assert.equal(
    values[counterByteOffset("activeLights") / Uint32Array.BYTES_PER_ELEMENT],
    37
  );
});

test("GPU counter copy pass validates the source ABI offset", () => {
  const graph = new FrameGraph("gpu-counter-copy-offset-test");
  const sourceResource = graph.import_resource(
    "source",
    { kind: "imported" },
    fakeBuffer(16)
  );
  const counterResource = graph.import_resource(
    "counters",
    { kind: "imported" },
    fakeBuffer(256)
  );

  assert.throws(
    () => addGpuCounterCopyPass(
      graph,
      "activeLights",
      sourceResource,
      counterResource,
      2
    ),
    /sourceOffset/
  );
});

function fakeBuffer(size) {
  return {
    size,
    usage: 0,
    bytes: new Uint8Array(size)
  };
}

function fakeEncoder() {
  return {
    copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
      destination.bytes.set(
        source.bytes.subarray(sourceOffset, sourceOffset + size),
        destinationOffset
      );
    }
  };
}
