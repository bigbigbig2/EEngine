import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, isAbsolute } from "node:path";
import { after } from "node:test";

// Node has no file: fetch. Restrict this host to the immutable decoder files;
// the real production loader still verifies the WASM hash and bounded extent.
export function installGeometryZstdNodeHost() {
  const originalFetch = globalThis.fetch;
  const root = fileURLToPath(new URL("../../.test-dist/assets/codec/vendor/geometry-zstd/", import.meta.url));
  globalThis.fetch = async (input, init) => {
    if (input instanceof URL && input.protocol === "file:") {
      const path = fileURLToPath(input);
      const child = relative(root, path);
      assert.ok(!isAbsolute(child) && ["source.json", "geometry_zstd.wasm"].includes(child));
      return new Response(await readFile(path));
    }
    return originalFetch(input, init);
  };
  after(() => { globalThis.fetch = originalFetch; });
}
