import assert from "node:assert/strict";
import test from "node:test";

const { prefetchCoalescedRanges } = await import("../.test-dist/assets/web-cook/CoalescedRangeReader.js");

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
