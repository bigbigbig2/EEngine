import assert from "node:assert/strict";
import test from "node:test";

import "./webgpu-test-globals.mjs";

import { GpuShadingPublicationStore } from "../.test-dist/gpu/GpuShadingPublicationPlan.js";
import {
  SparseShadingPublicationCoordinator
} from "../.test-dist/render/pipeline/SparseShadingPublicationCoordinator.js";

const sizingLimits = Object.freeze({
  maxTextureDimension2D: 32768,
  maxBufferSize: 8 * 1024 * 1024 * 1024,
  maxStorageBufferBindingSize: 8 * 1024 * 1024 * 1024,
  maxComputeWorkgroupsPerDimension: 65535
});
const capability = Object.freeze({
  fingerprint: "production-publication-test-capability",
  formatProfile: "desktop-tier1-v1"
});

test("production publication derives one atomic GPU revision and stable frames reuse it", async () => {
  const destroyed = [];
  const coordinator = new SparseShadingPublicationCoordinator(
    null,
    false,
    fakeGpuRevisionFactory(destroyed)
  );
  const firstScene = scenePublication(1, source({ materialId: 0 }));
  const initialContext = context(320, 180);

  const initial = await coordinator.reconcile(firstScene, initialContext, 0);
  assert.strictEqual(coordinator.active(firstScene, initialContext), initial);
  assert.strictEqual(await coordinator.reconcile(firstScene, initialContext, 0), initial);
  assert.deepEqual(coordinator.evidence(), {
    activeSceneRevision: 1,
    activePublicationRevision: initial.snapshot.revision,
    stableHits: 1,
    prepareCount: 1,
    publishCount: 1,
    failureCount: 0,
    pending: false,
    deviceLost: false,
    gpu: coordinator.evidence().gpu
  });

  const resizedContext = context(640, 360);
  const resized = await coordinator.reconcile(firstScene, resizedContext, 7);
  assert.notStrictEqual(resized, initial);
  assert.equal(resized.snapshot.context.width, 640);
  assert.deepEqual(coordinator.evidence().gpu.retiringRevisions, [initial.snapshot.revision]);
  assert.deepEqual(coordinator.completeSubmittedWork(6), { cpu: [], gpu: [] });
  assert.deepEqual(coordinator.completeSubmittedWork(7), {
    cpu: [initial.snapshot.revision],
    gpu: [initial.snapshot.revision]
  });
    assert.deepEqual(destroyed, [
      `resolve:${initial.snapshot.revision}`,
    `status:${initial.snapshot.revision}`
  ]);
  coordinator.destroy();
});

test("preview and committed value-equivalent scene publications share one GPU revision", async () => {
  const coordinator = new SparseShadingPublicationCoordinator(
    null,
    false,
    fakeGpuRevisionFactory([])
  );
  const preview = scenePublication(1, source({ materialId: 0 }));
  const active = await coordinator.reconcile(preview, context(), 0);
  const committed = Object.freeze({
    ...preview,
    summary: Object.freeze({
      ...preview.summary,
      binRefCounts: preview.summary.binRefCounts.slice()
    })
  });
  assert.notStrictEqual(committed, preview);
  assert.strictEqual(coordinator.active(committed, context()), active);
  assert.strictEqual(await coordinator.reconcile(committed, context(), 0), active);
  assert.equal(coordinator.evidence().stableHits, 1);
  coordinator.destroy();
});

