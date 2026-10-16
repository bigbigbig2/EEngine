/** Cache-private scratch. Counts are profile capacities, never output pixels.
 * Every scan has a portable hierarchical implementation without inter-group
 * polling. Parent sums are a separate dispatch's input. */
export const SCGI_CACHE_WORKGROUP_SIZE = 128;
export const SCGI_CACHE_DIRTY_CAPACITY = 32;
// source/destination/old-generation/reserved + 288B patch + 48B A1 + 16B cache state.
export const SCGI_CACHE_MOVE_STRIDE = 368;

export function scgiCacheScratchParts(
  cells: number,
  patches: number,
  requests: number,
  bounceRequests: number,
): readonly (readonly [string, number, number])[] {
  const parts: [string, number, number][] = [
    ["cacheSettings", 64, 4],
    ["cacheClaims", cells, 4],
    ["cacheRequestCells", requests + bounceRequests, 4],
    ["cacheActive", patches, 4],
    ["cachePriorityLists", patches * 4, 4],
    ["cacheMoves", patches, SCGI_CACHE_MOVE_STRIDE],
    ["cacheDirtyRegions", SCGI_CACHE_DIRTY_CAPACITY, 32],
    ["cacheControl", 64, 4],
  ];
  for (const [name, capacity] of scgiCacheScanDomains(patches, requests + bounceRequests)) {
    let count = capacity;
    let level = 0;
    for (;;) {
      parts.push([`${name}Flags${level}`, count, 4], [`${name}Prefix${level}`, count, 4]);
      if (count <= SCGI_CACHE_WORKGROUP_SIZE) {
        break;
      }
      count = Math.ceil(count / SCGI_CACHE_WORKGROUP_SIZE);
      level++;
    }
  }
  return parts;
}

export function scgiCacheScanDomains(
  patches: number,
  requests: number,
): readonly (readonly [string, number])[] {
  return [
    ["cacheFree", patches],
    ["cacheLive", patches],
    ["cacheWinner", requests],
    ["cacheVisibleWinner", requests],
    ["cachePriority0", patches],
    ["cachePriority1", patches],
    ["cachePriority2", patches],
    ["cachePriority3", patches],
  ];
}
