import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openOegPackV3 } from "../.test-dist/assets/OegPackV3.js";
import { parseOegPackSceneManifestV3 } from "../.test-dist/assets/geometry-product/OegPackSceneManifestV3.js";
import { openTextureProduct, textureProductHash } from "../.test-dist/assets/TextureProduct.js";

const directory = resolve(process.argv[2] ?? ".local/models/bistro-cooked");
const sceneBytes = await readFile(resolve(directory, "scene.oescene"));
const scene = parseOegPackSceneManifestV3(sceneBytes);
const packs = [];
for (const reference of scene.packs) {
  const file = await open(resolve(directory, reference.uri), "r");
  try {
    const pack = await openOegPackV3({
      async read(offset, length) {
        const bytes = new Uint8Array(length);
        let read = 0;
        while (read < length) {
          const result = await file.read(bytes, read, length - read, Number(offset) + read);
          if (!result.bytesRead) throw new Error("Pack range EOF");
          read += result.bytesRead;
        }
        return bytes.buffer;
      }
    });
    assert.equal(pack.header.packContentHash, reference.packId);
    packs.push(pack);
  } finally {
    await file.close();
  }
}
const triangles = scene.instances.reduce((sum, instance) => {
  const reference = scene.assets[instance.asset];
  return sum + packs[reference.pack].assets[reference.assetRecordIndex].sourceTriangleCount;
}, 0);
const geometry = {
  packs: packs.length,
  uniqueAssets: scene.assets.length,
  instances: scene.instances.length,
  triangles,
  fileBytes: packs.reduce((sum, pack) => sum + Number(pack.header.fileBytes), 0),
  pages: packs.reduce((sum, pack) => sum + pack.pages.length, 0)
};
if (process.argv.includes("--geometry-only")) {
  console.log(JSON.stringify({ geometry }, null, 2));
} else {
  const materials = JSON.parse(await readFile(resolve(directory, "scene.materials.json")));
  assert.equal(materials.schema, "oengine-offline-scene-materials-v1");
  assert.equal(materials.geometryManifestHash, await textureProductHash(sceneBytes));
  assert.equal(materials.source.triangles, triangles);
  assert.equal(materials.instanceMaterials.length, scene.instances.length);
  assert.equal(materials.bindings.length, materials.gltf.materials.length);
  const images = new Set(),
    identities = new Set(),
    receipts = [];
  const byUri = new Map();
  const formats = {};
  let payloadBytes = 0,
    packageBytes = 0;
  for (const entry of materials.products) {
    const bytes = await readFile(resolve(directory, entry.uri));
    const product = await openTextureProduct(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    );
    assert.equal(product.identity, entry.identity);
    assert.equal(product.metadata.recipe.quality, "bc7e-scalar-6-bc4-hq");
    assert.equal(product.metadata.recipe.revision, "99f52d63aa6799cbdaecfe977111dc5ec3b31d47");
    const receipt = JSON.parse(await readFile(resolve(directory, entry.uri + ".json")));
    assert.equal(receipt.identity, product.identity);
    assert.equal(receipt.binaryHash, product.metadata.recipe.binaryHash);
    images.add(receipt.imageIndex);
    identities.add(product.identity);
    receipts.push(receipt);
    byUri.set(entry.uri, product.metadata);
    payloadBytes += product.evidence.ownedPayloadBytes;
    packageBytes += bytes.length;
    for (const plane of product.metadata.planes) formats[plane.format] = (formats[plane.format] ?? 0) + 1;
  }
  assert.equal(images.size, materials.source.images);
  let masks = 0;
  for (const [index, material] of materials.gltf.materials.entries()) {
    if (material.alphaMode !== "MASK") continue;
    masks++;
    const metadata = byUri.get(materials.bindings[index].texture_albedo.uri);
    assert.equal(metadata.exactAlpha, true);
    assert.ok(metadata.planes.some((plane) => plane.role === "coverage" && plane.format === "r8unorm"));
  }
  console.log(
    JSON.stringify(
      {
        source: materials.source,
        geometry,
        texture: {
          products: materials.products.length,
          uniqueProducts: identities.size,
          sourceImages: images.size,
          formats,
          maskMaterials: masks,
          payloadBytes,
          packageBytes,
          encodeMsSum: receipts.reduce((sum, receipt) => sum + receipt.encodeMs, 0),
          prepareMsSum: receipts.reduce((sum, receipt) => sum + receipt.prepareMs, 0),
          decodeMsSum: receipts.reduce((sum, receipt) => sum + receipt.decodeMs, 0)
        },
        runtimeContract:
          "Final blocks + full mips + exact coverage; browser consumption must be verified separately"
      },
      null,
      2
    )
  );
}
