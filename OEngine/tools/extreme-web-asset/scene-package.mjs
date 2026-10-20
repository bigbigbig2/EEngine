import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function packagePath(root, uri) {
  if (typeof uri !== "string" || /[?#\\]|^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    throw new Error("Scene package requires relative immutable objects");
  }
  const path = resolve(root, uri), child = relative(root, path);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\")) {
    throw new Error("Scene package reference escapes its root");
  }
  return path;
}

/** Enumerate only the published closure, never scratch, candidate caches,
 * superseded payloads or source GLBs. Read/hash everything before publication. */
export async function scenePackageFiles(directory) {
  const root = resolve(directory), files = new Map();
  const add = async (uri, expected) => {
    const path = packagePath(root, uri);
    const key = relative(root, path).replaceAll("\\", "/");
    const bytes = await readFile(path);
    if (expected && hash(bytes) !== expected) throw new Error(`Scene package hash mismatch: ${uri}`);
    const record = { path, bytes: bytes.length, sha256: hash(bytes) };
    const prior = files.get(key);
    if (prior && prior.sha256 !== record.sha256) throw new Error("Scene package changed during enumeration");
    files.set(key, record);
    return bytes;
  };
  const manifest = JSON.parse(await add("scene.materials.json"));
  if (manifest.schema !== "oengine-image-scene-materials-v2") throw new Error("Scene package requires the current material schema");
  const scene = JSON.parse(await add(manifest.geometryManifest, manifest.geometryManifestHash));
  if (scene.schema !== "oengine-scene-v4") throw new Error("Scene package requires geometry V4");
  for (const pack of scene.packs) {
    const path = packagePath(root, pack.uri), digest = createHash("sha256");
    let size = 0;
    for await (const bytes of createReadStream(path)) { size += bytes.length; digest.update(bytes); }
    files.set(relative(root, path).replaceAll("\\", "/"), { path, bytes: size, sha256: digest.digest("hex") });
  }
  for (const product of manifest.products) {
    const bytes = await add(product.uri, product.identity);
    if (bytes.length !== product.byteLength) throw new Error("Scene product directory extent mismatch");
    const directory = JSON.parse(bytes);
    if (directory.schemaVersion !== 4) throw new Error("Scene package requires image schema4");
    const report = JSON.parse(await add(product.searchReport, product.searchReportHash));
    const receipt = JSON.parse(await add(product.receipt));
    if (receipt.identity !== product.identity || receipt.searchReportHash !== product.searchReportHash ||
        receipt.searchIdentity !== report.identity || !isDeepStrictEqual(receipt.directory, directory)) {
      throw new Error("Scene product receipt identity mismatch");
    }
    const candidates = directory.planes.some((plane) => plane.mode === "virtual") ? 60 : 20;
    if (report.report?.rows?.length !== candidates || report.report.selected?.accepted !== true ||
        report.report.selected?.evaluation?.hardSemantics !== true ||
        report.report.selected?.evaluation?.inputHash !== product.identity) {
      throw new Error("Scene product lacks the complete qualified image search");
    }
    for (const item of directory.items) {
      const uri = relative(root, resolve(dirname(packagePath(root, product.uri)), item.uri)).replaceAll("\\", "/");
      const payload = await add(uri);
      const offset = item.offset === null ? 0 : Number(BigInt(item.offset));
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
          offset + item.bytes > payload.length || BigInt(payload.length) !== BigInt(item.objectBytes) ||
          hash(payload.subarray(offset, offset + item.bytes)) !== item.sha256) {
        throw new Error(`Scene payload extent/hash mismatch: ${uri}`);
      }
    }
  }
  return { manifest, files };
}

/** Publish immutable dependencies first, then replace the only mutable root.
 * An interrupted copy leaves the previous manifest and complete closure intact. */
export async function publishScenePackage(source, destination) {
  const { manifest, files } = await scenePackageFiles(source);
  const target = resolve(destination);
  for (const [uri, record] of files) {
    if (uri === "scene.materials.json") continue;
    const path = packagePath(target, uri);
    await mkdir(dirname(path), { recursive: true });
    try {
      const digest = createHash("sha256");
      for await (const bytes of createReadStream(path)) digest.update(bytes);
      if (digest.digest("hex") !== record.sha256) {
        throw new Error(`Immutable deployment object conflict: ${uri}`);
      }
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const pending = `${path}.${randomUUID()}.partial`;
    const digest = createHash("sha256");
    let size = 0;
    await pipeline(createReadStream(record.path), new Transform({
      transform(bytes, _encoding, callback) {
        size += bytes.length;
        digest.update(bytes);
        callback(null, bytes);
      }
    }), createWriteStream(pending, { flags: "wx" }));
    if (size !== record.bytes || digest.digest("hex") !== record.sha256) {
      throw new Error(`Scene package changed during copy: ${uri}`);
    }
    await rename(pending, path);
  }
  await mkdir(target, { recursive: true });
  const pending = resolve(target, `scene.materials.json.${randomUUID()}.partial`);
  const root = files.get("scene.materials.json");
  const bytes = await readFile(root.path);
  if (hash(bytes) !== root.sha256) throw new Error("Scene manifest changed during publication");
  await writeFile(pending, bytes, { flag: "wx" });
  await rename(pending, resolve(target, "scene.materials.json"));
  return { products: manifest.products.length, files: files.size, bytes: [...files.values()].reduce((sum, record) => sum + record.bytes, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , source, destination] = process.argv;
  if (!source || !destination) throw new Error("Usage: scene-package.mjs <completed-cook> <deployment-directory>");
  console.log(JSON.stringify(await publishScenePackage(source, destination), null, 2));
}
