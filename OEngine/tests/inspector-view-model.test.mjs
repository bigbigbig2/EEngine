import test from "node:test";
import assert from "node:assert/strict";

import { FrameProfiler } from "../.test-dist/debug/FrameProfiler.js";
import { Inspector } from "../.test-dist/addons/inspector/Inspector.js";
import { InspectorViewModel } from "../.test-dist/addons/inspector/InspectorViewModel.js";
import { createPerformanceCapture } from "../.test-dist/debug/profiling/PerformanceCapture.js";

function createProfiler() {
  return new FrameProfiler({
    enabled: true,
    gpuTimestampAvailable: true,
    gpuSampleInterval: 1,
    historyCapacity: 8
  });
}

test("InspectorViewModel owns mode, pause and frame selection state", () => {
  const profiler = createProfiler();
  const model = new InspectorViewModel(profiler);
  const updates = [];
  model.subscribe((state) => updates.push(state));

  profiler.beginFrame(1);
  profiler.endFrame();
  profiler.beginFrame(2);
  profiler.endFrame();

  assert.equal(model.mode, "live");
  model.setMode("record");
  assert.equal(model.mode, "record");
  model.pause();
  assert.equal(model.paused, true);
  model.resume();
  assert.equal(model.paused, false);

  model.selectFrame(1);
  assert.equal(model.selectedFrame?.frameIndex, 1);
  assert.deepEqual(
    model.selectRange(1, 2).map((frame) => frame.frameIndex),
    [1, 2]
  );
  assert.ok(updates.length >= 4);

  model.dispose();
  const updateCount = updates.length;
  profiler.beginFrame(3);
  profiler.endFrame();
  assert.equal(updates.length, updateCount);
  profiler.destroy();
});

test("InspectorViewModel follows asynchronous frame replacement and rejects stale selection", () => {
  const profiler = createProfiler();
  const model = new InspectorViewModel(profiler);
  const updates = [];
  model.subscribe((state) => updates.push(state));

  profiler.beginFrame(4);
  profiler.endFrame();
  model.selectFrame(4);
  const before = model.selectedFrame;
  profiler.recordGpuTimings(4, [
    { label: "visibility", type: "render", duration_ms: 1.25 }
  ]);

  assert.equal(model.selectedFrame?.gpu.pending, false);
  assert.notEqual(model.selectedFrame, before);
  assert.equal(model.selectedFrame?.gpu.segments[0].durationMs, 1.25);
  assert.throws(() => model.selectFrame(999), /unknown frame/i);
  assert.throws(() => model.selectRange(3, 2), /range/i);
  assert.ok(updates.length >= 3);

  model.dispose();
  profiler.destroy();
});

test("InspectorViewModel can replay an imported capture and restore live frames", () => {
  const profiler = createProfiler();
  profiler.beginFrame(7);
  profiler.endFrame();
  const capture = createPerformanceCapture({
    engine: { name: "test" },
    sampling: {
      mode: "record",
      warmupFrames: 0,
      timestampInterval: 1,
      counterInterval: 1,
      historyCapacity: 8
    },
    metricCatalog: profiler.metricCatalog,
    frames: [{
      schemaVersion: 1,
      frameIndex: 42,
      epoch: 0,
      warmup: false,
      visibilityState: "visible",
      samples: {},
      spans: [],
      gpuCounterSchemaVersion: 1,
      timestampInstrumented: false,
      counterInstrumented: false,
      complete: true
    }]
  });
  const model = new InspectorViewModel(profiler);
  model.loadCapture(capture);
  assert.equal(model.mode, "record");
  assert.deepEqual(model.frames.map((frame) => frame.frameIndex), [42]);
  model.selectFrame(42);
  assert.equal(model.selectedFrame?.frameIndex, 42);
  model.clearLoadedCapture();
  assert.deepEqual(model.frames.map((frame) => frame.frameIndex), [7]);
  profiler.destroy();
});

test("Inspector lifecycle restores a profiler that it enabled", () => {
  const profiler = createProfiler();
  profiler.configure({ enabled: false });
  const inspector = new Inspector({ profiler });
  assert.equal(profiler.enabled, true);
  inspector.startRecording();
  assert.equal(profiler.mode, "record");
  inspector.dispose();
  assert.equal(profiler.enabled, false);
  profiler.destroy();
});
