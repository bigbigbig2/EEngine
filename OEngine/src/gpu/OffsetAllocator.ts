// Adapted from sebbbi/OffsetAllocator, MIT, Copyright (c) 2023 Sebastian Aaltonen.
// Revision 3610a7377088b1e8c8f1525f458c96038a4e6fc0; see tests/oracle/reference/offset-allocator.
const UNUSED = 0xffffffff;

export function offsetSizeClass(size: number, roundUp = false): number {
  if (size < 8) {
    return size;
  }
  const shift = 31 - Math.clz32(size) - 3;
  const exponent = shift + 1;
  let mantissa = (size >>> shift) & 7;
  if (roundUp && size % 2 ** shift !== 0) {
    mantissa++;
  }
  return exponent * 8 + mantissa;
}

export function offsetClassSize(bin: number): number {
  const exponent = bin >>> 3;
  const mantissa = bin & 7;
  return exponent === 0 ? mantissa : (mantissa | 8) * 2 ** (exponent - 1);
}

function lowestBitAfter(mask: number, start: number): number {
  if (start >= 32) {
    return UNUSED;
  }
  const bits = (mask & (0xffffffff << start)) >>> 0;
  return bits === 0 ? UNUSED : 31 - Math.clz32((bits & -bits) >>> 0);
}

export interface OffsetAllocation {
  readonly offset: number;
  readonly size: number;
  readonly node: number;
  readonly generation: number;
}

/** Full two-level segregated-fit allocator. Units are chosen by the caller.
 * Local additions: checked leases, bounded SoA nodes and stable-offset tail growth. */
export class OffsetAllocator {
  #size: number;
  #freeBytes = 0;
  #topMask = 0;
  #freeCount: number;
  #tail = UNUSED;
  readonly #leafMasks = new Uint8Array(32);
  readonly #heads = new Uint32Array(256).fill(UNUSED);
  readonly #offsets: Uint32Array;
  readonly #sizes: Uint32Array;
  readonly #binPrev: Uint32Array;
  readonly #binNext: Uint32Array;
  readonly #prev: Uint32Array;
  readonly #next: Uint32Array;
  readonly #used: Uint8Array;
  readonly #generations: Float64Array;
  readonly #freeNodes: Uint32Array;

