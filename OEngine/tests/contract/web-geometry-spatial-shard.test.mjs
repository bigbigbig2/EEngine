import assert from "node:assert/strict";
import test from "node:test";

const { createWebCookSceneSource } = await import("../../.test-dist/assets/web-cook/WebCookSceneSource.js");

test("multiple Product assets may map to one triangle-owned catalog primitive", () => {
  const assetRecords = new Uint8Array(128 * 2), view = new DataView(assetRecords.buffer);
  for (let asset = 0; asset < 2; asset++) {
    const at = asset * 128;
    for (const [offset, value] of [[72, asset], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) view.setUint32(at + offset, value, true);
  }
  const primitive = { materialIndex: 0xffffffff, material: {}, attributeSemantics: ["POSITION"], instanceNodeIndices: [0] };
  const catalog = { primitives: [primitive], instances: [{ nodeIndex: 0, meshIndex: 0, worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }], textures: [], images: [] };
  const result = createWebCookSceneSource(catalog, { assetRecords }, { sceneAssetIndices: [0, 0] });
  assert.equal(result.source.count, 2);
  assert.deepEqual([...result.source.geometryIndices], [0, 1]);
});
