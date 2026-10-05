import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUShaderStage = { COMPUTE: 1 };
const [{ GPUViewContext }, { GPUCameraState }] = await Promise.all([
  import("../../.test-dist/render/ViewContext.js"),
  import("../../.test-dist/render/GPUCameraState.js"),
]);

function signal() {
  const handlers = [];
  return {
    addOne(handler) {
      handlers.push(handler);
    },
    dispatch(...args) {
      for (const handler of handlers.splice(0)) handler(...args);
    },
  };
}

function command(copies) {
  return {
    gpu_encoder: {
      copyBufferToBuffer(...args) {
        copies.push(args);
      },
    },
    onFinished: signal(),
    onAborted: signal(),
  };
}

test("View camera mirror, HZB publication and frame index commit only after submit", () => {
  const view = Object.create(GPUViewContext.prototype);
  const sourceBuffer = { size: 64 };
  const previousBuffer = { size: 64 };
  let cpuCopies = 0;
  let hzbCommits = 0;
  let hzbInvalidations = 0;
  view.camera = { buffer: sourceBuffer };
  view.gpu_previous_camera_state = {
    buffer: previousBuffer,
    copyCpu(source) {
      assert.equal(source, view.camera);
      cpuCopies++;
    },
  };
  view.hierarchical_z_buffer = {
    commitHistory(index) {
      assert.equal(index, 9);
      hzbCommits++;
    },
    invalidate(reason) {
      assert.equal(reason, "explicit");
      hzbInvalidations++;
    },
  };
  view.frame_index = 3;
  const copies = [];
  const aborted = command(copies);
  view.finish_frame(aborted, 9);
  assert.deepEqual(copies, [[sourceBuffer, 0, previousBuffer, 0, 64]]);
  assert.equal(view.frame_index, 3);
  assert.equal(cpuCopies, 0);
  aborted.onAborted.dispatch(aborted, new Error("encode failed"));
  assert.equal(hzbInvalidations, 1);
  assert.equal(hzbCommits, 0);
  assert.equal(cpuCopies, 0);
  assert.equal(view.frame_index, 3);

  const submitted = command(copies);
  view.finish_frame(submitted, 9);
  submitted.onFinished.dispatch(submitted);
  assert.equal(cpuCopies, 1);
  assert.equal(hzbCommits, 1);
  assert.equal(view.frame_index, 4);
});

test("new View seeds previous camera from the uploaded current camera within its frame", () => {
  const view = Object.create(GPUViewContext.prototype);
  const current = { size: 64 };
  const previous = { size: 64 };
  const order = [];
  view.frame_index = 0;
  view.camera = {
    buffer: current,
    update() {
      order.push("upload-current");
    },
  };
  view.gpu_previous_camera_state = {
    buffer: previous,
    copyCpu(source) {
      assert.equal(source, view.camera);
      order.push("seed-cpu");
    },
  };
  view.update_uniforms = () => order.push("upload-view");
  view.graphics = { profiler: { addCounter() {} } };
  const frame = command([]);
  frame.gpu_encoder.copyBufferToBuffer = (...args) => {
    assert.deepEqual(args, [current, 0, previous, 0, 64]);
    order.push("seed-gpu");
  };
  view.update(frame);
  assert.deepEqual(order, ["upload-current", "seed-gpu", "seed-cpu", "upload-view"]);
  order.length = 0;
  view.frame_index = 1;
  view.update(frame);
  assert.deepEqual(order, ["upload-current", "upload-view"]);
});

test("GPUCameraState can update its CPU mirror without a separate GPU submission", () => {
  const mirror = Object.create(GPUCameraState.prototype);
  let copiedCamera;
  mirror.cameraValue = {
    copy(value) {
      copiedCamera = value;
    },
  };
  mirror.viewportOffset = new Float32Array(2);
  mirror.viewProjection = new Float32Array(16);
  mirror.currentProjection = new Float32Array(16);
  const source = {
    camera: { id: 7 },
    viewportOffset: new Float32Array([0.2, -0.3]),
    viewProjection: Float32Array.from({ length: 16 }, (_, index) => index + 1),
    currentProjection: Float32Array.from({ length: 16 }, (_, index) => index + 17),
  };
  mirror.copyCpu(source);
  assert.equal(copiedCamera, source.camera);
  assert.deepEqual([...mirror.viewportOffset], [...source.viewportOffset]);
  assert.deepEqual([...mirror.view_projection_matrix], [...source.viewProjection]);
  assert.deepEqual([...mirror.projection_matrix], [...source.currentProjection]);
});
