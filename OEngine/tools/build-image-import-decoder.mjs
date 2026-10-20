import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const basis = resolve(process.env.BASIS_SOURCE ?? join(root, ".local/texture-design-basis"));
const emsdk = resolve(process.env.EMSDK ?? join(root, ".local/toolchains/emsdk"));
const out = join(root, "OEngine/src/assets/codec/vendor/image-import");
const revision = "99f52d63aa6799cbdaecfe977111dc5ec3b31d47";
process.env.EMSDK_PYTHON ??= join(emsdk, "python/3.13.3_64bit/python.exe");
process.env.EM_CONFIG ??= join(emsdk, ".emscripten");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command}: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
if (run("git", ["rev-parse", "HEAD"], basis) !== revision ||
    run("git", ["diff", "HEAD", "--name-only"], basis)) throw new Error("Cold decoder source identity mismatch");
await mkdir(out, { recursive: true });
const glue = join(root, "OEngine/tools/texture-codec/ImageImportDecode.cpp");
run(join(emsdk, "upstream/emscripten/em++.exe"), [
  "-std=c++17", "-O2", "-DNDEBUG", "-DBASISU_SUPPORT_SSE=0", "-DBASISD_SUPPORT_KTX2_ZSTD=0",
  `-I${basis}/transcoder`, glue, join(basis, "transcoder/basisu_transcoder.cpp"),
  "-o", join(out, "image_decode.js"), "-sMODULARIZE=1", "-sEXPORT_ES6=1",
  "-sEXPORT_NAME=createImageDecodeModule", "-sENVIRONMENT=web,worker,node",
  "-sALLOW_MEMORY_GROWTH=1", "-sMAXIMUM_MEMORY=67108864", "-sABORTING_MALLOC=0",
  "-sINITIAL_MEMORY=16777216", "-sSTACK_SIZE=1048576",
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_image_decode']",
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']"
]);
const hashes = {};
for (const name of ["image_decode.js", "image_decode.wasm"]) {
  hashes[name] = createHash("sha256").update(await readFile(join(out, name))).digest("hex");
}
await writeFile(join(out, "source.json"), JSON.stringify({
  revision, recipe: "OEngine/tools/build-image-import-decoder.mjs", hashes,
  exports: ["malloc", "free", "image_decode"], memoryMaximum: 67108864,
  scope: "Cold KTX BC4/BC7 to canonical RGBA only; no CPU encoder or final BC transport",
  license: "Apache-2.0; ../image-resample/LICENSE and NOTICE"
}, null, 2) + "\n");
console.log(JSON.stringify({ out, hashes }));
