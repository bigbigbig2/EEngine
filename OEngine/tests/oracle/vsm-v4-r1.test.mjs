import assert from "node:assert/strict";
import test from "node:test";
import { VsmGeneration } from "../../.test-dist/render/vsm/VsmGeneration.js";
import { buildVsmDirectionalFrameConstants } from "../../.test-dist/render/vsm/VsmProjection.js";
import { vsmWorldPageEntryIndex } from "../../.test-dist/render/vsm/VsmPageState.js";
import { instanceShadowFlagsFromExtras } from "../../.test-dist/core/InstanceShadowSemantics.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { BoxGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";

test("instance default, explicit off and public Scene changes retain distinct semantics", () => {
  for (const extras of [undefined, null, [], { nested: { castShadow: false } }]) {
    assert.equal(instanceShadowFlagsFromExtras(extras), 6);
  }
  assert.equal(instanceShadowFlagsFromExtras({ castShadow: false }), 4);
  assert.equal(instanceShadowFlagsFromExtras({ receiveShadow: false }), 2);
  assert.equal(instanceShadowFlagsFromExtras({ castShadow: false, receiveShadow: false }), 0);
  assert.throws(() => instanceShadowFlagsFromExtras({ castShadow: 0 }), /boolean/);
  const scene = new Scene(),
    mesh = Mesh.from(new BoxGeometry(), new StandardShadeMaterial());
  scene.add(mesh);
  const revision = scene.change_revision;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  assert.deepEqual(scene.changesSince(revision).changedMeshShadowSemantics, [mesh]);
  assert.equal(instanceShadowFlagsFromExtras(mesh.clone()), 0);
  scene.remove(mesh);
  const detachedRevision = scene.change_revision;
  mesh.castShadow = true;
  assert.equal(scene.change_revision, detachedRevision);
});

test("world page storage modulo preserves signed identity and mip plane separation", () => {
  const seen = new Set();
  for (let y = -77; y < 51; y++) {
    for (let x = -149; x < -21; x++) {
      const address = vsmWorldPageEntryIndex(2, 0, x, y, 128);
      assert.ok(!seen.has(address));
      seen.add(address);
      assert.equal(address, vsmWorldPageEntryIndex(2, 0, x + 128, y - 128, 128));
      assert.notEqual(address, vsmWorldPageEntryIndex(2, 1, x, y, 128));
    }
  }
  assert.throws(() => vsmWorldPageEntryIndex(0, 0, 2 ** 31, 0, 128), /i32/);
});

test("world projection does not translate with camera, including the light axis", () => {
  const resources = {
    profile: "vsm-directional-high",
    namespace: 19,
    capabilities: { clipLevels: 6, virtualPagesPerAxis: 128, pageSize: 128 }
  };
  const initial = buildVsmDirectionalFrameConstants([0, 1, 0], [-0.31, 2, -0.47], 256, resources, 8);
  const axial = buildVsmDirectionalFrameConstants([0, 1, 0], [-0.31, 103, -0.47], 256, resources, 8);
  assert.deepEqual(initial.lightView, axial.lightView);
  assert.deepEqual(initial.clipOriginExtent, axial.clipOriginExtent);
  const within = buildVsmDirectionalFrameConstants([0, 1, 0], [-0.3, 2, -0.46], 256, resources, 8);
  assert.deepEqual(initial.clipOriginExtent, within.clipOriginExtent);
  const rolling = buildVsmDirectionalFrameConstants([0, 1, 0], [-0.06, 2, -0.47], 256, resources, 8);
  assert.deepEqual(initial.lightView, rolling.lightView);
  assert.notDeepEqual(initial.clipOriginExtent, rolling.clipOriginExtent);
  const rounded = buildVsmDirectionalFrameConstants([0.4, 1, 0.3], [-0.31, 2, -0.47], 256, resources, 8);
  const equivalent = buildVsmDirectionalFrameConstants([0.4 + 1e-10, 1, 0.3], [-0.31, 2, -0.47], 256, resources, 8);
  assert.deepEqual(rounded.lightView, equivalent.lightView, "basis must match f32 direction epoch identity");
});

test("prepare abort retry, window roll, Sun intensity and deferred invalidation are transactional", () => {
  const owner = new VsmGeneration();
  const input = {
    deviceEpoch: 1,
    scene: {},
    sceneRevision: 1,
    casterRevision: 0,
    sourceRevision: 0,
    sunDirection: [0, 1, 0],
    cameraCut: false,
    clipOriginExtent: [[-16, -16, 32, 1]],
    width: 16,
    height: 16
  };
  const abandoned = owner.prepare(input);
  assert.equal(owner.currentGeneration, 1);
  assert.throws(() => owner.prepare(input), /pending/);
  owner.abort();
  const retry = owner.prepare(input);
  assert.deepEqual(retry, abandoned);
  owner.commit(retry);
  assert.throws(() => owner.commit(abandoned), /pending/);
  const steady = owner.prepare({ ...input, sunIntensity: 17 });
  assert.equal(steady.rebuildDepth, false);
  owner.commit(steady);
  const rolled = owner.prepare({ ...input, clipOriginExtent: [[-15, -16, 32, 1]] });
  assert.equal(rolled.pageQuantumChanged, true);
  assert.equal(rolled.projectionEpoch, retry.projectionEpoch);
  assert.equal(rolled.fullInvalidate, false);
  owner.abort();
  const source = owner.prepare({ ...input, sourceRevision: 1 });
  assert.equal(source.rebuildDepth, true);
  owner.invalidate();
  owner.commit(source);
  const forced = owner.prepare({ ...input, sourceRevision: 1 });
  assert.equal(forced.fullInvalidate, true);
  owner.abort();
  const direction = owner.prepare({ ...input, sunDirection: [0.1, 1, 0] });
  assert.equal(direction.rebuildDepth, true);
  owner.abort();
  assert.equal(owner.prepare({ ...input, deviceEpoch: 2 }).fullInvalidate, true);
});
