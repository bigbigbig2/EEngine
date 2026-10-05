/**
 * Conservative world-space bounds of a whole Web Cook scene catalog.
 *
 * The catalog is published before any geometry page exists, so these bounds are
 * the earliest point at which a camera can be framed to the final scene instead
 * of to whatever the first Product cut happens to contain. Framing once from the
 * catalog is what keeps a later revision's publication from having to move the
 * camera: the framing is already the final one.
 */

/** Axis-aligned world box plus the sphere the camera helpers actually consume. */
export interface WebCookSceneBoundsV1 {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly center: readonly [number, number, number];
  readonly radius: number;
  /**
   * Primitives the catalog could not bound, so they are excluded from the box.
   *
   * A non-zero value means the result is **not** provably conservative: those
   * primitives may lie outside it. This is reported rather than thrown so a
   * caller can still frame the scene it can measure, but a caller that needs a
   * guaranteed covering box must treat a non-zero count as a failure.
   */
  readonly unknownBoundPrimitives: number;
}

/**
 * Structural input, satisfied by `WebCookSceneCatalogSnapshot`.
 *
 * Only the two arrays that carry geometry position are read; identity, material
 * and texture metadata are irrelevant to a spatial box.
 */
export interface WebCookSceneBoundsSourceV1 {
  readonly primitives: readonly {
    readonly nodeIndex: number;
    readonly instanceNodeIndices: readonly number[];
    readonly boundsMin: readonly number[];
    readonly boundsMax: readonly number[];
  }[];
  readonly instances: readonly {
    readonly nodeIndex: number;
    readonly worldMatrix: readonly number[];
  }[];
}

/**
 * Expands the union of every primitive's world-space AABB.
 *
 * Each primitive's local box is transformed by every instance that references
 * it, not just the first one: a shared mesh instanced several times has to
 * contribute all of its placements or the box would clip the others.
 *
 * Errors: throws when the catalog has no bounded primitive at all, or when the
 * accumulator overflows to a non-finite value. Bounds that are missing or
 * non-finite do not throw; they are skipped and counted in
 * `unknownBoundPrimitives`.
 *
 * Cost: one pass over `primitives × instances × 8 corners`, allocating a small
 * number of scalars. It performs no I/O and touches no GPU object, so it is
 * safe to call on the catalog-ready path.
 */
export function webCookCatalogSceneBounds(catalog: WebCookSceneBoundsSourceV1): WebCookSceneBoundsV1 {
  const instanceMatrices = new Map<number, readonly number[]>();
  for (const instance of catalog.instances) instanceMatrices.set(instance.nodeIndex, instance.worldMatrix);

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  let bounded = 0;
  let unknownBoundPrimitives = 0;

  for (const primitive of catalog.primitives) {
    const min = primitive.boundsMin,
      max = primitive.boundsMax;
    if (!isFiniteBox(min, max)) {
      unknownBoundPrimitives++;
      continue;
    }
    const owners =
      primitive.instanceNodeIndices.length > 0 ? primitive.instanceNodeIndices : [primitive.nodeIndex];
    for (const owner of owners) {
      const matrix = instanceMatrices.get(owner);
      for (let corner = 0; corner < 8; corner++) {
        const local: [number, number, number] = [
          corner & 1 ? (max[0] as number) : (min[0] as number),
          corner & 2 ? (max[1] as number) : (min[1] as number),
          corner & 4 ? (max[2] as number) : (min[2] as number),
        ];
        const world = matrix === undefined ? local : transformPoint(matrix, local);
        if (!Number.isFinite(world[0]) || !Number.isFinite(world[1]) || !Number.isFinite(world[2])) continue;
        minX = Math.min(minX, world[0]);
        minY = Math.min(minY, world[1]);
        minZ = Math.min(minZ, world[2]);
        maxX = Math.max(maxX, world[0]);
        maxY = Math.max(maxY, world[1]);
        maxZ = Math.max(maxZ, world[2]);
      }
    }
    bounded++;
  }

  if (bounded === 0)
    throw new Error("Web Cook catalog published no bounded primitive to frame the scene with");
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(minZ) ||
    !Number.isFinite(maxZ)
  ) {
    throw new Error("Web Cook catalog scene bounds overflowed to a non-finite box");
  }

  return Object.freeze({
    min: Object.freeze([minX, minY, minZ] as const),
    max: Object.freeze([maxX, maxY, maxZ] as const),
    center: Object.freeze([(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5] as const),
    radius: Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5),
    unknownBoundPrimitives,
  });
}

