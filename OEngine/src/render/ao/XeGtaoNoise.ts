/** XeGTAO.h::HilbertIndex, fixed revision a5b1686c7ea37788eeb3576b5be47f7c03db532c. */
export function buildXeGtaoHilbertLut(): Uint32Array {
  const table = new Uint32Array(64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    let px = x, py = y, index = 0;
    for (let level = 32; level > 0; level >>= 1) {
      const rx = (px & level) !== 0 ? 1 : 0;
      const ry = (py & level) !== 0 ? 1 : 0;
      index += level * level * ((3 * rx) ^ ry);
      if (ry === 0) {
        if (rx === 1) { px = 63 - px; py = 63 - py; }
        [px, py] = [py, px];
      }
    }
    table[y * 64 + x] = index;
  }
  return table;
}
