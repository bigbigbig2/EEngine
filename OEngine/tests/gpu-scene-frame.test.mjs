import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage = {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512
};

const { GPUSceneContext } = await import(
  "../.test-dist/gpu/GPUSceneContext.js"
);

test("GPU scene preparation encodes at most once for the same frame", () => {
  const scene = Object.create(GPUSceneContext.prototype);
  scene._lastPreparedFrame = -1;
  scene._lastSceneChangeRevision = 4;
  scene._dirty = false;
  scene.scene = {
    changesSince(revision) {
      assert.equal(revision, 4);
      return {
        revision: 4,
        fullResyncRequired: false,
        instanceStructureChanged: false,
        transformedNodes: [],
        changedMeshBounds: [],
        changedLights: []
      };
    }
  };
  const calls = [];
  scene.light_probe_volume = { update: () => calls.push("probes") };
  scene.lights = { update: () => calls.push("lights") };
  scene.volumetrics = { update: () => calls.push("volumetrics") };
  scene.tlas = { update: () => calls.push("tlas") };
  scene.animation_manager = { tick: () => calls.push("animation") };
  scene.graphics = {
    profiler: { addCounter: (name, value) => calls.push(`${name}:${value}`) }
  };

  let abortFrame = null;
  const command = {
    onAborted: {
      addOne(callback) {
        abortFrame = callback;
      }
    }
  };
  const first = scene.encodeFrame(command, 12, 1 / 60);
  const duplicate = scene.encodeFrame(command, 12, 1 / 60);

  assert.equal(first.scenePrepareCount, 1);
  assert.equal(duplicate.scenePrepareCount, 0);
  assert.deepEqual(calls, [
    "probes",
    "lights",
    "volumetrics",
    "tlas",
    "animation",
    "runtime.scenePrepareCount:1"
  ]);

  abortFrame();
  assert.equal(scene._dirty, true);
  scene._dirty = false;
  const retry = scene.encodeFrame(command, 12, 1 / 60);
  assert.equal(retry.scenePrepareCount, 1);
});
