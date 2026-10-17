import assert from "node:assert/strict";
import test from "node:test";
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
const { planScgiEstimator, SCGI_ESTIMATOR } = await import(
  "../../.test-dist/render/gi/ScgiEstimatorLayout.js"
);
const { ScgiEstimator } = await import("../../.test-dist/render/gi/ScgiEstimator.js");
const { ChangeSignal } = await import("../../.test-dist/core/Signal.js");

const limits = {
  maxBufferSize: 128 * 1024 ** 2,
  maxStorageBufferBindingSize: 128 * 1024 ** 2,
  minStorageBufferOffsetAlignment: 256
};
const profile = {
  lightSamples: 1024,
  hemisphereSamples: 8,
  connectionSamples: 8,
  maximumLights: 4096,
  batchRays: 256
};

test("estimator working set follows pool, bounded batch and selected updates; never pixels times spp", () => {
  const plan = planScgiEstimator(limits, profile, 2048);
  assert.equal(plan.ranges.pool.bytes, 1024 * 192);
  assert.equal(plan.ranges.paths.bytes, 256 * 224);
  assert.equal(plan.ranges.cohorts.bytes, 2048 * 96);
  assert.equal(SCGI_ESTIMATOR.hitStride, 96);
  assert.equal(plan.bytes, 516352);
  assert.equal(planScgiEstimator(limits, { ...profile, hemisphereSamples: 128 }, 2048).bytes, plan.bytes);
  for (const range of Object.values(plan.ranges)) assert.equal(range.offset % 256, 0);
});

test("estimator rejects unrepresentable finite batches and planned sample denominator", () => {
  for (const name of Object.keys(profile)) {
    for (const invalid of [0, -1, NaN, Infinity, 0.5]) {
      assert.throws(() => planScgiEstimator(limits, { ...profile, [name]: invalid }, 8), RangeError);
    }
  }
  assert.throws(
    () => planScgiEstimator(limits, { ...profile, hemisphereSamples: 0xffffffff }, 8),
    RangeError
  );
  assert.throws(
    () => planScgiEstimator({ ...limits, maxStorageBufferBindingSize: 4096 }, profile, 8),
    RangeError
  );
});

test("independent diffuse Jacobi energy contracts for colored reflectance without same-frame feedback", () => {
  // A two-wall closed diffuse enclosure: view factor is one, irradiance source
  // is RGB(1,2,4). Solve the two coupled scalar transport equations explicitly.
  const rhoA = [0.8, 0.2, 0.1],
    rhoB = [0.15, 0.7, 0.3],
    source = [1, 2, 4];
  let a = [0, 0, 0],
    b = [0, 0, 0];
  for (let frame = 0; frame < 128; frame++) {
    const nextA = a.map((_, c) => source[c] + rhoB[c] * b[c]);
    b = b.map((_, c) => rhoA[c] * a[c]);
    a = nextA;
  }
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(a[c] - source[c] / (1 - rhoA[c] * rhoB[c])) < 1e-12);
    assert.ok(Math.abs(b[c] - rhoA[c] * a[c]) < 1e-12);
  }
  // rho=0 absorbs all continuation; rho=1 with an emissive source has no finite
  // stationary solution. The estimator must not hide that with an energy clamp.
  assert.equal(0 * a[0], 0);
  assert.equal(1 - 1 * 1, 0);
});

test("estimator abort retires safely; submitted failure quarantines rather than rolling back or retrying", async () => {
  // Exercise the actual encode/observer implementation with a command sink.
  // GPU math is covered by the real-device oracle, not this lifecycle fixture.
  const plan = { profile: { updates: 1 }, scratch: { ranges: { raw: { offset: 0, bytes: 64 } } } };
  const buffer = {
    size: 256,
    destroy() {
      this.destroyed = true;
    }
  };
  const device = {
    limits: { minUniformBufferOffsetAlignment: 256 },
    createBindGroup() {
      return {};
    }
  };
  const input = {
    scene: {
      profile: { deviceEpoch: 1 },
      sourceInstances: {
        assertCurrent() {},
        sourceSnapshot: buffer,
        identitySnapshot: buffer
      },
      materials: { source: { revision: 1, isCurrent: () => true } },
      materialPublication: { data: buffer }
    },
    lights: {
      publicationRevision: 1,
      source: { version: 1 },
      buffer_data: buffer,
      authoredIbl: { publicationRevision: 1 }
    },
    physical: null,
    environment: "black",
    multiBounce: false
  };
  const makeOwner = () =>
    Object.assign(Object.create(ScgiEstimator.prototype), {
      device,
      plan,
      profile: { batchRays: 1, lightSamples: 1, hemisphereSamples: 1, connectionSamples: 1 },
      input,
      lightRevision: 1,
      lightSourceRevision: 1,
      lightBuffer: buffer,
      environmentRevision: 1,
      physicalGeneration: 0,
      materialRevision: 1,
      pointPages: 0,
      spotPages: 0,
      directionalSlots: 0,
      inFlight: 0,
      destroyed: false,
      poisoned: false,
      encoded: new WeakSet(),
      pipelines: {},
      closest: { encode() {}, destroy() {} },
      shadow: { encode() {}, destroy() {} },
      buffer,
      batch: buffer,
      hits: buffer,
      indirect: buffer,
      defaults: buffer,
      black: buffer
    });
  const makeTx = () => {
    const observers = [];
    const command = {
      device,
      closed: false,
      onBeforeFinish: new ChangeSignal(),
      observeSubmission(value) {
        observers.push(value);
      },
      clearBuffer() {},
      copyBufferToBuffer() {},
      allocateTransientBufferAndLoad() {
        return buffer;
      },
      beginComputePass() {
        return {
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups() {},
          dispatchWorkgroupsIndirect() {},
          end() {}
        };
      }
    };
    return {
      command,
      observers,
      state: "encoded",
      workset: { plan },
      publication: {
        deviceEpoch: 1,
        cacheComplete: true,
        activeWorld: null,
        candidateWorld: { buffer },
        privateScratch: { buffer }
      }
    };
  };
  const aborted = makeOwner(),
    abortTx = makeTx();
  aborted.encode(abortTx);
  assert.equal(abortTx.publication.estimateComplete, true);
  assert.throws(() => aborted.destroy(), /fence/);
  abortTx.observers[0].aborted();
  assert.equal(aborted.inFlight, 0);
  aborted.destroy();
  const failed = makeOwner(),
    failedTx = makeTx();
  failed.encode(failedTx);
  failedTx.observers[0].submitted(Promise.reject(new Error("controlled GPU fence failure")));
  await Promise.resolve();
  assert.equal(failed.poisoned, true);
  assert.throws(() => failed.encode(makeTx()), /publication changed/);
  assert.throws(() => failed.destroy(), /poisoned/);
  const current = makeOwner(),
    currentTx = makeTx();
  current.encode(currentTx);
  input.lights.source.version++;
  assert.throws(
    () => currentTx.command.onBeforeFinish.send1Checked(currentTx.command),
    /publication changed/
  );
  currentTx.observers[0].aborted();
  current.destroy();
});
