import assert from "node:assert/strict";
import test from "node:test";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { FrameCoordinator } from "../../.test-dist/render/FrameCoordinator.js";

test("publication failure retains submitted admission and settles pre-submit observers", async () => {
  const fences = [];
  const graphics = {
    device: {
      createCommandEncoder: () => ({ finish: () => ({}) }),
      queue: {
        submit() {},
        onSubmittedWorkDone: () => new Promise((resolve) => fences.push(resolve)),
      },
    },
    profiler: { attachGpuTimingContext() {} },
  };
  const coordinator = new FrameCoordinator(graphics);
  const error = new Error("publication failed after submit");
  const observers = [];
  for (let i = 0; i < 2; i++) {
    const frame = coordinator.beginFrame(i, "Renderer/visibility-frame");
    const finish = frame.command.finish.bind(frame.command);
    frame.command.finish = () => {
      finish();
      throw error;
    };
    observers.push(frame.command.gpuDone);
    assert.throws(
      () => coordinator.submitFrame(frame),
      (cause) => cause === error,
    );
    assert.equal(frame.command.wasSubmitted, true);
  }
  assert.equal(coordinator.canBeginFrame, false);
  assert.equal(coordinator.evidence().inFlight, 2);
  fences[0]();
  await observers[0];
  await Promise.resolve();
  assert.equal(coordinator.canBeginFrame, true);
  assert.equal(coordinator.evidence().completedCount, 1);
  fences[1]();
  await observers[1];
  await Promise.resolve();
  assert.equal(coordinator.evidence().inFlight, 0);
});

test("each submit captures one fence before publication callbacks submit later work", async () => {
  const pending = [],
    calls = [];
  const graphics = {
    device: {
      createCommandEncoder: () => ({ finish: () => ({}) }),
      queue: {
        submit: () => calls.push("submit"),
        onSubmittedWorkDone: () => {
          calls.push("fence");
          return new Promise((resolve) => pending.push(resolve));
        },
      },
    },
    profiler: { attachGpuTimingContext() {} },
  };
  const a = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
  const b = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
  const beforeSubmit = a.gpuDone;
  let firstComplete = false,
    secondComplete = false;
  beforeSubmit.then(() => {
    firstComplete = true;
  });
  a.onFinished.addOne(() => b.finish());
  a.finish();
  b.gpuDone.then(() => {
    secondComplete = true;
  });
  assert.equal(a.gpuDone, beforeSubmit);
  assert.deepEqual(calls, ["submit", "fence", "submit", "fence"]);
  pending[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstComplete, true);
  assert.equal(secondComplete, false);
  pending[1]();
  await b.gpuDone;
  assert.equal(secondComplete, true);
});
