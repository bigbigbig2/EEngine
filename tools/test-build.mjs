import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "./project-navigation.mjs";

const manifestName = ".build-identity.json";
async function hashFiles(root, files) {
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const path = relative(root, file).replaceAll("\\", "/");
    const bytes = await readFile(file);
    hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(file)));
    else if (entry.name !== manifestName) files.push(file);
  }
  return files;
}
export async function sourceIdentity(root = REPO_ROOT) {
  const engine = resolve(root, "OEngine");
  const files = await walk(resolve(engine, "src"));
  for (const name of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.test.json",
    "node_modules/typescript/package.json"
  ]) {
    const file = resolve(engine, name);
    if (existsSync(file)) files.push(file);
  }
  files.push(resolve(root, "tools/test-build.mjs"));
  return hashFiles(root, files);
}
export async function verifyTestBuild(root = REPO_ROOT) {
  const output = resolve(root, "OEngine/.test-dist");
  const path = resolve(output, manifestName);
  if (!existsSync(path)) throw new Error("test build identity missing; run npm run build:test in OEngine");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.sourceSha256 !== (await sourceIdentity(root))) {
    throw new Error("test build is stale: production input changed; run npm run build:test");
  }
  if (manifest.outputSha256 !== (await hashFiles(root, await walk(output)))) {
    throw new Error("test build output changed; run npm run build:test");
  }
  return manifest;
}
export async function buildTests(root = REPO_ROOT) {
  const before = await sourceIdentity(root);
  const engine = resolve(root, "OEngine");
  const output = resolve(engine, ".test-dist");
  if (relative(engine, output) !== ".test-dist") throw new Error("invalid test output directory");
  // tsc does not remove output for deleted sources. Keep one fresh build tree.
  await rm(output, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [resolve(engine, "node_modules/typescript/lib/tsc.js"), "-p", "tsconfig.test.json"],
    {
      cwd: engine,
      stdio: "inherit",
      windowsHide: true
    }
  );
  if (result.status !== 0)
    throw new Error(`test compilation failed: ${result.error?.message ?? result.status}`);
  if (before !== (await sourceIdentity(root)))
    throw new Error("source changed during test compilation; rebuild");
  const manifest = {
    schemaVersion: 1,
    recipe: "tsc -p tsconfig.test.json",
    node: process.version,
    dependencyScope: "conservative: engine src, configs, lock and compiler identity",
    sourceSha256: before,
    outputSha256: await hashFiles(root, await walk(output)),
    completedAt: new Date().toISOString()
  };
  await writeFile(resolve(output, manifestName), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTests().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
