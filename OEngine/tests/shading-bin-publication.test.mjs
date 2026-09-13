import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  GPU_SPARSE_SHADING_REQUIRED_LIMITS
} from "../.test-dist/gpu/GpuSparseShadingCapability.js";
import {
  GpuShadingPublicationStore
} from "../.test-dist/gpu/GpuShadingPublicationPlan.js";
import {
  GPU_SHADING_DEPENDENCY,
  GPU_SHADING_PROGRAM,
  ShadingIdentityPublicationError
} from "../.test-dist/gpu/GpuShadingProgramAbi.js";

const adapterLimits = {
  ...GPU_SPARSE_SHADING_REQUIRED_LIMITS
};
const capabilityPlan = createGpuSparseShadingCapabilityPlan({
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: adapterLimits,
  info: { subgroupMinSize: 4, subgroupMaxSize: 128 }
});
const capability = captureGpuSparseShadingCapabilityRecord(capabilityPlan, {
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: adapterLimits,
  textureFormatFeatures: ["texture-formats-tier1"],
  formatProfile: "desktop-tier1-v1"
});
const sizingLimits = Object.freeze({
  maxTextureDimension2D: 32768,
  maxBufferSize: 8 * 1024 * 1024 * 1024,
  maxStorageBufferBindingSize: 8 * 1024 * 1024 * 1024,
  maxComputeWorkgroupsPerDimension: 65535
});

function context(overrides = {}) {
  return {
    width: 1920,
    height: 1080,
    outputDependencyMask: 0,
    shadowSamplingEnabled: false,
    capability,
    sizingLimits,
    ...overrides
  };
}

function material(id, shadingModel, textureBits = 0, textureBindingSetId = 0, generation = 1) {
  return {
    id,
    profile: {
      shadingModel,
      hasBaseTexture: (textureBits & 1) !== 0,
      hasOrmTexture: (textureBits & 2) !== 0,
      hasNormalTexture: (textureBits & 4) !== 0,
      hasEmissiveTexture: (textureBits & 8) !== 0,
      textureBindingSetId
    },
    generation,
    textureGeneration: generation
  };
}

function geometry(id, overrides = {}, generation = 1) {
  return {
    id,
    profile: {
      hasAuthoredVertexColor: false,
      hasUv0: true,
      hasNormal: true,
      hasTangent: true,
      ...overrides
    },
    generation
  };
}

function instance(id, materialId, geometryId, overrides = {}) {
  return {
    id,
    materialId,
    geometryId,
    active: true,
    transparent: false,
    generation: 1,
    ...overrides
  };
}

function load(store, source, submissionSerial = 1) {
  return store.beginTransaction().replaceAll(source).commit(submissionSerial);
}

