import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The public entry imports GPU ABI modules, so provide the constants needed by
// Node for this source/compiled topology audit.
globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, COPY_SRC: 4, STORAGE: 128, UNIFORM: 64 });
globalThis.GPUTextureUsage ??= Object.freeze({ COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 });
globalThis.GPUShaderStage ??= Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });

const root = fileURLToPath(new URL("..", import.meta.url));

test("public entry is Product-first and has no V2 production symbols", async () => {
  const entry = await import("../.test-dist/index.js");
  for (const symbol of [
    "load_gltf_packed",
    "cookGeometryAssetPackage",
    "openGeometryAssetPackage",
    "createPackedSceneSourceFromScene",
    "createInstanceSourceFromScene",
    "AssetHandle",
    "PackedSceneSource",
    "SceneGeometryAssetBinding"
  ]) {
    assert.equal(symbol in entry, false, `${symbol} must not be a public production export`);
  }
  for (const symbol of ["load_gltf", "load_gltf_web_product", "cookSceneGeometryProductV1", "createDefaultWebGeometryCookerModule"]) {
    assert.equal(symbol in entry, true, `${symbol} must remain a Product entry`);
  }
});

test("source and compiled consumer topology has no legacy V2 call sites", async () => {
  const roots = [
    resolve(root, "../examples/demos"),
    resolve(root, "../validation/src")
  ];
  const files = [];
  async function visit(directory) {
    for (const name of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      if (name.isDirectory()) await visit(path);
      else if (/\.(?:ts|tsx|mjs|js)$/.test(name.name)) files.push(path);
    }
  }
  for (const directory of roots) await visit(directory);
  const source = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
  for (const pattern of [/uploadScene\s*\(/u, /uploadPackedScene\s*\(/u, /cookGeometryAssetPackage/u, /load_gltf_packed/u, /GeometryPackagePipeline/u]) {
    assert.equal(pattern.test(source), false, `legacy consumer pattern remains: ${pattern}`);
  }
});
