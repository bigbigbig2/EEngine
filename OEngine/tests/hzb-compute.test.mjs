import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildHzbReference,
  hzbLevelDimensions,
  hzbMipLevelCount,
  isReverseZOccluded,
  reduceDepthToHzbLevel,
  sanitizeReverseZDepth
} from "../.test-dist/render/HzbReference.js";
import { HzbHistoryState } from "../.test-dist/render/HzbHistory.js";

test("HZB reference freezes mip dimensions including 1x1 and odd sizes", () => {
  assert.equal(hzbMipLevelCount(1, 1), 1);
  assert.equal(hzbMipLevelCount(640, 360), 10);
  assert.deepEqual(hzbLevelDimensions(7, 5, 0), [7, 5]);
  assert.deepEqual(hzbLevelDimensions(7, 5, 1), [3, 2]);
  assert.deepEqual(hzbLevelDimensions(7, 5, 2), [1, 1]);
});

test("HZB reference preserves reverse-Z min/max and reaches odd boundaries", () => {
  const depth = new Float32Array([
    0.1, 0.2, 0.3, 0.4, 0.5,
    0.2, 0.3, 0.4, 0.5, 0.6,
    0.3, 0.4, 0.5, 0.6, 0.7
  ]);
  const level = reduceDepthToHzbLevel(depth, 5, 3, 2, 1);
  assert.equal(level.width, 2);
  assert.equal(level.height, 1);
  assert.deepEqual(
    Array.from(level.minMax, (value) => Number(value.toFixed(4))),
    [0.1, 0.5, 0.3, 0.7]
  );
});

test("HZB reference handles all-far, all-near, NaN and 8x8 pyramid", () => {
  assert.equal(sanitizeReverseZDepth(Number.NaN), 0);
  assert.equal(sanitizeReverseZDepth(-2), 0);
  assert.equal(sanitizeReverseZDepth(2), 1);
  const far = buildHzbReference(new Float32Array(64), 8, 8);
  const near = buildHzbReference(new Float32Array(64).fill(1), 8, 8);
  assert.equal(far.length, 3);
  assert.deepEqual(far.map((level) => [level.width, level.height]), [[4, 4], [2, 2], [1, 1]]);
  assert.ok(far.every((level) => level.minMax.every((value) => value === 0)));
  assert.ok(near.every((level) => level.minMax.every((value) => value === 1)));
  const nan = reduceDepthToHzbLevel([Number.NaN], 1, 1, 1, 1);
  assert.deepEqual(Array.from(nan.minMax), [0, 0]);
});

test("reverse-Z compare rejects only a candidate fully behind the occluder", () => {
  assert.equal(isReverseZOccluded(0.2, 0.6), true);
  assert.equal(isReverseZOccluded(0.6, 0.6), false);
  assert.equal(isReverseZOccluded(0.8, 0.6), false);
});

const revision = (overrides = {}) => ({
  width: 640,
  height: 360,
  camera: 0,
  renderScale: 0,
  feature: 0,
  format: 1,
  ...overrides
});

test("HZB history exposes only committed previous data and ping-pongs after build", () => {
  const history = new HzbHistoryState();
  history.beginFrame(0, revision());
  assert.equal(history.valid, false);
  assert.equal(history.writeTextureIndex, 1);
  history.markBuilt();
  assert.equal(history.commit(0), true);
  assert.equal(history.valid, true);
  assert.equal(history.committedTextureIndex, 1);
  history.beginFrame(1, revision());
  assert.equal(history.valid, true);
  assert.equal(history.writeTextureIndex, 0);
});

