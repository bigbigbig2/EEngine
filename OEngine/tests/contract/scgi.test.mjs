import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage = { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 };

const { SCGI_ABI, packScgiRecord, unpackScgiRecord, packScgiCoefficients, unpackScgiCoefficients } =
  await import("../../.test-dist/render/gi/ScgiAbi.js");
const {
  planScgiAllocation,
  planScgiLightingWindow,
  planScgiShards,
  planScgiNativeDescriptors,
  planScgiQueryDescriptors,
  scgiExecutionProfile,
} = await import("../../.test-dist/render/gi/ScgiCapacity.js");
const { ScgiRuntime } = await import("../../.test-dist/render/gi/ScgiRuntime.js");
const { ResourceAccounting } = await import("../../.test-dist/debug/profiling/ResourceAccounting.js");
const { scgiProfile, scgiGraphics, scgiCommand, scgiWriteKnown } = await import("../oracle/scgi-fixture.mjs");

const limits = {
  maxBufferSize: 256 * 1024 * 1024,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  minStorageBufferOffsetAlignment: 256,
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 1000,
  maxStorageBuffersPerShaderStage: 16,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxSampledTexturesPerShaderStage: 24,
  maxStorageTexturesPerShaderStage: 4,
  maxSamplersPerShaderStage: 16,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupsPerDimension: 65535,
  maxComputeWorkgroupStorageSize: 16384,
};
const demand = { enabled: true, hasGeometry: true, hasLitMaterials: true };

