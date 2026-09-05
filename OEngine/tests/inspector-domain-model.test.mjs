import test from "node:test";
import assert from "node:assert/strict";

import { buildGpuDrivenFunnel, buildQueueSummaries } from "../.test-dist/addons/inspector/panels/GpuDrivenPanel.js";
import { buildFrameGraphRows } from "../.test-dist/addons/inspector/panels/FrameGraphPanel.js";
import { buildResourceRows } from "../.test-dist/addons/inspector/panels/ResourcesPanel.js";
import { buildDiagnostics } from "../.test-dist/addons/inspector/panels/DiagnosticsPanel.js";

function sample(frameIndex, metricId, value, availability = "available", instrumented = false) {
  return { metricId, value, availability, sourceFrameIndex: frameIndex, resolvedAtFrameIndex: frameIndex, instrumented };
}

function frame(samples) {
  return {
    schemaVersion: 1,
    frameIndex: 10,
    epoch: 0,
    warmup: false,
    visibilityState: "visible",
    samples,
    spans: [],
    gpuCounterSchemaVersion: 1,
    timestampInstrumented: false,
    counterInstrumented: false,
    complete: true
  };
}

test("GPU-driven funnel is fail-visible for zero denominators and missing counters", () => {
  const current = frame({
    "legacy.instances.candidate": sample(10, "legacy.instances.candidate", 0),
    "packed.visibility.hierarchy": sample(10, "packed.visibility.hierarchy", 0),
    "lighting.clusterCount": sample(10, "lighting.clusterCount", 4),
    "packed.visibility.drawIndirect": sample(10, "packed.visibility.drawIndirect", 2),
    "temporal.outputPixels": sample(10, "temporal.outputPixels", null, "unsupported")
  });
  const funnel = buildGpuDrivenFunnel([current]);
  assert.equal(funnel[0].ratio, null);
  assert.equal(funnel[1].ratio, null);
  assert.equal(funnel[4].availability, "unsupported");

  const queues = buildQueueSummaries([current], [{
    label: "Raster",
    current: "packed.visibility.drawIndirect",
    capacity: "queue.raster.capacity",
    peak: "queue.raster.peak",
    overflow: "queue.raster.overflow"
  }]);
  assert.equal(queues[0].current, 2);
  assert.equal(queues[0].capacity, null);
  assert.equal(queues[0].overflow, null);
});

test("GPU-driven queue preserves explicit overflow and feature-off state", () => {
  const current = frame({
    "queue.current": sample(10, "queue.current", 8),
    "queue.capacity": sample(10, "queue.capacity", 4),
    "queue.peak": sample(10, "queue.peak", 9),
    "queue.overflow": sample(10, "queue.overflow", 1)
  });
  const queue = buildQueueSummaries([current], [{ label: "Raster", current: "queue.current", capacity: "queue.capacity", peak: "queue.peak", overflow: "queue.overflow" }])[0];
  assert.deepEqual(queue, { label: "Raster", current: 8, capacity: 4, peak: 9, overflow: 1, available: true });
  assert.ok(buildGpuDrivenFunnel([]).every((stage) => stage.availability === "unsupported"));
});

test("FrameGraph rows expose active/pruned phases and resource read/write counts", () => {
  const evidence = {
    dump: {
      executablePassOrder: [3],
      resources: [],
      passes: [
        { id: 3, name: "Shade", culled: false, reads: [1, 2], writes: [3], scheduleIndex: 0, encoderWork: { renderPasses: 1, computePasses: 0, dispatches: 0, draws: 4 } },
        { id: 4, name: "Pruned", culled: true, reads: [], writes: [], encoderWork: { renderPasses: 0, computePasses: 0, dispatches: 0, draws: 0 } }
      ]
    }
  };
  const rows = buildFrameGraphRows(evidence, undefined);
  assert.deepEqual(rows.map((row) => [row.state, row.phase, row.reads, row.writes]), [["active", "render", 2, 1], ["pruned", "unknown", 0, 0]]);
});

test("Resources and Diagnostics keep accounted/estimated labels and unsupported reasons", () => {
  const resources = buildResourceRows({
    totalBytes: 100,
    peakBytes: 120,
    createdCount: 2,
    destroyedCount: 1,
    counts: { buffer: 1, texture: 0, sampler: 0, bindGroup: 0, pipeline: 0 },
    categories: { resident: { bytes: 100, peakBytes: 120, count: 1 } },
    owners: { Scene: { buffer: 100 } }
  }, {
    allocatedBytes: 200,
    residentLogicalBytes: 100,
    transientPoolBytes: 50,
    retiringBytes: 0,
    reclaimableBytes: 0,
    fragmentationBytes: 0,
    owners: {}
  });
  assert.ok(resources.some((row) => row.measurement === "accounted"));
  assert.ok(resources.some((row) => row.measurement === "estimated"));
  assert.deepEqual(buildResourceRows(null), []);

  const diagnostics = buildDiagnostics({
    diagnostics: { validationErrorCount: 0, uncapturedErrorCount: 0, deviceLostCount: 0, uncapturedErrors: [], deviceLostReasons: [], failedGpuTimestampBatches: 0, droppedGpuCounterSamples: 0, failedGpuCounterSamples: 0 },
    metricCatalog: [{ id: "gpu.x", label: "GPU X", group: "gpu", unit: "ms", source: "gpu-timestamp", measurement: "measured", cost: "low", scope: "frame", aggregation: "last", description: "timestamp unavailable" }],
    frame: frame({ "gpu.x": sample(10, "gpu.x", null, "unsupported") }),
    mode: "live",
    gpuTimestampAvailable: false,
    gpuSampleInterval: 4,
    gpuCounterSampleInterval: 8,
    inspectorOverheadMs: 0.25
  });
  assert.equal(diagnostics.find((row) => row.label === "Unsupported metrics").severity, "warning");
  assert.equal(diagnostics.find((row) => row.label === "Inspector overhead").value, "0.250 ms");
});