test("HZB history invalidates on resize, cut, toggle and view discontinuity", () => {
  const cases = [
    [revision({ width: 800 }), "resize"],
    [revision({ camera: 1 }), "camera-cut"],
    [revision({ renderScale: 1 }), "render-scale"],
    [revision({ feature: 1 }), "feature-toggle"],
    [revision({ format: 2 }), "format-change"]
  ];
  for (const [next, reason] of cases) {
    const history = new HzbHistoryState();
    history.beginFrame(0, revision());
    history.markBuilt();
    history.commit(0);
    history.beginFrame(1, next);
    assert.equal(history.valid, false, reason);
    assert.equal(history.lastInvalidationReason, reason);
  }
  const switched = new HzbHistoryState();
  switched.beginFrame(0, revision());
  switched.markBuilt();
  switched.commit(0);
  switched.beginFrame(2, revision());
  assert.equal(switched.valid, false);
  assert.equal(switched.lastInvalidationReason, "view-switch");
});

test("HZB history refuses mismatched commit and does not commit an unbuilt frame", () => {
  const history = new HzbHistoryState();
  history.beginFrame(4, revision());
  assert.throws(() => history.commit(3), /does not match/);
  assert.equal(history.commit(4), false);
  assert.equal(history.valid, false);
});

test("production HZB has no render-pass fallback and exposes compute evidence", () => {
  const owner = readFileSync(new URL("../src/render/HierarchicalZBuffer.ts", import.meta.url), "utf8");
  const shader = readFileSync(new URL("../src/shaders/hzb_reduce.ts", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(owner, /beginRenderPass|GPURenderPipeline|RENDER_ATTACHMENT/);
  assert.match(owner, /beginComputePass\(\{ label: "HZB\/compute-pyramid"/);
  assert.match(shader, /texture_storage_2d<rg16float, write>/);
  assert.doesNotMatch(shader, /@vertex|@fragment/);
  for (const counter of [
    "hzb.computeBuilds",
    "hzb.computePasses",
    "hzb.dispatches",
    "hzb.outputPixels",
    "hzb.historyValid",
    "hzb.historyInvalidations"
  ]) {
    assert.match(renderer, new RegExp(counter.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(renderer, /legacy\.hzb\./);
});

test("HZB history commit is attached to submission, while abort invalidates it", () => {
  const viewContext = readFileSync(new URL("../src/render/ViewContext.ts", import.meta.url), "utf8");
  const finishBody = viewContext.slice(viewContext.indexOf("finish_frame("));
  assert.match(finishBody, /onFinished\.addOne[\s\S]*commitHistory/);
  assert.match(finishBody, /onAborted\.addOne[\s\S]*invalidate\("explicit"\)/);
  assert.doesNotMatch(
    finishBody,
    /copy\(this\.camera, command\.gpu_encoder\);\s*this\.hierarchical_z_buffer\.commitHistory/
  );
});

test("R1-C requests the storage-texture feature and captures WGSL diagnostics", () => {
  const example = readFileSync(new URL("../../examples/r1-compute-hzb/main.ts", import.meta.url), "utf8");
  assert.match(example, /requiredFeature[^\n]*texture-formats-tier1/);
  assert.match(example, /requestDevice\(\{ requiredFeatures: \[requiredFeature\] \}/);
  assert.match(example, /getCompilationInfo\(\)/);
  for (const field of ["label", "type", "message", "lineNum", "linePos", "offset", "length"]) {
    assert.match(example, new RegExp("\\b" + field + "\\b"));
  }
});

test("shader module cache retains compilation diagnostics for runtime owners", () => {
  const cache = readFileSync(new URL("../src/gpu/GPUDescriptorCaches.ts", import.meta.url), "utf8");
  assert.match(cache, /getCompilationInfo\(\)/);
  assert.match(cache, /compilationDiagnostics/);
  assert.match(cache, /get diagnostics\(\)/);
});
test("the renderer requires the storage format feature used by core HZB", () => {
  const renderer = readFileSync(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(renderer, /requiredFeatures:[\s\S]*texture-formats-tier1/);
  assert.doesNotMatch(renderer, /optionalFeatures:[\s\S]*texture-formats-tier1/);
});

test("HZB WGSL uses portable NaN sanitization", () => {
  const shader = readFileSync(new URL("../src/shaders/hzb_reduce.ts", import.meta.url), "utf8");
  assert.match(shader, /depth != depth/);
  assert.doesNotMatch(shader, /isNan\(/);
});
