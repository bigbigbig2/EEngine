import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "../webgpu-test-globals.mjs";
import { FinalPixelLightingPublication } from "../../.test-dist/render/lighting/FinalPixelLightingPublication.js";
import { packVsmFilterData, VSM_FILTER_DATA_BYTES } from "../../.test-dist/gpu/GpuVsmFilterAbi.js";
import { deserialize_shade_image } from "../../.test-dist/texture/deserialize_shade_image.js";
globalThis.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

test("actual STBN sequence is retained byte-for-byte and all rotation entries are bounded", async () => {
  const raw = await readFile(new URL("../../src/render/assets/textures/stbn_vec1.bin", import.meta.url));
  const image = deserialize_shade_image(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  assert.deepEqual(
    [image.width, image.height, image.depth, image.channel_count, image.data_type],
    [128, 128, 64, 1, "uint8"],
  );
  const source = new Uint8Array(image.source);
  const data = packVsmFilterData(source);
  assert.equal(data.byteLength, VSM_FILTER_DATA_BYTES);
  assert.deepEqual(data.subarray(0, source.length), source);
  const table = new Float32Array(data.buffer, source.length);
  for (let i = 0; i < 256; i++) {
    assert.ok(Math.abs(table[i * 2] ** 2 + table[i * 2 + 1] ** 2 - 1) < 1e-7);
    let angle = (i * 2 * Math.PI) / 256;
    if (angle > Math.PI) angle -= 2 * Math.PI;
    assert.ok(Math.abs(Math.atan2(table[i * 2 + 1], table[i * 2]) - angle) < 1e-7);
  }
  assert.throws(() => packVsmFilterData(source.subarray(0, source.length - 1)), /complete/);
});

test("STBN fetch failure is reported, retry succeeds, and a complete CPU asset is cached", async () => {
  const raw = await readFile(new URL("../../src/render/assets/textures/stbn_vec1.bin", import.meta.url));
  const { loadVsmFilterData } = await import("../../.test-dist/render/vsm/VsmFilterNoise.js?retry-contract");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    return {
      ok: true,
      arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    };
  };
  try {
    await assert.rejects(loadVsmFilterData(), /HTTP 503/);
    const data = await loadVsmFilterData();
    assert.equal(data.length, VSM_FILTER_DATA_BYTES);
    assert.equal(await loadVsmFilterData(), data);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("noise initializes once per allocation, survives abort and retires only after its consumer fence", async () => {
  const writes = [],
    buffers = [];
  let lose;
  const device = {
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
    limits: {
      minStorageBufferOffsetAlignment: 256,
      maxBufferSize: 1 << 28,
      maxStorageBufferBindingSize: 1 << 27,
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        writes.push({ buffer, offset, bytes: data.byteLength });
      },
    },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
  };
  const command = () => {
    const finished = [],
      aborted = [];
    let done;
    return {
      device,
      closed: false,
      gpuDone: new Promise((resolve) => {
        done = resolve;
      }),
      onFinished: {
        addOne(fn) {
          finished.push(fn);
        },
      },
      onAborted: {
        addOne(fn) {
          aborted.push(fn);
        },
      },
      finish() {
        this.closed = true;
        finished.forEach((fn) => fn());
      },
      abort() {
        this.closed = true;
        aborted.forEach((fn) => fn());
      },
      done() {
        done();
      },
    };
  };
  const data = packVsmFilterData(new Uint8Array(128 * 128 * 64));
  const owner = new FinalPixelLightingPublication(device);
  const first = command(),
    a = owner.prepare(24, 260, first, data);
  assert.equal(a.plan.filterNoiseBytes, data.byteLength);
  assert.equal(a.plan.filterNoiseOffset, a.plan.lookupOffset + a.plan.lookupBytes);
  first.abort();
  const retry = command(),
    b = owner.prepare(24, 260, retry, data);
  assert.equal(a.buffer, b.buffer);
  retry.finish();
  const second = command(),
    c = owner.prepare(24, 260, second, data);
  second.finish();
  assert.notEqual(a.buffer, c.buffer);
  assert.equal(writes.filter((write) => write.bytes === data.byteLength).length, 2);
  retry.done();
  await retry.gpuDone;
  await Promise.resolve();
  const gather = command(),
    d = owner.prepare(24, 260, gather);
  assert.equal(d.plan.filterNoiseBytes, 0);
  assert.ok(a.buffer.destroyed);
  assert.ok(!c.buffer.destroyed);
  gather.abort();
  owner.releaseFrameResources();
  assert.ok(d.buffer.destroyed);
  assert.ok(!c.buffer.destroyed);
  second.done();
  await second.gpuDone;
  await Promise.resolve();
  assert.equal(owner.allocatedBytes, 0);
  const pending = command();
  owner.prepare(48, 260, pending, data);
  lose({ reason: "destroyed" });
  await Promise.resolve();
  assert.ok(pending.closed);
  assert.ok(buffers.every((buffer) => buffer.destroyed));
});

test("noise allocation/upload failure rolls back every partially allocated resource", () => {
  const buffers = [];
  const device = {
    lost: new Promise(() => {}),
    limits: {
      minStorageBufferOffsetAlignment: 256,
      maxBufferSize: 1 << 28,
      maxStorageBufferBindingSize: 1 << 27,
    },
    queue: {
      writeBuffer(_buffer, _offset, data) {
        if (data.byteLength === VSM_FILTER_DATA_BYTES) throw new Error("upload failed");
      },
    },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
  };
  const owner = new FinalPixelLightingPublication(device);
  assert.throws(
    () => owner.prepare(1, 1, { device, closed: false }, new Uint8Array(VSM_FILTER_DATA_BYTES)),
    /upload failed/,
  );
  assert.ok(buffers.every((buffer) => buffer.destroyed));
  assert.equal(owner.allocatedBytes, 0);
  assert.throws(() => owner.prepare(1, 1, { device, closed: false }, new Uint8Array(4)), /complete/);
});
