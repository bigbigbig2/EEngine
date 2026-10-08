// Preserve nested raw frame/pass samples while bounding diagnostic reports.
export function toJsonSafe(value, depth = 0, seen = new Set()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "undefined") return "[undefined]";
  if (type === "boolean" || type === "string") return value;
  if (type === "number") return Number.isFinite(value) ? value : `[${String(value)}]`;
  if (type === "bigint") return `${value}n`;
  if (type === "symbol" || type === "function") return `[${type}]`;
  if (depth >= 16) return "[depth-limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (ArrayBuffer.isView(value)) {
      const limit = Math.min(value.length ?? 0, 256);
      const head = Array.from(value.slice ? value.slice(0, limit) : value).map((entry) =>
        toJsonSafe(entry, depth + 1, seen),
      );
      return {
        typedArray: value.constructor.name,
        length: value.length ?? null,
        head,
        truncated: (value.length ?? 0) > limit,
      };
    }
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, 4096);
      const entries = value.slice(0, limit).map((entry) => toJsonSafe(entry, depth + 1, seen));
      if (value.length > limit) entries.push(`[+${value.length - limit} more]`);
      return entries;
    }
    if (value instanceof Map)
      return Object.fromEntries(
        [...value].map(([key, entry]) => [String(key), toJsonSafe(entry, depth + 1, seen)]),
      );
    if (value instanceof Set) return [...value].map((entry) => toJsonSafe(entry, depth + 1, seen));
    if (value instanceof Date) return value.toISOString();
    const record = {};
    for (const key of Object.keys(value)) record[key] = toJsonSafe(value[key], depth + 1, seen);
    return record;
  } finally {
    seen.delete(value);
  }
}
