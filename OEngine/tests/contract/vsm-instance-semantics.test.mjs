import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  instanceShadowFlagsFromExtras,
  INSTANCE_SHADOW_SEMANTICS
} from "../../.test-dist/core/InstanceShadowSemantics.js";
import { parseOegPackSceneManifestV3 } from "../../.test-dist/assets/geometry-product/OegPackSceneManifestV3.js";
import {
  geometryCookRecipeV3Key,
  createGeometryCookRecipeV3
} from "../../.test-dist/assets/GeometryCookRecipe.js";
import { createHash } from "node:crypto";

test("fresh Native cook agrees with source semantics and refuses legacy manifests", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const directory = resolve(root, ".local/validation/vsm-v4-r1/instance-cook");
  await mkdir(directory, { recursive: true });
  const source = await readFile(resolve(root, "validation/public/assets/oengine/glb-web-product-v1.glb"));
  const length = source.readUInt32LE(12);
  const document = JSON.parse(source.subarray(20, 20 + length).toString());
  const bin = source.subarray(28 + length);
  const variants = [
    undefined,
    { castShadow: false },
    { receiveShadow: false },
    { castShadow: false, receiveShadow: false },
    { nested: { castShadow: false }, text: "receiveShadow:false" }
  ];
  document.nodes = variants.map((extras) => ({ mesh: 0, extras }));
  document.scenes = [{ nodes: variants.map((_, index) => index) }];
  document.scene = 0;
  const save = async () => {
    const json = Buffer.from(JSON.stringify(document));
    const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 32)]);
    const header = Buffer.alloc(20),
      binHeader = Buffer.alloc(8);
    [0x46546c67, 2, 28 + padded.length + bin.length, padded.length, 0x4e4f534a].forEach((value, index) =>
      header.writeUInt32LE(value, index * 4)
    );
    binHeader.writeUInt32LE(bin.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    await writeFile(resolve(directory, "source.glb"), Buffer.concat([header, padded, binHeader, bin]));
  };
  await save();
  const run = () =>
    spawnSync(
      resolve(root, "OEngine/tools/oengine-asset-core/build/oengine-asset-cooker.exe"),
      [resolve(directory, "source.glb"), "--out", resolve(directory, "cooked"), "--threads", "1"],
      { encoding: "utf8", windowsHide: true }
    );
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(resolve(directory, "cooked/scene.oescene")));
  assert.equal(manifest.instanceSemantics, INSTANCE_SHADOW_SEMANTICS);
  assert.deepEqual(
    manifest.instances.map((instance) => instance.flags),
    variants.map(instanceShadowFlagsFromExtras)
  );
  const recipeHash = createHash("sha256")
    .update(geometryCookRecipeV3Key(createGeometryCookRecipeV3()))
    .digest("hex");
  const pack = await readFile(resolve(directory, "cooked", manifest.packs[0].uri));
  assert.equal(pack.subarray(144, 176).toString("hex"), recipeHash);
  parseOegPackSceneManifestV3(JSON.stringify(manifest));
  const legacy = { ...manifest };
  delete legacy.instanceSemantics;
  assert.throws(() => parseOegPackSceneManifestV3(JSON.stringify(legacy)), /re-cook/);
  document.nodes[0].extras = { castShadow: 0 };
  await save();
  const invalid = run();
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /boolean/);
});