  constructor(
    size: number,
    readonly nodeCapacity: number,
  ) {
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > 0x40000000 ||
      !Number.isSafeInteger(nodeCapacity) ||
      nodeCapacity < 3 ||
      nodeCapacity > 0x1000000
    ) {
      throw new RangeError("Offset allocator size/node capacity is invalid");
    }
    this.#size = size;
    this.#offsets = new Uint32Array(nodeCapacity);
    this.#sizes = new Uint32Array(nodeCapacity);
    this.#binPrev = new Uint32Array(nodeCapacity).fill(UNUSED);
    this.#binNext = new Uint32Array(nodeCapacity).fill(UNUSED);
    this.#prev = new Uint32Array(nodeCapacity).fill(UNUSED);
    this.#next = new Uint32Array(nodeCapacity).fill(UNUSED);
    this.#used = new Uint8Array(nodeCapacity);
    this.#generations = new Float64Array(nodeCapacity);
    this.#freeNodes = new Uint32Array(nodeCapacity);
    for (let index = 0; index < nodeCapacity; index++) {
      this.#freeNodes[index] = nodeCapacity - index - 1;
    }
    this.#freeCount = nodeCapacity;
    this.#tail = this.#insert(size, 0);
  }

  get size(): number {
    return this.#size;
  }
  get freeUnits(): number {
    return this.#freeBytes;
  }
  get availableNodes(): number {
    return this.#freeCount;
  }
  get cpuBytes(): number {
    return 32 + 256 * 4 + this.nodeCapacity * (7 * 4 + 1 + 8);
  }
  get largestFreeRegionLowerBound(): number {
    if (this.#topMask === 0) {
      return 0;
    }
    const top = 31 - Math.clz32(this.#topMask);
    const leaf = 31 - Math.clz32(this.#leafMasks[top]!);
    return offsetClassSize(top * 8 + leaf);
  }

  allocate(size: number): OffsetAllocation | undefined {
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.#size) {
      return undefined;
    }
    // As upstream, keep a node available for the split and future growth.
    if (this.#freeCount < 2) {
      return undefined;
    }
    const minimum = offsetSizeClass(size, true);
    const minimumTop = minimum >>> 3;
    let top = minimumTop;
    let leaf =
      (this.#topMask & (1 << top)) !== 0 ? lowestBitAfter(this.#leafMasks[top]!, minimum & 7) : UNUSED;
    if (leaf === UNUSED) {
      top = lowestBitAfter(this.#topMask, minimumTop + 1);
      if (top === UNUSED) {
        return undefined;
      }
      leaf = lowestBitAfter(this.#leafMasks[top]!, 0);
    }
    const bin = top * 8 + leaf;
    const node = this.#heads[bin]!;
    const total = this.#sizes[node]!;
    this.#unlink(node, bin);
    this.#freeBytes -= total;
    this.#sizes[node] = size;
    this.#used[node] = 1;
    this.#generations[node] = this.#generations[node]! + 1;
    const remainder = total - size;
    if (remainder > 0) {
      const rest = this.#insert(remainder, this.#offsets[node]! + size);
      const next = this.#next[node]!;
      this.#prev[rest] = node;
      this.#next[rest] = next;
      this.#next[node] = rest;
      if (next !== UNUSED) {
        this.#prev[next] = rest;
      } else {
        this.#tail = rest;
      }
    }
    return { offset: this.#offsets[node]!, size, node, generation: this.#generations[node]! };
  }

  free(allocation: OffsetAllocation): void {
    const node = allocation.node;
    if (
      node < 0 ||
      node >= this.nodeCapacity ||
      this.#used[node] !== 1 ||
      this.#generations[node] !== allocation.generation ||
      this.#offsets[node] !== allocation.offset ||
      this.#sizes[node] !== allocation.size
    ) {
      throw new Error("Offset allocator lease is stale or was released twice");
    }
    let offset = this.#offsets[node]!;
    let size = this.#sizes[node]!;
    let previous = this.#prev[node]!;
    let next = this.#next[node]!;
    if (previous !== UNUSED && this.#used[previous] === 0) {
      offset = this.#offsets[previous]!;
      size += this.#sizes[previous]!;
      const before = this.#prev[previous]!;
      this.#remove(previous);
      previous = before;
    }
    if (next !== UNUSED && this.#used[next] === 0) {
      size += this.#sizes[next]!;
      const after = this.#next[next]!;
      this.#remove(next);
      next = after;
    }
    this.#used[node] = 0;
    this.#freeNodes[this.#freeCount++] = node;
    const combined = this.#insert(size, offset);
    this.#prev[combined] = previous;
    this.#next[combined] = next;
    if (previous !== UNUSED) {
      this.#next[previous] = combined;
    }
    if (next !== UNUSED) {
      this.#prev[next] = combined;
    } else {
      this.#tail = combined;
    }
  }

  /** Adds a free tail without moving or recreating any live node. */
  grow(size: number): void {
    if (!Number.isSafeInteger(size) || size < this.#size || size > 0x40000000) {
      throw new RangeError("Offset allocator growth is invalid");
    }
    if (size === this.#size) {
      return;
    }
    let begin = this.#size;
    let count = size - begin;
    let previous = this.#tail;
    if (this.#used[previous] === 0) {
      begin = this.#offsets[previous]!;
      count = size - begin;
      const before = this.#prev[previous]!;
      this.#remove(previous);
      previous = before;
    } else if (this.#freeCount === 0) {
      throw new Error("Offset allocator growth has no metadata node");
    }
    const tail = this.#insert(count, begin);
    this.#prev[tail] = previous;
    if (previous !== UNUSED) {
      this.#next[previous] = tail;
    }
    this.#tail = tail;
    this.#size = size;
  }

  #insert(size: number, offset: number): number {
    if (this.#freeCount === 0) {
      throw new Error("Offset allocator metadata exhausted");
    }
    const bin = offsetSizeClass(size);
    const top = bin >>> 3;
    const old = this.#heads[bin]!;
    const node = this.#freeNodes[--this.#freeCount]!;
    this.#offsets[node] = offset;
    this.#sizes[node] = size;
    this.#binPrev[node] = UNUSED;
    this.#binNext[node] = old;
    this.#prev[node] = UNUSED;
    this.#next[node] = UNUSED;
    this.#used[node] = 0;
    if (old !== UNUSED) {
      this.#binPrev[old] = node;
    } else {
      this.#leafMasks[top] = this.#leafMasks[top]! | (1 << (bin & 7));
      this.#topMask = (this.#topMask | (1 << top)) >>> 0;
    }
    this.#heads[bin] = node;
    this.#freeBytes += size;
    return node;
  }

  #unlink(node: number, bin = offsetSizeClass(this.#sizes[node]!)): void {
    const previous = this.#binPrev[node]!;
    const next = this.#binNext[node]!;
    if (previous !== UNUSED) {
      this.#binNext[previous] = next;
    } else {
      this.#heads[bin] = next;
    }
    if (next !== UNUSED) {
      this.#binPrev[next] = previous;
    }
    if (this.#heads[bin] === UNUSED) {
      const top = bin >>> 3;
      this.#leafMasks[top] = this.#leafMasks[top]! & ~(1 << (bin & 7));
      if (this.#leafMasks[top] === 0) {
        this.#topMask = (this.#topMask & ~(1 << top)) >>> 0;
      }
    }
  }

  #remove(node: number): void {
    this.#unlink(node);
    this.#freeBytes -= this.#sizes[node]!;
    this.#freeNodes[this.#freeCount++] = node;
  }
}
