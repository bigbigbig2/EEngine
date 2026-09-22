import test from "node:test";
import assert from "node:assert/strict";
import { classifyGpuSubmitLabel } from "../../.test-dist/gpu/GpuQueueEvidence.js";

test("multi-Product publication submit has an explicit GPU owner", () => {
  assert.equal(
    classifyGpuSubmitLabel("Renderer/GpuRenderWorld/multi-product-append"),
    "tool"
  );
});
