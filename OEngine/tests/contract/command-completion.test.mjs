import assert from "node:assert/strict";
import test from "node:test";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";

function fixture() {
  const fences = [];
  const device = {
    createCommandEncoder: () => ({ finish: () => ({}) }),
    queue: {
      submit() {},
      onSubmittedWorkDone() {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        fences.push({ promise, resolve });
        return promise;
      }
    }
  };
  const graphics = {
    device,
    profiler: { enabled: false, attachGpuTimingContext() {} },
    buffer_allocator_main: {},
    buffer_allocator_staging: {}
  };
  const create = () => ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
  return { create, fences };
}

test("submission captures one exact queue-prefix fence shared by all owners", async () => {
  const f = fixture();
  const first = f.create();
  const early = first.gpuDone;
  let destroyed = 0,
    completed = false;
  first.destroyAfterGpuDone({
    destroy() {
      destroyed++;
    }
  });
  first.destroyAfterGpuDone({
    destroy() {
      destroyed++;
    }
  });
  void early.then(() => {
    completed = true;
  });
  first.finish();
  assert.equal(f.fences.length, 1);
  assert.equal(first.gpuDone, early, "pre/post-submit owners must observe the same future");
  const second = f.create();
  second.finish();
  // Submit again in the same JS turn, before early observers' microtasks run.
  await Promise.resolve();
  assert.equal(f.fences.length, 2, "lazy observers must not register another queue drain");
  assert.equal(destroyed, 0);
  f.fences[0].resolve();
  await early;
  assert.equal(completed, true);
  assert.equal(destroyed, 2, "later pending submission must not extend first resource lifetime");
  f.fences[1].resolve();
  await second.gpuDone;
});

test("unsubmitted abort rejects completion and protects resources used by prior work", async () => {
  const f = fixture();
  const command = f.create();
  const done = command.gpuDone;
  const cause = new Error("discard encoder");
  let destroyed = false;
  command.destroyAfterGpuDone({
    destroy() {
      destroyed = true;
    }
  });
  command.abort(cause);
  await assert.rejects(done, (error) => error === cause);
  assert.equal(command.submittedAtMs, null);
  assert.equal(destroyed, false);
  assert.equal(f.fences.length, 1, "abort retirement still fences earlier submitted users");
  f.fences[0].resolve();
  await Promise.resolve();
  assert.equal(destroyed, true);
});
