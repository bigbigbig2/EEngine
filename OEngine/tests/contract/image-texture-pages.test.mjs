import assert from "node:assert/strict";
import test from "node:test";
import { cookImageTexture } from "../../.test-dist/assets/codec/ImageTextureCook.js";
import { ImageTexturePages, imagePageSource, assertImageTailLevel } from "../../.test-dist/assets/ImageTexturePages.js";

async function product(width, height, cellSize, addressU, addressV) {
  const inputs = [];
  for (let mip = 0; mip <= Math.floor(Math.log2(Math.max(width, height))); mip++) {
    const w = Math.max(1, Math.floor(width / 2 ** mip));
    const h = Math.max(1, Math.floor(height / 2 ** mip));
    inputs.push({ width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(127) });
  }
  return (
    await cookImageTexture(
      {
        semantic: "data-rgb",
        quality: "high",
        mode: "virtual",
        mips: "provided",
        inputs,
        cellSize,
        addressU,
        addressV,
        toolHash: "a".repeat(64)
      },
      {
        encodeAvif: async () => new Uint8Array([1]),
        put: async () => "test.avif"
      }
    )
  ).directory;
}

test("unique owner index covers every NPOT page texel including 16-owner repeat and tiny tails", async () => {
  let maxOwners = 0;
  let checked = 0;
  // Independent per-texel brute force versus the production spatial lookup.
  const coordinate = (value, size, mode) => {
    if (mode === "clamp-to-edge") return Math.min(size - 1, Math.max(0, value));
    if (mode === "repeat") return value - Math.floor(value / size) * size;
    const cycle = Math.floor(value / size);
    const local = value - cycle * size;
    return cycle % 2 === 0 ? local : size - local - 1;
  };
  for (const [w, h, cell] of [
    [385, 385, 128],
    [513, 259, 256],
    [513, 385, 512],
    [1, 1, 128]
  ]) {
    for (const u of ["repeat", "mirror-repeat", "clamp-to-edge"]) {
      for (const v of ["repeat", "mirror-repeat", "clamp-to-edge"]) {
        const directory = await product(w, h, cell, u, v);
        const pages = new ImageTexturePages(directory);
        for (let mip = 0; mip < directory.mipCount; mip++) {
          const width = Math.max(1, Math.floor(w / 2 ** mip));
          const height = Math.max(1, Math.floor(h / 2 ** mip));
          const items = directory.items.filter((item) => item.mip === mip);
          for (const x of new Set([0, Math.ceil(width / 128) - 1])) {
            for (const y of new Set([0, Math.ceil(height / 128) - 1])) {
              const expected = new Set();
              for (let dy = 0; dy < 144; dy++) {
                for (let dx = 0; dx < 144; dx++) {
                  const sx = coordinate(x * 128 + dx - 8, width, u);
                  const sy = coordinate(y * 128 + dy - 8, height, v);
                  const owner = items.find(
                    (item) =>
                      sx >= item.x && sy >= item.y && sx < item.x + item.width && sy < item.y + item.height
                  );
                  assert.ok(owner);
                  expected.add(owner.id);
                }
              }
              const plan = pages.page(0, mip, x, y);
              assert.deepEqual(
                plan.owners,
                [...expected].sort((a, b) => a - b)
              );
              assert.equal(
                plan.decodedBytes,
                plan.owners.reduce((n, id) => n + directory.items[id].decodedBytes, 0)
              );
              assert.equal(imagePageSource(plan), pages.directory);
              maxOwners = Math.max(maxOwners, plan.owners.length);
              checked++;
            }
          }
        }
      }
    }
  }
  assert.equal(maxOwners, 16);
  assert.ok(checked > 300);
});

test("index admission precedes allocation; caller mutation and forged plans cannot change issued domain", async () => {
  const directory = await product(385, 385, 128, "repeat", "repeat");
  assert.throws(() => new ImageTexturePages(directory, 4), /capacity/);
  const pages = new ImageTexturePages(directory);
  directory.items[0].x = 100;
  assert.equal(pages.directory.items[0].x, 0);
  assert.throws(() => pages.page(0, 100, 0, 0));
  assert.throws(() => pages.page(0, 0, 4, 0));
  assert.throws(() => imagePageSource({ ...pages.page(0, 0, 0, 0) }), /not issued/);
});

test("protected tail preserves every canonical mip in one block-aligned nonoverlapping 144 slot", async () => {
  for (const [width, height] of [[385, 385], [513, 1], [64, 64], [1, 1], [129, 65]]) {
    const pages = new ImageTexturePages(await product(width, height, 128, "repeat", "mirror-repeat"));
    const tail = pages.tail(0);
    assert.equal(tail.first + tail.levels.length, pages.directory.mipCount);
    const written = new Uint8Array(144 * 144);
    for (const [index, level] of tail.levels.entries()) {
      assertImageTailLevel(level);
      assert.equal(level.page.mip, tail.first + index);
      assert.equal(level.origin[0] % 4, 0);
      assert.equal(level.origin[1] % 4, 0);
      assert.ok(level.width >= level.page.logicalWidth + 16);
      assert.ok(level.height >= level.page.logicalHeight + 16);
      assert.ok(level.origin[0] + level.width <= 144);
      assert.ok(level.origin[1] + level.height <= 144);
      for (let y = level.origin[1]; y < level.origin[1] + level.height; y++) {
        for (let x = level.origin[0]; x < level.origin[0] + level.width; x++) {
          assert.equal(written[y * 144 + x], 0, "tail levels must not overwrite another mip/gutter");
          written[y * 144 + x] = 1;
        }
      }
    }
    assert.throws(() => assertImageTailLevel({ ...tail.levels[0] }), /not issued/);
  }
});
