/** One GPU-owned request publication. All offsets are u32 words. Requests use
 * half-pixel identity; Native additionally checks the exact full source pixel.
 * Request lookup is (ticket + 1, exact sourcePixel + 1), 8B per half pixel.
 * Direction mapping is (half pixel + 1, distance, reserved, reserved), 16B.
 * Header: unique, current shadow count, fault, Native writes; words4..6 source
 * dispatch, 8..10 shadow dispatch, 11 validated directions, 12 missing rays,
 * 13 reused visibility. Counts are bounded by admitted Q/light inventory.
 * Preparation is diffuse/instance flags, base radiance/valid, normal/sun visibility;
 * diffuse includes the camera-dependent coat underlayer, 48B per unique source.
 * No accepted-hit geometry survives the pre/post boundary. */
export const SCGI_GATHER_PREPARATION_BYTES = 48;

export function planScgiGatherWork(halfPixels: number, directions: number, batch: number) {
  const capacity = Math.min(halfPixels, directions);
  const bits = 16;
  const requests = bits + Math.ceil(halfPixels / 32);
  const ids = requests + halfPixels * 2;
  const preparation = ids + capacity;
  const mapping = preparation + capacity * (SCGI_GATHER_PREPARATION_BYTES / 4);
  const shadow = mapping + directions * 4;
  return Object.freeze({
    capacity,
    bits,
    requests,
    ids,
    preparation,
    mapping,
    shadow,
    bytes: (shadow + batch) * 4,
    countByteOffset: 4,
    indirectByteOffset: 32,
  });
}
