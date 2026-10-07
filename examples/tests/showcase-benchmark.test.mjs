import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCapture, compareCaptures, validGpuFrame } from "../demos/14-integrated/next-renderer-showcase/BenchmarkMetrics.ts";

function frame(frameIndex, durations, extra = {}) {
  return { frameIndex, cpuMs: { frame: 2 }, counters: {}, submits: { count: 1 }, uploads: { bytes: 0 }, readbacks: { bytes: 0 },
    gpu: { available: true, sampled: true, pending: false, segments: durations.map(durationMs => ({ label: "SurfaceV4/native opaque", phase: "material", durationMs })) },
    gpuCounters: { sampled: false, pending: false, dropped: false, values: {} }, gpuValid: true, ...extra };
}
test("fixed capture aggregates repeated intervals per frame and retains long tails", () => {
  const result = summarizeCapture([frame(1, [1, 9]), frame(2, [90, 10])]);
  assert.equal(result.gpuPassSumMs.p50, 10);
  assert.equal(result.gpuPassSumMs.p95, 100);
  assert.equal(result.passes[0].p95, 100);
  assert.deepEqual(result.slowFrames, [2]);
});
test("late patches replace by frame id; missing timestamp results remain explicit", () => {
  const pending = frame(1, []); pending.gpu.pending = true;
  const result = summarizeCapture([pending, frame(1, [4]), frame(2, [])]);
  assert.equal(result.submitted, 2); assert.equal(result.completedGpu, 1);
  assert.deepEqual(result.invalidGpuFrameIds, [2]);
  assert.equal(validGpuFrame(frame(3, [0])), false);
  assert.equal(validGpuFrame(frame(3, [NaN])), false);
});
test("counters require completed readback; absent values never become zero", () => {
  const complete = frame(1, [4]); complete.gpuCounters = { sampled: true, pending: false, dropped: false, values: { geometryVisiblePixels: 100 } };
  const pending = frame(2, [4]); pending.gpuCounters = { ...complete.gpuCounters, pending: true, values: { geometryVisiblePixels: 0 } };
  const result = summarizeCapture([complete, pending]);
  assert.equal(result.counters.geometryVisiblePixels.count, 1);
  assert.equal(result.counters.geometryVisiblePixels.min, 100);
  assert.equal(result.counters.iblSampledPixels, undefined);
});
test("condition drift and incomplete GPU measurements forbid comparison", () => {
  const a = { conditions: { camera: [1, 2], extent: [1280, 720] }, frames: [frame(1, [10])] };
  assert.throws(() => compareCaptures(a, { ...a, conditions: { camera: [1, 3] } }), /conditions differ/);
  assert.throws(() => compareCaptures(a, { ...a, frames: [frame(2, [])] }), /Incomplete/);
  assert.equal(compareCaptures(a, { ...a, frames: [frame(2, [5])] }).p50Ratio, 0.5);
});

test("full-frame and Surface spans retain encoder gaps and subtract bigint clocks exactly",()=>{
 const first=frame(1,[1,1]);
 const base=1000000000000000000n;
 first.gpu.segments=[
  {label:"SurfaceV4/bins classify",durationMs:1,startTick:String(base),endTick:String(base+1000000n)},
  {label:"SurfaceV4/native opaque",durationMs:1,startTick:String(base+11000000n),endTick:String(base+12000000n)},
  {label:"Present",durationMs:1,startTick:String(base+13000000n),endTick:String(base+14000000n)}
 ];
 const summary=summarizeCapture([first]);
 assert.equal(summary.surfacePassSumMs.p50,2);
 assert.equal(summary.surfaceSpanMs.p50,12);
 assert.equal(summary.gpuFrameSpanMs.p50,14);
 assert.equal(summary.surfacePhases.nativeSun,undefined,'Missing phase has no measured duration');
});

test('span and semantic stage do not double-count pass sum; same-frame costs precede percentiles',()=>{
 const first=frame(1,[]);
 first.gpu.segments=[{label:'Renderer/frame-span',scope:'span',durationMs:20},{label:'Renderer/native-surface',scope:'stage',durationMs:17},
 {label:'SurfaceV4/bins classify',scope:'pass',durationMs:3},{label:'SurfaceV4/native opaque',scope:'pass',durationMs:5},{label:'SurfaceV4/empty background',scope:'pass',durationMs:2}];
 const summary=summarizeCapture([first]);
 assert.equal(summary.gpuPassSumMs.p50,10);assert.equal(summary.gpuFrameSpanMs.p50,20);assert.equal(summary.surfaceSpanMs.p50,17);
 assert.equal(summary.pairedCosts.surfaceManagementMs.p50,3);assert.equal(summary.pairedCosts.surfaceEvaluationMs.p50,5);assert.equal(summary.pairedCosts.outsidePassMs.p50,10);
 const coarse=frame(2,[]);coarse.gpu.segments=[{label:'Renderer/frame-span',scope:'span',durationMs:20}];
 assert.equal(summarizeCapture([coarse]).surfacePassSumMs,null);assert.equal(summarizeCapture([coarse]).gpuPassSumMs,null);
 first.counters['gpu.timing.truncated']=1;assert.equal(validGpuFrame(first),false);
});

test('Present surface stage cannot replace the native Surface span',()=>{
 const first=frame(1,[]);const base=1000000000000000000n;
 first.gpu.segments=[
  {label:'Renderer/surface',scope:'stage',durationMs:0.2},
  {label:'SurfaceV4/bins count',scope:'pass',durationMs:1,startTick:String(base),endTick:String(base+1000000n)},
  {label:'SurfaceV4/native opaque',scope:'pass',durationMs:4,startTick:String(base+1100000n),endTick:String(base+5100000n)}
 ];
 assert.equal(summarizeCapture([first]).surfaceSpanMs.p50,5.1);
 first.gpu.segments=first.gpu.segments.slice(0,1);
 assert.equal(summarizeCapture([first]).surfaceSpanMs,null);
});
