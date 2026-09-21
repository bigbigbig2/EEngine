import assert from "node:assert/strict";
import test from "node:test";

const { prefetchCoalescedRanges, prefetchCoalescedRangeGroups } = await import("../.test-dist/assets/web-cook/CoalescedRangeReader.js");

test("coalesced range reader merges nearby ranges and preserves accessor identity", async () => {
  const source = new Uint8Array(256);
  for (let index = 0; index < source.length; index++) source[index] = index;
  const reads = [];
  const readRange = async (range) => {
    reads.push({ ...range });
    return source.slice(range.byteOffset, range.byteOffset + range.byteLength).buffer;
  };
  const ranges = [
    { bufferIndex: 0, byteOffset: 0, byteLength: 10 },
    { bufferIndex: 0, byteOffset: 12, byteLength: 8 },
    { bufferIndex: 0, byteOffset: 100, byteLength: 10 }
  ];
  const reader = await prefetchCoalescedRanges(ranges, readRange, undefined, { maxBlockBytes: 1024, maxGapBytes: 4, concurrency: 2 });
  assert.equal(reads.length, 2, "nearby ranges share one physical read");
  assert.deepEqual(reads[0], { bufferIndex: 0, byteOffset: 0, byteLength: 20 });
  assert.deepEqual(reads[1], { bufferIndex: 0, byteOffset: 100, byteLength: 10 });
  assert.equal(reader.evidence.requestedRanges, 3);
  assert.equal(reader.evidence.blocks, 2);
  for (const range of ranges) {
    const bytes = new Uint8Array(await reader.readRange(range));
    assert.deepEqual([...bytes], [...source.slice(range.byteOffset, range.byteOffset + range.byteLength)]);
  }
});

test("coalesced range reader fails closed on an unprefetched range", async () => {
  const source = new Uint8Array(64);
  const reader = await prefetchCoalescedRanges([{ bufferIndex: 0, byteOffset: 0, byteLength: 8 }], async (range) => source.slice(range.byteOffset, range.byteOffset + range.byteLength).buffer, undefined, { maxBlockBytes: 64, maxGapBytes: 0, concurrency: 1 });
  await assert.rejects(() => reader.readRange({ bufferIndex: 0, byteOffset: 32, byteLength: 8 }), /not prefetched/);
});

test("coalesced range reader folds overlapping accessors into one read", async () => {
  // A glTF BIN interleaves a VEC3/SCALAR pair with the VEC4 that embeds it: the
  // second range starts 12 bytes into the first and ends further out. Comparing
  // against the previous block alone treated that as unmergeable and fragmented
  // one contiguous span into one read per accessor.
  const source = new Uint8Array(4096);
  for (let index = 0; index < source.length; index++) source[index] = index % 256;
  const reads = [];
  const readRange = async (range) => {
    reads.push({ ...range });
    return source.slice(range.byteOffset, range.byteOffset + range.byteLength).buffer;
  };
  const ranges = [
    { bufferIndex: 0, byteOffset: 0, byteLength: 1000 },
    { bufferIndex: 0, byteOffset: 12, byteLength: 2000 },
    { bufferIndex: 0, byteOffset: 24, byteLength: 3000 }
  ];
  const reader = await prefetchCoalescedRanges(ranges, readRange, undefined, { maxBlockBytes: 1024 * 1024, maxGapBytes: 64 * 1024, concurrency: 1 });
  assert.equal(reads.length, 1, "overlapping ranges share one physical read");
  assert.deepEqual(reads[0], { bufferIndex: 0, byteOffset: 0, byteLength: 3024 });
  assert.equal(reader.evidence.blocks, 1);
  // `wastedBytes` is fetched minus the sum of the requested ranges, and the
  // requests overlap, so merging redundancy makes the total negative.
  assert.equal(reader.evidence.fetchedBytes, 3024);
  assert.equal(reader.evidence.wastedBytes, 3024 - (1000 + 2000 + 3000));
  for (const range of ranges) {
    const bytes = new Uint8Array(await reader.readRange(range));
    assert.deepEqual([...bytes], [...source.slice(range.byteOffset, range.byteOffset + range.byteLength)]);
  }
});

test("coalesced range reader keeps every range inside a single block when one outgrows the cap", async () => {
  // A range that starts inside the open block but would push it past
  // `maxBlockBytes` must not be split across two blocks, and must not orphan the
  // ranges already folded into the open block.
  const source = new Uint8Array(4096);
  for (let index = 0; index < source.length; index++) source[index] = index % 256;
  const ranges = [
    { bufferIndex: 0, byteOffset: 0, byteLength: 100 },
    { bufferIndex: 0, byteOffset: 64, byteLength: 900 },
    { bufferIndex: 0, byteOffset: 1024, byteLength: 512 }
  ];
  const reader = await prefetchCoalescedRanges(
    ranges,
    async (range) => source.slice(range.byteOffset, range.byteOffset + range.byteLength).buffer,
    undefined,
    { maxBlockBytes: 512, maxGapBytes: 0, concurrency: 1 }
  );
  assert.equal(reader.evidence.blocks, 3);
  for (const range of ranges) {
    const bytes = new Uint8Array(await reader.readRange(range));
    assert.deepEqual([...bytes], [...source.slice(range.byteOffset, range.byteOffset + range.byteLength)]);
  }
});

test("coalesced range reader plans every group in one physical pass", async () => {
  // Per-group planning issued one read per unit even when the units were
  // byte-adjacent; a single global plan collapses them.
  const source = new Uint8Array(4096);
  for (let index = 0; index < source.length; index++) source[index] = index % 256;
  const reads = [];
  const groups = [
    [{ bufferIndex: 0, byteOffset: 0, byteLength: 100 }],
    [{ bufferIndex: 0, byteOffset: 100, byteLength: 100 }],
    [{ bufferIndex: 0, byteOffset: 200, byteLength: 100 }]
  ];
  const readers = await prefetchCoalescedRangeGroups(
    groups,
    async (range) => {
      reads.push({ ...range });
      return source.slice(range.byteOffset, range.byteOffset + range.byteLength).buffer;
    },
    undefined,
    { maxBlockBytes: 1024 * 1024, maxGapBytes: 64 * 1024, concurrency: 2 }
  );
  assert.equal(reads.length, 1, "adjacent groups share one physical read");
  assert.deepEqual(reads[0], { bufferIndex: 0, byteOffset: 0, byteLength: 300 });
  assert.equal(readers.length, 3);
  for (let index = 0; index < groups.length; index++) {
    const bytes = new Uint8Array(await readers[index].readRange(groups[index][0]));
    assert.deepEqual([...bytes], [...source.slice(groups[index][0].byteOffset, groups[index][0].byteOffset + groups[index][0].byteLength)]);
  }
});
