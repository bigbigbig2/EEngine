import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";
import { createTiledTextureDecoder } from "../../.test-dist/assets/codec/TiledTextureDecoder.js";
import { tiledTextureCompressedBound } from "../../.test-dist/assets/codec/TiledTextureCompression.js";
import { compressTiledTexturePage } from "../../tools/tiled-texture-compress.mjs";

const binary = await readFile(
  new URL("../../src/assets/codec/vendor/tiled-zstd/tiled_zstd.wasm", import.meta.url),
);
const decoder = await createTiledTextureDecoder(new Uint8Array(binary).buffer);

test("fixed Zstd WASM exactly restores BC pages, including high-entropy expansion", async () => {
  assert.equal(decoder.memoryBytes, 4 * 1024 ** 2);
  for (const size of [10368, 20736]) {
    for (const input of [Buffer.alloc(size, 128), randomBytes(size)]) {
      const encoded = await compressTiledTexturePage(input);
      assert.ok(encoded.length <= tiledTextureCompressedBound(size));
      assert.deepEqual(new Uint8Array(decoder.decode(encoded, size)), new Uint8Array(input));
      assert.deepEqual(new Uint8Array(zstdDecompressSync(encoded)), new Uint8Array(input));
    }
  }
  const bad = new Uint8Array(binary);
  bad[0] ^= 1;
  await assert.rejects(createTiledTextureDecoder(bad.buffer), /identity/);
});

test("fixed decoder rejects malformed, concatenated, unknown-size and unchecked frames", async () => {
  const input = Buffer.alloc(10368, 31);
  const valid = await compressTiledTexturePage(input);
  const corrupt = valid.slice();
  corrupt[corrupt.length - 1] ^= 1;
  const unchecked = zstdCompressSync(input, { params: { [constants.ZSTD_c_checksumFlag]: 0 } });
  assert.ok(valid[4] & 0x20, "oracle expects the small single-segment reference frame");
  const window = Buffer.concat([valid.subarray(0, 5), Buffer.from([0x50]), valid.subarray(5)]);
  window[4] &= ~0x20; // Explicit 1MiB window, larger than one admitted BC page.
  const dictionary = Buffer.concat([valid.subarray(0, 5), Buffer.from([1]), valid.subarray(5)]);
  dictionary[4] |= 1; // Nonzero one-byte dictionary ID is outside this profile.
  for (const bytes of [
    valid.subarray(0, -1),
    corrupt,
    unchecked,
    window,
    dictionary,
    Buffer.concat([valid, valid]),
    Buffer.concat([valid, Buffer.from([0])]),
    Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]),
  ]) {
    assert.throws(() => decoder.decode(bytes, 10368), /rejected/);
    assert.deepEqual(
      new Uint8Array(decoder.decode(valid, 10368)),
      new Uint8Array(input),
      "rejected frames cannot poison the reused static context",
    );
  }
  assert.throws(() => decoder.decode(valid, 20736), /rejected/);
  assert.throws(() => decoder.decode(valid, 1), /page/);
  // The streaming encoder's absent pledged size is intentionally not accepted.
  const { zstdCompress } = await import("node:zlib");
  const unknown = await new Promise((resolve, reject) =>
    zstdCompress(input, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }, (error, bytes) =>
      error ? reject(error) : resolve(bytes),
    ),
  );
  assert.throws(() => decoder.decode(unknown, 10368), /rejected/);
});