test("scene release publishes an empty closure and retires GPU work only at the completed boundary", async () => {
  const destroyed = [];
  const coordinator = new SparseShadingPublicationCoordinator(
    null,
    false,
    fakeGpuRevisionFactory(destroyed)
  );
  const scene = scenePublication(1, source({ materialId: 0 }));
  const active = await coordinator.reconcile(scene, context(), 0);

  assert.equal(await coordinator.release(scene, 9), true);
  assert.throws(() => coordinator.active(scene, context()), /not active/u);
  assert.equal(coordinator.evidence().activeSceneRevision, null);
  assert.equal(coordinator.evidence().activePublicationRevision, null);
  assert.deepEqual(coordinator.evidence().gpu.retiringRevisions, [active.snapshot.revision]);
  assert.deepEqual(coordinator.completeSubmittedWork(8), { cpu: [], gpu: [] });
  assert.deepEqual(destroyed, []);
  assert.deepEqual(coordinator.completeSubmittedWork(9), {
    cpu: [active.snapshot.revision],
    gpu: [active.snapshot.revision]
  });
  assert.deepEqual(destroyed, [
    `resolve:${active.snapshot.revision}`,
    `status:${active.snapshot.revision}`
  ]);
  assert.equal(await coordinator.release(scene, 10), false);
  coordinator.destroy();
});

test("scene/source mismatch fails before GPU preparation and leaves the active revision intact", async () => {
  let factoryCalls = 0;
  const coordinator = new SparseShadingPublicationCoordinator(
    null,
    false,
    async (...args) => {
      factoryCalls++;
      return fakeGpuRevisionFactory([])(...args);
    }
  );
  const firstScene = scenePublication(1, source({ materialId: 0 }));
  const active = await coordinator.reconcile(firstScene, context(), 0);
  const malformed = Object.freeze({
    ...firstScene,
    revision: 2,
    summary: Object.freeze({ ...firstScene.summary, revision: 2, activeBinMaskLo: 0 })
  });

  await assert.rejects(
    coordinator.reconcile(malformed, context(), 1),
    /activeBinMaskLo does not match its source/u
  );
  assert.equal(factoryCalls, 1);
  assert.strictEqual(coordinator.active(firstScene, context()), active);
  assert.equal(coordinator.evidence().failureCount, 1);
  coordinator.destroy();
});

test("identical concurrent requests share preparation and destroy closes late factory output", async () => {
  const destroyed = [];
  let releaseFactory;
  const gate = new Promise((resolve) => { releaseFactory = resolve; });
  const factory = async (...args) => {
    await gate;
    return fakeGpuRevisionFactory(destroyed)(...args);
  };
  const coordinator = new SparseShadingPublicationCoordinator(null, false, factory);
  const scene = scenePublication(1, source({ materialId: 0 }));
  const first = coordinator.reconcile(scene, context(), 0);
  const second = coordinator.reconcile(scene, context(), 0);
  assert.strictEqual(second, first);
  assert.equal(coordinator.evidence().pending, true);

  coordinator.destroy();
  releaseFactory();
  await assert.rejects(first, /invalidated by lifecycle change/u);
  await assert.rejects(second, /invalidated by lifecycle change/u);
  assert.deepEqual(destroyed, ["resolve:2", "status:2"]);
});

test("device loss invalidates the old epoch and rebuilds from retained CPU scene truth", async () => {
  const destroyed = [];
  const devices = [];
  const factory = fakeGpuRevisionFactory(destroyed);
  const oldDevice = { label: "old device" };
  const newDevice = { label: "replacement device" };
  const coordinator = new SparseShadingPublicationCoordinator(
    oldDevice,
    false,
    async (device, ...args) => { devices.push(device); return factory(device, ...args); }
  );
  const scene = scenePublication(1, source({ materialId: 0 }));
  const before = await coordinator.reconcile(scene, context(), 0);
  coordinator.markDeviceLost();
  assert.throws(() => coordinator.active(scene, context()), /not active/u);
  assert.equal(coordinator.evidence().deviceLost, true);

  const rebuilt = await coordinator.rebuildAfterDeviceLoss(newDevice, scene, context(), 0);
  assert.deepEqual(devices, [oldDevice, newDevice], "GPU factory must use the newly negotiated device");
  assert.ok(rebuilt.snapshot.revision > before.snapshot.revision);
  assert.ok(rebuilt.snapshot.deviceEpoch > before.snapshot.deviceEpoch);
  assert.strictEqual(coordinator.active(scene, context()), rebuilt);
  assert.equal(coordinator.evidence().deviceLost, false);
  coordinator.destroy();
});

