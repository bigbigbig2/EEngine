import assert from "node:assert/strict";
import test from "node:test";
import { FrameCoordinator } from "../../.test-dist/render/FrameCoordinator.js";

function harness(profiled = false) {
  const pending = [];
  const coordinator = new FrameCoordinator({ profiler: { enabled: profiled } }, (_, label) => {
    let resolve, reject;
    const gpuDone = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const command = {
      label,
      gpuDone,
      closed: false,
      submittedAtMs: null,
      finish() {
        this.submittedAtMs = performance.now();
        this.closed = true;
      },
      abort() {
        this.closed = true;
      },
    };
    pending.push({ resolve, reject });
    return command;
  });
  return { coordinator, pending };
}

test("completion evidence observes the existing two-frame fence and separates failures", async () => {
  const { coordinator, pending } = harness(true);
  coordinator.submitFrame(coordinator.beginFrame(0, "frame"));
  coordinator.submitFrame(coordinator.beginFrame(1, "frame"));
  assert.equal(coordinator.canBeginFrame, false);
  assert.equal(coordinator.evidence().inFlight, 2);
  assert.equal(coordinator.evidence().completionSamples.length, 0);
  pending[0].resolve();
  await Promise.resolve();
  assert.equal(coordinator.canBeginFrame, true);
  const evidence = coordinator.evidence();
  assert.equal(evidence.submittedCount, 2);
  assert.equal(evidence.completedCount, 1);
  assert.equal(evidence.completionSamples[0].frameIndex, 0);
  assert.equal(evidence.completionSamples[0].profiled, true);
  assert.ok(evidence.completionSamples[0].elapsedMs >= 0);
  assert.throws(() => {
    evidence.completionSamples[0].frameIndex = 9;
  }, TypeError);
  pending[1].reject(new Error("device lost"));
  await Promise.resolve();
  assert.equal(coordinator.evidence().inFlight, 0);
  assert.equal(coordinator.evidence().completedCount, 1);
  assert.equal(coordinator.evidence().failedCompletionCount, 1);
});

test("abort and destruction do not publish successful completion samples", async () => {
  const { coordinator, pending } = harness();
  coordinator.abortFrame(coordinator.beginFrame(0, "abort"), new Error("abort"));
  assert.equal(coordinator.evidence().submittedCount, 0);
  coordinator.submitFrame(coordinator.beginFrame(1, "frame"));
  coordinator.destroy();
  pending[1].resolve();
  await Promise.resolve();
  assert.equal(coordinator.evidence().inFlight, 0);
  assert.equal(coordinator.evidence().completionSamples.length, 0);
  assert.equal(coordinator.canBeginFrame, false);
});

test("completion samples remain bounded without retaining frame commands", async () => {
  const { coordinator, pending } = harness();
  for (let frame = 0; frame < 650; frame++) {
    coordinator.submitFrame(coordinator.beginFrame(frame, "frame"));
    pending[frame].resolve();
    await Promise.resolve();
  }
  const evidence = coordinator.evidence();
  assert.equal(evidence.completedCount, 650);
  assert.equal(evidence.completionSamples.length, 600);
  assert.equal(evidence.completionSamples[0].frameIndex, 50);
  assert.equal(evidence.completionSamples.at(-1).profiled, false);
});

