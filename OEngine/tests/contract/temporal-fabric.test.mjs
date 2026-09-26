import assert from "node:assert/strict";
import test from "node:test";
import { TemporalFabric } from "../../.test-dist/render/TemporalFabric.js";

const frame = (index, overrides = {}) => ({ frameIndex: index, output: [1920, 1080], internal: [1280, 720],
  cameraRevision: 1, sceneRevision: 1, representationRevision: 1, lightRevision: "sun:1", view: "main",
  renderScale: 0.666, featureRevision: 1, formatRevision: 1, deviceRevision: 1,
  preExposure: { generation: 1, multiplier: 1, colorSpace: "working-linear" },
  temporalEnabled: true, nssEnabled: false, ...overrides });

test("TemporalFabric owns one begin/commit transaction for all shared histories", () => {
  const fabric = new TemporalFabric();
  const jitter = fabric.begin(frame(0));
  assert.equal(jitter.length, 2);
  for (const name of ["color", "depth", "motion"]) fabric.markProduced(name);
  assert.equal(fabric.commit(0), true);
  assert.throws(() => fabric.commit(0), /mismatch/);
  fabric.begin(frame(1));
  assert.throws(() => fabric.begin(frame(2)), /already active/);
  fabric.abort(1);
});

test("camera and resolution changes invalidate histories at the shared boundary", () => {
  const fabric = new TemporalFabric();
  fabric.begin(frame(0));
  fabric.markProduced("depth"); fabric.markProduced("motion"); fabric.markProduced("color"); fabric.commit(0);
  fabric.begin(frame(1, { cameraRevision: 2, internal: [960, 540] }));
  const state = fabric.histories.state("color");
  assert.equal(state.readValid, false);
  fabric.abort(1);
});
