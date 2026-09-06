import test from "node:test";
import assert from "node:assert/strict";

import { FrameProfiler } from "../.test-dist/debug/FrameProfiler.js";
import { Inspector } from "../.test-dist/addons/inspector/Inspector.js";
import { InspectorViewModel } from "../.test-dist/addons/inspector/InspectorViewModel.js";
import { LiveProfilerStore } from "../.test-dist/addons/inspector/LiveProfilerStore.js";

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

  assert.equal(model.mode, "monitor");
  model.setMode("record");
  assert.equal(model.mode, "record");
  model.pause();
  assert.equal(model.paused, true);
  const pausedUpdateCount = updates.length;
  profiler.beginFrame(3);
  profiler.endFrame();
  assert.equal(updates.length, pausedUpdateCount);
  model.resume();
  assert.equal(model.paused, false);

  model.setFollowLatest(true);
  assert.equal(model.followLatest, true);
  assert.equal(model.snapshot().selectedFrameIndex, null);
  model.selectFrame(1);
  assert.equal(model.followLatest, false);
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

  assert.equal(model.selectedFrame?.samples["gpu.passSumMs"]?.availability, "available");
  assert.notEqual(model.selectedFrame, before);
  assert.equal(model.selectedFrame?.samples["gpu.passSumMs"]?.value, 1.25);
  assert.throws(() => model.selectFrame(999), /unknown frame/i);
  assert.throws(() => model.selectRange(3, 2), /range/i);
  assert.ok(updates.length >= 3);

  model.dispose();
  profiler.destroy();
});

test("InspectorViewModel keeps one live source and exposes high-detail mode", () => {
  const profiler = createProfiler();
  profiler.beginFrame(7);
  profiler.endFrame();
  const model = new InspectorViewModel(profiler);
  assert.equal(model.snapshot().source, "live");
  assert.deepEqual(model.frames.map((frame) => frame.frameIndex), [7]);
  model.setMode("high-detail");
  assert.equal(model.mode, "high-detail");
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

test("LiveProfilerStore keeps bounded live selection state independent from the renderer", () => {
  const profiler = createProfiler();
  const store = new LiveProfilerStore(profiler);
  const updates = [];
  store.subscribe((state) => updates.push(state));
  profiler.beginFrame(11);
  profiler.endFrame();
  profiler.beginFrame(12);
  profiler.endFrame();
  store.selectFrame(11);
  assert.equal(store.state.followLatest, false);
  assert.equal(store.selectedFrame?.frameIndex, 11);
  store.setFollowLatest(true);
  assert.equal(store.selectedFrame, undefined);
  assert.equal(store.state.frames.at(-1)?.frameIndex, 12);
  assert.ok(updates.length >= 3);
  store.dispose();
  profiler.destroy();
});