test("bulk publication derives opaque bins and receiver truth in one immutable revision", () => {
  const store = new GpuShadingPublicationStore(context());
  const initial = store.currentSnapshot();
  assert.equal(initial.revision, 1);
  assert.equal(initial.summary.binRefCounts.length, 64);
  assert.equal(initial.summary.activeBinMaskLo, 0);
  assert.equal(initial.pipelines.length, 0);
  assert.equal(initial.bindGroups.length, 0);
  assert.equal(initial.sizing.heapBytes, 2304);

  const snapshot = load(store, {
    materials: [
      material(1, "standard-pbr", 1, 1),
      material(2, "unlit"),
      material(3, "standard-pbr", 0)
    ],
    geometries: [geometry(1)],
    instances: [
      instance(10, 1, 1),
      instance(11, 2, 1),
      instance(12, 1, 1, { active: false }),
      instance(13, 3, 1, { transparent: true })
    ]
  }, 10);
  const litBin = 16 + GPU_SHADING_PROGRAM.PbrBase;
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.layoutRevision, 2);
  assert.equal(snapshot.generation, 2);
  assert.equal(snapshot.summary.revision, 2);
  assert.equal(snapshot.summary.binRefCounts[litBin], 1);
  assert.equal(snapshot.summary.binRefCounts[GPU_SHADING_PROGRAM.UnlitFactor], 1);
  assert.equal(snapshot.summary.opaqueLitReceiverCount, 1);
  assert.equal(snapshot.summary.opaqueUnlitReceiverCount, 1);
  assert.equal(snapshot.summary.transparentLitReceiverCount, 1);
  assert.equal(snapshot.summary.activeBinMaskLo, (1 << litBin) | 1);
  assert.equal(snapshot.summary.activeBinMaskHi, 0);
  assert.equal(snapshot.pipelines.length, 2);
  assert.deepEqual(snapshot.pipelines.map(({ binId }) => binId), [0, litBin]);
  assert.deepEqual(
    snapshot.bindGroups.map(({ binId, group }) => [binId, group]),
    [[0, 0], [0, 1], [0, 2], [litBin, 0], [litBin, 1], [litBin, 2], [litBin, 3]]
  );
  assert.ok(snapshot.bindGroups.every((publication) =>
    publication.layoutRevision === snapshot.layoutRevision &&
    publication.publicationRevision === snapshot.revision &&
    snapshot.pipelines.some((pipeline) => pipeline.cacheKey === publication.pipelineCacheKey)
  ));
  assert.equal(snapshot.associations.length, 4);
  assert.ok(snapshot.associations.every((association) =>
    association.instanceBinId === association.identity.binId &&
    association.meshletWorkBinId === association.identity.binId &&
    association.publicationRevision === snapshot.revision &&
    association.layoutRevision === snapshot.layoutRevision
  ));
  assert.ok((snapshot.summary.dependencyMask & GPU_SHADING_DEPENDENCY.Lit) !== 0);
  assert.ok((snapshot.summary.dependencyMask & GPU_SHADING_DEPENDENCY.BaseTexture) !== 0);
  assert.deepEqual(store.completeSubmittedWork(9), []);
  assert.deepEqual(store.completeSubmittedWork(10), [1]);
});

test("add/remove and Active/Transparency patches update 0-to-1 boundaries without scans", () => {
  const store = new GpuShadingPublicationStore(context());
  store.beginTransaction()
    .addMaterial(material(1, "standard-pbr"))
    .addGeometry(geometry(1))
    .commit(1);
  const added = store.beginTransaction().addInstance(instance(1, 1, 1)).commit(2);
  assert.equal(added.summary.binRefCounts[GPU_SHADING_PROGRAM.PbrFactor], 1);
  assert.equal(added.summary.opaqueLitReceiverCount, 1);

  const inactive = store.beginTransaction().patchInstanceVisibility(1, {
    active: false,
    generation: 2
  }).commit(3);
  assert.equal(inactive.summary.activeBinMaskLo, 0);
  assert.equal(inactive.summary.opaqueLitReceiverCount, 0);

  const transparent = store.beginTransaction().patchInstanceVisibility(1, {
    active: true,
    transparent: true,
    generation: 3
  }).commit(4);
  assert.equal(transparent.summary.activeBinMaskLo, 0);
  assert.equal(transparent.summary.opaqueLitReceiverCount, 0);
  assert.equal(transparent.summary.transparentLitReceiverCount, 1);

  const opaque = store.beginTransaction().patchInstanceVisibility(1, {
    transparent: false,
    generation: 4
  }).commit(5);
  assert.equal(opaque.summary.binRefCounts[GPU_SHADING_PROGRAM.PbrFactor], 1);
  const removed = store.beginTransaction().removeInstance(1).commit(6);
  assert.equal(removed.summary.activeBinMaskLo, 0);
  assert.equal(removed.summary.opaqueLitReceiverCount, 0);
});

