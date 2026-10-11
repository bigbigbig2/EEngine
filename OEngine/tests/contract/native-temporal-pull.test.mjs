import "../webgpu-test-globals.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { NativeTemporalV2 } from "../../.test-dist/render/temporal/NativeTemporalV2.js";

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
    limits: {
      maxTextureDimension2D: 4096,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageTexturesPerShaderStage: 4,
      maxSampledTexturesPerShaderStage: 16,
      maxComputeWorkgroupStorageSize: 16384,
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
  const owner = new NativeTemporalV2(device);
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
  const build = (width = 19, height = 13) => {
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
        device.createTexture({ label: name, size: [width, height] }),
      );
    }
    owner.addToGraph(graph, input, (_name, resolve) => ({ resolve }));
  };
  const encode = () => {
    for (const { data, callback } of callbacks) {
      callback(
        data,
        {
          get: (id) => {
            const binding = imported.get(id);
            return binding?.resolve ? binding.resolve(owner) : binding;
          },
        },
        { encoder: command },
      );
    }
  };
  const prepare = (width = 19, height = 13, reset = false, jitter = [0, 0]) =>
    owner.prepareFrame(command, { width, height, reset, jitter });
  return { owner, prepare, build, encode, textures, buffers, groups, writes, loss, command, device };
}

test("unencoded commit is rejected; resize abort retains submitted histories, roles and jitter", async () => {
  const f = fixture();
  f.prepare();
  assert.throws(() => f.owner.commit(Promise.resolve()), /complete encoded/);
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
  assert.deepEqual([...new Float32Array(f.writes.at(-1)).slice(6)], [0, 0]);
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
      g.entries.some((e) => e.binding === 9 && e.resource.texture?.format === "rg32float"),
    );
    roleTextures.push(resolve.entries.find((e) => e.binding === 8).resource.texture);
    const fence = deferred();
    fences.push(fence);
    f.owner.commit(fence.promise);
  }
  assert.equal(new Set(roleTextures).size, 2);
  assert.equal(f.owner.generation, 1);
  assert.equal(f.owner.allocatedBytes, 19 * 13 * 40 + 52);
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
  const ownsHistory = (t) => /^Native Temporal V2\/(color|depth|state)\//.test(t.label);
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
  assert.equal(f.buffers.length - count, 2);
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
