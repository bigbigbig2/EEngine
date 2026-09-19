import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = dirname(toolsDir);
const nyxRoot = resolve(process.env.NYX_SOURCE_DIR ?? "D:/Nyx-main");
const sourcePath = join(nyxRoot, "MiniEngine", "Model", "ModelConvert.cpp");
const driverPath = join(toolsDir, "nyx-reference", "nyx_model_convert_reference_main.cpp");
const compiler = process.env.CXX ?? (process.platform === "win32" ? "D:/Devtool/mingw64/bin/g++.exe" : "g++");
const expectedHash = "8bdf016e0f36e70f0c1aa46d679ab0e1b4f57ea30e0748a6549675620cc8a059";

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Nyx source function not found: ${signature}`);
  const brace = source.indexOf("{", start);
  if (brace < 0) throw new Error(`Nyx source function has no body: ${signature}`);
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Nyx source function body is unbalanced: ${signature}`);
}

function run(command, args, cwd, capture = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; }); child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${command} exited ${code}\n${stderr}`)));
  });
}

const sourceBytes = await readFile(sourcePath);
const actualHash = createHash("sha256").update(sourceBytes).digest("hex");
if (actualHash !== expectedHash) throw new Error(`Nyx ModelConvert.cpp hash mismatch: ${actualHash}`);
const sourceText = sourceBytes.toString("utf8");
const functionTexts = {
  MODEL_CONVERT_PARALLEL_COMPILE_MESHES: extractFunction(sourceText, "static void ParallelCompileMeshes(")
    .replaceAll("wchar_t tempPath[MAX_PATH];", "wchar_t tempPath[8] = L\"/tmp/\";")
    .replaceAll("GetTempPathW(MAX_PATH, tempPath);", "(void)tempPath;")
    .replaceAll("wchar_t tempFileName[MAX_PATH];", "wchar_t tempFileName[256];")
    .replaceAll("swprintf_s(tempFileName, L\"%sNYX_TASK_%d.tmp\", tempPath, taskIndex);", "std::swprintf(tempFileName, 256, L\"/tmp/NYX_TASK_%d.tmp\", taskIndex);")
    .replaceAll("std::ofstream localTempFile(result.tempFilePath,", "std::ofstream localTempFile(std::string(result.tempFilePath.begin(), result.tempFilePath.end()),")
    .replaceAll("buildArgs.IBData = draw->IB->data();", "buildArgs.IBData = reinterpret_cast<unsigned char*>(draw->IB->data());"),
  MODEL_CONVERT_WALK_GRAPH: extractFunction(sourceText, "static uint32_t WalkGraph("),
  MODEL_CONVERT_BUILD_MODEL: extractFunction(sourceText, "bool Renderer::BuildModel(")
};
const template = await readFile(driverPath, "utf8");
const generated = Object.entries(functionTexts).reduce((text, [marker, functionText]) => text.replace(marker, functionText), template);
const work = await mkdtemp(join(tmpdir(), "oengine-nyx-model-convert-reference-"));
try {
  const source = join(work, "nyx_model_convert_reference.cpp");
  const executable = join(work, process.platform === "win32" ? "nyx-model-convert-reference.exe" : "nyx-model-convert-reference");
  await writeFile(source, generated);
  const standard = process.platform === "win32" && compiler.toLowerCase().includes("mingw") ? "c++2a" : "c++20";
  await run(compiler, [`-std=${standard}`, "-O2", "-fno-fast-math", "-ffp-contract=off", source, "-o", executable], repoDir);
  const result = await run(executable, [], repoDir, true);
  process.stdout.write(result.stdout);
} finally {
  await rm(work, { recursive: true, force: true });
}
