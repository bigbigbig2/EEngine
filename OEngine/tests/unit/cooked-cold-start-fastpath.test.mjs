import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  openTextureProduct,
  saveTextureProduct,
} from "../../.test-dist/assets/TextureProduct.js";
import { textureProduct } from "../fixtures/texture-product.mjs";
import {
  MemoryRangeReadablePackV3,
  openOegPackV3,
} from "../../.test-dist/assets/OegPackV3.js";
import {
  descriptorFromOegPack,
  OegPackProductRevisionSource,
} from "../../.test-dist/assets/geometry-product/OegPackProductProvider.js";
import { VirtualGeometryResidency } from "../../.test-dist/gpu/VirtualGeometryResidency.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";
import {
  writeTriangleProductPage,
  TRIANGLE_PRODUCT_PAYLOAD_BYTES,
} from "../helpers/geometry-product-fixture.mjs";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Synthesizes a valid 2-bootstrap-page raw OEGPACK V3 archive in memory. */
async function buildTwoPageOegPackV3() {
  const page0 = writeTriangleProductPage(new Uint8Array(262144));
  const page1 = writeTriangleProductPage(new Uint8Array(262144));

  const headerSize = 256;
  const assetOffset = 256;
  const assetBytes = 128;
  const rootOffset = assetOffset + assetBytes;
  const rootBytes = 8; // 2 roots
  const hierarchyOffset = rootOffset + rootBytes;
  const hierarchyBytes = 96; // 2 leaf nodes
  const groupOffset = hierarchyOffset + hierarchyBytes;
  const groupBytes = 32; // 2 groups
  const pageDirOffset = groupOffset + groupBytes;
  const pageDirBytes = 128; // 2 pages
  const bootstrapOffset = pageDirOffset + pageDirBytes;
  const bootstrapBytes = 8; // 2 bootstrap page IDs
  const formatOffset = bootstrapOffset + bootstrapBytes;
  const formatBytes = 16; // 1 vertex format
  const pageBlobOffset = formatOffset + formatBytes;
  const fileBytes = pageBlobOffset + page0.byteLength + page1.byteLength;

  const pack = new Uint8Array(fileBytes);
  const view = new DataView(pack.buffer);
  // Magic "OEGPACK\0"
  pack.set([79, 69, 71, 80, 65, 67, 75, 0], 0);
  view.setUint32(8, 3, true); // major
  view.setUint32(12, 0, true); // minor
  view.setUint32(16, 0x01020304, true); // endian
  view.setUint32(20, headerSize, true);
  view.setUint32(24, 18, true); // pageShift
  view.setUint32(28, 262144, true); // pageBytes
  view.setUint32(32, 0, true); // flags
  view.setUint32(36, 1, true); // defaultCodec
  view.setUint32(40, 1, true); // assetCount
  view.setUint32(44, 2, true); // rootNodeIndexCount
  view.setUint32(48, 2, true); // hierarchyNodeCount
  view.setUint32(52, 2, true); // groupCount
  view.setUint32(56, 2, true); // pageCount
  view.setUint32(60, 1, true); // vertexFormatCount
  view.setUint32(64, 2, true); // bootstrapPageCount
  view.setBigUint64(72, BigInt(assetOffset), true);
  view.setBigUint64(80, BigInt(rootOffset), true);
  view.setBigUint64(88, BigInt(hierarchyOffset), true);
  view.setBigUint64(96, BigInt(groupOffset), true);
  view.setBigUint64(104, BigInt(pageDirOffset), true);
  view.setBigUint64(112, BigInt(formatOffset), true);
  view.setBigUint64(120, BigInt(bootstrapOffset), true);
  view.setBigUint64(128, BigInt(pageBlobOffset), true);
  view.setBigUint64(136, BigInt(fileBytes), true);
  pack.fill(0xaa, 144, 176); // recipeHash

  // Asset 0
  pack.fill(0x11, assetOffset, assetOffset + 32);
  view.setFloat32(assetOffset + 44, 1, true); // radius
  view.setUint32(assetOffset + 72, 0, true); // rootNodeBegin
  view.setUint32(assetOffset + 76, 2, true); // rootNodeCount
  view.setUint32(assetOffset + 80, 0, true); // hierarchyBegin
  view.setUint32(assetOffset + 84, 2, true); // hierarchyCount
  view.setUint32(assetOffset + 88, 0, true); // groupBegin
  view.setUint32(assetOffset + 92, 2, true); // groupCount
  view.setUint32(assetOffset + 96, 0, true); // bootstrapPageBegin
  view.setUint32(assetOffset + 100, 2, true); // bootstrapPageCount
  view.setUint32(assetOffset + 104, 2, true); // sourceTriangleCount
  view.setUint32(assetOffset + 108, 2, true); // leafMeshletCount
  view.setUint32(assetOffset + 112, 2, true); // totalMeshletCount

  // Roots: [0, 1]
  view.setUint32(rootOffset, 0, true);
  view.setUint32(rootOffset + 4, 1, true);

  // Hierarchy node 0 -> group 0 (1 meshlet), node 1 -> group 1 (1 meshlet)
  for (let i = 0; i < 2; i++) {
    const at = hierarchyOffset + i * 48;
    view.setFloat32(at + 12, 1, true);
    view.setUint32(at + 44, (i << 1) | 1, true);
  }

  // Group directory: group 0 in page 0, group 1 in page 1 (both bootstrap flag=1)
  for (let i = 0; i < 2; i++) {
    const at = groupOffset + i * 16;
    view.setUint32(at, i, true); // pageId
    view.setUint32(at + 4, 0, true); // offsetInDecodedPage
    view.setUint32(at + 8, TRIANGLE_PRODUCT_PAYLOAD_BYTES, true);
    view.setUint32(at + 12, 1, true); // bootstrap flag
  }

  // Page directory
  const pages = [page0, page1];
  for (let i = 0; i < 2; i++) {
    const at = pageDirOffset + i * 64;
    const pOffset = pageBlobOffset + i * 262144;
    view.setBigUint64(at, BigInt(pOffset), true);
    view.setUint32(at + 8, 262144, true); // compressedBytes
    view.setUint32(at + 12, 262144, true); // decodedBytes
    view.setUint32(at + 16, i, true); // firstGroup
    view.setUint32(at + 20, 1, true); // groupCount
    view.setUint32(at + 24, 0, true); // codec = 0 (raw)
    view.setUint32(at + 28, 1, true); // flags = bootstrap
    const hash = createHash("sha256").update(pages[i]).digest();
    pack.set(hash.subarray(0, 16), at + 32);
    view.setUint32(at + 48, crc32(pages[i]), true);
    pack.set(pages[i], pOffset);
  }

  // Bootstrap page IDs: [0, 1]
  view.setUint32(bootstrapOffset, 0, true);
  view.setUint32(bootstrapOffset + 4, 1, true);

  // Vertex format 0
  view.setUint16(formatOffset, 16, true); // strideBytes
  view.setUint16(formatOffset + 2, 3, true); // attributeMask (pos + normal)
  view.setUint8(formatOffset + 4, 0); // positionOffset
  view.setUint8(formatOffset + 5, 12); // normalOffset
  view.setUint8(formatOffset + 6, 0xff);
  view.setUint8(formatOffset + 7, 0xff);
  view.setUint8(formatOffset + 8, 0xff);
  view.setUint8(formatOffset + 9, 0xff);
  view.setUint8(formatOffset + 10, 1); // Float32x3

  // Compute metadata packContentHash
  pack.fill(0, 176, 208);
  const metadataDigest = createHash("sha256").update(pack.subarray(0, pageBlobOffset)).digest();
  pack.set(metadataDigest, 176);
  return pack;
}