test("material, geometry, association and texture relocation update incrementally", () => {
  const store = new GpuShadingPublicationStore(context());
  load(store, {
    materials: [material(1, "standard-pbr", 1, 1), material(2, "unlit")],
    geometries: [geometry(1), geometry(2, { hasAuthoredVertexColor: true })],
    instances: [instance(1, 1, 1), instance(2, 1, 1), instance(3, 2, 1)]
  });
  const before = store.currentSnapshot();
  assert.equal(before.summary.binRefCounts[21], 2);
  assert.equal(before.summary.binRefCounts[0], 1);

  const materialPatched = store.beginTransaction().patchMaterial(
    material(1, "standard-pbr", 3, 1, 2)
  ).commit(2);
  assert.equal(materialPatched.revision, before.revision + 1);
  assert.equal(materialPatched.summary.binRefCounts[21], 0);
  assert.equal(materialPatched.summary.binRefCounts[23], 2);

  const relocated = store.beginTransaction().relocateTextureBindingSet(1, 2, 3).commit(3);
  assert.equal(relocated.summary.binRefCounts[23], 0);
  assert.equal(relocated.summary.binRefCounts[39], 2);
  assert.ok(relocated.associations.filter(({ instance }) => instance.materialId === 1)
    .every(({ textureGeneration }) => textureGeneration === 3));

  const geometryPatched = store.beginTransaction().patchGeometry(
    geometry(1, { hasAuthoredVertexColor: true }, 2)
  ).commit(4);
  assert.equal(geometryPatched.summary.binRefCounts[0], 0);
  assert.equal(geometryPatched.summary.binRefCounts[1], 1);

  const associated = store.beginTransaction().patchInstanceAssociation(3, {
    materialId: 1,
    geometryId: 2,
    generation: 2
  }).commit(5);
  assert.equal(associated.summary.binRefCounts[1], 0);
  assert.equal(associated.summary.binRefCounts[39], 3);
  assert.equal(associated.summary.opaqueLitReceiverCount, 3);
  assert.equal(associated.summary.opaqueUnlitReceiverCount, 0);
});

test("multiple publication changes commit as one revision and one indivisible snapshot", () => {
  const store = new GpuShadingPublicationStore(context());
  const loaded = load(store, {
    materials: [material(1, "standard-pbr"), material(2, "unlit", 0, 3)],
    geometries: [geometry(1), geometry(2)],
    instances: [instance(1, 1, 1), instance(2, 2, 1)]
  });
  assert.equal(loaded.associations.find(({ instance: value }) => value.id === 2).identity.binId, 0);

  const transaction = store.beginTransaction();
  transaction.patchMaterial(material(1, "standard-pbr", 3, 2, 2));
  transaction.patchGeometry(geometry(1, { hasAuthoredVertexColor: true }, 2));
  transaction.patchInstanceAssociation(2, { materialId: 1, geometryId: 2, generation: 2 });
  transaction.patchInstanceVisibility(1, { transparent: true, generation: 2 });
  const prepared = transaction.prepare();
  assert.strictEqual(transaction.prepare(), prepared);
  const committed = transaction.commit(2);

  assert.strictEqual(committed, prepared);
  assert.equal(committed.revision, loaded.revision + 1);
  assert.equal(committed.layoutRevision, committed.revision);
  assert.equal(committed.generation, committed.revision);
  assert.equal(committed.summary.revision, committed.revision);
  assert.equal(committed.summary.binRefCounts[39], 1);
  assert.equal(committed.summary.opaqueLitReceiverCount, 1);
  assert.equal(committed.summary.transparentLitReceiverCount, 1);
  assert.ok(committed.associations.every((association) =>
    association.publicationRevision === committed.revision &&
    association.layoutRevision === committed.layoutRevision &&
    association.materialGeneration === 2
  ));
  assert.ok(committed.bindGroups.every((publication) =>
    publication.publicationRevision === committed.revision &&
    publication.layoutRevision === committed.layoutRevision
  ));
  assert.deepEqual(store.completeSubmittedWork(1), [1]);
  assert.deepEqual(store.completeSubmittedWork(2), [loaded.revision]);
});

test("transparent receivers never enter opaque bins and bin 63 remains addressable", () => {
  const store = new GpuShadingPublicationStore(context());
  const snapshot = load(store, {
    materials: [material(1, "standard-pbr", 8, 3), material(2, "unlit")],
    geometries: [geometry(1)],
    instances: [
      instance(1, 1, 1),
      instance(2, 1, 1, { transparent: true }),
      instance(3, 2, 1, { transparent: true })
    ]
  });
  assert.equal(snapshot.associations[0].identity.programId, GPU_SHADING_PROGRAM.PbrGeneric);
  assert.equal(snapshot.associations[0].identity.binId, 63);
  assert.equal(snapshot.summary.binRefCounts[63], 1);
  assert.equal(snapshot.summary.activeBinMaskHi, 0x80000000);
  assert.equal(snapshot.summary.transparentLitReceiverCount, 1);
  assert.equal(snapshot.summary.opaqueLitReceiverCount, 1);
  assert.equal(snapshot.pipelines.length, 1);
});

