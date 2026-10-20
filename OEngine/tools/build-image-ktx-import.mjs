import { spawnSync } from "node:child_process";
import { mkdir, copyFile, readFile, writeFile, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ktx = resolve(process.env.KTX_SOURCE ?? join(root, ".local/texture-codec-ktx-4.4.2"));
const emsdk = resolve(process.env.EMSDK ?? join(root, ".local/toolchains/emsdk"));
const cmake = process.env.CMAKE ?? "D:/Devtool/vcpkg-master/downloads/tools/cmake-3.25.1-windows/cmake-3.25.1-windows-i386/bin/cmake.exe";
const ninja = process.env.NINJA ?? join(root, ".local/texture-toolchain/ninja.exe");
const out = join(root, "OEngine/src/assets/codec/vendor/image-ktx");
const build = join(root, ".local/image-ktx-build");
const glue = join(root, "OEngine/tools/texture-codec");
const revision = "4d6fc70eaf62ad0558e63e8d97eb9766118327a6";
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 ** 2 });
  if (result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
if (run("git", ["rev-parse", "HEAD"], ktx) !== revision || run("git", ["diff", "HEAD", "--name-only"], ktx)) {
  throw new Error("KTX cold import requires the clean pinned source");
}
process.env.EMSDK_PYTHON = resolve(process.env.EMSDK_PYTHON ?? join(emsdk, "python/3.13.3_64bit/python.exe"));
process.env.EM_CONFIG = resolve(process.env.EM_CONFIG ?? join(emsdk, ".emscripten"));
await mkdir(out, { recursive: true });
run(cmake, [
  "-S", glue, "-B", build, "-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`,
  `-DCMAKE_TOOLCHAIN_FILE=${emsdk}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake`,
  `-DKTX_SOURCE=${ktx}`, "-DCMAKE_BUILD_TYPE=Release"
]);
// Preserve the generated module/export names and the existing read-only ABI.
run(cmake, ["--build", build, "--target", "ktx_pc", "-j", "4"]);
for (const extension of ["js", "wasm"]) await copyFile(join(build, `ktx_pc.${extension}`), join(out, `ktx_pc.${extension}`));
await copyFile(join(ktx, "LICENSE.md"), join(out, "KTX-LICENSE"));
await cp(join(ktx, "LICENSES"), join(out, "KTX-LICENSES"), { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = {}, glueHashes = {};
for (const name of ["ktx_pc.js", "ktx_pc.wasm"]) hashes[name] = hash(await readFile(join(out, name)));
for (const name of ["KtxRead.cpp", "CMakeLists.txt"]) glueHashes[name] = hash(await readFile(join(glue, name)));
await writeFile(join(out, "source.json"), JSON.stringify({
  pins: { ktx: revision }, recipe: "OEngine/tools/build-image-ktx-import.mjs",
  emscripten: run(join(emsdk, "upstream/emscripten/emcc.exe"), ["--version"]).split("\n")[0],
  memoryMaximum: 100663296, profile: "Read-only cold KTX2 to canonical RGBA; no final texture encoder",
  glueHashes, hashes
}, null, 2) + "\n");