test("openTextureProduct verifyHashes=false matches strict mode and still enforces identity/manifest contracts", async () => {
  const authored = await textureProduct();
  const archive = await saveTextureProduct(authored);

  const strictProduct = await openTextureProduct(archive, { verifyHashes: true });
  const fastProduct = await openTextureProduct(archive, { verifyHashes: false });

  assert.equal(fastProduct.identity, strictProduct.identity);
  assert.equal(fastProduct.recipeHash, strictProduct.recipeHash);
  assert.deepEqual(fastProduct.metadata, strictProduct.metadata);
  assert.deepEqual(fastProduct.evidence, strictProduct.evidence);
  for (const [id, chunk] of strictProduct.chunks) {
    assert.deepEqual(fastProduct.chunks.get(id), chunk);
  }
});

test("OegPackV3 coalesced readPages merges contiguous bootstrap page reads and catches CRC32 corruption", async () => {
  const packBytes = await buildTwoPageOegPackV3();
  const rangeCalls = [];
  const inner = new MemoryRangeReadablePackV3(packBytes);
  const countingSource = {
    async read(byteOffset, byteLength) {
      rangeCalls.push({ byteOffset: Number(byteOffset), byteLength });
      return inner.read(byteOffset, byteLength);
    },
  };

  const opened = await openOegPackV3(countingSource, { verifyPageSha256: false });
  const readsBeforeActivation = rangeCalls.length;

  const deviceWrites = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer(d) {
      return { d, destroy() {} };
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        deviceWrites.push({ buffer, offset, bytes: data.byteLength });
      },
    },
  };

  const revisionSource = new OegPackProductRevisionSource(opened, descriptorFromOegPack(opened));
  const residency = await VirtualGeometryResidency.create(device, revisionSource, 1);

  // Two contiguous 256 KiB bootstrap pages must be fetched in ONE coalesced range read, not two!
  const activationRangeReads = rangeCalls.length - readsBeforeActivation;
  assert.equal(activationRangeReads, 1, "two contiguous bootstrap pages must coalesce into 1 range read");
  assert.equal(rangeCalls.at(-1).byteLength, 2 * 262144);
  assert.equal(residency.evidence().residentPages, 2);
  residency.destroy();

  // Corrupting a byte inside page 1 still fails CRC32 even when verifyPageSha256 is false
  const corrupted = packBytes.slice();
  corrupted[corrupted.byteLength - 64] ^= 0xff;
  const openedCorrupted = await openOegPackV3(new MemoryRangeReadablePackV3(corrupted), {
    verifyPageSha256: false,
  });
  await assert.rejects(openedCorrupted.readPages([0, 1]), /checksum/i);
});

test("compileCanonicalMaterial caches unchanged materials and invalidates on mutation", () => {
  const material = new StandardShadeMaterial();
  material.roughness_factor = 0.42;
  const first = compileCanonicalMaterial(material);
  const second = compileCanonicalMaterial(material);
  assert.equal(first, second, "unchanged StandardShadeMaterial must return cached CanonicalMaterial");

  material.clearcoat_factor = 0.5;
  const third = compileCanonicalMaterial(material);
  assert.notEqual(third, first, "mutated StandardShadeMaterial must invalidate cache");
  assert.equal(third.coatFactor, 0.5);
});
