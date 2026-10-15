import test from "node:test";
import assert from "node:assert/strict";
import { SceneRefinement } from "../../.test-dist/render/SceneRefinement.js";
import { uniqueCookedTextures } from "../../.test-dist/assets/CookedTextureCatalog.js";

const sample = (frame, patch = {}) => ({
  frame,
  mainFrame: frame,
  shadowFrame: frame,
  mainComplete: true,
  shadowComplete: true,
  shadowRequired: true,
  vsmFrame: frame,
  vsmValid: true,
  texturesFull: true,
  pendingGeometry: 0,
  stagedGeometry: 0,
  limited: false,
  error: null,
  ...patch,
});

test("settlement requires fresh complete feedback and another completed observation; movement restarts epoch", async () => {
  const state = new SceneRefinement();
  state.begin("view-1/sun-1", "quality-1", 10);
  const wait = state.wait();
  state.completed(sample(9), 90);
  assert.equal(state.evidence().firstCompletedAtMs, 90);
  assert.equal(state.evidence().geometryTarget, false);
  state.completed(sample(10, { shadowFrame: 9 }), 100);
  assert.equal(state.evidence().phase, "refining");
  state.completed(sample(11, { stagedGeometry: 1 }), 110);
  assert.equal(state.evidence().phase, "refining");
  state.completed(sample(12), 120);
  assert.notEqual(state.evidence().phase, "view-settled");
  state.completed(sample(13), 130);
  assert.equal((await wait).phase, "view-settled");
  state.begin("view-2/sun-1", "quality-1", 14);
  assert.equal(state.evidence().phase, "refining");
  assert.equal(state.evidence().epoch, 2);
  state.completed(sample(14, { mainComplete: false }), 140);
  assert.equal(state.evidence().geometryTarget, false);
  state.completed(sample(15, { limited: true, pendingGeometry: 1 }), 150);
  assert.equal((await state.wait()).phase, "limited");
  assert.equal(state.evidence().settledAtMs, null);
});

test("publication, invalid VSM, cancellation and terminal failures never resolve as settled", async () => {
  const state = new SceneRefinement();
  state.begin("view", "q1", 0);
  state.frameCompleted(5);
  assert.equal(state.evidence().firstCompletedAtMs, 5);
  assert.equal(state.evidence().phase, "first-completed");
  state.completed(sample(0), 10);
  state.begin("view", "q2", 1);
  assert.equal(state.evidence().phase, "refining");
  assert.equal(state.evidence().geometryTarget, false);
  assert.equal(state.evidence().vsmValid, false);
  state.completed(sample(1, { vsmValid: false }), 20);
  assert.equal(state.evidence().vsmValid, false);
  const wait = state.wait();
  state.cancel();
  await assert.rejects(wait, /cancelled/);
  const fail = new SceneRefinement();
  const failed = fail.wait();
  fail.completed(sample(0, { error: "bad receipt" }), 30);
  await assert.rejects(failed, /bad receipt/);
});

test("capacity pressure revokes a settled timestamp within the same view epoch", () => {
  const state = new SceneRefinement();
  state.begin("view", "quality", 0);
  state.completed(sample(0), 10);
  state.completed(sample(1), 20);
  assert.equal(state.evidence().settledAtMs, 20);
  state.completed(sample(2, { limited: true, texturesFull: false }), 30);
  assert.equal(state.evidence().phase, "limited");
  assert.equal(state.evidence().settledAtMs, null);
  state.completed(sample(3), 40);
  assert.equal(state.evidence().phase, "refining");
  state.completed(sample(4), 50);
  assert.equal(state.evidence().settledAtMs, 50);
});

test("catalog aliases share one read and critical priority, conflicting URI is rejected", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64);
  const catalog = uniqueCookedTextures(
    [
      { uri: "shading", identity: b },
      { uri: "opaque", identity: a },
      { uri: "mask-alias", identity: a },
    ],
    new Set(["mask-alias"]),
  );
  assert.equal(catalog.reads.length, 2);
  assert.equal(catalog.reads[0].identity, a);
  assert.equal(catalog.reads[0].critical, true);
  assert.equal(catalog.aliases.get("opaque"), catalog.aliases.get("mask-alias"));
  assert.throws(
    () =>
      uniqueCookedTextures(
        [
          { uri: "same", identity: a },
          { uri: "same", identity: b },
        ],
        new Set(),
      ),
    /conflicting/,
  );
});
