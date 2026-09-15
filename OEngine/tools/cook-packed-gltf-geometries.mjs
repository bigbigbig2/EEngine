import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GEOMETRY_COOKER_VERSION, openGeometryAssetPackage } from "../.test-dist/assets/GeometryAssetPackage.js";
import { createGeometryCookRecipe, geometryCookRecipeKey } from "../.test-dist/assets/GeometryCookRecipe.js";
import { cookGeometryAssetPackage } from "../.test-dist/geometry/GeometryCooker.js";
import { GltfLoader } from "../.test-dist/loaders/gltf/GltfLoader.js";
import { buildPackedGltfSource } from "../.test-dist/loaders/load_gltf.js";

const [inputArgument, outputArgument] = process.argv.slice(2);
if (inputArgument === undefined || outputArgument === undefined) {
  throw new Error(
    "Usage: node tools/cook-packed-gltf-geometries.mjs <input.glb> <output-directory>"
  );
}

const inputPath = path.resolve(inputArgument);
const outputDirectory = path.resolve(outputArgument);
await mkdir(outputDirectory, { recursive: true });

process.stdout.write(`Reading ${inputPath}\n`);
let fileBytes = await readFile(inputPath);
const sourceSha256 = createHash("sha256").update(fileBytes).digest("hex");
const sourceByteLength = fileBytes.byteLength;
const glb = fileBytes.buffer.slice(
  fileBytes.byteOffset,
  fileBytes.byteOffset + fileBytes.byteLength
);
fileBytes = undefined;

const loader = new GltfLoader();
loader.loadImageSlots = [];
const document = await loader.loadFromBinary(glb, pathToFileURL(inputPath).href);
installPlaceholderImages(document);
const packed = buildPackedGltfSource(document);
const recipe = createGeometryCookRecipe();
const recipeKey = geometryCookRecipeKey(recipe);
const recipeHash = createHash("sha256").update(recipeKey).digest("hex");
const entries = [];
let packageBytes = 0;

for (let index = 0; index < packed.geometries.length; index++) {
  const source = packed.geometries[index];
  const file = `geometry-${String(index).padStart(5, "0")}.oeg`;
  const outputPath = path.join(outputDirectory, file);
  process.stdout.write(
    `[${index + 1}/${packed.geometries.length}] ${source.sourceId} ` +
    `(${source.vertexCount} vertices, ${source.triangleCount} triangles)\n`
  );
  let bytes = await readReusablePackage(outputPath, source.sourceId, recipeHash);
  if (bytes === undefined) {
    const cooked = await cookGeometryAssetPackage(source, recipe);
    bytes = cooked.bytes;
    await writeFile(outputPath, new Uint8Array(bytes));
    process.stdout.write(`  cooked in ${cooked.timing.cookTimeMs.toFixed(1)} ms\n`);
  } else {
    process.stdout.write("  reused existing validated package\n");
  }
  packageBytes += bytes.byteLength;
  entries.push({ sourceId: source.sourceId, uri: file, byteLength: bytes.byteLength });
}

const manifest = {
  format: "oengine-geometry-set-v1",
  cookerVersion: GEOMETRY_COOKER_VERSION,
  recipeKey,
  source: {
    file: path.basename(inputPath),
    byteLength: sourceByteLength,
    sha256: sourceSha256
  },
  geometryCount: entries.length,
  packageBytes,
  geometries: entries
};
await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
process.stdout.write(
  `Wrote ${entries.length} validated Geometry packages (${packageBytes} bytes) to ${outputDirectory}\n`
);

async function readReusablePackage(file, sourceId, expectedRecipeHash) {
  try {
    const stored = await readFile(file);
    const bytes = stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength);
    const asset = await openGeometryAssetPackage(bytes);
    const actualRecipeHash = Buffer.from(asset.directory.recipeHash).toString("hex");
    if (
      asset.runtime.manifest.sourceProvenance.uri !== sourceId ||
      actualRecipeHash !== expectedRecipeHash
    ) {
      return undefined;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function installPlaceholderImages(document) {
  let maximumSource = -1;
  for (const texture of document.textures ?? []) {
    maximumSource = Math.max(
      maximumSource,
      texture.source ?? -1,
      texture.extensions?.EXT_texture_webp?.source ?? -1
    );
  }
  document.images = Array.from(
    { length: maximumSource + 1 },
    () => ({ width: 1, height: 1 })
  );
}
