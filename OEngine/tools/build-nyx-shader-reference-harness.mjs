import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const engineDir = dirname(toolsDir);
const repoDir = dirname(engineDir);
const nyxRoot = resolve(process.env.NYX_SOURCE_DIR ?? "D:/Nyx-main");
const shaderRoot = join(nyxRoot, "MiniEngine", "Model", "Shaders");
const slangc = resolve(process.env.NYX_SLANGC ?? join(nyxRoot, "MiniEngine", "ThirdParty", "slang-2026.10", "bin", process.platform === "win32" ? "slangc.exe" : "slangc"));
const manifest = JSON.parse(await readFile(join(repoDir, "docs", "porting", "nyx-function-map.json"), "utf8"));

function run(args) {
  const result = spawnSync(slangc, args, { cwd: repoDir, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (result.status !== 0) throw new Error(`slangc ${args.join(" ")} failed (${result.status})\n${result.stderr || result.stdout}`);
  return result.stdout.trim() || result.stderr.trim();
}

async function verifySource(relativePath) {
  const record = manifest.sourceFiles.find(source => source.path === relativePath);
  if (!record) throw new Error(`Nyx shader is not pinned in the function map: ${relativePath}`);
  const bytes = await readFile(join(nyxRoot, ...relativePath.split("/")));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== record.sha256) throw new Error(`Nyx source hash mismatch for ${relativePath}: ${actual}`);
  return actual;
}

const dagRelative = "MiniEngine/Model/Shaders/DAGCull.slang";
const vbufferRelative = "MiniEngine/Model/Shaders/VBufferMesh.slang";
const [dagHash, vbufferHash] = await Promise.all([verifySource(dagRelative), verifySource(vbufferRelative)]);
const slangVersion = run(["-v"]);
const work = await mkdtemp(join(tmpdir(), "oengine-nyx-shader-reference-"));

try {
  const dagPasses = [];
  const vbufferPasses = [];
  for (const pass of [0, 1]) {
    const dagSpirv = join(work, `dag-${pass}.spv`);
    const dagReflection = join(work, `dag-${pass}.json`);
    run([
      join(shaderRoot, "DAGCull.slang"), "-I", shaderRoot,
      `-DDAG_CULL_PASS_INDEX=${pass}`,
      "-entry", "computeMain", "-stage", "compute",
      "-target", "spirv", "-profile", "sm_6_6",
      "-reflection-json", dagReflection, "-o", dagSpirv
    ]);
    const dag = JSON.parse(await readFile(dagReflection, "utf8"));
    const entry = dag.entryPoints?.find(item => item.name === "computeMain");
    if (!entry) throw new Error(`Nyx DAGCull pass ${pass} reflection omitted computeMain`);
    dagPasses.push({ pass, entry: entry.name, stage: entry.stage, threadGroupSize: entry.threadGroupSize, spirvBytes: (await stat(dagSpirv)).size });

    const vbufferSpirv = join(work, `vbuffer-${pass}.spv`);
    const vbufferReflection = join(work, `vbuffer-${pass}.json`);
    run([
      join(shaderRoot, "VBufferMesh.slang"), "-I", shaderRoot,
      `-DVBUFFER_MESH_PASS_INDEX=${pass}`,
      "-entry", "meshMain", "-stage", "mesh",
      "-entry", "pixelMain", "-stage", "fragment",
      "-target", "spirv", "-profile", "sm_6_6",
      "-reflection-json", vbufferReflection, "-o", vbufferSpirv
    ]);
    const vbuffer = JSON.parse(await readFile(vbufferReflection, "utf8"));
    const entries = (vbuffer.entryPoints ?? []).map(({ name, stage }) => ({ name, stage }));
    if (!entries.some(entry => entry.name === "meshMain") || !entries.some(entry => entry.name === "pixelMain")) {
      throw new Error(`Nyx VBuffer pass ${pass} reflection omitted a required entry point`);
    }
    vbufferPasses.push({ pass, entries, spirvBytes: (await stat(vbufferSpirv)).size });
  }
  process.stdout.write(`${JSON.stringify({ slangVersion, sourceHashes: { [dagRelative]: dagHash, [vbufferRelative]: vbufferHash }, dagPasses, vbufferPasses })}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
