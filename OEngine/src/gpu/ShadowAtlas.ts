/**
 * ShadowAtlas：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { AABB2, aabb2Overlaps } from "../core/math/AABB2.js";
import { Vec2 } from "../core/math/Vec2.js";

class QuadTreeDatum extends AABB2 {
  data: unknown = null;
  parentNode: QuadTreeNode | null = null;

  disconnect(): void {
    const parent = this.parentNode;
    if (parent === null) return;
    const index = parent.data.indexOf(this);
    parent.data.splice(index, 1);
    let node: QuadTreeNode | null = parent;
    while (node !== null) {
      node.treeDataCount--;
      node = node.parentNode;
    }
    parent.balanceBubbleUp();
    this.parentNode = null;
  }

  resize(x0: number, y0: number, x1: number, y1: number): void {
    this.set(x0, y0, x1, y1);
    const parent = this.parentNode;
    if (parent === null) return;
    if (x0 < parent.x0 || x1 >= parent.x1 || y0 < parent.y0 || y1 >= parent.y1) {
      this.disconnect();
      parent.insertDatum(this);
    }
  }
}

class QuadTreeNode extends AABB2 {
  topLeft: QuadTreeNode | null = null;
  topRight: QuadTreeNode | null = null;
  bottomLeft: QuadTreeNode | null = null;
  bottomRight: QuadTreeNode | null = null;
  parentNode: QuadTreeNode | null = null;
  treeDataCount = 0;
  data: QuadTreeDatum[] = [];

  isSplit(): boolean {
    return this.topLeft !== null;
  }

  isSplitMeaningful(): boolean {
    if (this.data.length < 16) return false;
    if (this.x0 === this.x1 && this.y0 === this.y1) return false;
    const midX = 0.5 * (this.x0 + this.x1);
    const midY = 0.5 * (this.y0 + this.y1);
    let tl = 0;
    let tr = 0;
    let bl = 0;
    let br = 0;
    for (const datum of this.data) {
      if (datum.y1 < midY) {
        if (datum.x1 < midX) tl++;
        else if (datum.x0 >= midX) tr++;
      } else if (datum.y0 >= midY) {
        if (datum.x1 < midX) bl++;
        else if (datum.x0 >= midX) br++;
      }
    }
    const moved = tl + tr + bl + br;
    return moved !== 0 && Math.max(tl, tr, bl, br) !== this.data.length;
  }

  balance(): number {
    const split = this.isSplit();
    if (!split && this.isSplitMeaningful()) {
      this.split();
      return 1;
    }
    if (this.treeDataCount < 8 && split) {
      this.merge();
      return 2;
    }
    return 0;
  }

  balanceBubbleUp(): void {
    if (this.balance() !== 2) return;
    let node = this.parentNode;
    while (node !== null && node.balance() === 2) node = node.parentNode;
  }

  add(data: unknown, x0: number, y0: number, x1: number, y1: number): QuadTreeDatum {
    const datum = new QuadTreeDatum(x0, y0, x1, y1);
    datum.data = data;
    this.insertDatum(datum);
    return datum;
  }

  insertDatum(datum: QuadTreeDatum): void {
    const { x0, y0, x1, y1 } = this;
    if (datum.x0 < x0 || datum.x1 > x1 || datum.y0 < y0 || datum.y1 > y1) {
      if (this.parentNode === null) {
        this.resize(Math.min(x0, datum.x0), Math.min(y0, datum.y0), Math.max(x1, datum.x1), Math.max(y1, datum.y1));
        this.addDatum(datum);
      } else {
        this.parentNode.insertDatum(datum);
      }
      return;
    }
    if (!this.isSplit()) {
      if (!(this.treeDataCount >= 16 && this.isSplitMeaningful())) {
        this.addDatum(datum);
        return;
      }
      this.split();
    }
    const midX = 0.5 * (x0 + x1);
    const midY = 0.5 * (y0 + y1);
    if (datum.y1 < midY) {
      if (datum.x1 < midX) this.topLeft!.insertDatum(datum);
      else if (datum.x0 >= midX) this.topRight!.insertDatum(datum);
      else this.addDatum(datum);
    } else if (datum.y0 >= midY) {
      if (datum.x1 < midX) this.bottomLeft!.insertDatum(datum);
      else if (datum.x0 >= midX) this.bottomRight!.insertDatum(datum);
      else this.addDatum(datum);
    } else {
      this.addDatum(datum);
    }
  }

  addDatum(datum: QuadTreeDatum): void {
    this.treeDataCount++;
    this.data.push(datum);
    datum.parentNode = this;
    let node = this.parentNode;
    while (node !== null) {
      node.treeDataCount++;
      node = node.parentNode;
    }
  }

  split(): void {
    const midX = 0.5 * (this.x0 + this.x1);
    const midY = 0.5 * (this.y0 + this.y1);
    this.topLeft = new QuadTreeNode(this.x0, this.y0, midX, midY);
    this.topRight = new QuadTreeNode(midX, this.y0, this.x1, midY);
    this.bottomLeft = new QuadTreeNode(this.x0, midY, midX, this.y1);
    this.bottomRight = new QuadTreeNode(midX, midY, this.x1, this.y1);
    this.topLeft.parentNode = this;
    this.topRight.parentNode = this;
    this.bottomLeft.parentNode = this;
    this.bottomRight.parentNode = this;
    this.pushDataDown();
    this.topLeft.balance();
    this.topRight.balance();
    this.bottomLeft.balance();
    this.bottomRight.balance();
  }

  private pushDataDown(): void {
    const midX = 0.5 * (this.x0 + this.x1);
    const midY = 0.5 * (this.y0 + this.y1);
    let index = 0;
    while (index < this.data.length) {
      const datum = this.data[index]!;
      let target: QuadTreeNode | null = null;
      if (datum.y1 < midY) {
        if (datum.x1 < midX) target = this.topLeft;
        else if (datum.x0 >= midX) target = this.topRight;
      } else if (datum.y0 >= midY) {
        if (datum.x1 < midX) target = this.bottomLeft;
        else if (datum.x0 >= midX) target = this.bottomRight;
      }
      if (target === null) {
        index++;
        continue;
      }
      target.data.push(datum);
      target.treeDataCount++;
      datum.parentNode = target;
      this.data.splice(index, 1);
    }
  }

  private absorbDataFrom(node: QuadTreeNode): void {
    for (const datum of node.data) {
      datum.parentNode = this;
      this.data.push(datum);
    }
    node.treeDataCount = 0;
    node.data = [];
  }

  private pullDataUp(): void {
    this.topLeft!.traversePreOrder((node) => this.absorbDataFrom(node));
    this.topRight!.traversePreOrder((node) => this.absorbDataFrom(node));
    this.bottomLeft!.traversePreOrder((node) => this.absorbDataFrom(node));
    this.bottomRight!.traversePreOrder((node) => this.absorbDataFrom(node));
  }

  merge(): void {
    this.pullDataUp();
    this.topLeft = null;
    this.topRight = null;
    this.bottomLeft = null;
    this.bottomRight = null;
  }

  clear(): void {
    this.data = [];
    this.treeDataCount = 0;
    this.topLeft = null;
    this.topRight = null;
    this.bottomLeft = null;
    this.bottomRight = null;
  }

  resize(x0: number, y0: number, x1: number, y1: number): void {
    if (this.x0 === x0 && this.y0 === y0 && this.x1 === x1 && this.y1 === y1) return;
    if (this.isSplit()) this.merge();
    this.set(x0, y0, x1, y1);
    this.balance();
  }

  traversePreOrder(visitor: (node: QuadTreeNode) => boolean | void): void {
    if (visitor(this) === false || !this.isSplit()) return;
    this.topLeft!.traversePreOrder(visitor);
    this.topRight!.traversePreOrder(visitor);
    this.bottomLeft!.traversePreOrder(visitor);
    this.bottomRight!.traversePreOrder(visitor);
  }

  traverseRectangleIntersections(x0: number, y0: number, x1: number, y1: number, visitor: (datum: QuadTreeDatum) => boolean | void): void {
    for (const datum of this.data) {
      if (datum.x0 < x1 && datum.x1 > x0 && datum.y0 < y1 && datum.y1 > y0 && visitor(datum) === false) return;
    }
    if (!this.isSplit()) return;
    const midX = 0.5 * (this.x0 + this.x1);
    const midY = 0.5 * (this.y0 + this.y1);
    if (midX >= x0) {
      if (midY >= y0) this.topLeft!.traverseRectangleIntersections(x0, y0, x1, y1, visitor);
      if (midY <= y1) this.bottomLeft!.traverseRectangleIntersections(x0, y0, x1, y1, visitor);
    }
    if (midX <= x1) {
      if (midY >= y0) this.topRight!.traverseRectangleIntersections(x0, y0, x1, y1, visitor);
      if (midY <= y1) this.bottomRight!.traverseRectangleIntersections(x0, y0, x1, y1, visitor);
    }
  }

  collectRectangleIntersections(out: QuadTreeDatum[], x0: number, y0: number, x1: number, y1: number): void {
    this.traversePreOrder((node) => {
      if (!aabb2Overlaps(node.x0, node.y0, node.x1, node.y1, x0, y0, x1, y1)) return false;
      for (const datum of node.data) {
        if (aabb2Overlaps(datum.x0, datum.y0, datum.x1, datum.y1, x0, y0, x1, y1)) out.push(datum);
      }
      return true;
    });
  }
}

function bestAreaFitScore(freeWidth: number, freeHeight: number, width: number, height: number): number {
  return (freeWidth - width) * freeHeight + (freeHeight - height) * width;
}

function findBestFreeRectangle(width: number, height: number, root: QuadTreeNode): QuadTreeDatum | null {
  let best: QuadTreeDatum | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  root.traversePreOrder((node) => {
    if (node.width < width || node.height < height) return false;
    for (const datum of node.data) {
      if (datum.width < width || datum.height < height) continue;
      const score = bestAreaFitScore(datum.width, datum.height, width, height);
      if (score < bestScore) {
        bestScore = score;
        best = datum;
      }
    }
    return true;
  });
  return best;
}

function removeContainedFreeRectangles(root: QuadTreeNode): void {
  const remove: QuadTreeDatum[] = [];
  let current: QuadTreeDatum;
  const compare = (datum: QuadTreeDatum): boolean | void => {
    if (current === datum) return;
    if (datum.x0 >= current.x0 && datum.x1 <= current.x1 && datum.y0 >= current.y0 && datum.y1 <= current.y1) {
      remove.push(datum);
    } else if (current.x0 >= datum.x0 && current.x1 <= datum.x1 && current.y0 >= datum.y0 && current.y1 <= datum.y1) {
      remove.push(current);
      return false;
    }
  };
  root.traversePreOrder((node) => {
    for (current of node.data) {
      root.traverseRectangleIntersections(current.x0, current.y0, current.x1, current.y1, compare);
    }
  });
  for (const datum of remove) datum.disconnect();
}

function removeContainedArrayRectangles(rectangles: QuadTreeDatum[]): void {
  outer: for (let i = 0; i < rectangles.length; i++) {
    const a = rectangles[i]!;
    for (let j = i + 1; j < rectangles.length; j++) {
      const b = rectangles[j]!;
      if (a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1) {
        rectangles.splice(i, 1);
        i--;
        continue outer;
      }
      if (b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1) {
        rectangles.splice(j, 1);
        j--;
      }
    }
  }
}

function placeRectangle(target: AABB2, freeRoot: QuadTreeNode): boolean {
  const free = findBestFreeRectangle(target.width, target.height, freeRoot);
  if (free === null) return false;
  free.disconnect();
  target.set(free.x0, free.y0, free.x0 + target.width, free.y0 + target.height);
  const intersections: QuadTreeDatum[] = [];
  freeRoot.collectRectangleIntersections(intersections, target.x0, target.y0, target.x1, target.y1);
  const fragments: QuadTreeDatum[] = [];
  for (const other of intersections) {
    const left = Math.max(target.x0, other.x0);
    const right = Math.min(target.x1, other.x1);
    const top = Math.max(target.y0, other.y0);
    const bottom = Math.min(target.y1, other.y1);
    if (left > other.x0) fragments.push(new QuadTreeDatum(other.x0, other.y0, left, other.y1));
    if (right < other.x1) fragments.push(new QuadTreeDatum(right, other.y0, other.x1, other.y1));
    if (top > other.y0) fragments.push(new QuadTreeDatum(other.x0, other.y0, other.x1, top));
    if (bottom < other.y1) fragments.push(new QuadTreeDatum(other.x0, bottom, other.x1, other.y1));
  }
  for (const other of intersections) other.disconnect();
  removeContainedArrayRectangles(fragments);
  for (const fragment of fragments) freeRoot.insertDatum(fragment);
  if (target.y1 !== free.y1) freeRoot.insertDatum(new QuadTreeDatum(free.x0, target.y1, free.x1, free.y1));
  if (target.x1 !== free.x1) freeRoot.insertDatum(new QuadTreeDatum(target.x1, free.y0, free.x1, free.y1));
  return true;
}

export class ShadowAtlasAllocator {
  readonly size: Vec2;
  private readonly free: QuadTreeNode;
  boxes: AABB2[] = [];

  constructor(width: number, height: number) {
    this.size = new Vec2(width, height);
    this.free = new QuadTreeNode(0, 0, width, height);
    this.free.add(null, 0, 0, width, height);
  }

  add(box: AABB2): boolean {
    const placed = placeRectangle(box, this.free);
    if (placed) {
      this.boxes.push(box);
      removeContainedFreeRectangles(this.free);
    }
    return placed;
  }

  addMany(boxes: AABB2[]): boolean {
    const placed: AABB2[] = [];
    const order = boxes.map((_, index) => index).sort((a, b) => Math.min(boxes[b]!.width, boxes[b]!.height) - Math.min(boxes[a]!.width, boxes[a]!.height));
    for (const index of order) {
      const box = boxes[index]!;
      if (!placeRectangle(box, this.free)) {
        this.removeMany(placed);
        return false;
      }
      this.boxes.push(box);
      placed.push(box);
    }
    removeContainedFreeRectangles(this.free);
    return true;
  }

  remove(box: AABB2): boolean {
    const index = this.boxes.indexOf(box);
    if (index < 0) return false;
    this.boxes.splice(index, 1);
    this.free.insertDatum(new QuadTreeDatum(box.x0, box.y0, box.x1, box.y1));
    return true;
  }

  removeMany(boxes: AABB2[]): number {
    let failures = 0;
    for (const box of boxes) if (!this.remove(box)) failures++;
    return failures;
  }

  canAdd(width: number, height: number): boolean {
    return findBestFreeRectangle(width, height, this.free) !== null;
  }

  repack(): boolean {
    const boxes = this.boxes;
    this.clear();
    return this.addMany(boxes);
  }

  clear(): void {
    this.free.clear();
    this.free.insertDatum(new QuadTreeDatum(0, 0, this.size.x, this.size.y));
    this.boxes = [];
  }

  resize(width: number, height: number): boolean {
    const oldWidth = this.size.x;
    const oldHeight = this.size.y;
    this.size.set(width, height);
    if (oldWidth > width || oldHeight > height) return this.repack();
    if (width > oldWidth) this.free.insertDatum(new QuadTreeDatum(oldWidth, 0, width, height));
    if (height > oldHeight) this.free.insertDatum(new QuadTreeDatum(0, oldHeight, width, height));
    return true;
  }
}

export type AdaptiveShadowMap = {
  light: unknown;
  layout: AABB2[];
  pending_layout: AABB2[] | null;
  projected_area_px: number;
  last_resize_frame_index: number;
};

export class ShadowAtlasResolutionController {
  private readonly candidates: AdaptiveShadowMap[] = [];
  private dropSizeScale = 1;
  private occupancy = 0;

  constructor(private readonly atlas: ShadowAtlasAllocator) {}

  get drop_size_scale(): number {
    return this.dropSizeScale;
  }

  get last_occupancy(): number {
    return this.occupancy;
  }

  adjust(maps: AdaptiveShadowMap[], frameIndex: number): void {
    this.updateOccupancy();
    this.candidates.length = 0;
    for (const map of maps) {
      if ((map.light as { isDirectionalLight?: boolean }).isDirectionalLight) continue;
      if (map.projected_area_px <= 0) {
        if (map.pending_layout !== null) this.removePending(map);
      } else {
        this.candidates.push(map);
      }
    }
    this.candidates.sort((a, b) => b.projected_area_px - a.projected_area_px);
    for (const map of this.candidates) {
      const currentSize = map.layout[0]!.width;
      const pendingSize = map.pending_layout?.[0]?.width ?? 0;
      const desired = this.selectSize(pendingSize || currentSize, map.projected_area_px, map.last_resize_frame_index, frameIndex);
      if (desired !== currentSize) {
        if (desired !== pendingSize) {
          if (map.pending_layout !== null) this.removePending(map);
          this.allocatePending(map, desired);
          map.last_resize_frame_index = frameIndex;
        }
      } else if (map.pending_layout !== null) {
        this.removePending(map);
        map.last_resize_frame_index = frameIndex;
      }
    }
    this.candidates.length = 0;
  }

  private updateOccupancy(): void {
    let used = 0;
    for (const box of this.atlas.boxes) used += box.width * box.height;
    const capacity = this.atlas.size.x * this.atlas.size.y;
    this.occupancy = capacity > 0 ? used / capacity : 0;
    if (this.occupancy > 0.85) this.dropSizeScale = Math.max(0.05, 0.9 * this.dropSizeScale);
    else if (this.occupancy < 0.5) this.dropSizeScale = Math.min(1, 1.1 * this.dropSizeScale);
  }

  private removePending(map: AdaptiveShadowMap): void {
    if (map.pending_layout === null) return;
    for (const box of map.pending_layout) this.atlas.remove(box);
    map.pending_layout = null;
  }

  private allocatePending(map: AdaptiveShadowMap, size: number): boolean {
    const box = new AABB2(0, 0, size, size);
    if (!this.atlas.add(box)) return false;
    map.pending_layout = [box];
    return true;
  }

  private selectSize(current: number, projectedArea: number, lastResizeFrame: number, frameIndex: number): number {
    const targetLog = Math.min(Math.max(Math.log2(Math.max(0.015625 * projectedArea * this.dropSizeScale, 1)), 5), 10);
    const currentLog = Math.log2(current);
    const distance = targetLog - currentLog;
    const absoluteDistance = Math.abs(distance);
    if (absoluteDistance < 0.7) return current;
    let selected = absoluteDistance >= 1.7 ? Math.round(targetLog) : currentLog + Math.sign(distance);
    selected = Math.min(Math.max(selected, 5), 10);
    const delta = selected - currentLog;
    if (delta === 0 || (Math.abs(delta) === 1 && lastResizeFrame !== -1 && frameIndex - lastResizeFrame < 3)) return current;
    return 1 << selected;
  }
}
