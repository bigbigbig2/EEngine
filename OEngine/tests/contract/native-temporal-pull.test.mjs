import "../webgpu-test-globals.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { NativeTemporalV2 } from "../../.test-dist/render/temporal/NativeTemporalV2.js";
import { NativeTemporalSeed } from "../../.test-dist/render/temporal/NativeTemporalSeed.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";

globalThis.GPUBufferUsage = { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 };

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture() {
  const loss = deferred();
  const textures = [];
  const buffers = [];
  const groups = [];
  const writes = [];
  const device = {
    features: new Set(["texture-formats-tier1"]),
    limits: {
      maxTextureDimension2D: 4096,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageTexturesPerShaderStage: 4,
      maxSampledTexturesPerShaderStage: 16,
      maxComputeWorkgroupStorageSize: 16384,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
    },
    lost: loss.promise,
    queue: { writeBuffer() {} },
    createShaderModule: (d) => d,
    createSampler: (d) => d,
    createBindGroupLayout: (d) => d,
    createPipelineLayout: (d) => d,
    createComputePipeline: (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createBindGroup(d) {
      groups.push(d);
      return d;
    },
    createBuffer(d) {
      const buffer = {
        ...d,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createTexture(d) {
      const t = {
        label: d.label,
        width: d.size[0],
        height: d.size[1],
        format: d.format,
        destroyed: false,
        createView() {
          return { texture: this };
        },
        destroy() {
          this.destroyed = true;
        },
      };
      textures.push(t);
      return t;
    },
  };
  const accounting = new ResourceAccounting();
  const owner = new NativeTemporalV2(device, accounting);
  const command = {
    writeBuffer(_buffer, _offset, bytes) {
      writes.push(bytes.slice(0));
    },
    beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
  };
  const imported = new Map();
  const callbacks = [];
  let next = 0;
  const graph = {
    import_resource(_name, _descriptor, resource) {
      const id = next++;
      imported.set(id, resource);
      return id;
    },
    add(_name, data, callback) {
      callbacks.push({ data, callback });
      return {
        read() {},
        write(id) {
          return id;
        },
        create(name, d) {
          const id = next++;
          imported.set(
            id,
            device.createTexture({ label: name, size: [d.width, d.height], format: d.format }),
          );
          return id;
        },
      };
    },
  };
  const build = (width = 19, height = 13, seedOwner = null) => {
    const input = { width, height };
    for (const name of [
      "color",
      "seed",
      "response",
      "identity",
      "previousIdentity",
      "preExposure",
      "priorExposure",
    ]) {
      input[name] = graph.import_resource(
        name,
        {},
        seedOwner && ["seed", "response", "identity", "previousIdentity"].includes(name)
          ? { resolve: () => seedOwner.frame[name] }
          : device.createTexture({ label: name, size: [width, height] }),
      );
    }
    owner.addToGraph(graph, input, (_name, resolve) => ({ resolve }));
  };
  const encode = (currentCommand = command) => {
    for (const { data, callback } of callbacks) {
      callback(
        data,
        {
          get: (id) => {
            const binding = imported.get(id);
            return binding?.resolve ? binding.resolve(owner) : binding;
          },
        },
        { encoder: currentCommand },
      );
    }
  };
  const prepare = (width = 19, height = 13, reset = false, jitter = [0, 0]) =>
    owner.prepareFrame(command, { width, height, reset, jitter });
  return {
    owner,
    prepare,
    build,
    encode,
    textures,
    buffers,
    groups,
    writes,
    loss,
    command,
    device,
    accounting
  };
}

test("inactive Native histories remain accounted until their fence; returning domain allocates invalid history", async () => {
  const f = fixture();
  f.prepare();
  f.build();
  f.encode();
  const fence = deferred();
  f.owner.commit(fence.promise);
  const historyBytes = 19 * 13 * 46 + 32;
  assert.equal(f.accounting.snapshot().totalBytes, f.owner.allocatedBytes);
  f.owner.releaseHistory();
  assert.equal(f.accounting.snapshot().retiredBytes, historyBytes);
  assert.equal(f.owner.allocatedBytes, historyBytes + 164);
  f.prepare();
  assert.equal(new Uint32Array(f.writes.at(-1))[2], 0);
  assert.equal(f.accounting.snapshot().totalBytes, 2 * historyBytes + 164);
  f.owner.abort();
  fence.resolve();
  await fence.promise;
  await Promise.resolve();
  assert.equal(f.accounting.snapshot().totalBytes, 164);
  f.owner.destroy();
  await Promise.resolve();
  assert.equal(f.accounting.snapshot().totalBytes, 0);
});

test("unencoded commit is rejected; resize abort retains submitted histories, roles and jitter", async () => {
  const f = fixture();
  f.prepare();
  assert.throws(() => f.owner.commit(Promise.resolve()), /complete encoded/);
  assert.throws(() => f.owner.assertCompleteFrame(), /complete graph/);
  f.build();
  f.encode();
  const fence = deferred();
  f.owner.commit(fence.promise);
  const generation = f.owner.generation;
  const role = f.owner.readIndex;
  const active = f.textures.filter((t) => t.label?.startsWith("Native Temporal V2/color/"));
  f.prepare(31, 17, false, [0.25, -0.25]);
  assert.equal(new Uint32Array(f.writes.at(-1))[2], 0);
  f.owner.abort();
  assert.equal(f.owner.readIndex, role);
  assert.equal(f.owner.generation, generation);
  assert.ok(active.every((t) => !t.destroyed));
  f.prepare(19, 13, false, [0.5, 0.25]);
  assert.equal(new Uint32Array(f.writes.at(-1))[2], 1);
  assert.deepEqual([...new Float32Array(f.writes.at(-1)).slice(6, 8)], [0, 0]);
  f.owner.abort();
  f.owner.destroy();
  assert.ok(
    active.every((t) => !t.destroyed),
    "history destroyed before last consumer fence",
  );
  fence.resolve();
  await fence.promise;
  await Promise.resolve();
  assert.ok(active.every((t) => t.destroyed));
  assert.equal(f.owner.allocatedBytes, 0);
});

test("cached graph late binds both roles during three in-flight frames; cut preserves allocation", async () => {
  const f = fixture();
  const fences = [];
  const roleTextures = [];
  f.prepare();
  f.build();
  for (let i = 0; i < 3; i++) {
    if (i) {
      f.prepare(19, 13, i === 2, [i / 8, 0]);
    }
    f.encode();
    const resolve = f.groups.findLast((g) =>
      g.entries.some((e) => e.binding === 6 && e.resource.texture?.format === "rgba16float"),
    );
    roleTextures.push(resolve.entries.find((e) => e.binding === 6).resource.texture);
    const fence = deferred();
    fences.push(fence);
    f.owner.commit(fence.promise);
  }
  assert.equal(new Set(roleTextures).size, 2);
  assert.equal(f.owner.generation, 1);
  assert.equal(f.owner.allocatedBytes, 19 * 13 * 46 + 196);
  f.owner.destroy();
  assert.ok(roleTextures.every((t) => !t.destroyed));
  for (const fence of fences) {
    fence.resolve();
  }
  await Promise.all(fences.map((fence) => fence.promise));
  await Promise.resolve();
  assert.equal(f.owner.allocatedBytes, 0);
  assert.throws(() => f.prepare(), /unavailable/);
});

test("invalid extent/role fails before allocation; write failure rolls candidate back", () => {
  const f = fixture();
  const count = f.textures.length;
  for (const width of [0, NaN, 4097]) {
    assert.throws(() => f.prepare(width));
  }
  assert.throws(() =>
    f.owner.prepareFrame(f.command, {
      width: 19,
      height: 13,
      jitter: [0, 0],
      reset: false,
      historyReadIndex: 2,
    }),
  );
  assert.equal(f.textures.length, count);
  assert.throws(
    () =>
      f.owner.prepareFrame(
        {
          writeBuffer() {
            throw new Error("upload rejected");
          },
        },
        { width: 19, height: 13, jitter: [0, 0], reset: false },
      ),
    /upload rejected/,
  );
  assert.ok(f.textures.slice(count).every((t) => t.destroyed));
  f.owner.destroy();
  assert.equal(f.owner.allocatedBytes, 0);
});

test("cached graph rejects resized domains before dispatch and requires an explicit binder", () => {
  const f = fixture();
  f.prepare();
  assert.throws(() => f.owner.addToGraph({}, { width: 19, height: 13 }), /explicit frame resource binder/);
  assert.throws(() => f.build(20, 13), /graph domain differs/);
  f.build();
  f.encode();
  f.owner.commit(Promise.resolve());
  const groupCount = f.groups.length;
  f.prepare(31, 17);
  assert.throws(() => f.encode(), /graph domain differs/);
  assert.equal(f.groups.length, groupCount, "stale extent encoded a partial write domain");
  assert.throws(() => f.owner.commit(Promise.resolve()), /complete encoded/);
  f.owner.abort();
  f.owner.destroy();
});

test("device loss retires active and pending histories after their last-use fence", async () => {
  const f = fixture();
  f.prepare();
  f.build();
  f.encode();
  const fence = deferred();
  f.owner.commit(fence.promise);
  f.prepare(31, 17);
  const ownsHistory = (t) =>
    /^Native Temporal V2\/(color|depth|luma|luma history|confidence|frame info)\//.test(t.label);
  const pending = f.textures.filter((t) => ownsHistory(t) && t.width === 31);
  const active = f.textures.filter((t) => ownsHistory(t) && t.width === 19);
  f.loss.resolve();
  await f.loss.promise;
  await Promise.resolve();
  assert.ok(pending.every((t) => t.destroyed));
  assert.ok(active.every((t) => !t.destroyed));
  assert.throws(() => f.prepare(), /unavailable/);
  fence.resolve();
  await fence.promise;
  await Promise.resolve();
  assert.ok(active.every((t) => t.destroyed));
  assert.equal(f.owner.allocatedBytes, 0);
  f.owner.destroy();
});

test("constructor upload failure releases every allocated permanent buffer", () => {
  const f = fixture();
  f.owner.destroy();
  const count = f.buffers.length;
  f.device.queue.writeBuffer = () => {
    throw new Error("initial upload rejected");
  };
  assert.throws(() => new NativeTemporalV2(f.device), /initial upload rejected/);
  assert.equal(f.buffers.length - count, 3);
  assert.ok(f.buffers.slice(count).every((buffer) => buffer.destroyed));
});

test("negotiated storage limit is checked before any resource allocation", () => {
  const f = fixture();
  f.owner.destroy();
  const bufferCount = f.buffers.length;
  const textureCount = f.textures.length;
  f.device.limits.maxStorageTexturesPerShaderStage = 2;
  assert.throws(() => new NativeTemporalV2(f.device), /complete Analyze\/Resolve profile/);
  assert.equal(f.buffers.length, bufferCount);
  assert.equal(f.textures.length, textureCount);
});

const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function jointCommand(f) {
  const before = [],
    finished = [],
    aborted = [];
  const fence = deferred();
  return {
    ...f.command,
    device: f.device,
    closed: false,
    wasSubmitted: false,
    gpuDone: fence.promise,
    fence,
    onBeforeFinish: { addOne: (fn) => before.push(fn) },
    onFinished: { addOne: (fn) => finished.push(fn) },
    onAborted: { addOne: (fn) => aborted.push(fn) },
    finish() {
      try {
        before.forEach((fn) => fn());
      } catch (error) {
        this.abort();
        throw error;
      }
      this.wasSubmitted = true;
      this.closed = true;
      finished.forEach((fn) => fn());
    },
    abort() {
      this.closed = true;
      aborted.forEach((fn) => fn());
    },
  };
}

test("Seed and V2 submit and abort their exact history roles together on one cached command graph", async () => {
  const f = fixture();
  const seed = new NativeTemporalSeed(f.device);
  const camera = {
    view: identityMatrix,
    projection: identityMatrix,
    inverseView: identityMatrix,
    inverseProjection: identityMatrix,
    jitter: [0, 0],
    preExposure: 1,
  };
  const fences = [];
  let previousIdentity;
  for (let frame = 0; frame < 4; frame++) {
    const facts = seed.prepare(19, 13, "native", camera);
    if (previousIdentity) assert.equal(facts.previousIdentity, previousIdentity);
    const command = jointCommand(f);
    f.owner.prepareFrame(command, {
      width: 19,
      height: 13,
      reset: !facts.previousValid,
      jitter: facts.jitter,
      historyReadIndex: facts.historyReadIndex,
    });
    f.owner.attach(command, seed);
    if (!frame) f.build(19, 13, seed);
    f.encode(command);
    assert.throws(() => f.owner.commit(command.gpuDone), /successful submission/);
    if (frame === 1) {
      const role = f.owner.readIndex;
      command.abort();
      assert.equal(f.owner.readIndex, role);
    } else {
      command.finish();
      previousIdentity = facts.identity;
      assert.equal(f.owner.readIndex, 1 - facts.historyReadIndex);
      fences.push(command.fence);
    }
  }
  f.owner.destroy();
  seed.destroy();
  assert.ok(f.owner.allocatedBytes > 0);
  assert.ok(seed.allocatedBytes > 0);
  fences.forEach((fence) => fence.resolve());
  await Promise.all(fences.map((fence) => fence.promise));
  await Promise.resolve();
  assert.equal(f.owner.allocatedBytes, 0);
  assert.equal(seed.allocatedBytes, 0);
});

test("joint Seed/V2 rejects incomplete, foreign-command, stale-role and mismatched-frame publication", () => {
  const f = fixture();
  const seed = new NativeTemporalSeed(f.device);
  const camera = {
    view: identityMatrix,
    projection: identityMatrix,
    inverseView: identityMatrix,
    inverseProjection: identityMatrix,
    jitter: [0.25, 0],
    preExposure: 1,
  };
  seed.prepare(19, 13, "native", camera);
  let command = jointCommand(f);
  f.owner.prepareFrame(command, { width: 19, height: 13, reset: true, jitter: [0, 0] });
  assert.throws(() => f.owner.attach(command, seed), /same role, jitter and reset/);
  f.owner.abort();
  f.owner.prepareFrame(command, { width: 19, height: 13, reset: true, jitter: camera.jitter });
  f.owner.attach(command, seed);
  f.build(19, 13, seed);
  assert.throws(() => f.encode(jointCommand(f)), /current single command/);
  assert.throws(
    () => seed.acceptNativeResolve(command, { ...seed.frame, identity: seed.frame.previousIdentity }),
    /stale or mismatched/,
  );
  assert.throws(() => command.finish(), /incomplete/);
  assert.equal(command.wasSubmitted, false);
  assert.equal(f.owner.readIndex, 0);
  const retry = seed.prepare(19, 13, "native", camera);
  assert.equal(retry.previousValid, false);
  command = jointCommand(f);
  f.owner.prepareFrame(command, { width: 19, height: 13, reset: true, jitter: camera.jitter });
  f.owner.attach(command, seed);
  f.encode(command);
  command.abort();
  f.owner.destroy();
  seed.destroy();
  assert.equal(f.owner.allocatedBytes, 0);
  assert.equal(seed.allocatedBytes, 0);
});

test("AA-off Surface proof rejects stale roles and abort never publishes identity", () => {
  const f = fixture();
  const seed = new NativeTemporalSeed(f.device);
  const camera = {
    view: identityMatrix,
    projection: identityMatrix,
    inverseView: identityMatrix,
    inverseProjection: identityMatrix,
    jitter: [0, 0],
    preExposure: 1,
  };
  const first = seed.prepare(19, 13, "native", camera);
  let command = jointCommand(f);
  seed.attach(command, "surface-writer");
  assert.throws(() => seed.assertCompleteFrame(), /incomplete/);
  assert.throws(
    () => seed.acceptSurfaceWrite(command, { ...first, identity: first.previousIdentity }),
    /stale or mismatched/,
  );
  seed.acceptSurfaceWrite(command, first);
  assert.throws(() => seed.acceptSurfaceWrite(command, first), /complete command/);
  command.abort();
  const retry = seed.prepare(19, 13, "native", camera);
  assert.equal(retry.previousValid, false);
  command = jointCommand(f);
  seed.attach(command, "surface-writer");
  seed.acceptSurfaceWrite(command, retry);
  seed.assertCompleteFrame();
  command.finish();
  const next = seed.prepare(19, 13, "native", camera);
  assert.equal(next.previousIdentity, retry.identity);
  assert.equal(next.previousValid, true);
  seed.abort();
  seed.destroy();
  f.owner.destroy();
});
