import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { makeTiledFixture } from "../tests/helpers/tiled-texture-fixture.mjs";
import { compressTiledTexturePage } from "./tiled-texture-compress.mjs";
import {
  TILED_TEXTURE_RECIPE,
  TILED_TEXTURE_TAIL_ORIGINS,
  validateTiledTextureMetadata,
} from "../.test-dist/assets/TiledTextureProduct.js";
import { TILED_TEXTURE_TRANSPORT } from "../.test-dist/assets/codec/TiledTextureCompression.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function save(name, metadata, payloads, nativePayloads) {
  const base = new URL(`../tests/fixtures/tiled-zstd/${name}/`, import.meta.url);
  await mkdir(new URL("shards/", base), { recursive: true });
  const pack = Buffer.concat(payloads);
  metadata.pack = { uri: "texture.vtpack", byteLength: pack.length };
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  validateTiledTextureMetadata(metadata, hash(bytes), bytes.length);
  await writeFile(new URL("texture.vtdirectory", base), bytes);
  await writeFile(new URL("texture.vtpack", base), pack);
  await writeFile(new URL("reference.bin", base), Buffer.concat(nativePayloads));
  for (const p of metadata.payloads) await writeFile(new URL(p.shard, base), payloads[p.id]);
  await writeFile(
    new URL("fixture.json", base),
    JSON.stringify(
      {
        identity: hash(bytes),
        directoryBytes: bytes.length,
        referenceHash: hash(Buffer.concat(nativePayloads)),
        recipe: "OEngine/tools/generate-tiled-texture-oracle-fixtures.mjs",
      },
      null,
      2,
    ) + "\n",
  );
}
for (const semantic of ["occlusion-linear", "base-color-srgb", "normal-linear"]) {
  const f = await makeTiledFixture({
    semantic,
    width: 260,
    height: 132,
    channel: 0,
    addresses: ["clamp", "repeat", "mirror"],
  });
  await save(semantic, structuredClone(f.directory.metadata), f.payloads, f.nativePayloads);
}
const encoded = (size, value) => {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 8) bytes[offset] = bytes[offset + 1] = value;
  return bytes;
};
const nativePayloads = [224, 224, 128, 32].map((value) => encoded(10368, value));
const payloads = await Promise.all(nativePayloads.map((b, id) => (id < 3 ? compressTiledTexturePage(b) : b)));
let offset = 0;
const records = payloads.map((bytes, id) => {
  const record = {
    id,
    offset,
    byteLength: bytes.length,
    nativeByteLength: 10368,
    encoding: id < 3 ? "zstd-bc" : "gpu-native",
    hash: hash(bytes),
    shard: `shards/p${id}.bin`,
  };
  offset += bytes.length;
  return record;
});
const mips = Array.from({ length: 9 }, (_, level) => {
  const width = Math.max(1, 256 >> level),
    height = Math.max(1, 128 >> level);
  const physicalWidth = Math.ceil(width / 4) * 4,
    physicalHeight = Math.ceil(height / 4) * 4;
  const byteLength = (physicalWidth * physicalHeight) / 2;
  return {
    level,
    width,
    height,
    physicalWidth,
    physicalHeight,
    byteLength,
    chunkId: `scalar-mip-${level}`,
    hash: hash(encoded(byteLength, 200)),
  };
});
await save(
  "analytic-bc4",
  {
    schemaVersion: 2,
    recipe: TILED_TEXTURE_RECIPE,
    transport: TILED_TEXTURE_TRANSPORT,
    sourceIdentity: "a".repeat(64),
    source: {
      schemaVersion: 3,
      sourceWidth: 256,
      sourceHeight: 128,
      storageWidth: 256,
      storageHeight: 128,
      sourceBytes: 131072,
      sourceHash: "b".repeat(64),
      sourceUri: "oracle://analytic-bc4",
      semantic: "occlusion-linear",
      channel: 0,
      exactAlpha: false,
      uvScaleBias: [1, 1, 0, 0],
      recipe: {
        encoder: "analytic-constant-bc4",
        revision: "1",
        binaryHash: "c".repeat(64),
        filter: "provided",
        quality: "external-final",
      },
      planes: [{ role: "scalar", format: "bc4-r-unorm", mips }],
    },
    payloads: records,
    planes: [
      {
        sourcePlane: 0,
        mode: "virtual",
        address: "repeat",
        tailFirst: 2,
        mips: mips.map((mip) => ({
          level: mip.level,
          width: mip.width,
          height: mip.height,
          gridWidth: mip.level === 0 ? 2 : 1,
          gridHeight: 1,
          payloads: mip.level === 0 ? [0, 1] : mip.level === 1 ? [2] : [3],
          ...(mip.level >= 2 ? { tailOrigin: TILED_TEXTURE_TAIL_ORIGINS[mip.level - 2] } : {}),
        })),
      },
    ],
  },
  payloads,
  nativePayloads,
);
