import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { publishScenePackage, scenePackageFiles } from "../../tools/extreme-web-asset/scene-package.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("scene publisher copies only the complete immutable closure and keeps prior root on corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "scene-package-"));
  const source = join(root, "source"), target = join(root, "target");
  await mkdir(source);
  const geometry = Buffer.from(JSON.stringify({ schema: "oengine-scene-v4", packs: [] }));
  const geometryName = `scene-${hash(geometry)}.oescene`;
  await writeFile(join(source, geometryName), geometry);
  const manifest = { schema: "oengine-image-scene-materials-v2", geometryManifest: geometryName,
    geometryManifestHash: hash(geometry), products: [] };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(source, "scene.materials.json"), bytes);
  await writeFile(join(source, "obsolete.bin"), "not a dependency");
  const result = await publishScenePackage(source, target);
  assert.equal(result.files, 2);
  assert.deepEqual((await readdir(target)).sort(), [geometryName, "scene.materials.json"].sort());
  assert.deepEqual(await publishScenePackage(source, target), result);
  await writeFile(join(target, geometryName), "conflicting immutable object");
  await assert.rejects(publishScenePackage(source, target), /Immutable deployment object conflict/);
  assert.equal(await readFile(join(target, "scene.materials.json"), "utf8"), bytes);
  await writeFile(join(target, geometryName), geometry);
  await writeFile(join(source, geometryName), "corrupt");
  await assert.rejects(publishScenePackage(source, target), /hash mismatch/);
  assert.equal(await readFile(join(target, "scene.materials.json"), "utf8"), bytes);
  manifest.geometryManifest = "../escape.oescene";
  await writeFile(join(source, "scene.materials.json"), JSON.stringify(manifest));
  await assert.rejects(scenePackageFiles(source), /escapes/);
});

test("scene publisher checks payload ranges, receipt and search identities before replacing a scene", async () => {
  const source = await mkdtemp(join(tmpdir(), "scene-payload-"));
  const geometry = Buffer.from(JSON.stringify({ schema: "oengine-scene-v4", packs: [] }));
  await writeFile(join(source, "geometry.oescene"), geometry);
  const payload = Buffer.from([1, 2, 3, 4]);
  const directory = Buffer.from(JSON.stringify({ schemaVersion: 4, planes: [{ mode: "resident" }], items: [{
    uri: "data.bin", offset: "1", objectBytes: "4", bytes: 2, sha256: hash(payload.subarray(1, 3))
  }] }));
  const identity = hash(directory), searchIdentity = "a".repeat(64);
  const search = { identity: searchIdentity, report: { rows: new Array(20).fill({}), selected: {
    accepted: true, evaluation: { hardSemantics: true, inputHash: identity }
  } } };
  const report = Buffer.from(JSON.stringify(search));
  await writeFile(join(source, "data.bin"), payload);
  await writeFile(join(source, "directory.json"), directory);
  await writeFile(join(source, "report.json"), report);
  const receipt = { identity, searchIdentity, directory: JSON.parse(directory), searchReportHash: hash(report) };
  await writeFile(join(source, "directory.json.receipt.json"), JSON.stringify(receipt));
  await writeFile(join(source, "scene.materials.json"), JSON.stringify({
    schema: "oengine-image-scene-materials-v2", geometryManifest: "geometry.oescene", geometryManifestHash: hash(geometry),
    products: [{ uri: "directory.json", identity, byteLength: directory.length, receipt: "directory.json.receipt.json", searchReport: "report.json", searchReportHash: hash(report) }]
  }));
  assert.equal((await scenePackageFiles(source)).files.size, 6);
  await writeFile(join(source, "directory.json.receipt.json"), JSON.stringify({ ...receipt,
    directory: { ...receipt.directory, width: 1 } }));
  await assert.rejects(scenePackageFiles(source), /receipt identity/);
  await writeFile(join(source, "directory.json.receipt.json"), JSON.stringify(receipt));
  await writeFile(join(source, "data.bin"), Buffer.from([1, 9, 3, 4]));
  await assert.rejects(scenePackageFiles(source), /extent\/hash/);
});
