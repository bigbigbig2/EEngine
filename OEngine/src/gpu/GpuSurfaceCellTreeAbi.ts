/** Portable 64-lane classifier scratch. Sizes use WGSL alignment/stride:
 * SurfaceCellLane 32B, CellLaneGeometry 112B, CellTreeNode 32B,
 * signal CellTreeGeometry 144B, AppearanceBound4 48B. */
export const SURFACE_CELL_TREE_NODES = 21;
export const SURFACE_CELL_TREE_LEVELS = Object.freeze([
  Object.freeze({ first: 0, count: 16, width: 2 }),
  Object.freeze({ first: 16, count: 4, width: 4 }),
  Object.freeze({ first: 20, count: 1, width: 8 }),
]);
export const SURFACE_CELL_TREE_STORAGE = Object.freeze({
  laneFacts: 64 * 32,
  geometryFacts: 64 * 112,
  nodes: SURFACE_CELL_TREE_NODES * 32,
  geometry: SURFACE_CELL_TREE_NODES * 144,
  fields: SURFACE_CELL_TREE_NODES * 48,
  prefixAndSources: 3 * 64 * 4,
  controls: 6 * 4 + 16 + 4 + 8,
  providers: SURFACE_CELL_TREE_NODES * 16,
  domains: SURFACE_CELL_TREE_NODES * 16,
});
// Allow declaration alignment and round the upper bound to a 256B boundary.
// Actual entry-point storage is additionally checked by WebGPU compilation.
export const SURFACE_CELL_TREE_WORKGROUP_BYTES =
  Math.ceil(Object.values(SURFACE_CELL_TREE_STORAGE).reduce((sum, bytes) => sum + bytes, 0) / 256) * 256;
