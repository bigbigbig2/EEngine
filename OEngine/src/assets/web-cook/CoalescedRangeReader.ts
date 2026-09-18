import type { GlbByteRange } from "../../loaders/gltf/streaming/GlbSceneCatalog.js";

export interface CoalescedRangeReaderOptions {
  /** Maximum bytes fetched in one physical read. */
  readonly maxBlockBytes: number;
  /** Maximum unused gap merged into one physical read. */
  readonly maxGapBytes: number;
  /** Maximum in-flight physical reads. */
  readonly concurrency: number;
}

export interface CoalescedRangeReader {
  readonly signal?: AbortSignal;
  readRange(range: GlbByteRange): Promise<ArrayBuffer>;
  readonly evidence: CoalescedRangeReaderEvidence;
}

export interface CoalescedRangeReaderEvidence {
  readonly requestedRanges: number;
  readonly blocks: number;
  readonly fetchedBytes: number;
  readonly wastedBytes: number;
}

interface RangeBlock {
  readonly bufferIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  bytes: Uint8Array | undefined;
}

/**
 * Coalesces many small glTF accessor ranges into a bounded number of physical
 * reads and serves the original accessors from the fetched blocks. It keeps the
 * caller's byte-range identity intact: only transfer granularity changes.
 */
export async function prefetchCoalescedRanges(
  ranges: readonly GlbByteRange[],
  readRange: (range: GlbByteRange) => Promise<ArrayBuffer>,
  signal: AbortSignal | undefined,
  options: CoalescedRangeReaderOptions
): Promise<CoalescedRangeReader> {
  if (!Number.isSafeInteger(options.maxBlockBytes) || options.maxBlockBytes <= 0) throw new RangeError("maxBlockBytes must be positive");
  if (!Number.isSafeInteger(options.maxGapBytes) || options.maxGapBytes < 0) throw new RangeError("maxGapBytes must be non-negative");
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) throw new RangeError("concurrency must be positive");
  const blockList = coalesce(ranges, options);
  let fetchedBytes = 0;
  let wastedBytes = 0;
  let cursor = 0;
  const lanes = Math.max(1, Math.min(options.concurrency, blockList.length));
  const runLane = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= blockList.length) return;
      const block = blockList[index]!;
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      const bytes = new Uint8Array(await readRange({ bufferIndex: block.bufferIndex, byteOffset: block.byteOffset, byteLength: block.byteLength }));
      if (bytes.byteLength !== block.byteLength) throw new Error("coalesced GLB range returned the wrong byte length");
      block.bytes = bytes;
      fetchedBytes += bytes.byteLength;
    }
  };
  await Promise.all(Array.from({ length: lanes }, runLane));
  const usedBytes = ranges.reduce((sum, range) => sum + range.byteLength, 0);
  wastedBytes = fetchedBytes - usedBytes;
  const evidence: CoalescedRangeReaderEvidence = Object.freeze({
    requestedRanges: ranges.length,
    blocks: blockList.length,
    fetchedBytes,
    wastedBytes
  });
  return Object.freeze({
    signal,
    evidence,
    readRange: async (range: GlbByteRange): Promise<ArrayBuffer> => sliceFromBlocks(blockList, range)
  });
}

function coalesce(ranges: readonly GlbByteRange[], options: CoalescedRangeReaderOptions): RangeBlock[] {
  const sorted = [...ranges].sort((a, b) => a.bufferIndex - b.bufferIndex || a.byteOffset - b.byteOffset || a.byteLength - b.byteLength);
  const blocks: RangeBlock[] = [];
  for (const range of sorted) {
    if (!Number.isInteger(range.byteOffset) || !Number.isInteger(range.byteLength) || range.byteOffset < 0 || range.byteLength < 0) throw new RangeError("GLB byte range is invalid");
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.bufferIndex === range.bufferIndex) {
      const lastEnd = last.byteOffset + last.byteLength;
      const gap = range.byteOffset - lastEnd;
      const mergedEnd = Math.max(lastEnd, range.byteOffset + range.byteLength);
      if (gap >= 0 && gap <= options.maxGapBytes && mergedEnd - last.byteOffset <= options.maxBlockBytes) {
        blocks[blocks.length - 1] = { bufferIndex: last.bufferIndex, byteOffset: last.byteOffset, byteLength: mergedEnd - last.byteOffset, bytes: undefined };
        continue;
      }
      if (range.byteOffset >= last.byteOffset && range.byteOffset + range.byteLength <= lastEnd) continue;
    }
    blocks.push({ bufferIndex: range.bufferIndex, byteOffset: range.byteOffset, byteLength: range.byteLength, bytes: undefined });
  }
  return blocks;
}

function sliceFromBlocks(blocks: readonly RangeBlock[], range: GlbByteRange): ArrayBuffer {
  const block = findBlock(blocks, range);
  if (!block || block.bytes === undefined) throw new Error(`coalesced GLB range ${range.bufferIndex}:${range.byteOffset}+${range.byteLength} was not prefetched`);
  const start = range.byteOffset - block.byteOffset;
  return block.bytes.slice(start, start + range.byteLength).buffer;
}

function findBlock(blocks: readonly RangeBlock[], range: GlbByteRange): RangeBlock | undefined {
  let low = 0, high = blocks.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const block = blocks[middle]!;
    if (block.bufferIndex < range.bufferIndex) low = middle + 1;
    else if (block.bufferIndex > range.bufferIndex) high = middle - 1;
    else if (range.byteOffset < block.byteOffset) high = middle - 1;
    else if (range.byteOffset + range.byteLength > block.byteOffset + block.byteLength) low = middle + 1;
    else return block;
  }
  return undefined;
}
