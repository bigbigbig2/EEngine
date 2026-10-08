import test from "node:test";
import assert from "node:assert/strict";
import { textureProduct } from "../fixtures/texture-product.mjs";
import {
  saveTextureProduct,
  openTextureProduct,
  validateTextureProduct,
} from "../../.test-dist/assets/TextureProduct.js";

test("container2 persists schema3 identity, all mips and exact coverage; corruption rejects", async () => {
  const product = await textureProduct(17, 9, "base-color-srgb", true);
  const bytes = await saveTextureProduct(product),
    replay = await openTextureProduct(bytes);
  assert.equal(replay.identity, product.identity);
  assert.deepEqual(replay.metadata, product.metadata);
  for (const [id, payload] of product.chunks) assert.deepEqual(replay.chunks.get(id), payload);
  const corrupt = bytes.slice(0);
  new Uint8Array(corrupt)[corrupt.byteLength - 1] ^= 1;
  await assert.rejects(openTextureProduct(corrupt), /checksum|hash/);
});
test("schema2 requires recook; missing mip and invalid format never adapt", async () => {
  const p = await textureProduct();
  await assert.rejects(validateTextureProduct({ ...p.metadata, schemaVersion: 2 }, p.chunks), /recook/);
  const chunks = new Map(p.chunks);
  chunks.delete("color-mip-0");
  await assert.rejects(validateTextureProduct(p.metadata, chunks), /checksum|length/);
  await assert.rejects(
    validateTextureProduct(
      { ...p.metadata, planes: [{ ...p.metadata.planes[0], format: "bc7-rgba-unorm-srgb" }] },
      p.chunks,
    ),
    /semantic/,
  );
});
