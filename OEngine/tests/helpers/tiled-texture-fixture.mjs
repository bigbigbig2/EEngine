import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import createBasis from "../../src/assets/codec/vendor/pc-texture/basis_bc.js";
import { cookPcTextureRgba } from "../../.test-dist/assets/codec/PcTextureCook.js";
import { TiledTextureCook } from "../../.test-dist/assets/codec/TiledTextureCook.js";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const vendor = new URL("../../src/assets/codec/vendor/pc-texture/", import.meta.url);
const identity = JSON.parse(await readFile(new URL("source.json", vendor), "utf8"));
const binary = await readFile(new URL("basis_bc.wasm", vendor));
assert.equal(digest(binary), identity.hashes["basis_bc.wasm"]);
export const codecs = {
  basis: await createBasis({
    wasmBinary: binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength)
  }),
  basisHash: identity.hashes["basis_bc.wasm"],
  ktx: { HEAPU8: new Uint8Array(0) },
  ktxHash: ""
};

export async function makeTiledFixture({
  addresses = ["repeat"],
  exactAlpha = false,
  semantic = "occlusion-linear",
  width = 257,
  height = 129,
  channel = 2
} = {}) {
  const payloads = [];
  let offset = 0;
  const cook = new TiledTextureCook(
    codecs,
    {
      addresses,
      packUri: "texture.vtpack",
      async writePayload(bytes, hash) {
        payloads.push(bytes.slice());
        const start = offset;
        offset += bytes.byteLength;
        return { offset: start, shard: `shards/${hash}.bin` };
      }
    },
    channel
  );
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgba.set([x % 256, y, (x * 3 + y * 5) % 256, (x + y) % 256], (y * width + x) * 4);
    }
  }
  const sourceMips = [];
  const result = await cookPcTextureRgba(
    codecs,
    rgba,
    width,
    height,
    {
      semantic,
      channel,
      exactAlpha,
      sourceUri: "fixture://tiled"
    },
    undefined,
    async (mip) => {
      sourceMips.push({ ...mip, payload: mip.payload.slice(), rgba: mip.rgba.slice() });
      await cook.appendMip(mip);
    }
  );
  const tiled = await cook.finish(result.product);
  const pack = new Uint8Array(offset);
  payloads.forEach((bytes, id) => pack.set(bytes, tiled.directory.metadata.payloads[id].offset));
  return { ...tiled, payloads, pack, product: result.product, sourceMips };
}
