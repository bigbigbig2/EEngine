/**
 * MeshletRangeAllocator：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

export const INVALID_MESHLET_ALLOCATION = 0xffff_ffff;

export type MeshletRangeAllocation = {
  offset: number;
  metadata: number;
};

export type MeshletRangeStorageReport = {
  totalFreeSpace: number;
  largestFreeRegion: number;
};

const NODE_OFFSET = 0;
const NODE_SIZE = 1;
const NODE_BIN_PREV = 2;
const NODE_BIN_NEXT = 3;
const NODE_PHYSICAL_PREV = 4;
const NODE_PHYSICAL_NEXT = 5;
const NODE_USED = 6;
const NODE_WORDS = 7;

function findLastSet(value: number): number {
  return 31 - Math.clz32(value);
}

function findFirstSet(value: number): number {
  let current = value | 0;
  let result = 0;
  if ((current & 0xffff) === 0) {
    current >>= 16;
    result += 16;
  }
  if ((current & 0xff) === 0) {
    current >>= 8;
    result += 8;
  }
  if ((current & 0xf) === 0) {
    current >>= 4;
    result += 4;
  }
  if ((current & 0x3) === 0) {
    current >>= 2;
    result += 2;
  }
  if ((current & 0x1) === 0) {
    current >>= 1;
    result += 1;
  }
  if (current === 0) result += 1;
  return result;
}

function sizeToBinFloor(size: number): number {
  let exponent = 0;
  let mantissa = 0;
  if (size < 8) {
    mantissa = size;
  } else {
    const shift = findLastSet(size) - 3;
    exponent = shift + 1;
    mantissa = (size >>> shift) & 7;
  }
  return (exponent << 3) | mantissa;
}

function sizeToBinCeil(size: number): number {
  let exponent = 0;
  let mantissa = 0;
  if (size < 8) {
    mantissa = size;
  } else {
    const shift = findLastSet(size) - 3;
    exponent = shift + 1;
    mantissa = (size >>> shift) & 7;
    if ((size & ((1 << shift) - 1)) !== 0) mantissa++;
  }
  return (exponent << 3) + mantissa;
}

function findNextSet(value: number, start: number): number {
  const masked = value & ~((1 << start) - 1);
  return masked === 0 ? INVALID_MESHLET_ALLOCATION : findFirstSet(masked);
}

function binToMinimumSize(bin: number): number {
  const exponent = bin >>> 3;
  const mantissa = bin & 7;
  return exponent === 0
    ? mantissa
    : ((8 | mantissa) << (exponent - 1)) >>> 0;
}

export class MeshletRangeAllocator {
  readonly size: number;
  readonly maxAllocs: number;

  private freeStorage = 0;
  private usedBinsTop = 0;
  private readonly usedBins = new Uint8Array(32);
  private readonly binIndices = new Uint32Array(256);
  private readonly nodes: Uint32Array;
  private readonly freeNodes: Uint32Array;
  private freeOffset = 0;

  constructor(size: number, maxAllocs = 131_072) {
    this.size = size;
    this.maxAllocs = maxAllocs;
    this.nodes = new Uint32Array(maxAllocs * NODE_WORDS);
    this.freeNodes = new Uint32Array(maxAllocs);
    this.reset();
  }

  allocate(size: number): MeshletRangeAllocation {
    if (this.freeOffset === 0) return this.invalid();

    const requestedBin = sizeToBinCeil(size);
    const requestedTop = requestedBin >>> 3;
    let top = requestedTop;
    let leaf = INVALID_MESHLET_ALLOCATION;

    if ((this.usedBinsTop & (1 << top)) !== 0) {
      leaf = findNextSet(this.usedBins[top]!, requestedBin & 7);
    }
    if (leaf === INVALID_MESHLET_ALLOCATION) {
      top = findNextSet(this.usedBinsTop, requestedTop + 1);
      if (top === INVALID_MESHLET_ALLOCATION) return this.invalid();
      leaf = findFirstSet(this.usedBins[top]!);
    }

    const bin = ((top << 3) | leaf) >>> 0;
    const node = this.binIndices[bin]!;
    const regionSize = this.read(node, NODE_SIZE);
    this.write(node, NODE_SIZE, size);
    this.write(node, NODE_USED, 1);

    const nextInBin = this.read(node, NODE_BIN_NEXT);
    this.binIndices[bin] = nextInBin;
    if (nextInBin !== INVALID_MESHLET_ALLOCATION) {
      this.write(nextInBin, NODE_BIN_PREV, INVALID_MESHLET_ALLOCATION);
    }
    this.freeStorage -= regionSize;
    if (this.binIndices[bin] === INVALID_MESHLET_ALLOCATION) {
      this.usedBins[top] = this.usedBins[top]! & ~(1 << leaf);
      if (this.usedBins[top] === 0) this.usedBinsTop &= ~(1 << top);
    }

    const remainder = regionSize - size;
    const offset = this.read(node, NODE_OFFSET);
    if (remainder > 0) {
      const split = this.addFreeRegion(remainder, offset + size);
      const physicalNext = this.read(node, NODE_PHYSICAL_NEXT);
      if (physicalNext !== INVALID_MESHLET_ALLOCATION) {
        this.write(physicalNext, NODE_PHYSICAL_PREV, split);
      }
      this.write(split, NODE_PHYSICAL_PREV, node);
      this.write(split, NODE_PHYSICAL_NEXT, physicalNext);
      this.write(node, NODE_PHYSICAL_NEXT, split);
    }

    return { offset, metadata: node };
  }

  free(allocation: MeshletRangeAllocation): void {
    this.freeNode(allocation.metadata);
  }

  reset(): void {
    this.freeStorage = 0;
    this.usedBinsTop = 0;
    this.freeOffset = this.maxAllocs - 1;
    this.usedBins.fill(0);
    this.binIndices.fill(INVALID_MESHLET_ALLOCATION);
    for (let i = 0; i < this.maxAllocs; i++) {
      this.freeNodes[i] = this.maxAllocs - i - 1;
    }
    this.addFreeRegion(this.size, 0);
  }

  storageReport(): MeshletRangeStorageReport {
    let largestFreeRegion = 0;
    let totalFreeSpace = 0;
    if (this.freeOffset > 0) {
      totalFreeSpace = this.freeStorage;
      if (this.usedBinsTop !== 0) {
        const top = findLastSet(this.usedBinsTop);
        largestFreeRegion = binToMinimumSize(
          (top << 3) | findLastSet(this.usedBins[top]!)
        );
      }
    }
    return { totalFreeSpace, largestFreeRegion };
  }

  private freeNode(node: number): void {
    let offset = this.read(node, NODE_OFFSET);
    let size = this.read(node, NODE_SIZE);

    const physicalPrev = this.read(node, NODE_PHYSICAL_PREV);
    if (
      physicalPrev !== INVALID_MESHLET_ALLOCATION &&
      (this.read(physicalPrev, NODE_USED) & 1) === 0
    ) {
      offset = this.read(physicalPrev, NODE_OFFSET);
      size += this.read(physicalPrev, NODE_SIZE);
      this.removeFreeRegion(physicalPrev);
      this.write(
        node,
        NODE_PHYSICAL_PREV,
        this.read(physicalPrev, NODE_PHYSICAL_PREV)
      );
    }

    const physicalNext = this.read(node, NODE_PHYSICAL_NEXT);
    if (
      physicalNext !== INVALID_MESHLET_ALLOCATION &&
      (this.read(physicalNext, NODE_USED) & 1) === 0
    ) {
      size += this.read(physicalNext, NODE_SIZE);
      this.removeFreeRegion(physicalNext);
      this.write(
        node,
        NODE_PHYSICAL_NEXT,
        this.read(physicalNext, NODE_PHYSICAL_NEXT)
      );
    }

    const next = this.read(node, NODE_PHYSICAL_NEXT);
    const prev = this.read(node, NODE_PHYSICAL_PREV);
    this.freeNodes[++this.freeOffset] = node;
    const merged = this.addFreeRegion(size, offset);
    if (next !== INVALID_MESHLET_ALLOCATION) {
      this.write(merged, NODE_PHYSICAL_NEXT, next);
      this.write(next, NODE_PHYSICAL_PREV, merged);
    }
    if (prev !== INVALID_MESHLET_ALLOCATION) {
      this.write(merged, NODE_PHYSICAL_PREV, prev);
      this.write(prev, NODE_PHYSICAL_NEXT, merged);
    }
  }

  private addFreeRegion(size: number, offset: number): number {
    const bin = sizeToBinFloor(size);
    const top = bin >>> 3;
    if (this.binIndices[bin] === INVALID_MESHLET_ALLOCATION) {
      this.usedBins[top] = this.usedBins[top]! | (1 << (bin & 7));
      this.usedBinsTop |= 1 << top;
    }

    const oldHead = this.binIndices[bin]!;
    const node = this.freeNodes[this.freeOffset--]!;
    this.write(node, NODE_OFFSET, offset);
    this.write(node, NODE_SIZE, size);
    this.write(node, NODE_BIN_PREV, INVALID_MESHLET_ALLOCATION);
    this.write(node, NODE_BIN_NEXT, oldHead);
    this.write(node, NODE_PHYSICAL_PREV, INVALID_MESHLET_ALLOCATION);
    this.write(node, NODE_PHYSICAL_NEXT, INVALID_MESHLET_ALLOCATION);
    this.write(node, NODE_USED, 0);
    if (oldHead !== INVALID_MESHLET_ALLOCATION) {
      this.write(oldHead, NODE_BIN_PREV, node);
    }
    this.binIndices[bin] = node;
    this.freeStorage += size;
    return node;
  }

  private removeFreeRegion(node: number): void {
    const prev = this.read(node, NODE_BIN_PREV);
    if (prev !== INVALID_MESHLET_ALLOCATION) {
      const next = this.read(node, NODE_BIN_NEXT);
      this.write(prev, NODE_BIN_NEXT, next);
      if (next !== INVALID_MESHLET_ALLOCATION) {
        this.write(next, NODE_BIN_PREV, prev);
      }
    } else {
      const bin = sizeToBinFloor(this.read(node, NODE_SIZE));
      const top = bin >>> 3;
      const leaf = bin & 7;
      const next = this.read(node, NODE_BIN_NEXT);
      this.binIndices[bin] = next;
      if (next !== INVALID_MESHLET_ALLOCATION) {
        this.write(next, NODE_BIN_PREV, INVALID_MESHLET_ALLOCATION);
      }
      if (this.binIndices[bin] === INVALID_MESHLET_ALLOCATION) {
        this.usedBins[top] = this.usedBins[top]! & ~(1 << leaf);
        if (this.usedBins[top] === 0) this.usedBinsTop &= ~(1 << top);
      }
    }
    this.freeNodes[++this.freeOffset] = node;
    this.freeStorage -= this.read(node, NODE_SIZE);
  }

  private read(node: number, field: number): number {
    return this.nodes[node * NODE_WORDS + field]! >>> 0;
  }

  private write(node: number, field: number, value: number): void {
    this.nodes[node * NODE_WORDS + field] = value >>> 0;
  }

  private invalid(): MeshletRangeAllocation {
    return {
      offset: INVALID_MESHLET_ALLOCATION,
      metadata: INVALID_MESHLET_ALLOCATION
    };
  }
}
