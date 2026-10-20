import { ImageTexturePages } from "../../.test-dist/assets/ImageTexturePages.js";
import { writeImageTextureDirectory } from "../../.test-dist/assets/ImageTextureProduct.js";

export { imageRanges } from "../../.test-dist/assets/codec/ImageTextureDelivery.js";
import { imageRanges } from "../../.test-dist/assets/codec/ImageTextureDelivery.js";

/** Trace lists the complete ordered requested pages, including urgency and
 * source mip. No trace is a named uncertainty, not a fabricated optimal view. */
export function deliveryCost(directory, trace = null, limits = {}) {
  const pages = new ImageTexturePages(directory);
  const rows = [];
  let decodedBytes = 0,
    usefulTexels = 0,
    fetchedBytes = 0,
    requestedBytes = 0,
    requests = 0,
    peakDecodedBytes = 0;
  const demand = trace?.pages;
  if (trace && (!Array.isArray(demand) || demand.length > 1_000_000))
    throw new Error("Invalid or unbounded demand trace");
  for (const entry of demand ?? []) {
    if (![0, 1, 2].includes(entry.priority)) throw new Error("Trace urgency must be 0..2");
    const page = pages.page(entry.plane, entry.mip, entry.x, entry.y);
    const ranges = imageRanges(
      page.owners.map((id) => ({ ...directory.items[id], priority: entry.priority })),
      limits
    );
    const fetched = ranges.reduce((sum, range) => sum + range.fetchedBytes, 0);
    const bytes = ranges.reduce((sum, range) => sum + range.usefulBytes, 0);
    fetchedBytes += fetched;
    requestedBytes += bytes;
    requests += ranges.length;
    decodedBytes += page.decodedBytes;
    peakDecodedBytes = Math.max(peakDecodedBytes, page.decodedBytes);
    usefulTexels +=
      Math.min(128, page.logicalWidth - entry.x * 128) * Math.min(128, page.logicalHeight - entry.y * 128);
    rows.push({
      ...entry,
      owners: page.owners.length,
      fetchedBytes: fetched,
      requestedBytes: bytes,
      decodedBytes: page.decodedBytes
    });
  }
  const unique = new Map();
  for (const item of directory.items) unique.set(`${item.uri}/${item.offset}`, item.bytes);
  const residentBytes = directory.items
    .filter((item) => directory.planes[item.plane].mode === "resident")
    .reduce((sum, item) => sum + item.bytes, 0);
  let worstPageBytes = 0,
    worstDecodedBytes = 0;
  if (!trace) {
    for (let plane = 0; plane < directory.planes.length; plane++) {
      if (directory.planes[plane].mode !== "virtual") continue;
      for (let mip = 0; mip < directory.mipCount; mip++) {
        const columns = Math.ceil(Math.max(1, Math.floor(directory.width / 2 ** mip)) / 128);
        const rows = Math.ceil(Math.max(1, Math.floor(directory.height / 2 ** mip)) / 128);
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < columns; x++) {
            const page = pages.page(plane, mip, x, y);
            worstPageBytes = Math.max(worstPageBytes, page.encodedBytes);
            worstDecodedBytes = Math.max(worstDecodedBytes, page.decodedBytes);
          }
      }
    }
  }
  return {
    trace: trace ? "explicit-complete-demand" : "no-trace",
    traceRows: rows.length,
    payloadBytes: [...unique.values()].reduce((sum, bytes) => sum + bytes, 0),
    directoryBytes: writeImageTextureDirectory(directory).byteLength,
    residentBytes,
    fetchedBytes: trace ? fetchedBytes : null,
    requestedBytes: trace ? requestedBytes : null,
    requests: trace ? requests : null,
    overfetchBytes: trace ? fetchedBytes - requestedBytes : null,
    decodedBytes: trace ? decodedBytes : null,
    peakDecodedBytes: trace ? peakDecodedBytes : null,
    usefulTexels: trace ? usefulTexels : null,
    assemblyPixels: trace ? rows.length * 144 * 144 : null,
    worstPageBytes,
    worstDecodedBytes,
    cacheModel: "cold-per-page; no invented cross-page cache hit",
    rows
  };
}
