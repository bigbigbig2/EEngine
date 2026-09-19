import assert from "node:assert/strict";
import test from "node:test";

const { createWebCookSceneSourceAsync } = await import("../.test-dist/assets/web-cook/WebCookSceneSource.js");

test("Web Cook async mapper materializes authored texture slots before scene source publication", async () => {
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2 });
  try {
    const assetRecords = new Uint8Array(128);
    const record = new DataView(assetRecords.buffer);
    record.setFloat32(32, 0, true); record.setFloat32(36, 0, true); record.setFloat32(40, 0, true); record.setFloat32(44, 1, true);
    record.setFloat32(48, -1, true); record.setFloat32(52, -1, true); record.setFloat32(56, -1, true);
    record.setFloat32(60, 1, true); record.setFloat32(64, 1, true); record.setFloat32(68, 1, true);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const textureSlots = {
      baseColorTexture: { textureIndex: 0, texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 },
      metallicRoughnessTexture: { textureIndex: 1, texCoord: 1, offset: [0.1, 0.2], scale: [2, 2], rotation: 0.25 },
      normalTexture: { textureIndex: 2, texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0, normalScale: 0.75 },
      occlusionTexture: { textureIndex: 3, texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0, occlusionStrength: 0.6 },
      emissiveTexture: { textureIndex: 4, texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 }
    };
    const catalog = {
      schemaVersion: 1, primitiveCount: 1, sourceBytes: 1, sourceTransferMode: "range", sourceIdentityHash: new Uint8Array(32), scenes: [0],
      instances: [{ nodeIndex: 0, meshIndex: 0, worldMatrix: identity }],
      primitives: [{ assetKey: "mesh:0:0", catalogIndex: 0, nodeIndex: 0, instanceNodeIndices: [0], meshIndex: 0, primitiveIndex: 0, materialIndex: 0,
        material: { materialIndex: 0, alphaMode: "MASK", doubleSided: false, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.2, roughnessFactor: 0.7, emissiveFactor: [0, 0, 0], alphaCutoff: 0.5, unlit: false, ...textureSlots },
        attributeSemantics: ["POSITION", "TEXCOORD_0", "TEXCOORD_1", "NORMAL"], vertexCount: 3, triangleCount: 1, boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1], boundsSphere: [0, 0, 0, 1] }],
      textures: [0, 1, 2, 3, 4].map(textureIndex => ({ textureIndex, sourceIndex: textureIndex, sampler: {} })),
      images: [0, 1, 2, 3, 4].map(imageIndex => ({ imageIndex, mimeType: "image/png", uri: `https://example.test/${imageIndex}.png` }))
    };
    const result = await createWebCookSceneSourceAsync(catalog, { assetRecords }, async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: "image/png" }));
    const material = result.materials[0];
    assert.ok(material.texture_albedo);
    assert.ok(material.texture_normal);
    assert.ok(material.texture_orm);
    assert.ok(material.texture_occlusion);
    assert.ok(material.texture_emissive);
    assert.equal(material.transparency_mode, 1);
    assert.deepEqual(material.base_color_uv_offset, [0, 0]);
    assert.deepEqual(material.orm_uv_offset, [0.1, 0.2]);
    assert.equal(result.source.count, 1);
  } finally {
    if (previous === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previous;
  }
});

test("Web Cook async mapper shares authored textures across revisions through a cache", async () => {
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2 });
  try {
    const assetRecords = new Uint8Array(128);
    new DataView(assetRecords.buffer).setFloat32(44, 1, true);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const catalog = {
      schemaVersion: 1, primitiveCount: 1, sourceBytes: 1, sourceTransferMode: "range", sourceIdentityHash: new Uint8Array(32), scenes: [0],
      instances: [{ nodeIndex: 0, meshIndex: 0, worldMatrix: identity }],
      primitives: [{ assetKey: "mesh:0:0", catalogIndex: 0, nodeIndex: 0, instanceNodeIndices: [0], meshIndex: 0, primitiveIndex: 0, materialIndex: 0,
        material: { materialIndex: 0, alphaMode: "OPAQUE", doubleSided: false, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1, emissiveFactor: [0, 0, 0], alphaCutoff: 0.5, unlit: false,
          baseColorTexture: { textureIndex: 0, texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 } },
        attributeSemantics: ["POSITION", "TEXCOORD_0", "NORMAL"], vertexCount: 3, triangleCount: 1, boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1], boundsSphere: [0, 0, 0, 1] }],
      textures: [{ textureIndex: 0, sourceIndex: 0, sampler: {} }],
      images: [{ imageIndex: 0, mimeType: "image/png", uri: "https://example.test/0.png" }]
    };
    let decodes = 0;
    const readImage = async () => { decodes++; return { bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: "image/png" }; };
    // A Product replacement maps the same authored images while the outgoing
    // revision is still resident. Sharing the cache keeps one resident texture
    // per image instead of one per revision.
    const cache = new Map();
    const first = await createWebCookSceneSourceAsync(catalog, { assetRecords }, readImage, undefined, { textureCache: cache });
    const second = await createWebCookSceneSourceAsync(catalog, { assetRecords }, readImage, undefined, { textureCache: cache });
    assert.equal(decodes, 1, "the shared cache must decode each image once");
    assert.equal(cache.size, 1);
    assert.equal(first.materials[0].texture_albedo, second.materials[0].texture_albedo, "both revisions must share one resident texture");
    // Without a cache each revision owns its own texture, which is what doubles
    // the layers a size-class bank must hold during a replacement.
    const isolated = await createWebCookSceneSourceAsync(catalog, { assetRecords }, readImage);
    assert.equal(decodes, 2);
    assert.notEqual(first.materials[0].texture_albedo, isolated.materials[0].texture_albedo);
  } finally {
    if (previous === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previous;
  }
});
