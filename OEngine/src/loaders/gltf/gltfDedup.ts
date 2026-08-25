/**
 * gltfDedup：解析 glTF 数据并转换为引擎运行时对象。
 */

export function dedupeByHashEquals<T extends object>(items: T[]): void {
  const t = items.length;
  if (t <= 1) return;
  const hashes = new Uint32Array(t);
  for (let r = 0; r < t; r++) {
    const item = items[r] as T & { hash?: () => number };
    if (typeof item.hash === "function") {
      hashes[r] = item.hash() >>> 0;
    }
  }
  for (let r = 0; r < t - 1; r++) {
    const s = items[r]!;
    for (let a = r + 1; a < t; a++) {
      const later = items[a]!;
      if (s === later) continue;
      if (s.constructor !== later.constructor) continue;
      if (hashes[r] !== hashes[a]) continue;
      if ((s as T & { equals(o: T): boolean }).equals(later)) {
        items[a] = s;
      }
    }
  }
}
