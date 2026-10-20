import assert from "node:assert/strict";
import test from "node:test";
import { imageTextureResidentLayout } from "../../.test-dist/gpu/ImageTextureLayout.js";

test("resident logical mip domains survive block padding without source rescale", () => {
  for (const [width, height] of [[7, 5], [1, 1], [513, 259], [2048, 2048]]) {
    for (const [semantic, target, block, bytes] of [
      ["normal-xy", "bc5-rg", 4, 16], ["data-rgb", "bc7-rgb", 4, 16],
      ["scalar-r", "bc4-r", 4, 8], ["exact-r", "r8", 1, 1]
    ]) {
      for (const unaligned of [false, true]) {
        const directory = { width, height, mipCount: 1 + Math.floor(Math.log2(Math.max(width, height))),
          planes: [{ semantic, target, mode: "resident" }] };
        const layout = imageTextureResidentLayout(directory, 0, { maxTextureDimension2D: 4096 }, unaligned);
        let total = 0;
        for (const level of layout.levels) {
          assert.equal(level.width, Math.max(1, Math.floor(width / 2 ** level.mip)));
          assert.equal(level.height, Math.max(1, Math.floor(height / 2 ** level.mip)));
          assert.ok(level.blockColumns * block >= level.width);
          assert.ok(level.blockRows * block >= level.height);
          total += Math.ceil(level.physicalWidth / block) * Math.ceil(level.physicalHeight / block) * bytes;
        }
        assert.equal(total, layout.bytesPerLayer);
        assert.equal(layout.hardwareDomain, layout.levels.every((mip) =>
          mip.width === mip.physicalWidth && mip.height === mip.physicalHeight));
        if (unaligned || block === 1 || width === 2048) assert.equal(layout.hardwareDomain, true);
      }
    }
  }
});

test("physical device dimensions and resident/virtual ownership reject before allocation", () => {
  const directory = { width: 7, height: 5, mipCount: 3,
    planes: [{ semantic: "normal-xy", target: "bc5-rg", mode: "resident" }] };
  assert.throws(() => imageTextureResidentLayout(directory, 0, { maxTextureDimension2D: 7 }, false), /dimensions/);
  assert.throws(() => imageTextureResidentLayout(directory, 1, { maxTextureDimension2D: 8 }, false));
  directory.planes[0].mode = "virtual";
  assert.throws(() => imageTextureResidentLayout(directory, 0, { maxTextureDimension2D: 8 }, false), /resident/);
});
