import assert from "node:assert/strict";
import test from "node:test";

const { createWebCookSceneSource, createWebCookSceneSourceAsync, decodeWebCookImageBitmap } = await import("../../.test-dist/assets/web-cook/WebCookSceneSource.js");
const { webCookCatalogSceneFraming } = await import("../../.test-dist/assets/web-cook/WebCookSceneBounds.js");
const { mergeVirtualGeometryProductSceneSourcesV1 } = await import("../../.test-dist/assets/geometry-product/VirtualGeometrySceneSourceV1.js");

test("Web Cook image decode fits the negotiated dimension without distorting aspect", async () => {
  const previous = globalThis.createImageBitmap;
  let closed = 0;
  let requested;
  globalThis.createImageBitmap = async (_source, options) => {
    if (!options) return { width: 600, height: 8400, close() { closed++; } };
    requested = options;
    return { width: options.resizeWidth, height: options.resizeHeight, close() {} };
  };
  try {
    const bitmap = await decodeWebCookImageBitmap(new Blob(), 8192);
    assert.deepEqual([bitmap.width, bitmap.height], [585, 8192]);
    assert.equal(requested.resizeQuality, "high");
    assert.equal(closed, 1);
  } finally {
    if (previous === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previous;
  }
});

test("separate Web Cook Products use one catalog fit without moving earlier instances", async () => {
  const translate = y => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1];
  const catalog = {
    primitives: [0, 1].map(index => ({
      nodeIndex: index, instanceNodeIndices: [index], boundsMin: [0, 0, 0], boundsMax: [1, 1, 1],
      materialIndex: 0, material: {}, attributeSemantics: ["POSITION"]
    })),
    instances: [
      { nodeIndex: 0, worldMatrix: translate(0) },
      { nodeIndex: 1, worldMatrix: translate(10) }
    ],
    textures: [], images: []
  };
  const assetRecords = new Uint8Array(128);
  const view = new DataView(assetRecords.buffer);
  view.setFloat32(44, 1, true);
  for (const offset of [60, 64, 68]) view.setFloat32(offset, 1, true);
  const framing = webCookCatalogSceneFraming(catalog, { fitHeight: 2, fitBase: [0, -1, 0] });
  const parts = [];
  for (let index = 0; index < 2; index++) {
    const mapped = await createWebCookSceneSourceAsync(catalog, { assetRecords }, async () => { throw new Error("no image expected"); }, undefined, {
      sceneAssetIndices: [index], scale: framing.scale, offset: framing.offset
    });
    assert.equal(mapped.materials[0].metallic_factor, 1, "missing glTF metallicFactor defaults to one");
    assert.equal(createWebCookSceneSource(catalog, { assetRecords }, { sceneAssetIndices: [index] }).materials[0].metallic_factor, 1);
    parts.push({ source: mapped.source, productTableSlot: index, productGeneration: 1, assetReferenceBegin: index });
  }
  const firstY = parts[0].source.currentTransforms[13];
  const combined = mergeVirtualGeometryProductSceneSourcesV1(parts);
  assert.equal(combined.currentTransforms[13], firstY, "later Product publication keeps the first transform");
  assert.ok(Math.abs(combined.boundsMin[1] - framing.min[1]) < 1e-6);
  assert.ok(Math.abs(combined.boundsMax[4] - framing.max[1]) < 1e-6);
  assert.ok(Math.abs((combined.boundsMax[4] - combined.boundsMin[1]) - 2) < 1e-6);
});

test("geometry-only mapping preserves selected primitives and skips authored image reads", async () => {
  const assetRecords = new Uint8Array(256);
  for (const offset of [44, 172]) new DataView(assetRecords.buffer).setFloat32(offset, 1, true);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const catalog = {
    primitives: [0, 1, 2].map(index => ({
      nodeIndex: index, instanceNodeIndices: [index], boundsMin: [0, 0, 0], boundsMax: [1, 1, 1],
      materialIndex: index, material: { baseColorTexture: { textureIndex: index } },
      attributeSemantics: ["POSITION", "TEXCOORD_0"]
    })),
    instances: [0, 1, 2].map(index => ({ nodeIndex: index, worldMatrix: identity })),
    textures: [], images: []
  };
  let reads = 0;
  let timing;
  const mapped = await createWebCookSceneSourceAsync(catalog, { assetRecords }, async () => { reads++; throw new Error("image read"); }, undefined, {
    sceneAssetIndices: [2, 0], geometryOnly: true, onMappingTiming: value => { timing = value; }
  });
  assert.equal(reads, 0);
  assert.equal(mapped.source.assetCount, 2);
  assert.equal(mapped.source.count, 2);
  assert.deepEqual([...mapped.source.geometryIndices], [0, 1]);
  assert.deepEqual([...mapped.source.materialIndices], [0, 0]);
  assert.equal(mapped.materials.length, 1);
  assert.equal(mapped.materials[0].is_unlit, true);
  assert.equal(mapped.materials[0].texture_albedo, undefined);
  assert.deepEqual(timing, { textureCacheHits: 0, textureCacheMisses: 0, imageReadMs: 0, imageDecodeMs: 0 });
});

