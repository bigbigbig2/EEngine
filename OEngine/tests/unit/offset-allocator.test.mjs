import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { OffsetAllocator, offsetSizeClass, offsetClassSize } from "../../.test-dist/gpu/OffsetAllocator.js";

test("OffsetAllocator matches the fixed native donor's complete 12000-step trace", () => {
  const allocator = new OffsetAllocator(65536, 4097);
  const live = [];
  const lines = [];
  let seed = 0x7ac01983;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 12000; step++) {
    if (live.length && random() % 3 === 0) {
      const index = random() % live.length;
      allocator.free(live[index]);
      live.splice(index, 1);
      lines.push(`F ${index}`);
    } else {
      const size = (random() % 1024) + 1;
      const allocation = allocator.allocate(size);
      lines.push(`A ${size} ${allocation?.offset ?? 0xffffffff}`);
      if (allocation) live.push(allocation);
    }
  }
  // Produced by unchanged donor C++, compiled with native-trace.cpp at the pinned revision.
  assert.equal(
    createHash("sha256").update(lines.join("\n")).digest("hex"),
    "a0593cdaf7d7eb59960867a6c77e8c01d22e8df930fdea46f163f548cbe0de84",
  );
});

test("OffsetAllocator SmallFloat classes bracket all exponent boundaries", () => {
  for (let exponent = 0; exponent <= 29; exponent++) {
    for (const delta of [-1, 0, 1, 3, 7]) {
      const value = 2 ** exponent + delta;
      if (value <= 0 || value > 0x40000000) continue;
      assert.ok(offsetClassSize(offsetSizeClass(value)) <= value);
      assert.ok(offsetClassSize(offsetSizeClass(value, true)) >= value);
    }
  }
});

test("OffsetAllocator preserves donor split/reuse/coalescing decisions", () => {
  const allocator = new OffsetAllocator(256 * 1024 * 1024, 1024);
  const a = allocator.allocate(1024);
  const b = allocator.allocate(3456);
  assert.equal(a.offset, 0);
  assert.equal(b.offset, 1024);
  allocator.free(a);
  const c = allocator.allocate(2345);
  const d = allocator.allocate(456);
  const e = allocator.allocate(512);
  assert.equal(c.offset, 4480);
  assert.equal(d.offset, 0);
  assert.equal(e.offset, 456);
  for (const allocation of [c, d, b, e]) allocator.free(allocation);
  assert.equal(allocator.freeUnits, allocator.size);
  const all = allocator.allocate(allocator.size);
  assert.equal(all.offset, 0);
  allocator.free(all);
  assert.throws(() => allocator.free(all), /stale|twice/);
});

test("OffsetAllocator independent interval oracle: fixed random trace and stable tail growth", () => {
  const allocator = new OffsetAllocator(65536, 4097);
  const live = [];
  let seed = 0x7ac01983;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 12000; step++) {
    if (step === 4000) allocator.grow(131072);
    if (live.length !== 0 && random() % 3 === 0) {
      const index = random() % live.length;
      allocator.free(live[index]);
      live.splice(index, 1);
    } else {
      const size = (random() % 1024) + 1;
      const allocation = allocator.allocate(size);
      if (allocation !== undefined) {
        assert.equal(allocation.size, size);
        assert.ok(allocation.offset + size <= allocator.size);
        for (const other of live) {
          assert.ok(
            allocation.offset + size <= other.offset || other.offset + other.size <= allocation.offset,
          );
        }
        live.push(allocation);
      }
    }
    assert.equal(allocator.freeUnits + live.reduce((sum, item) => sum + item.size, 0), allocator.size);
  }
  for (const allocation of live) allocator.free(allocation);
  assert.equal(allocator.allocate(131072).offset, 0);
});

test("OffsetAllocator node exhaustion and high-bit bounds never alias live leases", () => {
  const small = new OffsetAllocator(1024, 3);
  const first = small.allocate(1);
  assert.ok(first);
  assert.equal(small.allocate(1), undefined);
  small.free(first);
  const second = small.allocate(1);
  assert.throws(() => small.free(first), /stale/);
  small.free(second);
  const large = new OffsetAllocator(0x40000000, 17);
  assert.equal(large.allocate(0x20000000).offset, 0);
  assert.equal(large.allocate(0x20000000).offset, 0x20000000);
  assert.equal(large.allocate(1), undefined);
  assert.equal(large.allocate(0), undefined);
});
