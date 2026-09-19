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
  return prefetchCoalescedRangeGroups([ranges], readRange, signal, options).then(groups => groups[0]!);
}

/**
 * Coalesces several range groups in one global pass.
 *
 * `prefetchCoalescedRanges` plans each caller's ranges independently, so a cook
 * that canonicalizes N units issues N physical reads even when the units are
 * byte-adjacent. A GLB packs accessors contiguously, so planning every group at
 * once collapses that to the block count implied by `maxBlockBytes` while each
 * caller still receives only the slice it asked for.
 */
export async function prefetchCoalescedRangeGroups(
  groups: readonly (readonly GlbByteRange[])[],
  readRange: (range: GlbByteRange) => Promise<ArrayBuffer>,
  signal: AbortSignal | undefined,
  options: CoalescedRangeReaderOptions
): Promise<readonly CoalescedRangeReader[]> {
  if (!Number.isSafeInteger(options.maxBlockBytes) || options.maxBlockBytes <= 0) throw new RangeError("maxBlockBytes must be positive");
  if (!Number.isSafeInteger(options.maxGapBytes) || options.maxGapBytes < 0) throw new RangeError("maxGapBytes must be non-negative");
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) throw new RangeError("concurrency must be positive");
  const flat = groups.flatMap(group => group);
  const blockList = coalesce(flat, options);
  let fetchedBytes = 0;
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
  const plannedBytes = flat.reduce((sum, range) => sum + range.byteLength, 0);
  const wastedBytes = fetchedBytes - plannedBytes;
  return Object.freeze(groups.map(group => {
    const evidence: CoalescedRangeReaderEvidence = Object.freeze({
      requestedRanges: group.length,
      blocks: blockList.length,
      fetchedBytes,
      wastedBytes
    });
    return Object.freeze({
      signal,
      evidence,
      readRange: async (range: GlbByteRange): Promise<ArrayBuffer> => sliceFromBlocks(blockList, range)
    });
  }));
}

/**
 * Plans physical reads by accumulating one open block at a time.
 *
 * glTF accessors overlap freely: a VEC3 accessor and the VEC4 accessor that
 * embeds it both cover the same leading bytes, and consecutive primitives reuse
 * the tail of the previous accessor. Comparing each range against the previous
 * *block* alone therefore refused every overlapping range (`gap < 0`), opened a
 * fresh block, and fragmented one contiguous BIN into hundreds of reads.
 *
 * Two invariants make the result usable by `sliceFromBlocks`:
 * - a requested range must stay inside exactly one block, so blocks are only
 *   closed on a range boundary and never split mid-range;
 * - once a range is folded into a block the block keeps covering it, so a block
 *   is never reopened at a later start offset.
 *
 * `maxBlockBytes` bounds coalescing waste, not the width of a single accessor:
 * a range wider than the cap is emitted as its own oversized block.
 */
function coalesce(ranges: readonly GlbByteRange[], options: CoalescedRangeReaderOptions): RangeBlock[] {
  const sorted = [...ranges].sort((a, b) => a.bufferIndex - b.bufferIndex || a.byteOffset - b.byteOffset || a.byteLength - b.byteLength);
  const blocks: RangeBlock[] = [];
  let openBuffer = -1;
  let openStart = 0;
  let openEnd = 0;
  for (const range of sorted) {
    if (!Number.isInteger(range.byteOffset) || !Number.isInteger(range.byteLength) || range.byteOffset < 0 || range.byteLength < 0) throw new RangeError("GLB byte range is invalid");
    const rangeEnd = range.byteOffset + range.byteLength;
    if (openStart < openEnd && openBuffer === range.bufferIndex) {
      // Already covered: the block swallows overlapping and fully-contained ranges.
      if (range.byteOffset >= openStart && rangeEnd <= openEnd) continue;
      // Overlapping or near ranges extend the open block as long as it stays bounded.
      const mergedEnd = Math.max(openEnd, rangeEnd);
      if (range.byteOffset <= openEnd + options.maxGapBytes && mergedEnd - openStart <= options.maxBlockBytes) {
        openEnd = mergedEnd;
        blocks[blocks.length - 1] = { bufferIndex: openBuffer, byteOffset: openStart, byteLength: openEnd - openStart, bytes: undefined };
        continue;
      }
      // The range starts inside the open block but would push it past the cap, and
      // `sliceFromBlocks` cannot serve a range spread over two blocks. Only a range
      // that clears the current end can start a new block; one that starts inside
      // the block and also exceeds the cap gets its own oversized block so the
      // bytes it shares with the open block are fetched twice rather than lost.
      if (range.byteOffset < openEnd) {
        blocks.push({ bufferIndex: range.bufferIndex, byteOffset: range.byteOffset, byteLength: range.byteLength, bytes: undefined });
        openBuffer = range.bufferIndex;
        openStart = range.byteOffset;
        openEnd = rangeEnd;
        continue;
      }
    }
    openBuffer = range.bufferIndex;
    openStart = range.byteOffset;
    openEnd = rangeEnd;
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
