import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { nativeBcCalls } from "../../tools/offline-bc-calls.mjs";
import { cookPcTextureRgba } from "../../.test-dist/assets/codec/PcTextureCook.js";
import { openTextureProduct } from "../../.test-dist/assets/TextureProduct.js";
import { parseOegPackSceneManifestV3 } from "../../.test-dist/assets/geometry-product/OegPackSceneManifestV3.js";
import createBasis from "../../src/assets/codec/vendor/pc-texture/basis_bc.js";

const root = resolve(import.meta.dirname, "../../..");
const directory = resolve(root, ".local/offline-scene-smoke");
const native = resolve(root, ".local/t4-1-codec-build/bc-reference.exe");
test("offline native full NPOT BC7/BC4/coverage matches production WASM", async () => {
  await mkdir(directory, { recursive: true });
  const bytes = await readFile(resolve(root, "OEngine/src/assets/codec/vendor/pc-texture/basis_bc.wasm"));
  const basis = await createBasis({ wasmBinary: bytes });
  const rgba = Uint8Array.from({ length: 13 * 9 * 4 }, (_, i) => (i * 37) % 256);
  for (const semantic of ["base-color-srgb", "normal-linear", "occlusion-linear"]) {
    const options = {
      semantic,
      exactAlpha: semantic === "base-color-srgb",
      sourceUri: "test://offline",
      channel: 0
    };
    const wasm = await cookPcTextureRgba(
      { basis, basisHash: "a".repeat(64), ktx: { HEAPU8: new Uint8Array(0) } },
      rgba,
      13,
      9,
      options
    );
    const cpu = await cookPcTextureRgba(
      {
        basis: nativeBcCalls(native, directory),
        basisHash: "b".repeat(64),
        ktx: { HEAPU8: new Uint8Array(0) }
      },
      rgba,
      13,
      9,
      options
    );
    assert.deepEqual(cpu.product.metadata.planes, wasm.product.metadata.planes);
    for (const [key, payload] of wasm.product.chunks) assert.deepEqual(cpu.product.chunks.get(key), payload);
  }
});

for (const format of ["png", "webp"]) {
  test(`offline ${format} scene preserves every primitive, instance transform, material and MASK coverage`, async () => {
    await mkdir(directory, { recursive: true });
    const source = await readFile(resolve(root, "validation/public/assets/oengine/glb-web-product-v1.glb"));
    const jsonLength = source.readUInt32LE(12);
    const document = JSON.parse(source.subarray(20, 20 + jsonLength).toString());
    const binStart = 28 + jsonLength;
    const bin = source.subarray(binStart);
    const require = createRequire(resolve(root, ".local/offline-cook-deps/package.json"));
    const { PNG } = require("pngjs");
    const rgba = Buffer.from(
      Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) => {
        const opaque = Math.floor(i / 4) % 2 === 0;
        // WebP may discard hidden RGB; use zero for transparent pixels.
        return i % 4 === 3 ? (opaque ? 255 : 0) : opaque ? (i * 7) % 256 : 0;
      })
    );
    const png =
      format === "png"
        ? PNG.sync.write({ width: 8, height: 8, data: rgba })
        : await require("sharp")(rgba, { raw: { width: 8, height: 8, channels: 4 } })
            .webp({ lossless: true })
            .toBuffer();
    const viewIndex = document.bufferViews.length;
    document.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: png.length });
    document.images = [{ bufferView: viewIndex, mimeType: `image/${format}` }];
    document.textures =
      format === "png" ? [{ source: 0 }] : [{ extensions: { EXT_texture_webp: { source: 0 } } }];
    if (format === "webp") {
      document.extensionsUsed = ["EXT_texture_webp"];
      document.extensionsRequired = ["EXT_texture_webp"];
    }
    document.materials = [
      { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } },
      {
        alphaMode: "MASK",
        alphaCutoff: 0.37,
        doubleSided: true,
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 }
      }
    ];
    const primitive = document.meshes[0].primitives[0];
    document.meshes = [
      {
        primitives: [
          { ...primitive, material: 0 },
          { ...primitive, material: 1 }
        ]
      }
    ];
    document.nodes = [{ mesh: 0, translation: [2, 3, 4] }];
    document.scenes = [{ nodes: [0] }];
    document.scene = 0;
    const payload = Buffer.concat([bin, png, Buffer.alloc((4 - (png.length % 4)) % 4)]);
    document.buffers = [{ byteLength: payload.length }];
    const jsonBytes = Buffer.from(JSON.stringify(document));
    const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 32)]);
    const header = Buffer.alloc(20),
      binHeader = Buffer.alloc(8);
    [0x46546c67, 2, 28 + jsonChunk.length + payload.length, jsonChunk.length, 0x4e4f534a].forEach((n, i) =>
      header.writeUInt32LE(n, i * 4)
    );
    binHeader.writeUInt32LE(payload.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    const input = resolve(directory, `source-${format}.glb`),
      output = resolve(directory, format === "png" ? "cooked" : "cooked-webp");
    await writeFile(input, Buffer.concat([header, jsonChunk, binHeader, payload]));
    const run = spawnSync(
      process.execPath,
      [resolve(root, "OEngine/tools/cook-offline-scene.mjs"), input, output, "1"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(run.status, 0, run.stderr);
    const scene = parseOegPackSceneManifestV3(await readFile(resolve(output, "scene.oescene")));
    const materials = JSON.parse(await readFile(resolve(output, "scene.materials.json")));
    assert.equal(scene.instances.length, 2);
    assert.deepEqual(materials.instanceMaterials, [0, 1]);
    for (const instance of scene.instances) assert.deepEqual(Array.from(instance.transform.slice(12, 15)), [2, 3, 4]);
    assert.equal(materials.gltf.materials[1].alphaCutoff, 0.37);
    assert.equal(materials.evidence.products, 2);
    assert.equal(materials.evidence.r8, 1);
    for (const entry of materials.products) {
      const bytes = await readFile(resolve(output, entry.uri));
      const product = await openTextureProduct(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      );
      assert.equal(product.identity, entry.identity);
      assert.equal(product.metadata.recipe.quality, "bc7e-scalar-6-bc4-hq");
      // Independent pixels verify full mip payloads, including exact MASK coverage.
      const expected = await cookPcTextureRgba(
        {
          basis: nativeBcCalls(native, directory),
          basisHash: "b".repeat(64),
          ktx: { HEAPU8: new Uint8Array(0) }
        },
        rgba,
        8,
        8,
        {
          semantic: "base-color-srgb",
          exactAlpha: product.metadata.exactAlpha,
          channel: 0,
          sourceUri: "test://offline-image"
        }
      );
      for (const [key, payload] of expected.product.chunks)
        assert.deepEqual(product.chunks.get(key), payload);
    }
  });
}
