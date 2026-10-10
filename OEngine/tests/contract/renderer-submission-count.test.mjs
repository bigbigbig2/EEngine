import assert from "node:assert/strict";
import test from "node:test";
import { FrameProgramCache } from "../../.test-dist/render/program/FrameProgram.js";
import { ChangeSignal } from "../../.test-dist/core/Signal.js";

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage = {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16
};
globalThis.GPUBufferUsage = {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512
};
const { Renderer } = await import("../../.test-dist/render/pipeline/RendererCore.js");

function harness(failure) {
  const error = new Error(failure);
  const command = {
    closed: false,
    wasSubmitted: false,
    encodeCompiledGraph() {
      if (failure === "encode") throw error;
    }
  };
  const renderer = Object.create(Renderer.prototype);
  Object.assign(renderer, {
    _frame_count: 0,
    _historyRuntime: null,
    deviceEpoch: 1,
    _output_resolution: { x: 1920, y: 1080 },
    _format: "bgra8unorm",
    _graphics: { encodeFrameMaintenance() {} },
    context: { getCurrentTexture: () => ({ createView: () => ({}) }) },
    _programCache: new FrameProgramCache(),
    _graphCache: { getOrCreate: () => ({}) },
    _profiler: { beginFrame() {}, endFrame() {} },
    _frameCoordinator: {
      beginFrame: () => ({ command }),
      abortFrame() {
        command.closed = true;
      },
      submitFrame() {
        if (failure === "submit-before") throw error;
        command.wasSubmitted = true;
        command.closed = true;
        if (failure === "submit-after") throw error;
      }
    },
    onFrameFinished: new ChangeSignal()
  });
  return { renderer, error };
}

test("Renderer counts actual empty-frame submission, not failed encoding/admission", () => {
  for (const failure of ["encode", "submit-before", "submit-after", "none"]) {
    const { renderer, error } = harness(failure);
    const notifications = [];
    renderer.onFrameFinished.add((count) => notifications.push(count));
    if (failure === "none") assert.equal(renderer.renderEmptyScene(), true);
    else
      assert.throws(
        () => renderer.renderEmptyScene(),
        (cause) => cause === error
      );
    const submitted = failure === "none" || failure === "submit-after";
    assert.equal(renderer.frame_count, Number(submitted));
    assert.deepEqual(notifications, submitted ? [1] : []);
  }
});

test("post-submit failure after counter update does not double-count a frame", () => {
  const { renderer } = harness("none");
  // Inject at the notification seam; ChangeSignal itself isolates its handlers.
  renderer.onFrameFinished = {
    send1() {
      throw new Error("observer");
    }
  };
  assert.throws(() => renderer.renderEmptyScene(), /observer/);
  assert.equal(renderer.frame_count, 1);
});

test("production scene encoding abort does not count a submitted frame", () => {
  const { renderer } = harness("none");
  const runtime = { nativeMaterials: { canPrepareFrame: () => true } };
  Object.assign(renderer, {
    pixelRatioOverride: 1,
    appliedPixelRatio: 1,
    _historyRuntime: runtime,
    _virtualProductScenes: new Map(),
    promotedTextureRuntimes: new WeakSet(),
    _surface: { canPrepareFrame: () => true, abort() {} },
    _fsr3: { invalidate() {} },
    _temporalFacts: { abort() {} },
    _gpuRadiometry: { abort() {} },
    _graphics: {
      render_world_if_created: { runtime: () => runtime },
      texture_residency: {
        promote() {
          throw new Error("encode failure");
        }
      }
    }
  });
  renderer._frameCoordinator.canBeginFrame = true;
  assert.throws(() => renderer.render({}, {}, 0.02), /encode failure/);
  assert.equal(renderer.frame_count, 0);
});

test("scene admission defer does not advance frame count or any history owner", () => {
  const { renderer } = harness("none");
  renderer._frameCoordinator.canBeginFrame = false;
  let defers = 0;
  renderer._frameCoordinator.deferFrame = () => defers++;
  renderer._completionDeferredTicks = 0;
  assert.equal(renderer.render({}, {}, 0.02), true);
  assert.equal(renderer.frame_count, 0);
  assert.equal(defers, 1);
  assert.equal(renderer._lastFrameDeferral, "gpu-completion");
  assert.equal(renderer._historyRuntime, null);
});
