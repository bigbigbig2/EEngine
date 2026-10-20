import test from "node:test";
import assert from "node:assert/strict";
import { prepareMaterialTextureProducts } from "../../.test-dist/assets/PcMaterialTextures.js";
import { ImageTextureSource } from "../../.test-dist/assets/ImageTextureSource.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { ShadeImage } from "../../.test-dist/texture/ShadeImage.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";

function material(texture) {
  const result = new StandardShadeMaterial();
  result.texture_albedo = texture;
  return result;
}
function source() {
  return {
    directory: { planes: [{ semantic: "color-rgba", addressU: "repeat", addressV: "repeat" }] },
    closed: false,
    close() { this.closed = true; }
  };
}

test("material preparation shares only within a batch and closes cancelled unpublished sources", async () => {
  const original = ImageTextureSource.importWeb;
  const texture = ShadeTexture.from(ShadeImage.fromArrayBuffer(new Uint8Array([5, 8, 9, 255]), 4, "uint8", 1, 1));
  const imported = [];
  const inputs = [];
  ImageTextureSource.importWeb = async (input) => {
    inputs.push(input);
    const value = source();
    imported.push(value);
    return { source: value, decodeMs: 0 };
  };
  try {
    const first = material(texture), second = material(texture);
    await prepareMaterialTextureProducts([first, second]);
    assert.equal(imported.length, 1);
    assert.equal(first.texture_albedo, second.texture_albedo);
    assert.notEqual(first.texture_albedo, texture);
    assert.equal(imported[0].closed, false);
    imported[0].close();
    const fresh = material(texture);
    await prepareMaterialTextureProducts([fresh]);
    assert.equal(imported.length, 2, "a closed prior batch must not poison new material preparation");
    imported[1].close();

    const controller = new AbortController();
    const cancelled = material(texture);
    await assert.rejects(prepareMaterialTextureProducts([cancelled], controller.signal, () => controller.abort()), /abort/i);
    assert.equal(cancelled.texture_albedo, texture, "cancel must not publish partial CPU replacements");
    assert.equal(imported[2].closed, true);
    assert.deepEqual([...new Uint8Array(inputs[0].input)], [5, 8, 9, 255]);
  } finally {
    ImageTextureSource.importWeb = original;
  }
});

test("material raw input rejects capacity before allocating or dispatching an import", async () => {
  const image = ShadeImage.fromArrayBuffer(new Uint8Array(4), 4, "uint8", 8192, 8192);
  await assert.rejects(prepareMaterialTextureProducts([material(ShadeTexture.from(image))]), /bounded/);
});
