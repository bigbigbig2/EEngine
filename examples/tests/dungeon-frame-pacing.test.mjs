import assert from "node:assert/strict";
import test from "node:test";
import { DungeonFramePacing } from "../demos/14-integrated/dungeon-warkarma-texture-compression/frame-pacing.ts";
import { createTextureQualityReader } from "../demos/14-integrated/dungeon-warkarma-texture-compression/texture-quality.ts";

function harness(mode) {
  const interactions = [],
    attempts = [];
  let admitted = true,
    camera = 0;
  const pacing = new DungeonFramePacing(
    mode,
    (delta) => {
      interactions.push(delta);
      camera++;
    },
    (now, delta, source) => {
      attempts.push({ now, delta, source, camera, admitted });
      return admitted;
    }
  );
  return {
    pacing,
    interactions,
    attempts,
    admit(value) {
      admitted = value;
    }
  };
}

for (const mode of ["interactive", "max-throughput"]) {
  test(`${mode}: completion retries never tick camera and deferred time accumulates`, () => {
    const h = harness(mode);
    h.pacing.raf(0);
    h.admit(false);
    h.pacing.raf(16);
    h.pacing.ready(17);
    h.admit(true);
    h.pacing.ready(20);
    assert.equal(h.interactions.length, 2);
    if (mode === "interactive") {
      assert.equal(h.attempts.length, 2);
      h.pacing.raf(32);
      assert.equal(h.attempts.at(-1).delta, 0.032);
    } else {
      assert.equal(h.attempts.at(-1).camera, 2);
      assert.equal(h.attempts.at(-1).delta, 0.02);
      h.pacing.raf(32);
      assert.equal(h.attempts.at(-1).delta, 0.012);
    }
    assert.equal(h.pacing.interactionTicks, 3);
    assert.equal(h.pacing.submittedFrames, 3 - Number(mode === "interactive"));
    h.pacing.dispose();
  });

  test(`${mode}: a deferred single step consumes input once; hidden/disposed callbacks do no work`, () => {
    const h = harness(mode);
    h.pacing.setPaused(true);
    h.pacing.raf(0);
    assert.equal(h.interactions.length, 0);
    h.pacing.step();
    h.admit(false);
    h.pacing.raf(16);
    h.pacing.ready(17);
    h.pacing.raf(32);
    assert.equal(h.interactions.length, 1);
    h.admit(true);
    h.pacing.raf(48);
    h.pacing.ready(49);
    h.pacing.raf(64);
    assert.equal(h.pacing.submittedFrames, 1);
    assert.equal(h.interactions.length, 1);
    h.pacing.setPaused(false);
    h.pacing.setVisible(false);
    h.pacing.raf(1000);
    h.pacing.ready(1001);
    assert.equal(h.interactions.length, 1);
    h.pacing.setVisible(true);
    h.pacing.ready(2000);
    h.pacing.raf(2016);
    assert.equal(h.interactions.at(-1), 1 / 60);
    assert.equal(h.attempts.at(-1).delta, 1 / 60);
    h.pacing.raf(5000);
    assert.equal(h.interactions.at(-1), 0.1);
    assert.equal(h.attempts.at(-1).delta, 0.1);
    h.pacing.dispose();
    const count = h.attempts.length;
    h.pacing.raf(5016);
    h.pacing.ready(5017);
    assert.equal(h.attempts.length, count);
  });
}

test("quality reads immutable published samples once, invalidates on publication and release", () => {
  let reads = 0;
  const texture = {
    texture_product: {
      metadata: {
        schemaVersion: 3,
        semantic: "base-color-srgb",
        storageWidth: 4,
        storageHeight: 4,
        planes: [{ format: "bc7-rgba-unorm-srgb", mips: [0, 1, 2] }]
      }
    }
  };
  const program = {
    get samples() {
      reads++;
      return [{ binding: { texture } }];
    }
  };
  const runtime = { appearancePrograms: [program] };
  const cache = createTextureQualityReader();
  const a = cache.read(runtime);
  assert.equal(a.productCount, 1);
  assert.equal(a.allFullMips, true);
  assert.equal(cache.read(runtime), a);
  assert.equal(reads, 1);
  const replacement = { appearancePrograms: [program] };
  assert.notEqual(cache.read(replacement), a);
  assert.equal(reads, 2);
  assert.equal(cache.read(undefined).textureLeafCount, 0);
  cache.read(replacement);
  cache.clear();
  cache.read(replacement);
  assert.equal(reads, 4);
});
