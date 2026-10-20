import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash, stableJson } from "./search.mjs";

/** Immutable per-job disk cache. No global memory cache; each payload is bounded
 * before reading. A corrupt/stale hit rejects rather than silently authorizing it. */
export class ImageSearchCache {
  constructor(directory, maxEntryBytes = 32 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1)
      throw new RangeError("Invalid search cache bound");
    this.directory = directory;
    this.maxEntryBytes = maxEntryBytes;
  }

  key(identity, candidate) {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("Search cache identity must be a complete hash");
    return contentHash(stableJson({ identity, candidate }));
  }

  async read(key) {
    const path = this.path(key);
    let file;
    try {
      const { open } = await import("node:fs/promises");
      file = await open(path, "r");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try {
      if ((await file.stat()).size > this.maxEntryBytes)
        throw new Error("Search cache entry exceeds capacity");
      const receipt = JSON.parse(await file.readFile("utf8"));
      if (receipt.key !== key || receipt.hash !== contentHash(stableJson(receipt.value))) {
        throw new Error("Search cache receipt checksum mismatch");
      }
      return receipt.value;
    } finally {
      await file.close();
    }
  }

  async write(key, value) {
    const path = this.path(key);
    const data = stableJson({ key, hash: contentHash(stableJson(value)), value });
    if (Buffer.byteLength(data) > this.maxEntryBytes) throw new Error("Search cache result exceeds capacity");
    await mkdir(this.directory, { recursive: true });
    const temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, path);
  }

  path(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid cache key");
    return join(this.directory, key + ".json");
  }
}