test("last contributors clear dependency and bin masks while referenced owners cannot be removed", () => {
  const store = new GpuShadingPublicationStore(context());
  load(store, {
    materials: [material(1, "standard-pbr", 15, 3), material(2, "unlit", 0, 3)],
    geometries: [geometry(1), geometry(2)],
    instances: [instance(1, 1, 1), instance(2, 2, 2)]
  });
  assert.throws(() => store.beginTransaction().removeMaterial(1), /still referenced/u);
  assert.throws(() => store.beginTransaction().removeGeometry(1), /still referenced/u);

  const transaction = store.beginTransaction();
  transaction.removeInstance(1);
  transaction.removeMaterial(1);
  transaction.removeGeometry(1);
  const snapshot = transaction.commit(2);
  assert.equal(snapshot.summary.dependencyMask, 0);
  assert.equal(snapshot.summary.activeBinMaskLo, 1);
  assert.equal(snapshot.associations[0].identity.textureBindingSetId, 0);
  assert.equal(snapshot.associations[0].identity.binId, GPU_SHADING_PROGRAM.UnlitFactor);
});

test("unsupported material, invalid generation, missing association and OOM preflight never publish", () => {
  const store = new GpuShadingPublicationStore(context());
  load(store, {
    materials: [material(1, "standard-pbr")],
    geometries: [geometry(1)],
    instances: [instance(1, 1, 1)]
  });
  const stable = store.currentSnapshot();

  const unsupported = store.beginTransaction();
  assert.throws(
    () => unsupported.patchMaterial({
      ...material(1, "standard-pbr", 0, 0, 2),
      profile: { ...material(1, "standard-pbr").profile, shadingModel: "clear-coat" }
    }),
    ShadingIdentityPublicationError
  );
  unsupported.abort();
  assert.strictEqual(store.currentSnapshot(), stable);

  const invalidGeneration = store.beginTransaction();
  assert.throws(
    () => invalidGeneration.patchInstanceVisibility(1, { active: false, generation: 0 }),
    /generation must be non-zero/u
  );
  invalidGeneration.abort();
  assert.strictEqual(store.currentSnapshot(), stable);

  const missing = store.beginTransaction();
  assert.throws(
    () => missing.patchInstanceAssociation(1, { materialId: 99, generation: 2 }),
    /material 99 does not exist/u
  );
  missing.abort();
  assert.strictEqual(store.currentSnapshot(), stable);

  const invalidSizingLimits = [
    ["maxBufferSize", { ...sizingLimits, maxBufferSize: 2304 }],
    ["maxStorageBufferBindingSize", { ...sizingLimits, maxStorageBufferBindingSize: 2304 }],
    ["maxTextureDimension2D", { ...sizingLimits, maxTextureDimension2D: 1024 }],
    ["maxComputeWorkgroupsPerDimension", { ...sizingLimits, maxComputeWorkgroupsPerDimension: 1 }]
  ];
  for (const [label, limits] of invalidSizingLimits) {
    const rejected = store.beginTransaction().updateContext(context({ sizingLimits: limits }));
    assert.throws(() => rejected.prepare(), new RegExp(label, "u"));
    rejected.abort();
    assert.strictEqual(store.currentSnapshot(), stable);
  }
});