test("bounded two/three policy retains pending frames and rejects unbounded admission", async () => {
  const { coordinator, pending } = harness();
  coordinator.submitFrame(coordinator.beginFrame(0, "frame"));
  coordinator.submitFrame(coordinator.beginFrame(1, "frame"));
  assert.equal(coordinator.canBeginFrame, false);
  coordinator.maxFramesInFlight = 3;
  coordinator.submitFrame(coordinator.beginFrame(2, "frame"));
  assert.equal(coordinator.canBeginFrame, false);
  assert.throws(() => {
    coordinator.maxFramesInFlight = 4;
  }, /2 or 3/);
  coordinator.maxFramesInFlight = 2;
  pending[0].resolve();
  await Promise.resolve();
  assert.equal(coordinator.canBeginFrame, false);
  pending[1].resolve();
  await Promise.resolve();
  assert.equal(coordinator.canBeginFrame, true);
  const evidence = coordinator.evidence();
  assert.equal(evidence.peakInFlight, 3);
  assert.equal(evidence.submissionSamples.length, 3);
  assert.throws(() => {
    evidence.submissionSamples[0].inFlight = 99;
  }, TypeError);
  assert.throws(() => evidence.submissionSamples.push({}), TypeError);
  assert.ok(evidence.submissionSamples[1].intervalMs >= 0);
  assert.ok(evidence.completionSamples[0].observedAtMs >= evidence.submissionSamples[0].submittedAtMs);
  pending[2].resolve();
  coordinator.destroy();
});

test("deferred host wakes once after reuse observers and never creates its own frame", async () => {
  const { coordinator, pending } = harness();
  const events = [];
  coordinator.onFrameAvailable.add(() => events.push("ready"));
  const first = coordinator.beginFrame(0, "frame");
  coordinator.submitFrame(first);
  coordinator.submitFrame(coordinator.beginFrame(1, "frame"));
  first.command.gpuDone.then(() => events.push("reuse"));
  coordinator.deferFrame();
  coordinator.deferFrame();
  pending[0].resolve();
  pending[1].resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["reuse"]);
  await Promise.resolve();
  assert.deepEqual(events, ["reuse", "ready"]);
  assert.equal(coordinator.evidence().submittedCount, 2);
  coordinator.destroy();
});

test("intervening RAF or teardown cancels a completion wakeup", async () => {
  for (const destroy of [false, true]) {
    const { coordinator, pending } = harness();
    let wakes = 0;
    coordinator.onFrameAvailable.add(() => {
      wakes++;
    });
    coordinator.submitFrame(coordinator.beginFrame(0, "frame"));
    coordinator.deferFrame();
    pending[0].resolve();
    await Promise.resolve();
    if (destroy) coordinator.destroy();
    else coordinator.abortFrame(coordinator.beginFrame(1, "RAF"));
    await Promise.resolve();
    assert.equal(wakes, 0);
    coordinator.destroy();
  }
});

test("three bounded contexts honor profile changes, abort and rejected completion", async () => {
  const { coordinator, pending } = harness();
  coordinator.admissionProfile = "throughput";
  const frames = [];
  for (let i = 0; i < 3; i++) {
    const frame = coordinator.beginFrame(i, "frame");
    frames.push(frame);
    coordinator.submitFrame(frame);
  }
  assert.equal(new Set(frames.map((frame) => frame.slotIndex)).size, 3);
  assert.equal(coordinator.canBeginFrame, false);
  assert.throws(() => coordinator.beginFrame(3, "overflow"), /completion/);
  coordinator.admissionProfile = "latency";
  pending[0].resolve();
  await Promise.resolve();
  assert.equal(coordinator.canBeginFrame, false, "lower limit must drain existing submissions");
  pending[1].reject(new Error("loss"));
  await Promise.resolve();
  assert.equal(coordinator.canBeginFrame, true);
  const retry = coordinator.beginFrame(3, "retry");
  assert.equal(retry.slotIndex, frames[0].slotIndex);
  coordinator.abortFrame(retry, new Error("abort"));
  assert.equal(coordinator.evidence().inFlight, 1);
  assert.equal(coordinator.evidence().inFlightLimit, 2);
  assert.equal(coordinator.evidence().frameContextCapacity, 3);
  assert.throws(() => {
    coordinator.admissionProfile = "unbounded";
  }, /Unknown/);
  coordinator.destroy();
  pending[2].resolve();
  await Promise.resolve();
  assert.equal(coordinator.canBeginFrame, false);
});
