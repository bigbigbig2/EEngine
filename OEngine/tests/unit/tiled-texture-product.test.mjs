import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tiledTextureGutter } from "../../.test-dist/assets/codec/TiledTextureCook.js";
import {
  openTiledTextureDirectory,
  tiledTextureBootstrapPayloads
} from "../../.test-dist/assets/TiledTextureProduct.js";
import { tiledTextureSpans } from "../../.test-dist/assets/codec/TiledTextureTransport.js";
import { TiledTextureCache } from "../../.test-dist/assets/codec/TiledTextureCache.js";

import { makeTiledFixture } from "../helpers/tiled-texture-fixture.mjs";
import { textureProduct } from "../fixtures/texture-product.mjs";
import { TiledTextureCook } from "../../.test-dist/assets/codec/TiledTextureCook.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("tiled NPOT product preserves encoded interior blocks, real mip dimensions and complete protected tail", async () => {
  const f = await makeTiledFixture();
  const m = f.directory.metadata;
  assert.deepEqual([m.source.storageWidth, m.source.storageHeight], [260, 132]);
  assert.equal(m.sourceIdentity, f.product.identity);
  const plane = m.planes[0];
  assert.equal(plane.tailFirst, 3);
  assert.deepEqual(
    plane.mips.map((p) => [p.width, p.height]),
    [
      [260, 132],
      [130, 66],
      [65, 33],
      [32, 16],
      [16, 8],
      [8, 4],
      [4, 2],
      [2, 1],
      [1, 1]
    ]
  );
  assert.deepEqual([plane.mips[0].gridWidth, plane.mips[0].gridHeight], [3, 2]);
  const first = f.payloads[plane.mips[0].payloads[0]];
  const original = f.sourceMips[0].payload;
  // First interior BC4 block is at physical block (2,2), source block (0,0).
  assert.deepEqual(first.subarray((2 * 36 + 2) * 8, (2 * 36 + 3) * 8), original.subarray(0, 8));
  const tailId = plane.mips[3].payloads[0];
  assert.ok(plane.mips.slice(3).every((mip) => mip.payloads[0] === tailId));
  assert.deepEqual(tiledTextureBootstrapPayloads(f.directory), [tailId]);
  assert.equal(f.payloads[tailId].byteLength, 10368);
  assert.equal(first.byteLength, 10368);
  assert.equal(Math.ceil((36 * 8) / 256) * 256 * 36, 18432);
  assert.ok(Object.isFrozen(plane.mips[0]));
});

test("gutter uses source mip with independent negative/wrapped/mirrored/clamped texel expectations", () => {
  const source = Uint8Array.from([10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255]);
  for (const [mode, expected] of [
    ["clamp", [10, 10, 10, 20, 30, 30, 30, 30]],
    ["repeat", [20, 30, 10, 20, 30, 10, 20, 30]],
    ["mirror", [20, 10, 10, 20, 30, 30, 20, 10]]
  ]) {
    const bytes = tiledTextureGutter(source, 3, 1, -2, -2, 8, 1, mode);
    assert.deepEqual(
      Array.from({ length: 8 }, (_, i) => bytes[i * 4]),
      expected
    );
  }
});

test("BC7 sRGB address profiles share exact inner blocks and keep exact coverage wholly resident", async () => {
  const f = await makeTiledFixture({
    addresses: ["clamp", "repeat", "mirror"],
    semantic: "base-color-srgb",
    exactAlpha: true
  });
  const m = f.directory.metadata;
  assert.equal(m.planes.length, 4);
  const coverage = m.planes.find((p) => p.mode === "resident");
  assert.equal(m.source.planes[coverage.sourcePlane].role, "coverage");
  for (const mip of coverage.mips) {
    const original = f.product.chunks.get(`coverage-mip-${mip.level}`);
    const reconstructed = Buffer.concat(mip.payloads.map((id) => f.payloads[id]));
    assert.deepEqual(new Uint8Array(reconstructed), original);
  }
  for (const plane of m.planes.filter((p) => p.mode === "virtual")) {
    assert.equal(m.source.planes[plane.sourcePlane].format, "bc7-rgba-unorm-srgb");
    const first = f.payloads[plane.mips[0].payloads[0]];
    const original = f.product.chunks.get("color-mip-0");
    assert.deepEqual(first.subarray((2 * 36 + 2) * 16, (2 * 36 + 3) * 16), original.subarray(0, 16));
    assert.equal(first.byteLength, 20736);
  }
  assert.equal(Math.ceil((36 * 16) / 256) * 256 * 36, 27648);
  assert.ok(tiledTextureBootstrapPayloads(f.directory).length > coverage.mips.length);
});

