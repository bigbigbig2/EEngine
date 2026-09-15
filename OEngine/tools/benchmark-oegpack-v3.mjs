import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const scenes = [];
let outputPath;
let diagnostic = false;
let includeV2 = true;
for (let i = 0; i < args.length; i++) {
  const option = args[i];
  if (option === "--scene") {
    const value = args[++i] ?? ""; const split = value.indexOf("=");
    if (split < 1) throw new Error("--scene must be role=path");
    scenes.push({ role: value.slice(0, split), path: resolve(value.slice(split + 1)) });
  } else if (option === "--out") outputPath = resolve(args[++i] ?? "");
  else if (option === "--diagnostic") diagnostic = true;
  else if (option === "--no-v2") includeV2 = false;
  else throw new Error(`unknown option: ${option}`);
}
if (!outputPath || scenes.length === 0) throw new Error("Usage: node tools/benchmark-oegpack-v3.mjs --scene bistro=<glb> --scene medium=<glb> --scene stress=<glb> --out <json> [--diagnostic] [--no-v2]");
const requiredRoles = ["bistro", "medium", "stress"];
const missingRoles = requiredRoles.filter(role => !scenes.some(scene => scene.role === role));
const repoRoot = resolve("..");
const cooker = resolve("tools/oengine-asset-core/build/oengine-asset-cooker.exe");
const provenance = {
  commit: git(["rev-parse", "HEAD"]),
  tree: git(["write-tree"]),
  dirty: git(["status", "--porcelain"]).length > 0,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpuCount: (await import("node:os")).cpus().length,
  nyxSourceDir: resolve(process.env.NYX_SOURCE_DIR ?? "D:/Nyx-main")
};
if (!diagnostic && (provenance.dirty || missingRoles.length)) throw new Error(`formal A9 requires a clean revision and bistro/medium/stress inputs; dirty=${provenance.dirty}, missing=${missingRoles.join(",")}`);

run(cooker, ["--help"], { acceptFailure: true });
const scratch = await mkdtemp(`${tmpdir()}\\oengine-oeg3-benchmark-`);
const profiles = [
  { id: "64-64", vertices: 64, triangles: 64 },
  { id: "64-128", vertices: 64, triangles: 128 },
  { id: "96-128", vertices: 96, triangles: 128 },
  { id: "128-128", vertices: 128, triangles: 128 }
];
const results = [];
for (const scene of scenes) {
  const source = await readFile(scene.path);
  const record = { role: scene.role, path: scene.path, sourceBytes: source.byteLength, sourceSha256: sha(source), v2: null, v3: [] };
  if (includeV2) {
    const v2Output = resolve(scratch, `${scene.role}-v2`);
    const started = performance.now();
    run(process.execPath, ["tools/cook-packed-gltf-geometries.mjs", scene.path, v2Output]);
    const manifest = JSON.parse(await readFile(resolve(v2Output, "manifest.json"), "utf8"));
    record.v2 = { geometryCount: manifest.geometryCount, packageBytes: manifest.packageBytes, wallMilliseconds: performance.now() - started, recipeKey: manifest.recipeKey };
  }
  for (const profile of profiles) {
    const destination = resolve(scratch, `${scene.role}-v3-${profile.id}`);
    const completed = run(cooker, [scene.path, "--out", destination, "--threads", String(Math.max(1, provenance.cpuCount)), "--meshlet-vertices", String(profile.vertices), "--meshlet-triangles", String(profile.triangles)]);
    const evidence = JSON.parse(completed.stdout.trim().split(/\r?\n/u).at(-1));
    record.v3.push({
      profile: profile.id,
      ...evidence,
      meshletMetadataBytes: (evidence.leafMeshlets + evidence.parentMeshlets) * 48,
      groupMetadataBytes: evidence.groups * 64,
      hierarchyBytesPerGroup: evidence.groups ? evidence.hierarchyBytes / evidence.groups : 0
    });
  }
  results.push(record);
}
const report = {
  schema: "oengine-oegpack-v3-a9-benchmark-v1",
  generatedAt: new Date().toISOString(),
  evidenceStatus: provenance.dirty || missingRoles.length ? "diagnostic-only" : "formal",
  abiFreezeEligible: !provenance.dirty && missingRoles.length === 0 && results.every(result => result.v2 && result.v3.length === profiles.length),
  blockers: [...(provenance.dirty ? ["dirty-revision"] : []), ...missingRoles.map(role => `missing-${role}-scene`), ...(!includeV2 ? ["v2-comparison-disabled"] : [])],
  provenance,
  nyxSourceAssumptions: {
    revision: "bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b",
    defaultMeshletProfile: "128/128",
    groupAlgorithm: "partitionClusters + attribute/seam locks + simplifyWithAttributes + refine DAG",
    hierarchy: "per-LOD BVH8 + top BVH",
    runtimePageModel: "fixed decoded pages, root pinning, independent LZ4 blocks"
  },
  profiles,
  results
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, evidenceStatus: report.evidenceStatus, abiFreezeEligible: report.abiFreezeEligible, blockers: report.blockers }));

function run(command, commandArgs, { acceptFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, { cwd: process.cwd(), encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (!acceptFailure && result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  return result;
}
function git(commandArgs) { const result = spawnSync("git", commandArgs, { cwd: repoRoot, encoding: "utf8", windowsHide: true }); return result.status === 0 ? result.stdout.trim() : "unavailable"; }
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
