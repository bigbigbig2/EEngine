import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { openOegPackV4 } from "../.test-dist/assets/OegPackV4.js";
import { parseOegPackSceneManifestV4 } from "../.test-dist/assets/geometry-product/OegPackSceneManifestV4.js";
import { readImageTextureDirectory, imageTextureHash } from "../.test-dist/assets/ImageTextureProduct.js";

function localPath(base, uri) {
  if (typeof uri !== "string" || /[?#\\]|^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    throw new Error("Offline product must reference an immutable local object");
  }
  const path = resolve(base, uri);
  const child = relative(base, path);
  if (isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\")) {
    throw new Error("Offline product reference escapes its owner directory");
  }
  return path;
}

const directory = resolve(process.argv[2] ?? ".local/models/bistro-cooked");
const geometryOnly = process.argv.includes("--geometry-only");
const materials = geometryOnly ? null : JSON.parse(await readFile(resolve(directory, "scene.materials.json")));
const sceneBytes = await readFile(localPath(directory, materials?.geometryManifest ?? "scene.oescene"));
const scene = parseOegPackSceneManifestV4(sceneBytes);
const packs = [];
for (const reference of scene.packs) {
  const file = await open(localPath(directory, reference.uri), "r");
  try {
    const pack = await openOegPackV4({
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
if (geometryOnly) {
  console.log(JSON.stringify({ geometry }, null, 2));
} else {
  assert.equal(materials.schema, "oengine-image-scene-materials-v2");
  assert.equal(materials.geometryManifestHash, await imageTextureHash(sceneBytes));
  assert.equal(materials.instanceMaterials.length, scene.instances.length);
  assert.equal(materials.bindings.length, materials.gltf.materials.length);
  const images = new Set(),
    identities = new Set(),
    receipts = [];
  const byUri = new Map();
  const targets = {}, codecs = {}, objects = new Map();
  let payloadBytes = 0,
    packageBytes = 0;
  for (const entry of materials.products) {
    const path = localPath(directory, entry.uri);
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.byteLength);
    assert.equal(await imageTextureHash(bytes), entry.identity);
    const product = readImageTextureDirectory(bytes);
    const receipt = JSON.parse(await readFile(localPath(directory, entry.receipt)));
    assert.equal(receipt.identity, entry.identity);
    assert.deepEqual(receipt.directory, product);
    const reportPath = localPath(directory, entry.searchReport);
    const reportBytes = await readFile(reportPath);
    assert.equal(await imageTextureHash(reportBytes), entry.searchReportHash);
    assert.equal(entry.searchReportHash, receipt.searchReportHash);
    const search = JSON.parse(reportBytes);
    assert.equal(search.identity, receipt.searchIdentity);
    assert.equal(search.report.selected.evaluation.inputHash, entry.identity);
    assert.equal(search.report.selected.accepted, true);
    assert.equal(search.report.selected.evaluation.hardSemantics, true);
    assert.equal(search.report.rows.length, product.planes.some((plane) => plane.mode === "virtual") ? 60 : 20);
    images.add(receipt.imageIndex);
    identities.add(entry.identity);
    receipts.push(receipt);
    byUri.set(entry.uri, product);
    packageBytes += bytes.length;
    for (const plane of product.planes) targets[plane.target] = (targets[plane.target] ?? 0) + 1;
    for (const item of product.items) {
      const object = localPath(dirname(path), item.uri);
      let payload = objects.get(object);
      if (!payload) {
        payload = await readFile(object);
        objects.set(object, payload);
      }
      assert.equal(BigInt(payload.length), BigInt(item.objectBytes));
      const start = item.offset === null ? 0 : Number(BigInt(item.offset));
      assert.equal(await imageTextureHash(payload.subarray(start, start + item.bytes)), item.sha256);
      payloadBytes += item.bytes;
      codecs[item.codec] = (codecs[item.codec] ?? 0) + 1;
    }
  }
  assert.equal(images.size, materials.source.cookedImages);
  let masks = 0;
  for (const [index, material] of materials.gltf.materials.entries()) {
    if (material.alphaMode !== "MASK") continue;
    masks++;
    const binding = materials.bindings[index].texture_albedo;
    // Constant alpha has no image dependency or exact-plane allocation.
    if (!binding) continue;
    const metadata = byUri.get(binding.uri);
    assert.ok(metadata, "MASK image binding is absent from its product catalog");
    assert.ok(metadata.planes.some((plane) => plane.semantic === "exact-r" && plane.target === "r8" && plane.mode === "resident"));
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
          targets,
          codecs,
          maskMaterials: masks,
          payloadBytes,
          directoryBytes: packageBytes,
          objectBytes: [...objects.values()].reduce((sum, bytes) => sum + bytes.length, 0),
          wallMsSum: receipts.reduce((sum, receipt) => sum + receipt.wallMs, 0)
        },
        runtimeContract:
          "Schema4 image/exact items; GPU encodes final BC; browser consumption is an E5 check"
      },
      null,
      2
    )
  );
}