test("prepare/abort, stale transactions and no-op commits preserve generation and retirement", () => {
  const store = new GpuShadingPublicationStore(context());
  load(store, {
    materials: [material(1, "unlit")],
    geometries: [geometry(1)],
    instances: [instance(1, 1, 1)]
  }, 1);
  const stable = store.currentSnapshot();
  const aborted = store.beginTransaction().patchInstanceVisibility(1, {
    active: false,
    generation: 2
  });
  assert.equal(aborted.prepare().revision, stable.revision + 1);
  aborted.abort();
  assert.strictEqual(store.currentSnapshot(), stable);
  assert.deepEqual(store.completeSubmittedWork(100), [1]);

  const noOp = store.beginTransaction();
  assert.strictEqual(noOp.prepare(), stable);
  assert.strictEqual(noOp.commit(101), stable);
  assert.deepEqual(store.completeSubmittedWork(101), []);

  const first = store.beginTransaction().patchInstanceVisibility(1, {
    active: false,
    generation: 2
  });
  const stale = store.beginTransaction().patchInstanceVisibility(1, {
    transparent: true,
    generation: 3
  });
  first.commit(102);
  assert.throws(() => stale.prepare(), /is stale/u);
  stale.abort();
});

test("same-bin updates reuse pipeline descriptors while resize republishes layout once", () => {
  const store = new GpuShadingPublicationStore(context());
  const loaded = load(store, {
    materials: [material(1, "standard-pbr")],
    geometries: [geometry(1)],
    instances: [instance(1, 1, 1)]
  });
  const pipeline = loaded.pipelines[0];
  const generationOnly = store.beginTransaction().patchInstanceVisibility(1, {
    generation: 2
  }).commit(2);
  assert.strictEqual(generationOnly.pipelines[0], pipeline);
  assert.equal(generationOnly.revision, loaded.revision + 1);

  const resized = store.beginTransaction().updateContext(context({ width: 3840, height: 2160 })).commit(3);
  assert.equal(resized.revision, generationOnly.revision + 1);
  assert.equal(resized.layoutRevision, resized.revision);
  assert.equal(resized.sizing.microtileCount, 129600);
  assert.strictEqual(resized.pipelines[0], pipeline);
});

test("device loss invalidates old work and rebuilds from CPU truth under a new epoch/revision", () => {
  const store = new GpuShadingPublicationStore(context());
  const before = load(store, {
    materials: [material(1, "standard-pbr", 1, 1)],
    geometries: [geometry(1)],
    instances: [instance(1, 1, 1)]
  });
  const inFlight = store.beginTransaction().patchInstanceVisibility(1, {
    active: false,
    generation: 2
  });
  store.markDeviceLost();
  assert.throws(() => store.currentSnapshot(), /unavailable after device loss/u);
  assert.throws(() => inFlight.commit(2), /invalidated by device loss/u);
  inFlight.abort();
  const rebuilt = store.rebuildAfterDeviceLoss();
  assert.ok(rebuilt.revision > before.revision);
  assert.ok(rebuilt.deviceEpoch > before.deviceEpoch);
  assert.equal(rebuilt.summary.binRefCounts[21], 1);
  assert.equal(rebuilt.associations[0].materialGeneration, 1);
  assert.notStrictEqual(rebuilt.pipelines[0], before.pipelines[0]);
});

test("bulk validation is atomic and stable reads return the same snapshot without scene scans", () => {
  const store = new GpuShadingPublicationStore(context());
  const stable = store.currentSnapshot();
  const transaction = store.beginTransaction();
  assert.throws(() => transaction.replaceAll({
    materials: [material(1, "standard-pbr")],
    geometries: [geometry(1)],
    instances: [instance(1, 99, 1)]
  }), /material 99 does not exist/u);
  transaction.abort();
  assert.strictEqual(store.currentSnapshot(), stable);
  assert.strictEqual(store.currentSnapshot(), store.currentSnapshot());

  const source = readFileSync(
    new URL("../src/gpu/GpuShadingPublicationPlan.ts", import.meta.url),
    "utf8"
  );
  const renderWorld = readFileSync(new URL("../src/gpu/GpuRenderWorld.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /requestAnimationFrame|beginFrame|from\s+["'][^"']*Scene|for\s*\([^)]*(?:scene|materialRegistry)/iu
  );
  assert.doesNotMatch(renderWorld, /GpuShadingPublicationPlan|ActiveShadingSummary/u);
});
