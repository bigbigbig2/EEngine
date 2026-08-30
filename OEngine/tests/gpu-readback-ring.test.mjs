import test from "node:test";
import assert from "node:assert/strict";

import {
  GPU_COUNTER_BYTE_SIZE,
  GPU_COUNTER_FIELDS,
  GPU_COUNTER_SCHEMA_VERSION,
  decodeGpuCounterValues
} from "../.test-dist/debug/GpuFrameCounters.js";
import { GpuReadbackRing } from "../.test-dist/debug/GpuReadbackRing.js";

globalThis.GPUBufferUsage ??= { COPY_DST: 1, MAP_READ: 2 };
globalThis.GPUMapMode ??= { READ: 1 };

test("GPU counter ABI is fixed, unique and 256-byte aligned", () => {
  assert.equal(GPU_COUNTER_SCHEMA_VERSION, 5);
  assert.equal(GPU_COUNTER_BYTE_SIZE, 256);
  assert.equal(GPU_COUNTER_BYTE_SIZE % 256, 0);
  assert.equal(new Set(GPU_COUNTER_FIELDS.map((field) => field.name)).size,
    GPU_COUNTER_FIELDS.length);
  assert.equal(new Set(GPU_COUNTER_FIELDS.map((field) => field.index)).size,
    GPU_COUNTER_FIELDS.length);

  const raw = new Uint32Array(GPU_COUNTER_BYTE_SIZE / 4);
  raw[GPU_COUNTER_FIELDS.find((field) => field.name === "candidateInstances").index] = 81;
  raw[GPU_COUNTER_FIELDS.find((field) => field.name === "queueOverflowMask").index] = 4;
  const decoded = decodeGpuCounterValues(raw);
  assert.equal(decoded.candidateInstances, 81);
  assert.equal(decoded.queueOverflowMask, 4);
});

test("three-slot readback ring drops instead of blocking and reuses completed slots", async () => {
  const device = new FakeDevice();
  const source = new FakeBuffer(16);
  new Uint32Array(source.bytes.buffer).set([11, 22, 33, 44]);
  const results = [];
  const ring = new GpuReadbackRing(device, {
    byteLength: 16,
    slotCount: 3,
    label: "test-ring",
    onResult: (result) => results.push(result)
  });
  const encoder = new FakeEncoder();

  const tickets = [1, 2, 3].map((frameIndex) =>
    ring.encodeCopy(encoder, source, 0, frameIndex)
  );
  assert.ok(tickets.every(Boolean));
  assert.equal(ring.encodeCopy(encoder, source, 0, 4), null);
  assert.equal(ring.stats.dropped, 1);
  assert.equal(ring.stats.pending, 3);

  for (const ticket of tickets) ring.markSubmitted(ticket);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ring.stats.pending, 0);
  assert.equal(ring.stats.completed, 3);
  assert.deepEqual(results.map((result) => result.frameIndex), [1, 2, 3]);
  assert.deepEqual([...new Uint32Array(results[0].data)], [11, 22, 33, 44]);

  const reused = ring.encodeCopy(encoder, source, 0, 5);
  assert.ok(reused);
  ring.markSubmitted(reused);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ring.stats.completed, 4);
  ring.destroy();
  assert.equal(device.buffers.every((buffer) => buffer.destroyed), true);
});

test("readback map failures release the slot and increment failure evidence", async () => {
  const device = new FakeDevice();
  const source = new FakeBuffer(16);
  const failures = [];
  const ring = new GpuReadbackRing(device, {
    byteLength: 16,
    slotCount: 3,
    onResult: () => assert.fail("failed mapping must not publish a result"),
    onError: (failure) => failures.push(failure)
  });
  const encoder = new FakeEncoder();
  const ticket = ring.encodeCopy(encoder, source, 0, 7);
  assert.ok(ticket);
  device.buffers[ticket.slotIndex].mapError = new Error("map failed");

  ring.markSubmitted(ticket);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ring.stats.pending, 0);
  assert.equal(ring.stats.failed, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].frameIndex, 7);
  assert.match(String(failures[0].error), /map failed/);

  const reusedTickets = [8, 9, 10].map((frameIndex) =>
    ring.encodeCopy(encoder, source, 0, frameIndex)
  );
  assert.ok(reusedTickets.every(Boolean));
  assert.equal(ring.stats.pending, 3);
  ring.destroy();
});

test("an encoded readback can be cancelled when frame encoding aborts", () => {
  const device = new FakeDevice();
  const source = new FakeBuffer(16);
  const failures = [];
  const ring = new GpuReadbackRing(device, {
    byteLength: 16,
    slotCount: 3,
    onResult: () => assert.fail("cancelled copy must not publish a result"),
    onError: (failure) => failures.push(failure)
  });
  const ticket = ring.encodeCopy(new FakeEncoder(), source, 0, 11);
  assert.ok(ticket);

  ring.cancel(ticket, new Error("frame aborted"));

  assert.equal(ring.stats.pending, 0);
  assert.equal(ring.stats.failed, 1);
  assert.equal(failures[0].frameIndex, 11);
  assert.match(String(failures[0].error), /frame aborted/);
  assert.ok(ring.encodeCopy(new FakeEncoder(), source, 0, 12));
  ring.destroy();
});

class FakeDevice {
  buffers = [];

  createBuffer(descriptor) {
    const buffer = new FakeBuffer(descriptor.size);
    this.buffers.push(buffer);
    return buffer;
  }
}

class FakeBuffer {
  mapState = "unmapped";
  destroyed = false;
  mapError = null;

  constructor(size) {
    this.size = size;
    this.bytes = new Uint8Array(size);
  }

  async mapAsync() {
    if (this.mapError !== null) throw this.mapError;
    this.mapState = "mapped";
  }

  getMappedRange(offset = 0, size = this.size - offset) {
    return this.bytes.buffer.slice(offset, offset + size);
  }

  unmap() {
    this.mapState = "unmapped";
  }

  destroy() {
    this.destroyed = true;
    this.mapState = "unmapped";
  }
}

class FakeEncoder {
  copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
    destination.bytes.set(
      source.bytes.subarray(sourceOffset, sourceOffset + size),
      destinationOffset
    );
  }
}
