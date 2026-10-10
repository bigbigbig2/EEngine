import assert from "node:assert/strict";
import test from "node:test";
import { PhysicalEnvironmentState } from "../../.test-dist/render/environment/PhysicalEnvironmentState.js";

const snapshot = Object.freeze({
  worldToUnit: 0.001,
  lutGeneration: 4,
  sunDirectionWorld: [0, 1, 0],
  sunIrradiance: [1.474, 1.8504, 1.91198],
  skyLuminanceScale: 1,
  lightingDiagnostic: "all",
  aerialPerspectiveEnabled: true,
  shadowLength: [0, 0],
});

test("environment publication is atomic across Sun, Sky and aerial consumers", () => {
  const state = new PhysicalEnvironmentState();
  const generation = state.stage(snapshot, true);
  assert.equal(state.active, null);
  assert.throws(() => state.commit(generation + 1), /stale|incomplete/);
  const active = state.commit(generation);
  assert.equal(active.snapshot.lutGeneration, 4);
  assert.equal(active.snapshot.shadowLength[0], 0);
  assert.throws(() => state.commit(generation), /stale|incomplete/);
});

test("incomplete LUT generations cannot replace the last valid environment", () => {
  const state = new PhysicalEnvironmentState();
  state.commit(state.stage(snapshot, true));
  const generation = state.stage({ ...snapshot, lutGeneration: 5 }, false);
  assert.throws(() => state.commit(generation), /not ready/);
  state.abort(generation);
  assert.equal(state.active.snapshot.lutGeneration, 4);
});

test("atmosphere boundary rejects non-normalized sun and negative shadow lengths", () => {
  const state = new PhysicalEnvironmentState();
  assert.throws(() => state.stage({ ...snapshot, sunDirectionWorld: [0, 2, 0] }, true), /normalized/);
  assert.throws(() => state.stage({ ...snapshot, shadowLength: [-1, 0] }, true), /non-negative/);
  assert.throws(() => state.stage({ ...snapshot, shadowLength: [1, 0] }, true), /VSM producer/);
});
