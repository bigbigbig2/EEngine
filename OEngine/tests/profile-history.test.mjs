import test from "node:test";
import assert from "node:assert/strict";

import { ProfileHistory } from "../.test-dist/debug/profiling/ProfileHistory.js";

const frame = (frameIndex) => ({
  schemaVersion: 1,
  frameIndex,
  epoch: 1,
  warmup: false,
  visibilityState: "visible",
  samples: {},
  spans: [],
  gpuCounterSchemaVersion: 1,
  timestampInstrumented: false,
  counterInstrumented: false,
  complete: false
});

test("profile history patches original frames immutably and reports orphaned results", () => {
  const history = new ProfileHistory(2);
  const first = frame(4);
  history.add(first);
  const original = history.get(4);
  const patched = history.patch(4, { complete: true });
  assert.equal(original.complete, false);
  assert.equal(patched.status, "updated");
  assert.equal(history.get(4).complete, true);

  history.add(frame(5));
  history.add(frame(6));
  assert.equal(history.get(4), undefined);
  assert.equal(history.patch(4, { complete: true }).status, "orphaned");
});

test("profile history selects an inclusive frame range", () => {
  const history = new ProfileHistory(8);
  for (const index of [2, 4, 6]) history.add(frame(index));
  assert.deepEqual(history.selectRange(3, 6).map((value) => value.frameIndex), [4, 6]);
  assert.throws(() => history.selectRange(6, 3), /range/);
});

test("profile history rejects changes to terminal sample states", () => {
  const history = new ProfileHistory();
  history.add({
    ...frame(7),
    samples: {
      "gpu.passSumMs": {
        metricId: "gpu.passSumMs",
        value: 1,
        availability: "available",
        sourceFrameIndex: 7,
        resolvedAtFrameIndex: 8,
        instrumented: true
      }
    }
  });

  assert.throws(() => history.patch(7, {
    samples: {
      "gpu.passSumMs": {
        metricId: "gpu.passSumMs",
        value: null,
        availability: "pending",
        sourceFrameIndex: 7,
        resolvedAtFrameIndex: null,
        instrumented: true
      }
    }
  }), /state transition/);
});
