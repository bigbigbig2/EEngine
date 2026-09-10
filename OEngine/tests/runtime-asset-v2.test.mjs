import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUTextureUsage ??= Object.freeze({ COPY_DST: 2, TEXTURE_BINDING: 4 });

const {
  cookTextureAssetPackageV2,
  openTextureAssetPackageV2,
  selectTextureAssetVariantV2,
  uploadTextureAssetPackageV2
} = await import("../.test-dist/assets/TextureAssetPackage.js");

test("Runtime Package V2 metadata is deterministic and rejects corruption", async () => {
  const source = sourceTexture("base-color-srgb");
  const first = await cookTextureAssetPackageV2(source);
  const second = await cookTextureAssetPackageV2(source);
  assert.deepEqual(new Uint8Array(first), new Uint8Array(second));

  const opened = await openTextureAssetPackageV2(first);
  assert.equal(opened.runtime.package.manifest.formatVersion, 2);
  assert.equal(opened.runtime.manifest.schemaVersion, 2);
  assert.equal(opened.runtime.manifest.assetType, "texture-2d");
  assert.deepEqual(opened.variants.map(({ profile }) => profile), ["desktop-bc", "portable-rgba8"]);
  for (const chunk of opened.runtime.manifest.chunks) {
    const section = opened.runtime.package.section(chunk.sectionType);
    assert.equal(chunk.byteOffset, section.byteOffset);
    assert.equal(chunk.compressedBytes, section.byteLength);
    assert.ok(chunk.variantIds.length >= 1);
  }
  assert.equal(opened.evidence.sourceBytes, 8 * 8 * 4);
  assert.ok(opened.evidence.packageBytes > opened.evidence.sourceBytes);
  assert.equal(opened.evidence.decodedPeakBytes, 8 * 8 * 4 + 4 * 4 * 4 + 2 * 2 * 4 + 4);

  const corrupt = first.slice(0);
  const bytes = new Uint8Array(corrupt);
  bytes[bytes.length - 1] ^= 0x80;
  await assert.rejects(() => openTextureAssetPackageV2(corrupt), /checksum|content hash/i);
});

test("Texture Cooker V2 preserves color-space, normal, and mask mip semantics in its portable oracle", async () => {
  const base = await portableMips("base-color-srgb");
  // Averaging 0 and 255 in linear light encodes near 188 sRGB, not 128.
  const highContrast = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) highContrast.set(x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 8 + x) * 4);
  const contrast = await openTextureAssetPackageV2(await cookTextureAssetPackageV2({ width: 8, height: 8, rgba8: highContrast, semantic: "base-color-srgb", sourceUri: "fixture://srgb" }));
  const contrastMips = selectTextureAssetVariantV2(contrast, new Set()).payloads;
  assert.ok(contrastMips[1][0] >= 186 && contrastMips[1][0] <= 189);
  assert.equal(base.length, 4);

  const normal = await portableMips("normal-linear");
  for (let offset = 0; offset < normal[1].length; offset += 4) {
    const x = normal[1][offset] / 127.5 - 1;
    const y = normal[1][offset + 1] / 127.5 - 1;
    const z = normal[1][offset + 2] / 127.5 - 1;
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 0.02);
  }

  const mask = await portableMips("alpha-mask");
  for (const mip of mask.slice(0, 3)) assert.equal(coverage(mip), 0.5);
});

test("Texture Cooker V2 emits complete offline mip chains and capability-selected physical variants", async () => {
  const expected = {
    "base-color-srgb": "bc3-rgba-unorm-srgb",
    "normal-linear": "bc5-rg-unorm",
    "orm-linear": "bc1-rgba-unorm",
    "alpha-mask": "bc4-r-unorm"
  };
  for (const [semantic, format] of Object.entries(expected)) {
    const asset = await openTextureAssetPackageV2(await cookTextureAssetPackageV2(sourceTexture(semantic)));
    const compressed = selectTextureAssetVariantV2(asset, new Set(["texture-compression-bc"]));
    const fallback = selectTextureAssetVariantV2(asset, new Set());
    assert.equal(compressed.format, format);
    assert.equal(fallback.format, semantic === "base-color-srgb" ? "rgba8unorm-srgb" : "rgba8unorm");
    assert.deepEqual(compressed.mips.map(({ width, height }) => [width, height]), [[8, 8], [4, 4], [2, 2], [1, 1]]);
    assert.equal(compressed.payloads.length, 4);
    assert.equal(fallback.payloads.length, 4);
  }
  const compressedOnly = await openTextureAssetPackageV2(await cookTextureAssetPackageV2(
    sourceTexture("base-color-srgb"),
    { includePortableFallback: false }
  ));
  assert.throws(
    () => selectTextureAssetVariantV2(compressedOnly, new Set()),
    /no variant compatible/i
  );
});