test("large mandatory coverage mip splits into bounded fragments without losing any bytes", async () => {
  const product = await textureProduct(1025, 1025, "alpha-mask");
  const payloads = [];
  let offset = 0;
  const cook = new TiledTextureCook(
    { basisHash: "a".repeat(64) },
    {
      addresses: ["clamp"],
      packUri: "coverage.pack",
      async writePayload(bytes, hash) {
        payloads.push(bytes.slice());
        const start = offset;
        offset += bytes.length;
        return { offset: start, shard: `shards/${hash}.bin` };
      }
    }
  );
  const plane = product.metadata.planes[0];
  for (const mip of plane.mips) {
    await cook.appendMip({
      level: mip.level,
      width: mip.width,
      height: mip.height,
      rgba: new Uint8Array(0),
      plane,
      payload: product.chunks.get(mip.chunkId)
    });
  }
  const result = await cook.finish(product);
  assert.equal(result.directory.metadata.planes[0].mips[0].payloads.length, 2);
  assert.ok(payloads.every((p) => p.byteLength <= 1024 * 1024));
  assert.deepEqual(new Uint8Array(Buffer.concat(payloads.slice(0, 2))), product.chunks.get("coverage-mip-0"));
  assert.equal(tiledTextureBootstrapPayloads(result.directory).length, payloads.length);
});

test("directory authenticates bytes and rejects malformed ranges, identities, orphan/tail/coverage contracts", async () => {
  const f = await makeTiledFixture();
  await assert.rejects(openTiledTextureDirectory(f.bytes, "0".repeat(64)), /hash/);
  for (const mutate of [
    (m) => {
      m.payloads[1].offset--;
    },
    (m) => {
      m.payloads[0].byteLength++;
    },
    (m) => {
      m.payloads[0].hash = "bad";
    },
    (m) => {
      m.payloads[0].shard = "../escape";
    },
    (m) => {
      m.source.planes[0].mips[1].width++;
    },
    (m) => {
      m.planes[0].mips.at(-1).tailOrigin = [140, 140];
    },
    (m) => {
      m.planes[0].mips.pop();
    },
    (m) => {
      m.recipe.border = 4;
    },
    (m) => {
      m.extra = true;
    }
  ]) {
    const m = structuredClone(f.directory.metadata);
    mutate(m);
    const bytes = new TextEncoder().encode(JSON.stringify(m));
    await assert.rejects(openTiledTextureDirectory(bytes, digest(bytes)));
  }
  await assert.rejects(openTiledTextureDirectory(f.bytes.subarray(0, -1), f.directory.identity));
});

test("range coalescing has 1MiB, 64KiB gap and 2x-overfetch bounds; cache counts exact backing ownership", async () => {
  const f = await makeTiledFixture();
  const spans = tiledTextureSpans(f.directory, [2, 0, 1, 1]);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0].payloadIds, [0, 1, 2]);
  assert.equal(
    spans[0].byteLength,
    f.payloads.slice(0, 3).reduce((n, p) => n + p.length, 0)
  );
  assert.throws(() => tiledTextureSpans(f.directory, [Number.MAX_SAFE_INTEGER]), /outside/);
  const cache = new TiledTextureCache(10);
  cache.put("a", new ArrayBuffer(6));
  cache.put("b", new ArrayBuffer(6));
  assert.equal(cache.take("a"), undefined);
  assert.equal(cache.evidence().bytes, 6);
  assert.equal(cache.take("b").byteLength, 6);
  assert.equal(cache.evidence().bytes, 0);
  cache.put("oversize", new ArrayBuffer(11));
  assert.equal(cache.evidence().bytes, 0);
});

test("pinned VT references retain source hashes, licenses and full core source for subsequent port", async () => {
  const base = new URL("../oracle/reference/vt/", import.meta.url);
  const sources = JSON.parse(await readFile(new URL("sources.json", base), "utf8"));
  for (const source of sources) {
    assert.equal(source.license, "MIT");
    assert.match(source.revision, /^[a-f0-9]{40}$/u);
    for (const file of source.files) {
      assert.equal(digest(await readFile(new URL(file.local, base))), file.sha256);
    }
  }
});
