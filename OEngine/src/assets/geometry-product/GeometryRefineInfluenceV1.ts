/**
 * Bounded reverse refine index: "which object-space region can change when this
 * group becomes resident or is retired".
 *
 * A coarse meshlet's `refineGroupId` names the finer group it simplifies
 * (`OEngine/tools/oengine-asset-core/src/geometry/GeometryCooker.cpp`: the
 * simplified meshlet stores the id of the group it simplified, and the LOD
 * invariant asserts the carrying group is coarser). So every validated page
 * yields edges (fine group, coarse group) and this index unions the coarse
 * parents' AABBs per fine group.
 *
 * Why accumulating only validated pages is conservative: a cached shadow page
 * can only hold content produced by a coarse parent that was *drawn*, and a
 * parent can only be drawn after its page was staged, which is exactly when its
 * edges were registered here. Edges are therefore never removed, only capped;
 * an over-cap index reports `overflowed` and the consumer must fall back to the
 * whole-instance bounds.
 */

const FLOATS_PER_AABB = 6;

export class GeometryRefineInfluenceV1 {
  /** fine group -> union AABB (min xyz, max xyz) of its known coarse parents. */
  readonly #parents = new Map<number, Float32Array>();
  readonly #registeredPages = new Set<number>();
  readonly #maxGroups: number;
  #overflowed = false;
  #edges = 0;

  constructor(maxGroups: number) {
    if (!Number.isSafeInteger(maxGroups) || maxGroups < 1) {
      throw new RangeError("refine influence capacity must be a positive integer");
    }
    this.#maxGroups = maxGroups;
  }

  get overflowed(): boolean {
    return this.#overflowed;
  }

  get edgeCount(): number {
    return this.#edges;
  }

  get indexedGroups(): number {
    return this.#parents.size;
  }

  get byteLength(): number {
    return this.#parents.size * FLOATS_PER_AABB * Float32Array.BYTES_PER_ELEMENT;
  }

  /** Registers one validated page exactly once. Re-validation of the same page
   * object must not inflate the index. */
  registerPage(pageId: number, refineEdges: Uint32Array, groupBounds: Float32Array, groupBegin: number): void {
    if (this.#registeredPages.has(pageId)) return;
    this.#registeredPages.add(pageId);
    if (this.#overflowed) return;
    for (let pair = 0; pair < refineEdges.length; pair += 2) {
      const fine = refineEdges[pair]!;
      const coarse = refineEdges[pair + 1]!;
      if (fine === 0xffffffff || fine === coarse) continue;
      const coarseLocal = coarse - groupBegin;
      if (coarseLocal < 0 || (coarseLocal + 1) * FLOATS_PER_AABB > groupBounds.length) continue;
      let parent = this.#parents.get(fine);
      if (parent === undefined) {
        if (this.#parents.size >= this.#maxGroups) {
          this.#overflowed = true;
          return;
        }
        parent = new Float32Array([
          groupBounds[coarseLocal * FLOATS_PER_AABB]!,
          groupBounds[coarseLocal * FLOATS_PER_AABB + 1]!,
          groupBounds[coarseLocal * FLOATS_PER_AABB + 2]!,
          groupBounds[coarseLocal * FLOATS_PER_AABB + 3]!,
          groupBounds[coarseLocal * FLOATS_PER_AABB + 4]!,
          groupBounds[coarseLocal * FLOATS_PER_AABB + 5]!,
        ]);
        this.#parents.set(fine, parent);
      } else {
        unionInto(parent, groupBounds, coarseLocal);
      }
      this.#edges++;
    }
  }

  /**
   * Conservative object-space AABB for one group: its own bounds unioned with
   * every coarse parent seen so far. Writes `out` as (min xyz, max xyz) and
   * returns false when the index cannot prove a bound, in which case the caller
   * must keep the conservative whole-instance damage and count the fallback.
   */
  influence(groupId: number, ownBounds: Float32Array, ownGroupBegin: number, out: Float32Array): boolean {
    if (this.#overflowed) return false;
    const ownLocal = groupId - ownGroupBegin;
    if (ownLocal < 0 || (ownLocal + 1) * FLOATS_PER_AABB > ownBounds.length) return false;
    for (let axis = 0; axis < 3; axis++) {
      out[axis] = ownBounds[ownLocal * FLOATS_PER_AABB + axis]!;
      out[axis + 3] = ownBounds[ownLocal * FLOATS_PER_AABB + 3 + axis]!;
    }
    const parent = this.#parents.get(groupId);
    if (parent !== undefined) {
      for (let axis = 0; axis < 3; axis++) {
        out[axis] = Math.min(out[axis]!, parent[axis]!);
        out[axis + 3] = Math.max(out[axis + 3]!, parent[axis + 3]!);
      }
    }
    return true;
  }

  clear(): void {
    this.#parents.clear();
    this.#registeredPages.clear();
    this.#overflowed = false;
    this.#edges = 0;
  }
}

function unionInto(target: Float32Array, bounds: Float32Array, local: number): void {
  for (let axis = 0; axis < 3; axis++) {
    target[axis] = Math.min(target[axis]!, bounds[local * FLOATS_PER_AABB + axis]!);
    target[axis + 3] = Math.max(target[axis + 3]!, bounds[local * FLOATS_PER_AABB + 3 + axis]!);
  }
}

export const GEOMETRY_REFINE_INFLUENCE_FLOATS = FLOATS_PER_AABB;