test("BC5 normal and BC4 mask blocks preserve their declared sampling semantics", async () => {
  const normalAsset = await openTextureAssetPackageV2(await cookTextureAssetPackageV2(sourceTexture("normal-linear")));
  const normal = selectTextureAssetVariantV2(normalAsset, new Set(["texture-compression-bc"]));
  const normalX = decodeBc4(normal.payloads[0].subarray(0, 8));
  const normalY = decodeBc4(normal.payloads[0].subarray(8, 16));
  for (let index = 0; index < 16; index++) {
    const x = normalX[index] / 127.5 - 1;
    const y = normalY[index] / 127.5 - 1;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    assert.ok(z > 0.95);
  }

  const maskAsset = await openTextureAssetPackageV2(await cookTextureAssetPackageV2(sourceTexture("alpha-mask")));
  const mask = selectTextureAssetVariantV2(maskAsset, new Set(["texture-compression-bc"]));
  const left = decodeBc4(mask.payloads[0].subarray(0, 8));
  const right = decodeBc4(mask.payloads[0].subarray(8, 16));
  assert.ok(left.every((value) => value >= 250));
  assert.ok(right.every((value) => value <= 5));
});

test("Texture Package V2 uploads selected BC mips without runtime mip work", async () => {
  const asset = await openTextureAssetPackageV2(await cookTextureAssetPackageV2(sourceTexture("base-color-srgb")));
  const writes = [];
  const texture = {
    destroyed: false,
    createView: () => ({ texture: true }),
    destroy() { this.destroyed = true; }
  };
  const device = {
    features: new Set(["texture-compression-bc"]),
    limits: { maxTextureArrayLayers: 2048, maxTextureDimension2D: 8192 },
    createTexture(descriptor) { texture.descriptor = descriptor; return texture; },
    queue: {
      writeTexture(destination, data, layout, size) {
        writes.push({ destination, bytes: data.byteLength, layout, size });
      }
    }
  };
  const uploaded = uploadTextureAssetPackageV2(device, asset);
  assert.equal(uploaded.variant.format, "bc3-rgba-unorm-srgb");
  assert.equal(uploaded.evidence.runtimeMipPasses, 0);
  assert.equal(uploaded.evidence.transcodeBytes, 0);
  assert.equal(writes.length, 4);
  assert.equal(texture.descriptor.mipLevelCount, 4);
  assert.deepEqual(writes.map(({ size }) => [size.width, size.height]), [[8, 8], [4, 4], [4, 4], [4, 4]]);
  assert.ok(uploaded.evidence.residentBytes < 8 * 8 * 4);
});

test("Texture Cooker V2 selects a declared portable fallback for unaligned bases and keeps identity dimensional", async () => {
  const rgba8 = new Uint8Array(8 * 8 * 4).fill(127);
  const first = await openTextureAssetPackageV2(await cookTextureAssetPackageV2({
    width: 8, height: 8, rgba8, semantic: "base-color-srgb", sourceUri: "fixture://identity-a"
  }));
  const second = await openTextureAssetPackageV2(await cookTextureAssetPackageV2({
    width: 4, height: 16, rgba8, semantic: "base-color-srgb", sourceUri: "fixture://identity-b"
  }));
  assert.notEqual(first.runtime.manifest.assetId, second.runtime.manifest.assetId);

  const unaligned = await openTextureAssetPackageV2(await cookTextureAssetPackageV2({
    width: 6,
    height: 5,
    rgba8: new Uint8Array(6 * 5 * 4).fill(255),
    semantic: "base-color-srgb",
    sourceUri: "fixture://unaligned"
  }));
  assert.deepEqual(unaligned.variants.map(({ profile }) => profile), ["portable-rgba8"]);
  assert.throws(
    () => selectTextureAssetVariantV2(first, new Set(), { maxTextureArrayLayers: 1, maxTextureDimension2D: 4 }),
    /no variant compatible/i
  );
  await assert.rejects(
    () => cookTextureAssetPackageV2({
      width: 6,
      height: 5,
      rgba8: new Uint8Array(6 * 5 * 4),
      semantic: "base-color-srgb",
      sourceUri: "fixture://unaligned-compressed-only"
    }, { includePortableFallback: false }),
    /divisible by 4/i
  );
});

function sourceTexture(semantic) {
  const rgba8 = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const offset = (y * 8 + x) * 4;
    if (semantic === "normal-linear") {
      rgba8.set([128 + x * 2, 128 + y * 2, 250, 255], offset);
    } else if (semantic === "alpha-mask") {
      rgba8.set([255, 255, 255, x < 4 ? 255 : 0], offset);
    } else if (semantic === "orm-linear") {
      rgba8.set([x * 31, y * 31, 127, 255], offset);
    } else {
      rgba8.set([x * 31, y * 31, 180, 64 + x * 20], offset);
    }
  }
  return { width: 8, height: 8, rgba8, semantic, sourceUri: `fixture://${semantic}`, alphaCutoff: 0.5 };
}

async function portableMips(semantic) {
  const asset = await openTextureAssetPackageV2(await cookTextureAssetPackageV2(sourceTexture(semantic)));
  return selectTextureAssetVariantV2(asset, new Set()).payloads;
}

function coverage(bytes) {
  let covered = 0;
  for (let index = 3; index < bytes.length; index += 4) if (bytes[index] >= 128) covered++;
  return covered / (bytes.length / 4);
}

function decodeBc4(block) {
  const palette = [block[0], block[1]];
  for (let index = 1; index <= 6; index++) {
    palette.push(Math.round(((7 - index) * block[0] + index * block[1]) / 7));
  }
  let bits = 0n;
  for (let index = 0; index < 6; index++) bits |= BigInt(block[index + 2]) << BigInt(index * 8);
  return Array.from({ length: 16 }, (_, index) => palette[Number((bits >> BigInt(index * 3)) & 7n)]);
}
