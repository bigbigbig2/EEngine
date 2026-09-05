import test from "node:test";
import assert from "node:assert/strict";

import {
  MetricRegistry,
  summarizeProfileSeries
} from "../.test-dist/debug/profiling/MetricRegistry.js";
import { summarizeMetricCoverage } from "../.test-dist/debug/profiling/ProfileStatistics.js";

test("metric registry rejects semantic conflicts and freezes descriptors", () => {
  const registry = new MetricRegistry();
  const descriptor = registry.register({
    id: "cpu.frameMs",
    label: "CPU Frame",
    group: "CPU",
    unit: "ms",
    source: "cpu-clock",
    measurement: "measured",
    cost: "low",
    scope: "frame",
    aggregation: "last",
    description: "Renderer frame wall time"
  });
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(registry.get("cpu.frameMs"), descriptor);
  assert.throws(() => registry.register({ ...descriptor, unit: "bytes" }), /conflict/);
  assert.equal(registry.register(descriptor), descriptor);
  assert.equal(registry.register({
    description: descriptor.description,
    aggregation: descriptor.aggregation,
    scope: descriptor.scope,
    cost: descriptor.cost,
    measurement: descriptor.measurement,
    source: descriptor.source,
    unit: descriptor.unit,
    group: descriptor.group,
    label: descriptor.label,
    id: descriptor.id
  }), descriptor);
});

test("profile series uses deterministic nearest-rank percentiles and rejects invalid values", () => {
  assert.deepEqual(summarizeProfileSeries([4, 1, 3, 2]), {
    count: 4,
    min: 1,
    max: 4,
    mean: 2.5,
    p50: 2,
    p95: 4,
    p99: 4
  });
  assert.equal(summarizeProfileSeries([]), null);
  assert.throws(() => summarizeProfileSeries([1, Number.NaN]), /finite/);
});

test("metric coverage preserves unavailable states", () => {
  assert.deepEqual(summarizeMetricCoverage([
    { availability: "available" },
    { availability: "pending" },
    { availability: "unsupported" },
    { availability: "invalid" },
    { availability: "dropped" }
  ]), {
    total: 5,
    available: 1,
    pending: 1,
    unsupported: 1,
    invalid: 1,
    dropped: 1,
    availableRatio: 0.2
  });
});
