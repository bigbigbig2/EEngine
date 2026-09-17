import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const engineDir = dirname(toolsDir);
const webDir = join(toolsDir, "oengine-web-geometry-cooker");
const coreDir = join(toolsDir, "oengine-asset-core");
const nyxRoot = resolve(process.env.NYX_SOURCE_DIR ?? "D:/Nyx-main");
const defaultCompiler = "D:/Devtool/mingw64/bin/g++.exe";
const clangCompiler = "C:/Program Files/LLVM/bin/clang++.exe";
const compiler = process.env.CXX ?? (existsSync(defaultCompiler) ? defaultCompiler : existsSync(clangCompiler) ? clangCompiler : "g++");
const output = join(webDir, "build", "oengine-web-geometry-cooker-oracle.exe");

const requiredHashes = new Map([
  ["MiniEngine/Model/MeshletBuilder.cpp", "b749346382b0f9a1574f0c0566a2860bff2acfbc6521df6f153a42653c81e84a"],
  ["MiniEngine/Model/ModelConvert.cpp", "8bdf016e0f36e70f0c1aa46d679ab0e1b4f57ea30e0748a6549675620cc8a059"],
  ["MiniEngine/Model/MeshletStructs.h", "1edfaa25d2e12067b98d93599142b110e2509be96471fa09a00b029484ef9b23"],
  ["MiniEngine/Model/GeometryStreaming.cpp", "acb3aa4786eb6367e92b99e9e295c83e0aade516d59578f23ff38496f838a072"],
  ["MiniEngine/Model/GeometryStreaming.h", "4bee73ffc0c29ad7670bb7c5ac1567a281b3f33271adfc534d834dc88897c264"],
  ["MiniEngine/Model/Shaders/DAGCull.slang", "6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e"],
  ["MiniEngine/Model/Shaders/VBufferMesh.slang", "9f374a2437d5ab939ae4d98289c150097bdab17305191ff97abf3fd1d13c621d"],
  ["MiniEngine/ThirdParty/meshoptimizer/meshoptimizer.h", "a05dfed026d1dbeea6b38751ff22397e48a6706a4138e92a160ad57e33f7c0fd"]
]);

for (const [relative, expected] of requiredHashes) {
  const actual = createHash("sha256").update(await readFile(join(nyxRoot, relative))).digest("hex");
  if (actual !== expected) throw new Error(`Nyx source identity mismatch for ${relative}: ${actual}`);
}

await mkdir(dirname(output), { recursive: true });
const meshoptimizerDir = join(nyxRoot, "MiniEngine", "ThirdParty", "meshoptimizer");
const meshoptimizerSources = (await readdir(meshoptimizerDir))
  .filter(name => name.endsWith(".cpp"))
  .sort()
  .map(name => join(meshoptimizerDir, name));
const sources = [
  join(coreDir, "src", "Hash.cpp"),
  join(coreDir, "src", "GeometryCookRecipe.cpp"),
  join(coreDir, "src", "OegPackCodec.cpp"),
  join(coreDir, "src", "geometry", "CanonicalGeometry.cpp"),
  join(coreDir, "src", "geometry", "GeometryCooker.cpp"),
  join(coreDir, "src", "product", "DecodedGeometryProduct.cpp"),
  join(webDir, "src", "WebGeometryCookerAbi.cpp"),
  join(webDir, "tests", "WebGeometryCookerAbiTest.cpp"),
  ...meshoptimizerSources
];
const args = [
  "-std=c++2a", "-O2", "-Wall", "-Wextra", "-Werror=return-type", "-fno-fast-math", "-ffp-contract=off", "-fexceptions", "-DNOMINMAX",
  `-I${join(coreDir, "include")}`,
  `-I${join(webDir, "include")}`,
  `-I${meshoptimizerDir}`,
  ...sources,
  "-o", output
];

await run(compiler, args, engineDir);
await run(output, [], engineDir);

async function run(command, args, cwd) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
  });
}
