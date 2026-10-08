import assert from "node:assert/strict";
import test from "node:test";
import { toJsonSafe } from "../gpu-oracle/page/json-safe.mjs";

test("GPU reports preserve complete nested timestamp and light samples", () => {
  const raw = Array.from({ length: 120 }, (_, frameIndex) => ({
    frameIndex,
    segments: [{ label: "LightCluster/assign", durationMs: 42, ticks: [100n, 142n] }],
  }));
  const lights = Array.from({ length: 1024 }, (_, index) => ({ position: [index, 2, 3] }));
  const output = toJsonSafe({ summary: { cases: [{ records: [{ raw, lights }] }] } });
  const record = output.summary.cases[0].records[0];
  assert.equal(record.raw.length, 120);
  assert.deepEqual(record.raw[119].segments[0], {
    label: "LightCluster/assign",
    durationMs: 42,
    ticks: ["100n", "142n"],
  });
  assert.deepEqual(record.lights[1023].position, [1023, 2, 3]);
  assert.ok(!JSON.stringify(output).includes("[depth-limit]"));
});

test("GPU reports retain cycle, depth and array guards", () => {
  const cycle = {};
  cycle.self = cycle;
  assert.deepEqual(toJsonSafe(cycle), { self: "[circular]" });
  let deep = {};
  for (let i = 0; i < 20; i++) deep = { child: deep };
  assert.ok(JSON.stringify(toJsonSafe(deep)).includes("[depth-limit]"));
  assert.equal(toJsonSafe(Array(5000).fill(0)).length, 4097);
  assert.equal(toJsonSafe(new Uint32Array(300)).truncated, true);
});
