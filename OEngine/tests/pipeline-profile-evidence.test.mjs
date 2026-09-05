import test from "node:test";
import assert from "node:assert/strict";

import { FrameProfiler } from "../.test-dist/debug/FrameProfiler.js";
import { ComputePipelineCache } from "../.test-dist/gpu/GPUDescriptorCaches.js";

test("pipeline cache evidence is typed and retained in the frame record", () => {
  const profiler = new FrameProfiler({ enabled: true });
  profiler.beginFrame(12);
  profiler.recordCounter("pipeline.render.cacheHits", 3);
  profiler.recordCounter("pipeline.render.cacheMisses", 1);
  profiler.addCounter("pipeline.render.createCount", 1);
  profiler.addCounter("pipeline.render.hostCallMs", 0.25);
  const frame = profiler.endFrame();

  assert.equal(frame.counters["pipeline.render.cacheHits"], 3);
  assert.equal(frame.counters["pipeline.render.cacheMisses"], 1);
  assert.equal(frame.counters["pipeline.render.createCount"], 1);
  assert.equal(frame.counters["pipeline.render.hostCallMs"], 0.25);
  assert.equal(profiler.historyStore.get(12).samples["pipeline.render.hostCallMs"].value, 0.25);
  assert.equal(profiler.metricRegistry.get("pipeline.render.hostCallMs").unit, "ms");
  assert.match(profiler.metricRegistry.get("pipeline.render.hostCallMs").description, /lazy|native compilation/i);
  assert.equal(profiler.metricRegistry.get("pipeline.render.firstUseCount").aggregation, "sum");
});

test("pipeline cache reports a first use once and distinguishes cache hits", () => {
  const events = [];
  const pipeline = Object.freeze({ label: "pipeline" });
  const cache = new ComputePipelineCache(
    {
      createComputePipeline() { return pipeline; }
    },
    { obtainPipelineLayout() { return Object.freeze({}); } },
    { obtain() { return Object.freeze({}); } },
    {
      onPipelineCacheHit(kind) { events.push(`${kind}:hit`); },
      onPipelineCacheMiss(kind) { events.push(`${kind}:miss`); },
      onPipelineFirstUse(kind) { events.push(`${kind}:first-use`); }
    }
  );
  const descriptor = {
    label: "compute",
    layout: { bindGroupLayouts: [] },
    compute: { module: { code: "@compute @workgroup_size(1) fn main() {}" }, entryPoint: "main" }
  };

  assert.equal(cache.obtain(descriptor), pipeline);
  assert.equal(cache.obtain(descriptor), pipeline);
  assert.deepEqual(events, ["compute:miss", "compute:first-use", "compute:hit"]);
});
