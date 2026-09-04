import test from "node:test";
import assert from "node:assert/strict";

import { FrameProfiler } from "../.test-dist/debug/FrameProfiler.js";

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
});