test("device loss during asynchronous preparation destroys the late provisional closure", async () => {
  const destroyed = [];
  let releaseFactory;
  const gate = new Promise((resolve) => { releaseFactory = resolve; });
  const coordinator = new SparseShadingPublicationCoordinator(
    null,
    false,
    async (...args) => {
      await gate;
      return fakeGpuRevisionFactory(destroyed)(...args);
    }
  );
  const scene = scenePublication(1, source({ materialId: 0 }));
  const pending = coordinator.reconcile(scene, context(), 0);
  coordinator.markDeviceLost();
  releaseFactory();

  await assert.rejects(pending, /invalidated by lifecycle change/u);
  assert.deepEqual(destroyed, ["resolve:2", "status:2"]);
  assert.equal(coordinator.evidence().deviceLost, true);
  assert.equal(coordinator.evidence().gpu.pendingPreparations, 0);
  coordinator.destroy();
});

function context(width = 320, height = 180) {
  return Object.freeze({
    width,
    height,
    outputDependencyMask: 0,
    shadowSamplingEnabled: false,
    capability,
    sizingLimits
  });
}

function source({ materialId }) {
  return Object.freeze({
    materials: Object.freeze([Object.freeze({
      id: materialId,
      profile: Object.freeze({
        shadingModel: "unlit",
        hasBaseTexture: false,
        hasOrmTexture: false,
        hasNormalTexture: false,
        hasEmissiveTexture: false,
        textureBindingSetId: 0
      }),
      generation: 3,
      textureGeneration: 4
    })]),
    geometries: Object.freeze([Object.freeze({
      id: 5,
      profile: Object.freeze({
        hasAuthoredVertexColor: false,
        hasUv0: false,
        hasNormal: false,
        hasTangent: false
      }),
      generation: 2
    })]),
    instances: Object.freeze([Object.freeze({
      id: 0,
      materialId,
      geometryId: 5,
      active: true,
      transparent: false,
      generation: 1
    })])
  });
}

function scenePublication(revision, publicationSource) {
  const oracle = new GpuShadingPublicationStore(context());
  const derived = oracle.beginTransaction().replaceAll(publicationSource).commit(0);
  return Object.freeze({
    schemaVersion: 1,
    revision,
    materialGeneration: 3,
    textureGeneration: 4,
    materialPublicationRevision: 5,
    summary: Object.freeze({ ...derived.summary, revision }),
    source: publicationSource
  });
}

function fakeGpuRevisionFactory(destroyed) {
  return async (_device, publication, diagnostics) => {
    if (publication.pipelines.length === 0) {
      return Object.freeze({
        snapshot: publication,
        bins: null,
        resolve: null,
        settings: null,
        heapBytes: 0,
        indirectBytes: 0,
        settingsBytes: 0,
        status: null,
        statusBytes: 0
      });
    }
    const bins = publication.executionMode === "sparse-microtile" ? {
      diagnostics,
      sizing: publication.sizing,
      destroy() { destroyed.push(`bins:${publication.revision}`); }
    } : null;
    const resolve = {
      diagnostics,
      publicationRevision: publication.revision,
      executionMode: publication.executionMode === "none" ? "sparse-microtile" : publication.executionMode,
      destroy() { destroyed.push(`resolve:${publication.revision}`); }
    };
    const settings = bins === null ? null : {
      size: 256,
      destroy() { destroyed.push(`settings:${publication.revision}`); }
    };
    const status = bins === null ? {
      size: 32,
      destroy() { destroyed.push(`status:${publication.revision}`); }
    } : null;
    return Object.freeze({
      snapshot: publication,
      bins,
      resolve,
      settings,
      status,
      heapBytes: bins?.sizing.heapBytes ?? 0,
      indirectBytes: bins?.sizing.indirectBytes ?? 0,
      settingsBytes: settings?.size ?? 0,
      statusBytes: status?.size ?? 0
    });
  };
}