function fakeDevice() {
  const deferred = [];
  const listeners = new Map();
  let loss;
  const device = {
    limits,
    features: new Set(),
    lost: new Promise((resolve) => {
      loss = resolve;
    }),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    pushErrorScope() {},
    popErrorScope: async () => null,
    createBuffer({ size, label, usage }) {
      if (device.failAllocation) throw new Error("allocation failure");
      device.created++;
      return {
        size,
        label,
        usage,
        bytes: new Uint8Array(size),
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
    },
    createCommandEncoder() {
      const actions = [];
      return {
        copyBufferToBuffer(source, offset, target, targetOffset, bytes) {
          actions.push(() => target.bytes.set(source.bytes.slice(offset, offset + bytes), targetOffset));
        },
        clearBuffer(target, offset = 0, bytes = target.size - offset) {
          actions.push(() => target.bytes.fill(0, offset, offset + bytes));
        },
        finish() {
          return actions;
        },
      };
    },
    queue: {
      writeBuffer(buffer, offset, data, dataOffset = 0, size = data.byteLength) {
        const view = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset + dataOffset, size)
          : new Uint8Array(data, dataOffset, size);
        buffer.bytes.set(view, offset);
      },
      submit(commands) {
        for (const actions of commands) for (const action of actions) action();
      },
      onSubmittedWorkDone() {
        return new Promise((resolve, reject) => deferred.push({ resolve, reject }));
      },
    },
    created: 0,
    complete() {
      for (const future of deferred.splice(0)) future.resolve();
    },
    reject() {
      for (const future of deferred.splice(0)) future.reject(new Error("fence rejected"));
    },
    lose() {
      loss({ reason: "destroyed" });
    },
    error(message) {
      listeners.get("uncapturederror")?.({ error: new Error(message) });
    },
  };
  return device;
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("SCGI exact nonzero/max ABI and literal offsets", () => {
  const expected = {
    identity: 64,
    cell: 8,
    cacheState: 16,
    patch: 304,
    request: 112,
    halfField: 112,
    anchor: 128,
    raw: 64,
    node: 64,
    links: 8,
    triangle: 16,
    directory: 32,
    instance: 128,
    ray: 48,
    result: 32,
    payload: 32,
    continuation: 64,
    worldHeader: 256,
  };
  for (const [kind, bytes] of Object.entries(expected)) {
    assert.equal(SCGI_ABI[kind].stride, bytes, kind);
    const values = Object.fromEntries(
      SCGI_ABI[kind].fields.map((field) => [
        field.name,
        Array.from({ length: field.count }, (_, lane) =>
          field.type === "u32" ? 0xffffffff - lane : -1.25 - lane,
        ),
      ]),
    );
    assert.deepEqual(unpackScgiRecord(kind, packScgiRecord(kind, values)), values);
  }
  assert.deepEqual(
    SCGI_ABI.patch.fields.map((f) => f.offset),
    [0, 16, 32, 80, 96, 112, 128, 144, 160, 208, 256, 272, 288],
  );
  assert.deepEqual(
    SCGI_ABI.halfField.fields.map((f) => f.offset),
    [0, 32, 36, 40, 44, 48],
  );
  assert.equal(SCGI_ABI.continuation.fields.find((f) => f.name === "candidateT").offset, 52);
  assert.throws(() => packScgiRecord("cell", { patchIndex: 2 ** 32, patchSlotGeneration: 1 }));
  const coefficients = [1, -2, 3, 0.5, -0.25, 4, 5, 6, -7, 8, 9, 10];
  const packed = packScgiCoefficients(coefficients, 2);
  assert.deepEqual([...unpackScgiCoefficients(packed, 2)], coefficients);
  for (let coefficient = 0; coefficient < 4; coefficient++)
    assert.equal(packed[coefficient * 2 + 1] >>> 16, 0);
});

test("SCGI capacity: total arena, binding ranges, full/window/remap, finite shards", () => {
  const plan = planScgiAllocation(limits, scgiProfile);
  assert.equal(plan.cells, 2 ** 3 * 16 * 2);
  assert.equal(plan.halfPixels, 12);
  assert.equal(
    plan.totalBytes,
    plan.world.bytes * 2 +
      plan.screenRoleBytes * 2 +
      plan.scratch.bytes +
      plan.batch.bytes +
      plan.anchorBytes,
  );
  assert.equal(plan.batch.ranges.spill, undefined);
  assert.equal(plan.batch.ranges.continuations.bytes, 8 * 64);
  assert.equal(plan.world.ranges.cacheState.bytes, scgiProfile.patches * 16);
  assert.equal(plan.scratch.ranges.cacheMoves.bytes, scgiProfile.patches * 384);
  for (const arena of [plan.world, ...plan.screen, plan.scratch, plan.batch]) {
    for (const range of Object.values(arena.ranges)) {
      assert.equal(range.offset % 256, 0);
      assert.ok(range.offset + range.bytes <= arena.bytes);
    }
  }
  assert.throws(() => planScgiAllocation(limits, { ...scgiProfile, width: 65536, height: 65536 }));
  assert.throws(() => planScgiAllocation({ ...limits, maxStorageBufferBindingSize: 1000 }, scgiProfile));
  const fourK = planScgiAllocation(limits, { ...scgiProfile, width: 3840, height: 2160 });
  assert.equal(fourK.screen.length, 2);
  assert.equal(fourK.screenRoleBytes, 1920 * 1080 * 112);
  assert.equal(
    fourK.screen.reduce((sum, segment) => sum + segment.ranges.worldField.count, 0),
    1920 * 1080,
  );
  const input = {
    width: 1920,
    height: 1080,
    oldDirectoryBytes: 1024 * 1024,
    filterNoiseBytes: 0,
    residual: true,
    haloHalfRows: 2,
    tileWidth: 8,
    tileHeight: 8,
    descriptorCountPerTile: 32,
  };
  assert.equal(planScgiLightingWindow(limits, input).route, "full");
  const striped = planScgiLightingWindow({ ...limits, maxStorageBufferBindingSize: 2 * 1024 * 1024 }, input);
  assert.equal(striped.route, "window");
  assert.ok(striped.windows > 1);
  const remapped = planScgiLightingWindow(
    { ...limits, maxStorageBufferBindingSize: 2 * 1024 * 1024 },
    { ...input, oldDirectoryBytes: 2 * 1024 * 1024 - 4 },
  );
  assert.equal(remapped.remapLighting, true);
  assert.ok(remapped.columns * remapped.windowWidth >= input.width);
  assert.ok(remapped.rows * remapped.windowHeight >= input.height);
  const shards = planScgiShards(
    { ...limits, maxStorageBufferBindingSize: 2048 },
    [
      { nodes: 10, triangles: 8 },
      { nodes: 10, triangles: 8 },
      { nodes: 10, triangles: 8 },
    ],
    3,
  );
  assert.ok(shards.length > 1);
  assert.equal(
    shards.reduce((count, shard) => count + shard.clusterCount, 0),
    3,
  );
  assert.throws(() => planScgiShards(limits, [{ nodes: 2 ** 28, triangles: 1 }], 4));
});

test("SCGI descriptors use actual Native routes and complete query coverage inventory", () => {
  for (const productGeometry of [false, true])
    for (const compact of [false, true])
      for (const virtualTextures of [false, true])
        for (const reflections of ["off", "sssr-base-coat"])
          for (const unlit of [false, true])
            for (const physicalSun of [false, true]) {
              const profile = {
                productGeometry,
                compact,
                virtualTextures,
                reflections,
                unlit,
                physicalSun,
                reactive: true,
                finalPixel: true,
              };
              const plan = planScgiNativeDescriptors(limits, profile, []);
              assert.equal(plan.addedGiBindings, 0);
              assert.equal(plan.groups.length, 4);
              const maxTextures = limits.maxSampledTexturesPerShaderStage - plan.counts.sampled;
              const material = Array.from({ length: maxTextures }, (_, binding) => ({
                binding,
                visibility: 4,
                texture: { sampleType: "float" },
              }));
              assert.equal(planScgiNativeDescriptors(limits, profile, material).counts.sampled, 24);
            }
  const full = planScgiNativeDescriptors(
    limits,
    {
      productGeometry: true,
      compact: true,
      virtualTextures: true,
      reflections: "sssr-base-coat",
      unlit: false,
      reactive: true,
      finalPixel: true,
    },
    [],
  );
  assert.equal(full.counts.storage, 16);
  const material = [{ binding: 0, visibility: 4, buffer: { type: "read-only-storage" } }];
  assert.equal(planScgiQueryDescriptors(limits, material, []).counts.storage, 15);
  assert.throws(() =>
    planScgiQueryDescriptors({ ...limits, maxStorageBuffersPerShaderStage: 14 }, material, []),
  );
  assert.equal(scgiExecutionProfile({ limits, features: new Set() }).scan, "portable");
  assert.equal(scgiExecutionProfile({ limits, features: new Set(["subgroups"]) }).scan, "portable");
});

test("SCGI independent submission model: abort/retry, 3 in flight, observer fault and retired fence", async () => {
  const device = fakeDevice();
  const accounting = new ResourceAccounting();
  const runtime = new ScgiRuntime(device, 1, accounting);
  const graphics = scgiGraphics(device);
  await runtime.configure(demand, scgiProfile);
  let expectedGeneration = 0;
  for (const [submit, value] of [
    [true, 11],
    [false, 99],
    [true, 22],
    [true, 33],
  ]) {
    const command = scgiCommand(graphics);
    const tx = runtime.prepare(command, { scene: 3, view: 7 });
    assert.equal(tx.publication.sampleSerial, expectedGeneration);
    runtime.encode(tx);
    scgiWriteKnown(tx, value);
    if (submit) {
      command.finish();
      expectedGeneration++;
    } else command.abort();
    assert.equal(runtime.activeGeneration, expectedGeneration);
    assert.equal(runtime.sampleSerial, expectedGeneration);
    // Repeated settlement cannot advance state or allocate.
    const before = device.created;
    runtime.commit(tx, Promise.resolve());
    assert.equal(runtime.activeGeneration, expectedGeneration);
    assert.equal(device.created, before);
  }
  assert.equal(runtime.activeGeneration, 3);
  const command = scgiCommand(graphics);
  command.onFinished.addOne(() => {
    throw new Error("post-submit observer failure");
  });
  const tx = runtime.prepare(command, { scene: 3, view: 7 });
  runtime.encode(tx);
  assert.throws(() => command.finish(), /post-submit/);
  assert.equal(command.wasSubmitted, true);
  assert.equal(runtime.activeGeneration, 4);
  assert.equal(runtime.poisoned, true);
  runtime.disable();
  assert.ok(runtime.snapshot().retiredBytes > 0);
  assert.ok(accounting.snapshot().retiredBytes > 0);
  device.complete();
  await flush();
  assert.equal(runtime.snapshot().totalBytes, 0);
  runtime.destroy();
});

test("SCGI resize keeps world, failed replacement keeps active, loss isolates callbacks", async () => {
  const device = fakeDevice();
  const runtime = new ScgiRuntime(device, 9);
  const graphics = scgiGraphics(device);
  await runtime.configure({ ...demand, hasLitMaterials: false }, scgiProfile);
  assert.equal(device.created, 0);
  await runtime.configure(demand, scgiProfile);
  const first = scgiCommand(graphics);
  const tx = runtime.prepare(first, { scene: 1, view: 1 });
  runtime.encode(tx);
  scgiWriteKnown(tx, 7);
  first.finish();
  device.failAllocation = true;
  await assert.rejects(runtime.configure(demand, { ...scgiProfile, width: 37 }), /allocation/);
  assert.equal(runtime.activeGeneration, 1);
  device.failAllocation = false;
  await runtime.configure(demand, { ...scgiProfile, width: 17 });
  const resized = scgiCommand(graphics);
  const next = runtime.prepare(resized, { scene: 1, view: 1 });
  assert.equal(next.publication.activeWorld.buffer, tx.publication.candidateWorld.buffer);
  assert.equal(next.publication.previousWorldField, null);
  runtime.encode(next);
  resized.finish();
  assert.ok(runtime.snapshot().peakBytes > runtime.snapshot().liveBytes);
  device.reject();
  await flush();
  assert.equal(runtime.poisoned, true);
  runtime.disable();
  assert.ok(runtime.snapshot().retiredBytes > 0, "rejected fence is not successful teardown");
  device.lose();
  await flush();
  assert.equal(runtime.snapshot().totalBytes, 0);
  const recovered = new ScgiRuntime(fakeDevice(), 10);
  recovered.poison(new Error("late old epoch"), 9);
  assert.equal(recovered.poisoned, false);
  recovered.destroy();
});

test("SCGI async device errors poison dependent history", async () => {
  for (const message of ["validation", "out-of-memory"]) {
    const device = fakeDevice();
    const runtime = new ScgiRuntime(device, 1);
    await runtime.configure(demand, scgiProfile);
    const command = scgiCommand(scgiGraphics(device));
    const tx = runtime.prepare(command, { scene: 1, view: 1 });
    runtime.encode(tx);
    command.finish();
    device.error(message);
    assert.equal(tx.publication.status, "poisoned");
    const stopped = scgiCommand(scgiGraphics(device));
    assert.throws(() => runtime.prepare(stopped, { scene: 1, view: 1 }));
    stopped.abort();
    device.complete();
    await flush();
    runtime.destroy();
  }
});

test("SCGI pre-submit checks abort all writes and settlement survives multiple listener failures", async () => {
  const device = fakeDevice();
  const runtime = new ScgiRuntime(device, 1);
  const graphics = scgiGraphics(device);
  await runtime.configure(demand, scgiProfile);
  const unencoded = scgiCommand(graphics);
  runtime.prepare(unencoded, { scene: 1, view: 1 });
  assert.throws(() => unencoded.finish(), /not initialized/);
  assert.equal(unencoded.wasSubmitted, false);
  assert.equal(runtime.activeGeneration, 0);
  const retry = scgiCommand(graphics);
  const tx = runtime.prepare(retry, { scene: 1, view: 1 });
  runtime.encode(tx);
  runtime.commit(tx, Promise.resolve());
  assert.equal(runtime.activeGeneration, 0, "manual pre-submit commit cannot publish");
  let secondRan = false;
  retry.onFinished.addOne(() => {
    throw new Error("first observer");
  });
  retry.onFinished.addOne(() => {
    secondRan = true;
    throw new Error("second observer");
  });
  assert.throws(() => retry.finish(), /first observer/);
  assert.equal(secondRan, true);
  assert.equal(runtime.activeGeneration, 1);
  assert.equal(runtime.poisoned, true);
  device.complete();
  await flush();
  runtime.destroy();
});

test("SCGI segmented histories, epochs, replacement abort and borrowed last-consumer leases", async () => {
  const device = fakeDevice();
  // Cache scan/claim scratch is now real, so an 8KiB binding cannot admit the
  // profile. Still force screen segmentation above the complete scratch bound.
  device.limits = { ...limits, maxStorageBufferBindingSize: 32768 };
  const graphics = scgiGraphics(device);
  const runtime = new ScgiRuntime(device, 1);
  const profile = { ...scgiProfile, width: 65, height: 65 };
  const plan = await runtime.configure(demand, profile);
  assert.ok(plan.screen.length > 1);
  let released;
  const command = scgiCommand(graphics);
  const tx = runtime.prepare(command, { scene: 1, view: 1 }, [
    {
      kind: "static-as",
      deviceEpoch: 1,
      release(fence) {
        released = fence;
      },
    },
  ]);
  runtime.encode(tx);
  scgiWriteKnown(tx, 7);
  command.finish();
  assert.equal(released, undefined);
  const world = tx.publication.candidateWorld;
  const nextCommand = scgiCommand(graphics);
  const next = runtime.prepare(nextCommand, { scene: 1, view: 2 });
  assert.equal(next.publication.activeWorld.buffer, world.buffer);
  assert.equal(next.publication.previousWorldField, null, "view epoch invalidates screen only");
  runtime.encode(next);
  nextCommand.abort();
  await runtime.configure(demand, { ...profile, patches: 10 });
  const replacementCommand = scgiCommand(graphics);
  const replacement = runtime.prepare(replacementCommand, { scene: 1, view: 1 });
  assert.equal(replacement.publication.activeWorld, null);
  runtime.encode(replacement);
  replacementCommand.abort();
  assert.equal(runtime.activeGeneration, 1);
  await runtime.configure(demand, profile);
  const sceneCommand = scgiCommand(graphics);
  const scene = runtime.prepare(sceneCommand, { scene: 2, view: 1 });
  assert.equal(scene.publication.activeWorld, null, "scene epoch rejects world history");
  sceneCommand.abort();
  device.complete();
  await flush();
  assert.equal(released, tx.completion);
  runtime.destroy();
  assert.equal(runtime.snapshot().totalBytes, 0);
});

test("SCGI asynchronous allocation OOM and pending configure disable preserve admission", async () => {
  const device = fakeDevice();
  const runtime = new ScgiRuntime(device, 1);
  const graphics = scgiGraphics(device);
  await runtime.configure(demand, scgiProfile);
  const command = scgiCommand(graphics);
  const tx = runtime.prepare(command, { scene: 1, view: 1 });
  runtime.encode(tx);
  command.finish();
  let calls = 0;
  device.popErrorScope = async () => (++calls % 2 === 0 ? new Error("asynchronous OOM") : null);
  const before = runtime.snapshot().totalBytes;
  await assert.rejects(runtime.configure(demand, { ...scgiProfile, width: 9 }), /asynchronous OOM/);
  assert.equal(runtime.activeGeneration, 1);
  assert.equal(runtime.snapshot().totalBytes, before);
  device.popErrorScope = async () => null;
  const pending = runtime.configure(demand, { ...scgiProfile, width: 11 });
  runtime.disable();
  await assert.rejects(pending, /expired owner/);
  device.complete();
  await flush();
  assert.equal(runtime.snapshot().totalBytes, 0);
  runtime.destroy();
});

test("SCGI fence acquisition failure after submit cannot become abort or success", async () => {
  const device = fakeDevice();
  const runtime = new ScgiRuntime(device, 1);
  const graphics = scgiGraphics(device);
  await runtime.configure(demand, scgiProfile);
  const command = scgiCommand(graphics);
  const tx = runtime.prepare(command, { scene: 1, view: 1 });
  runtime.encode(tx);
  device.queue.onSubmittedWorkDone = () => {
    throw new Error("fence acquisition failure");
  };
  assert.throws(() => command.finish(), /fence acquisition failure/);
  assert.equal(command.wasSubmitted, true);
  assert.equal(tx.state, "submitted");
  assert.equal(runtime.activeGeneration, 1);
  await flush();
  assert.equal(runtime.poisoned, true);
  runtime.disable();
  assert.ok(runtime.snapshot().retiredBytes > 0);
  device.lose();
  await flush();
  assert.equal(runtime.snapshot().totalBytes, 0);
});

test("SCGI no-op configuration retains address generation and per-role coefficient scale", async () => {
  const device = fakeDevice();
  const runtime = new ScgiRuntime(device, 1);
  const graphics = scgiGraphics(device);
  await runtime.configure(demand, scgiProfile);
  const firstCommand = scgiCommand(graphics);
  const first = runtime.prepare(firstCommand, { scene: 1, view: 1 });
  runtime.encode(first);
  first.markFieldComplete(8);
  firstCommand.finish();
  const created = device.created;
  await runtime.configure(demand, scgiProfile);
  assert.equal(device.created, created);
  const nextCommand = scgiCommand(graphics);
  const next = runtime.prepare(nextCommand, { scene: 1, view: 1 });
  assert.equal(next.publication.addressGeneration, first.publication.addressGeneration);
  assert.equal(next.publication.previousCoefficientScale, 8);
  assert.equal(next.publication.coefficientScale, 1);
  nextCommand.abort();
  device.complete();
  await flush();
  runtime.destroy();
});

test("SCGI cache rejects dispatch limits before allocating any GPU arena", async () => {
  const device = fakeDevice();
  device.limits = { ...limits, maxComputeWorkgroupsPerDimension: 1 };
  const runtime = new ScgiRuntime(device, 1);
  await assert.rejects(runtime.configure(demand, scgiProfile), /cache physical/);
  assert.equal(device.created, 0);
  runtime.destroy();
});

test("SCGI anchor rejects mixed geometry capability before allocating world or history", async () => {
  for (const change of [
    { maxStorageBuffersPerShaderStage: 12 },
    { maxBindGroups: 1 },
    { maxUniformBufferBindingSize: 256 },
  ]) {
    const device = fakeDevice();
    device.limits = { ...limits, ...change };
    const runtime = new ScgiRuntime(device, 1);
    await assert.rejects(runtime.configure(demand, scgiProfile), /anchor\/seed/);
    assert.equal(device.created, 0);
    runtime.destroy();
  }
});