test("multi-Product scene merge preserves transforms, materials, bounds, and Product identity", () => {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const translated = identity.slice();
  translated[12] = 7;
  const material0 = Object.freeze({ name: "first" });
  const material1 = Object.freeze({ name: "second" });
  const source = (transform, materialIndex, materials, center) => Object.freeze({
    materials,
    geometryProfiles: Object.freeze([Object.freeze({ profile: "virtual" })]),
    assetCount: 1,
    hierarchyMaxDepth: 4,
    hierarchyTraversalCapacity: 8,
    hierarchyVisibleClusterCapacity: 6,
    hierarchyRasterWorkCapacity: 5,
    count: 1,
    geometryIndices: new Uint32Array([0]),
    materialIndices: new Uint32Array([materialIndex]),
    currentTransforms: transform,
    boundsSpheres: new Float32Array([center, 0, 0, 2]),
    boundsMin: new Float32Array([center - 2, -2, -2]),
    boundsMax: new Float32Array([center + 2, 2, 2])
  });
  const merged = mergeVirtualGeometryProductSceneSourcesV1([
    { source: source(identity, 0, Object.freeze([material0]), 0), productTableSlot: 2, productGeneration: 11, assetReferenceBegin: 0 },
    { source: source(translated, 1, Object.freeze([material0, material1]), 7), productTableSlot: 7, productGeneration: 29, assetReferenceBegin: 1 }
  ]);
  assert.equal(merged.count, 2);
  assert.equal(merged.assetCount, 2);
  assert.deepEqual([...merged.geometryIndices], [0, 1]);
  assert.deepEqual([...merged.productTableSlots], [2, 7]);
  assert.deepEqual([...merged.productGenerations], [11, 29]);
  assert.deepEqual([...merged.materialIndices], [0, 1]);
  assert.strictEqual(merged.materials[0], material0);
  assert.strictEqual(merged.materials[1], material1);
  assert.equal(merged.currentTransforms[16 + 12], 7);
  assert.deepEqual([...merged.boundsSpheres], [0, 0, 0, 2, 7, 0, 0, 2]);
  assert.equal(merged.hierarchyTraversalCapacity, 16);
  assert.equal(merged.hierarchyVisibleClusterCapacity, 12);
  assert.equal(merged.hierarchyRasterWorkCapacity, 10);
});

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

test("Web Cook async mapper shares matching image usage but separates normal mip semantics", async () => {
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
          baseColorTexture: { textureIndex: 0, texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 },
          emissiveTexture: { textureIndex: 1, texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 },
          normalTexture: { textureIndex: 2, texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 } },
        attributeSemantics: ["POSITION", "TEXCOORD_0", "NORMAL"], vertexCount: 3, triangleCount: 1, boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1], boundsSphere: [0, 0, 0, 1] }],
      textures: [0, 1, 2].map(textureIndex => ({ textureIndex, sourceIndex: 0, sampler: {} })),
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
    assert.equal(decodes, 2, "sRGB and normal usage each decode once");
    assert.equal(cache.size, 2);
    assert.equal(first.materials[0].texture_albedo, second.materials[0].texture_albedo, "both revisions must share one resident texture");
    assert.equal(first.materials[0].texture_albedo, first.materials[0].texture_emissive);
    assert.notEqual(first.materials[0].texture_albedo, first.materials[0].texture_normal);
    // Without a cache each revision owns its own texture, which is what doubles
    // the layers a size-class bank must hold during a replacement.
    const isolated = await createWebCookSceneSourceAsync(catalog, { assetRecords }, readImage);
    assert.equal(decodes, 4);
    assert.notEqual(first.materials[0].texture_albedo, isolated.materials[0].texture_albedo);
  } finally {
    if (previous === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previous;
  }
});
