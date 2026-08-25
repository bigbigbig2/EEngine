/**
 * DynamicBvh：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

export const BVH_NULL_NODE = 0xffff_ffff;
export const DYNAMIC_BVH_INTERNAL_NODE_BYTES = 40;
export const DYNAMIC_BVH_GPU_NODE_BYTES = 32;

const NODE_WORDS = 10;
const MAX_CAPACITY = Math.floor(1_073_741_823.75);

function surfaceArea(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): number {
  const x = maxX - minX;
  const z = maxZ - minZ;
  return 2 * ((maxY - minY) * (x + z) + z * x);
}

export class DynamicBvh {
  private dataBufferValue = new ArrayBuffer(5120);
  private dataFloat32Value = new Float32Array(this.dataBufferValue);
  private dataUint32Value = new Uint32Array(this.dataBufferValue);
  private capacity = 128;
  private sizeValue = 0;
  private readonly free: number[] = [];
  private freePointer = 0;
  private rootValue = BVH_NULL_NODE;

  get data_buffer(): ArrayBuffer {
    return this.dataBufferValue;
  }

  set data_buffer(value: ArrayBuffer) {
    this.dataBufferValue = value;
    this.dataFloat32Value = new Float32Array(value);
    this.dataUint32Value = new Uint32Array(value);
    this.node_capacity = Math.floor(
      value.byteLength / DYNAMIC_BVH_INTERNAL_NODE_BYTES
    );
  }

  get data_float32(): Float32Array {
    return this.dataFloat32Value;
  }

  get data_uint32(): Uint32Array {
    return this.dataUint32Value;
  }

  get root(): number {
    return this.rootValue;
  }

  set root(value: number) {
    this.rootValue = value >>> 0;
  }

  get size(): number {
    return this.sizeValue;
  }

  get node_capacity(): number {
    return this.capacity;
  }

  set node_capacity(value: number) {
    if (this.sizeValue > value) {
      throw new Error(
        `Can't shrink capacity to ${value}, because it's below occupancy(${this.sizeValue}).`
      );
    }
    this.setCapacity(value);
  }

  trim(): void {
    if (this.capacity > this.sizeValue) this.setCapacity(this.sizeValue);
  }

  allocate_linear(count: number): void {
    this.node_capacity = count;
    this.sizeValue = count;
  }

  allocate_node(): number {
    let node: number;
    if (this.freePointer > 0) {
      const next = this.freePointer - 1;
      node = this.free[next]!;
      this.freePointer = next;
    } else {
      node = this.sizeValue;
      if (node >= this.capacity) this.growCapacity();
      this.sizeValue++;
    }

    const base = NODE_WORDS * node;
    const f32 = this.dataFloat32Value;
    f32[base] = Number.POSITIVE_INFINITY;
    f32[base + 1] = Number.POSITIVE_INFINITY;
    f32[base + 2] = Number.POSITIVE_INFINITY;
    f32[base + 3] = Number.NEGATIVE_INFINITY;
    f32[base + 4] = Number.NEGATIVE_INFINITY;
    f32[base + 5] = Number.NEGATIVE_INFINITY;
    const u32 = this.dataUint32Value;
    u32[base + 6] = BVH_NULL_NODE;
    u32[base + 7] = BVH_NULL_NODE;
    u32[base + 8] = BVH_NULL_NODE;
    u32[base + 9] = 0;
    return node;
  }

  release_node(node: number): void {
    this.free[this.freePointer++] = node;
  }

  node_is_leaf(node: number): boolean {
    return this.dataUint32Value[NODE_WORDS * node + 7] === BVH_NULL_NODE;
  }

  node_get_user_data(node: number): number {
    return this.dataUint32Value[NODE_WORDS * node + 8]! >>> 0;
  }

  node_set_user_data(node: number, value: number): void {
    this.dataUint32Value[NODE_WORDS * node + 8] = value >>> 0;
  }

  node_get_child1(node: number): number {
    return this.dataUint32Value[NODE_WORDS * node + 7]! >>> 0;
  }

  node_set_child1(node: number, value: number): void {
    this.dataUint32Value[NODE_WORDS * node + 7] = value >>> 0;
  }

  node_get_child2(node: number): number {
    return this.dataUint32Value[NODE_WORDS * node + 8]! >>> 0;
  }

  node_set_child2(node: number, value: number): void {
    this.dataUint32Value[NODE_WORDS * node + 8] = value >>> 0;
  }

  node_get_parent(node: number): number {
    return this.dataUint32Value[NODE_WORDS * node + 6]! >>> 0;
  }

  node_set_parent(node: number, value: number): void {
    this.dataUint32Value[NODE_WORDS * node + 6] = value >>> 0;
  }

  node_get_height(node: number): number {
    return this.dataUint32Value[NODE_WORDS * node + 9]! >>> 0;
  }

  node_set_height(node: number, value: number): void {
    this.dataUint32Value[NODE_WORDS * node + 9] = value >>> 0;
  }

  node_get_aabb(node: number, out: Float32Array): void {
    const base = NODE_WORDS * node;
    for (let i = 0; i < 6; i++) out[i] = this.dataFloat32Value[base + i]!;
  }

  node_set_aabb(node: number, box: ArrayLike<number>): void {
    const base = NODE_WORDS * node;
    for (let i = 0; i < 6; i++) {
      this.dataFloat32Value[base + i] = box[i] ?? 0;
    }
  }

  node_move_aabb(
    node: number,
    box: ArrayLike<number>,
    onNodeChanged?: (node: number) => void
  ): void {
    this.node_set_aabb(node, box);
    onNodeChanged?.(node);
    const parent = this.dataUint32Value[NODE_WORDS * node + 6]! >>> 0;
    if (parent !== BVH_NULL_NODE) {
      this.bubble_up_refit(parent, onNodeChanged);
    }
  }

  node_get_surface_area(node: number): number {
    const base = NODE_WORDS * node;
    const f32 = this.dataFloat32Value;
    return surfaceArea(
      f32[base]!,
      f32[base + 1]!,
      f32[base + 2]!,
      f32[base + 3]!,
      f32[base + 4]!,
      f32[base + 5]!
    );
  }

  node_get_combined_surface_area(a: number, b: number): number {
    const aa = NODE_WORDS * a;
    const bb = NODE_WORDS * b;
    const f32 = this.dataFloat32Value;
    return surfaceArea(
      Math.min(f32[aa]!, f32[bb]!),
      Math.min(f32[aa + 1]!, f32[bb + 1]!),
      Math.min(f32[aa + 2]!, f32[bb + 2]!),
      Math.max(f32[aa + 3]!, f32[bb + 3]!),
      Math.max(f32[aa + 4]!, f32[bb + 4]!),
      Math.max(f32[aa + 5]!, f32[bb + 5]!)
    );
  }

  node_set_combined_aabb(
    destination: number,
    a: number,
    b: number
  ): void {
    const dst = NODE_WORDS * destination;
    const aa = NODE_WORDS * a;
    const bb = NODE_WORDS * b;
    const f32 = this.dataFloat32Value;
    f32[dst] = Math.min(f32[aa]!, f32[bb]!);
    f32[dst + 1] = Math.min(f32[aa + 1]!, f32[bb + 1]!);
    f32[dst + 2] = Math.min(f32[aa + 2]!, f32[bb + 2]!);
    f32[dst + 3] = Math.max(f32[aa + 3]!, f32[bb + 3]!);
    f32[dst + 4] = Math.max(f32[aa + 4]!, f32[bb + 4]!);
    f32[dst + 5] = Math.max(f32[aa + 5]!, f32[bb + 5]!);
  }

  insert_leaf(leaf: number): void {
    let u32 = this.dataUint32Value;
    if (this.rootValue === BVH_NULL_NODE) {
      this.rootValue = leaf;
      u32[leaf * NODE_WORDS + 6] = BVH_NULL_NODE;
      return;
    }

    let sibling = this.rootValue;
    while (!this.node_is_leaf(sibling)) {
      const base = sibling * NODE_WORDS;
      const child1 = u32[base + 7]! >>> 0;
      const child2 = u32[base + 8]! >>> 0;
      const area = this.node_get_surface_area(sibling);
      const combined = this.node_get_combined_surface_area(sibling, leaf);
      const parentCost = 2 * combined;
      const inheritanceCost = 2 * (combined - area);
      const child1Cost = this.node_is_leaf(child1)
        ? this.node_get_combined_surface_area(leaf, child1) + inheritanceCost
        : this.node_get_combined_surface_area(leaf, child1) -
          this.node_get_surface_area(child1) +
          inheritanceCost;
      const child2Cost = this.node_is_leaf(child2)
        ? this.node_get_combined_surface_area(leaf, child2) + inheritanceCost
        : this.node_get_combined_surface_area(leaf, child2) -
          this.node_get_surface_area(child2) +
          inheritanceCost;
      if (parentCost < child1Cost && parentCost < child2Cost) break;
      sibling = child1Cost < child2Cost ? child1 : child2;
    }

    const oldParent = u32[sibling * NODE_WORDS + 6]! >>> 0;
    const newParent = this.allocate_node();
    u32 = this.dataUint32Value;
    u32[newParent * NODE_WORDS + 6] = oldParent;
    this.node_set_combined_aabb(newParent, leaf, sibling);
    u32[newParent * NODE_WORDS + 9] =
      (u32[sibling * NODE_WORDS + 9]! >>> 0) + 1;
    if (oldParent !== BVH_NULL_NODE) {
      if ((u32[oldParent * NODE_WORDS + 7]! >>> 0) === sibling) {
        u32[oldParent * NODE_WORDS + 7] = newParent;
      } else {
        u32[oldParent * NODE_WORDS + 8] = newParent;
      }
    } else {
      this.rootValue = newParent;
    }
    u32[newParent * NODE_WORDS + 7] = sibling;
    u32[newParent * NODE_WORDS + 8] = leaf;
    u32[sibling * NODE_WORDS + 6] = newParent;
    u32[leaf * NODE_WORDS + 6] = newParent;
    this.bubble_up_update(newParent);
  }

  bubble_up_refit(
    node: number,
    onNodeChanged?: (node: number) => void
  ): void {
    let current = node;
    const u32 = this.dataUint32Value;
    do {
      const base = current * NODE_WORDS;
      this.node_set_combined_aabb(
        current,
        u32[base + 7]! >>> 0,
        u32[base + 8]! >>> 0
      );
      onNodeChanged?.(current);
      current = u32[base + 6]! >>> 0;
    } while (current !== BVH_NULL_NODE);
  }

  bubble_up_update(node: number): void {
    let current = node;
    const u32 = this.dataUint32Value;
    while (current !== BVH_NULL_NODE) {
      current = this.balance(current);
      const base = current * NODE_WORDS;
      const child1 = u32[base + 7]! >>> 0;
      const child2 = u32[base + 8]! >>> 0;
      u32[base + 9] =
        1 +
        Math.max(
          u32[child1 * NODE_WORDS + 9]! >>> 0,
          u32[child2 * NODE_WORDS + 9]! >>> 0
        );
      this.node_set_combined_aabb(current, child1, child2);
      current = u32[base + 6]! >>> 0;
    }
  }

  balance(node: number): number {
    const u32 = this.dataUint32Value;
    if (
      this.node_is_leaf(node) ||
      (u32[node * NODE_WORDS + 9]! >>> 0) < 2
    ) {
      return node;
    }
    const child1 = u32[node * NODE_WORDS + 7]! >>> 0;
    const child2 = u32[node * NODE_WORDS + 8]! >>> 0;
    const delta =
      (u32[child2 * NODE_WORDS + 9]! >>> 0) -
      (u32[child1 * NODE_WORDS + 9]! >>> 0);

    if (delta > 1) {
      const grand1 = u32[child2 * NODE_WORDS + 7]! >>> 0;
      const grand2 = u32[child2 * NODE_WORDS + 8]! >>> 0;
      u32[child2 * NODE_WORDS + 7] = node;
      const parent = u32[node * NODE_WORDS + 6]! >>> 0;
      u32[child2 * NODE_WORDS + 6] = parent;
      u32[node * NODE_WORDS + 6] = child2;
      if (parent !== BVH_NULL_NODE) {
        if ((u32[parent * NODE_WORDS + 7]! >>> 0) === node) {
          u32[parent * NODE_WORDS + 7] = child2;
        } else {
          u32[parent * NODE_WORDS + 8] = child2;
        }
      } else {
        this.rootValue = child2;
      }
      if (
        (u32[grand1 * NODE_WORDS + 9]! >>> 0) >
        (u32[grand2 * NODE_WORDS + 9]! >>> 0)
      ) {
        u32[child2 * NODE_WORDS + 8] = grand1;
        u32[node * NODE_WORDS + 8] = grand2;
        u32[grand2 * NODE_WORDS + 6] = node;
        this.node_set_combined_aabb(node, child1, grand2);
        this.node_set_combined_aabb(child2, node, grand1);
        u32[node * NODE_WORDS + 9] =
          1 +
          Math.max(
            u32[child1 * NODE_WORDS + 9]! >>> 0,
            u32[grand2 * NODE_WORDS + 9]! >>> 0
          );
        u32[child2 * NODE_WORDS + 9] =
          1 +
          Math.max(
            u32[node * NODE_WORDS + 9]! >>> 0,
            u32[grand1 * NODE_WORDS + 9]! >>> 0
          );
      } else {
        u32[child2 * NODE_WORDS + 8] = grand2;
        u32[node * NODE_WORDS + 8] = grand1;
        u32[grand1 * NODE_WORDS + 6] = node;
        this.node_set_combined_aabb(node, child1, grand1);
        this.node_set_combined_aabb(child2, node, grand2);
        u32[node * NODE_WORDS + 9] =
          1 +
          Math.max(
            u32[child1 * NODE_WORDS + 9]! >>> 0,
            u32[grand1 * NODE_WORDS + 9]! >>> 0
          );
        u32[child2 * NODE_WORDS + 9] =
          1 +
          Math.max(
            u32[node * NODE_WORDS + 9]! >>> 0,
            u32[grand2 * NODE_WORDS + 9]! >>> 0
          );
      }
      return child2;
    }

    if (delta < -1) {
      const grand1 = u32[child1 * NODE_WORDS + 7]! >>> 0;
      const grand2 = u32[child1 * NODE_WORDS + 8]! >>> 0;
      u32[child1 * NODE_WORDS + 7] = node;
      const parent = u32[node * NODE_WORDS + 6]! >>> 0;
      u32[child1 * NODE_WORDS + 6] = parent;
      u32[node * NODE_WORDS + 6] = child1;
      if (parent !== BVH_NULL_NODE) {
        if ((u32[parent * NODE_WORDS + 7]! >>> 0) === node) {
          u32[parent * NODE_WORDS + 7] = child1;
        } else {
          u32[parent * NODE_WORDS + 8] = child1;
        }
      } else {
        this.rootValue = child1;
      }
      if (
        (u32[grand1 * NODE_WORDS + 9]! >>> 0) >
        (u32[grand2 * NODE_WORDS + 9]! >>> 0)
      ) {
        u32[child1 * NODE_WORDS + 8] = grand1;
        u32[node * NODE_WORDS + 7] = grand2;
        u32[grand2 * NODE_WORDS + 6] = node;
        this.node_set_combined_aabb(node, child2, grand2);
        this.node_set_combined_aabb(child1, node, grand1);
        u32[node * NODE_WORDS + 9] =
          1 +
          Math.max(
            u32[child2 * NODE_WORDS + 9]! >>> 0,
            u32[grand2 * NODE_WORDS + 9]! >>> 0
          );
        u32[child1 * NODE_WORDS + 9] =
          1 +
          Math.max(
            u32[node * NODE_WORDS + 9]! >>> 0,
            u32[grand1 * NODE_WORDS + 9]! >>> 0
          );
      } else {
        u32[child1 * NODE_WORDS + 8] = grand2;
        u32[node * NODE_WORDS + 7] = grand1;
        u32[grand1 * NODE_WORDS + 6] = node;
        this.node_set_combined_aabb(node, child2, grand1);
        this.node_set_combined_aabb(child1, node, grand2);
        u32[node * NODE_WORDS + 9] =
          1 +
          Math.max(
            u32[child2 * NODE_WORDS + 9]! >>> 0,
            u32[grand1 * NODE_WORDS + 9]! >>> 0
          );
        u32[child1 * NODE_WORDS + 9] =
          1 +
          Math.max(
            u32[node * NODE_WORDS + 9]! >>> 0,
            u32[grand2 * NODE_WORDS + 9]! >>> 0
          );
      }
      return child1;
    }
    return node;
  }

  node_assign_children(parent: number, child1: number, child2: number): void {
    this.node_set_combined_aabb(parent, child1, child2);
    this.node_assign_children_only(parent, child1, child2);
  }

  node_assign_children_only(
    parent: number,
    child1: number,
    child2: number
  ): void {
    this.node_set_parent(child1, parent);
    this.node_set_parent(child2, parent);
    this.node_set_child1(parent, child1);
    this.node_set_child2(parent, child2);
    this.node_set_height(
      parent,
      1 + Math.max(this.node_get_height(child1), this.node_get_height(child2))
    );
  }

  release_all(): void {
    this.rootValue = BVH_NULL_NODE;
    this.sizeValue = 0;
    this.freePointer = 0;
  }

  private growCapacity(): void {
    if (this.capacity >= MAX_CAPACITY) {
      throw new Error(
        "Can not grow capacity, already at maximum platform limit"
      );
    }
    let next = Math.ceil(Math.max(1.2 * this.capacity, this.capacity + 64));
    if (next > MAX_CAPACITY) next = MAX_CAPACITY;
    this.setCapacity(next);
  }

  private setCapacity(capacity: number): void {
    if (this.capacity === capacity) return;
    const next = new ArrayBuffer(DYNAMIC_BVH_INTERNAL_NODE_BYTES * capacity);
    if (this.sizeValue > 0) {
      new Uint8Array(next).set(
        new Uint8Array(
          this.dataBufferValue,
          0,
          Math.min(
            DYNAMIC_BVH_INTERNAL_NODE_BYTES * this.sizeValue,
            next.byteLength
          )
        )
      );
    }
    this.dataBufferValue = next;
    this.dataFloat32Value = new Float32Array(next);
    this.dataUint32Value = new Uint32Array(next);
    this.capacity = capacity;
  }
}

const optimizerScratch = new ArrayBuffer(9280);
const subsetBounds = new Float32Array(optimizerScratch, 0, 1536);
const subsetSurface = new Float32Array(optimizerScratch, 6144, 256);
const subsetCost = new Float32Array(optimizerScratch, 7168, 256);
const subsetPartition = new Uint32Array(optimizerScratch, 8192, 256);
const optimizerNodes = new Uint32Array(optimizerScratch, 9216, 16);

const deBruijnTable = new Uint8Array([
  0, 1, 28, 2, 29, 14, 24, 3, 30, 22, 20, 15, 25, 17, 4, 8,
  31, 27, 13, 23, 21, 19, 16, 7, 26, 12, 18, 6, 11, 5, 10, 9
]);

function firstBitIndex(value: number): number {
  return deBruijnTable[(Math.imul(125_613_361, value & -value) >>> 27)]!;
}

function bitCount(value: number): number {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x5555_5555;
  v = (v & 0x3333_3333) + ((v >>> 2) & 0x3333_3333);
  v = (v + (v >>> 4)) & 0x0f0f_0f0f;
  return Math.imul(v, 0x0101_0101) >>> 24;
}

function buildOptimalSubtree(
  bvh: DynamicBvh,
  nodes: Uint32Array,
  mask: number
): number {
  if (bitCount(mask) === 1) return nodes[firstBitIndex(mask)]!;
  const split = subsetPartition[mask]!;
  const other = mask & ~split;
  const parent = bvh.allocate_node();
  const child1 = buildOptimalSubtree(bvh, nodes, split);
  const child2 = buildOptimalSubtree(bvh, nodes, other);
  bvh.node_assign_children(parent, child1, child2);
  return parent;
}

function optimizeSubtree(
  bvh: DynamicBvh,
  root: number,
  maxChildren: number
): void {
  if (root === BVH_NULL_NODE || bvh.node_is_leaf(root)) return;
  let count = 0;
  const child1 = bvh.node_get_child1(root);
  const child2 = bvh.node_get_child2(root);
  if (child1 !== BVH_NULL_NODE) optimizerNodes[count++] = child1;
  if (child2 !== BVH_NULL_NODE) optimizerNodes[count++] = child2;

  while (count < maxChildren) {
    let selected = -1;
    let selectedArea = 0;
    for (let i = 0; i < count; i++) {
      const node = optimizerNodes[i]!;
      if (bvh.node_is_leaf(node)) continue;
      const area = bvh.node_get_surface_area(node);
      if (area > selectedArea) {
        selectedArea = area;
        selected = i;
      }
    }
    if (selected === -1) break;
    const node = optimizerNodes[selected]!;
    optimizerNodes[selected] = bvh.node_get_child1(node);
    optimizerNodes[count++] = bvh.node_get_child2(node);
    bvh.release_node(node);
  }
  if (count <= 2) return;

  const fullMask = (1 << count) - 1;
  const data = bvh.data_float32;
  for (let mask = 1; mask <= fullMask; mask++) {
    let minX: number;
    let minY: number;
    let minZ: number;
    let maxX: number;
    let maxY: number;
    let maxZ: number;
    const singleton = (mask & (mask - 1)) === 0;
    if (singleton) {
      const source = optimizerNodes[firstBitIndex(mask)]! * NODE_WORDS;
      minX = data[source]!;
      minY = data[source + 1]!;
      minZ = data[source + 2]!;
      maxX = data[source + 3]!;
      maxY = data[source + 4]!;
      maxZ = data[source + 5]!;
    } else {
      const lowest = mask & -mask;
      const a = 6 * lowest;
      const b = 6 * (mask ^ lowest);
      minX = Math.min(subsetBounds[a]!, subsetBounds[b]!);
      minY = Math.min(subsetBounds[a + 1]!, subsetBounds[b + 1]!);
      minZ = Math.min(subsetBounds[a + 2]!, subsetBounds[b + 2]!);
      maxX = Math.max(subsetBounds[a + 3]!, subsetBounds[b + 3]!);
      maxY = Math.max(subsetBounds[a + 4]!, subsetBounds[b + 4]!);
      maxZ = Math.max(subsetBounds[a + 5]!, subsetBounds[b + 5]!);
    }
    const offset = 6 * mask;
    subsetBounds[offset] = minX;
    subsetBounds[offset + 1] = minY;
    subsetBounds[offset + 2] = minZ;
    subsetBounds[offset + 3] = maxX;
    subsetBounds[offset + 4] = maxY;
    subsetBounds[offset + 5] = maxZ;
    const area = surfaceArea(minX, minY, minZ, maxX, maxY, maxZ);
    subsetSurface[mask] = area;
    if (singleton) subsetCost[mask] = area;
  }

  for (let size = 2; size <= count; size++) {
    for (let mask = 1; mask <= fullMask; mask++) {
      if (bitCount(mask) !== size) continue;
      let bestCost = Number.POSITIVE_INFINITY;
      let bestSplit = 0;
      const base = (mask - 1) & mask;
      let split = (-base) & mask;
      do {
        const cost = subsetCost[split]! + subsetCost[mask ^ split]!;
        if (cost < bestCost) {
          bestCost = cost;
          bestSplit = split;
        }
        split = (split - base) & mask;
      } while (split !== 0);
      subsetCost[mask] = 1.2 * subsetSurface[mask]! + bestCost;
      subsetPartition[mask] = bestSplit;
    }
  }

  const split = subsetPartition[fullMask]!;
  bvh.node_assign_children(
    root,
    buildOptimalSubtree(bvh, optimizerNodes, split),
    buildOptimalSubtree(bvh, optimizerNodes, fullMask & ~split)
  );
}

export function optimizeDynamicBvh(
  bvh: DynamicBvh,
  root = bvh.root,
  maxChildren = 7
): void {
  if (root === BVH_NULL_NODE || bvh.node_is_leaf(root)) return;
  let previous = root;
  let state = 0;
  let current = bvh.node_get_child1(previous);
  if (current === BVH_NULL_NODE) current = bvh.node_get_child2(previous);
  if (current === BVH_NULL_NODE) return;
  const minimumHeight = Math.ceil(Math.log2(maxChildren));

  for (;;) {
    if (state === 2 && bvh.node_get_height(current) >= minimumHeight) {
      optimizeSubtree(bvh, current, maxChildren);
    }
    if (bvh.node_is_leaf(current)) {
      const oldPrevious = previous;
      state = bvh.node_get_child1(oldPrevious) === current ? 1 : 2;
      previous = current;
      current = oldPrevious;
    } else if (state === 2) {
      previous = current;
      const parent = bvh.node_get_parent(current);
      state = bvh.node_get_child1(parent) === current ? 1 : 2;
      if (current === root) break;
      current = parent;
    } else if (state === 1) {
      const next = bvh.node_get_child2(current);
      previous = current;
      if (next === BVH_NULL_NODE) {
        state = 2;
        current = bvh.node_get_parent(current);
      } else {
        state = 0;
        current = next;
      }
    } else {
      const next1 = bvh.node_get_child1(current);
      const next2 = bvh.node_get_child2(current);
      if (next1 !== BVH_NULL_NODE) {
        state = 0;
        previous = current;
        current = next1;
      } else if (next2 !== BVH_NULL_NODE) {
        state = 0;
        previous = current;
        current = next2;
      } else {
        const next = bvh.node_get_child1(previous);
        bvh.release_node(current);
        if (next === current) {
          bvh.node_set_child1(previous, BVH_NULL_NODE);
          previous = BVH_NULL_NODE;
          state = 1;
        } else {
          bvh.node_set_child2(previous, BVH_NULL_NODE);
          previous = BVH_NULL_NODE;
          state = 2;
        }
        current = previous;
      }
    }
  }
  optimizeSubtree(bvh, root, maxChildren);
}

export function exportDynamicBvhNodes(bvh: DynamicBvh): ArrayBuffer {
  return exportDynamicBvhNodeRange(bvh, 0, bvh.node_capacity);
}

export function exportDynamicBvhNodeRange(
  bvh: DynamicBvh,
  firstNode: number,
  nodeCount: number
): ArrayBuffer {
  if (
    firstNode < 0 ||
    nodeCount < 0 ||
    firstNode + nodeCount > bvh.node_capacity
  ) {
    throw new RangeError("Dynamic BVH export range is out of bounds");
  }
  const output = new ArrayBuffer(nodeCount * DYNAMIC_BVH_GPU_NODE_BYTES);
  const source = bvh.data_uint32;
  const destination = new Uint32Array(output);
  for (let localNode = 0; localNode < nodeCount; localNode++) {
    const node = firstNode + localNode;
    const src = node * NODE_WORDS;
    const dst = localNode * 8;
    for (let i = 0; i < 6; i++) destination[dst + i] = source[src + i]!;
    destination[dst + 6] = source[src + 7]!;
    destination[dst + 7] = source[src + 8]!;
  }
  return output;
}