function isFiniteBox(min: readonly number[], max: readonly number[]): boolean {
  for (let axis = 0; axis < 3; axis++) {
    const low = min[axis],
      high = max[axis];
    if (!Number.isFinite(low) || !Number.isFinite(high) || (high as number) < (low as number)) return false;
  }
  return true;
}

/** Requested normalization applied to the whole scene, not to one revision. */
export interface WebCookCatalogSceneFramingOptionsV1 {
  /** Uniform scale so the catalog's world height equals this value. */
  readonly fitHeight?: number;
  /** World point the fitted catalog's base centre is aligned to (defaults to the origin). */
  readonly fitBase?: readonly [number, number, number];
}

/** Framing constants plus the box the camera must actually frame. */
export interface WebCookCatalogSceneFramingV1 {
  /**
   * Uniform scale to pass as the mapper's `scale`.
   *
   * Derived from the whole catalog, so it is identical for every revision of
   * that catalog. A `fitHeight` handed to the mapper instead would be resolved
   * against whichever revision is being mapped, which makes the geometry change
   * scale when a richer revision replaces a bootstrap subset.
   */
  readonly scale: number;
  /** World translation to pass as the mapper's `offset`. */
  readonly offset: readonly [number, number, number];
  /** Catalog box **after** the fit: the box a camera must frame. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly unknownBoundPrimitives: number;
}

/**
 * Resolves the scene normalization from catalog bounds instead of from a cut.
 *
 * The transform the mapper applies for `fitHeight` is
 * `fitted(p) = scale * p + offset` with the scale and offset derived from the
 * instances it was handed. Resolving the same formula against the catalog's
 * bounds once and passing the resulting `scale`/`offset` explicitly makes the
 * transform revision-independent, so publishing a richer revision no longer
 * changes the geometry's scale and a camera framed once stays correct.
 *
 * Errors: throws for a non-positive or non-finite `fitHeight`, for a non-finite
 * `fitBase`, and for the same unbounded-catalog case as
 * `webCookCatalogSceneBounds`. Cost: one bounds pass plus constant work.
 */
export function webCookCatalogSceneFraming(
  catalog: WebCookSceneBoundsSourceV1,
  options: WebCookCatalogSceneFramingOptionsV1 = {},
): WebCookCatalogSceneFramingV1 {
  const bounds = webCookCatalogSceneBounds(catalog);
  let scale = 1;
  let offset: readonly [number, number, number] = Object.freeze([0, 0, 0] as const);
  if (options.fitHeight !== undefined) {
    if (!Number.isFinite(options.fitHeight) || options.fitHeight <= 0)
      throw new RangeError("Web Cook catalog fitHeight must be positive and finite");
    const base = options.fitBase ?? [0, 0, 0];
    if (!Number.isFinite(base[0]) || !Number.isFinite(base[1]) || !Number.isFinite(base[2])) {
      throw new RangeError("Web Cook catalog fitBase must be finite");
    }
    // Mirrors the mapper's expression operation for operation so the two
    // resolutions cannot disagree by a rounding step.
    const height = Math.max(1e-5, bounds.max[1] - bounds.min[1]);
    scale = options.fitHeight / height;
    offset = Object.freeze([
      (base[0] as number) - bounds.center[0] * scale,
      (base[1] as number) + (bounds.center[1] - bounds.min[1]) * scale - bounds.center[1] * scale,
      (base[2] as number) - bounds.center[2] * scale,
    ] as const);
  } else if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("Web Cook catalog scale must be positive and finite");
  }
  const min = Object.freeze([
    bounds.min[0] * scale + offset[0],
    bounds.min[1] * scale + offset[1],
    bounds.min[2] * scale + offset[2],
  ] as const);
  const max = Object.freeze([
    bounds.max[0] * scale + offset[0],
    bounds.max[1] * scale + offset[1],
    bounds.max[2] * scale + offset[2],
  ] as const);
  return Object.freeze({
    scale,
    offset,
    min,
    max,
    center: Object.freeze([
      (min[0] + max[0]) * 0.5,
      (min[1] + max[1]) * 0.5,
      (min[2] + max[2]) * 0.5,
    ] as const),
    radius: Math.max(0.01, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 0.5),
    unknownBoundPrimitives: bounds.unknownBoundPrimitives,
  });
}

function transformPoint(
  matrix: readonly number[],
  point: readonly [number, number, number],
): [number, number, number] {
  return [
    matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!,
    matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!,
    matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!,
  ];
}
