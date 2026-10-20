import type { ImageTextureItem } from "../ImageTextureProduct.js";

export interface ImageDeliveryRange {
  uri: string;
  priority: number;
  objectBytes: string;
  ranged: boolean;
  start: string;
  end: string;
  usefulBytes: number;
  fetchedBytes: number;
  overfetchBytes: number;
  items: number[];
}

/** Coalesce only already requested items of one urgency; never wait to fill a range. */
export function imageRanges(
  items: readonly (Pick<ImageTextureItem, "id" | "uri" | "offset" | "bytes" | "objectBytes"> & {
    priority: number;
  })[],
  { maxBytes = 256 * 1024, maxGapBytes = 4096, maxOverfetchRatio = 0.125 } = {}
): ImageDeliveryRange[] {
  if (
    ![maxBytes, maxGapBytes].every(Number.isSafeInteger) ||
    maxBytes < 1 ||
    maxGapBytes < 0 ||
    !Number.isFinite(maxOverfetchRatio) ||
    maxOverfetchRatio < 0 ||
    maxOverfetchRatio > 1
  ) {
    throw new RangeError("Invalid range bounds");
  }
  const sorted = [...items].sort(
    (a, b) =>
      a.uri.localeCompare(b.uri) ||
      a.priority - b.priority ||
      (BigInt(a.offset ?? 0) < BigInt(b.offset ?? 0)
        ? -1
        : BigInt(a.offset ?? 0) === BigInt(b.offset ?? 0)
          ? 0
          : 1)
  );
  const result: ImageDeliveryRange[] = [];
  for (const item of sorted) {
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 1) {
      throw new RangeError("Invalid item byte length");
    }
    const start = BigInt(item.offset ?? 0);
    const end = start + BigInt(item.bytes);
    const last = result.at(-1);
    const gap = last ? start - BigInt(last.end) : 0n;
    const span = last ? end - BigInt(last.start) : 0n;
    const useful = (last?.usefulBytes ?? 0) + item.bytes;
    if (
      last &&
      item.offset !== null &&
      last.ranged &&
      last.uri === item.uri &&
      last.priority === item.priority &&
      last.objectBytes === item.objectBytes &&
      gap >= 0n &&
      gap <= BigInt(maxGapBytes) &&
      span <= BigInt(maxBytes) &&
      Number(span) - useful <= useful * maxOverfetchRatio
    ) {
      last.end = String(end);
      last.usefulBytes = useful;
      last.fetchedBytes = Number(span);
      last.overfetchBytes = Number(span) - useful;
      last.items.push(item.id);
    } else {
      result.push({
        uri: item.uri,
        priority: item.priority,
        objectBytes: item.objectBytes,
        ranged: item.offset !== null,
        start: String(start),
        end: String(end),
        usefulBytes: item.bytes,
        fetchedBytes: item.bytes,
        overfetchBytes: 0,
        items: [item.id]
      });
    }
  }
  return result;
}

export async function fetchImageRange(
  range: ImageDeliveryRange,
  baseUrl: string,
  signal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  if (!range.ranged || range.fetchedBytes > 256 * 1024 || range.items.length < 2) {
    throw new RangeError("Only bounded coalesced ranges use shared fetch");
  }
  const url = new URL(range.uri, baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Image range requires HTTP transport");
  }
  const end = BigInt(range.end) - 1n;
  const response = await fetch(url, { signal, headers: { Range: `bytes=${range.start}-${end}` } });
  if (
    response.status !== 206 ||
    (response.headers.get("content-encoding") ?? "identity") !== "identity" ||
    response.headers.get("content-range") !== `bytes ${range.start}-${end}/${range.objectBytes}` ||
    (response.headers.has("content-length") &&
      response.headers.get("content-length") !== String(range.fetchedBytes))
  ) {
    await response.body?.cancel();
    throw new Error("Image coalesced range status/extent/encoding mismatch");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Image coalesced range body missing");
  }
  const bytes = new Uint8Array(range.fetchedBytes);
  let used = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      if (part.value.length > bytes.length - used) {
        throw new RangeError("Image coalesced range exceeds reservation");
      }
      bytes.set(part.value, used);
      used += part.value.length;
    }
    if (used !== bytes.length) {
      throw new Error("Image coalesced range truncated");
    }
    signal.throwIfAborted();
    return bytes;
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
