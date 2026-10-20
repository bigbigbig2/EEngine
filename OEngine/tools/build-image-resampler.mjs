import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const basis = resolve(process.env.BASIS_SOURCE ?? join(root, ".local/texture-design-basis"));
const emsdk = resolve(process.env.EMSDK ?? join(root, ".local/toolchains/emsdk"));
const out = join(root, "OEngine/src/assets/codec/vendor/image-resample");
const revision = "99f52d63aa6799cbdaecfe977111dc5ec3b31d47";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command}: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
if (run("git", ["rev-parse", "HEAD"], basis) !== revision ||
    run("git", ["diff", "HEAD", "--name-only"], basis)) {
  throw new Error("Canonical resampler requires the clean pinned Basis source");
}
await mkdir(out, { recursive: true });
const glue = join(root, "OEngine/tools/texture-codec/CanonicalResample.cpp");
const sourceNames = ["basisu_resampler.cpp", "basisu_resample_filters.cpp"];
const compiler = join(emsdk, "upstream/emscripten/em++.exe");
// The Windows launcher needs the SDK Python, not the Windows Store alias.
process.env.EMSDK_PYTHON = resolve(process.env.EMSDK_PYTHON ?? join(emsdk, "python/3.13.3_64bit/python.exe"));
process.env.EM_CONFIG = resolve(process.env.EM_CONFIG ?? join(emsdk, ".emscripten"));
run(compiler, [
  "-std=c++17", "-O2", "-DNDEBUG", "-ffp-contract=off", `-I${basis}/encoder`,
  glue, ...sourceNames.map((name) => join(basis, "encoder", name)),
  "-o", join(out, "image_resample.js"),
  "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sEXPORT_NAME=createImageResampleModule",
  "-sENVIRONMENT=web,worker,node", "-sALLOW_MEMORY_GROWTH=1", "-sMAXIMUM_MEMORY=67108864",
  "-sABORTING_MALLOC=0", "-sINITIAL_MEMORY=16777216", "-sSTACK_SIZE=1048576",
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_image_resample']",
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']"
]);
for (const name of ["LICENSE", "NOTICE"]) await copyFile(join(basis, name), join(out, name));
const hashes = {};
for (const name of ["image_resample.js", "image_resample.wasm"]) {
  hashes[name] = hash(await readFile(join(out, name)));
}
await writeFile(join(out, "source.json"), JSON.stringify({
  pins: { basis: revision }, recipe: "OEngine/tools/build-image-resampler.mjs",
  emscripten: run(compiler, ["--version"]).split("\n")[0],
  memoryMaximum: 67108864, exports: ["malloc", "free", "image_resample"],
  profile: "Unchanged Basis tent resampler; EEngine canonical sRGB/normal C ABI; no BC codec",
  glueHash: hash(await readFile(glue)), hashes
}, null, 2) + "\n");
console.log(JSON.stringify({ out, hashes }));
