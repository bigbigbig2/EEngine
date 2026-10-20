import { mkdir, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const web = join(root, "OEngine/tools/oengine-web-geometry-cooker");
const core = join(root, "OEngine/tools/oengine-asset-core");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sdk = process.env.EMSDK ?? join(root, ".local/toolchains/emsdk");
process.env.EMSDK_PYTHON ??= join(sdk, "python/3.13.3_64bit/python.exe");
process.env.EM_CONFIG ??= join(sdk, ".emscripten");
const inputs = {};
async function collect(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await collect(path);
    else if (/\.(cpp|h|json)$/.test(item.name)) {
      inputs[path.slice(root.length).replaceAll("\\", "/")] = hash(await readFile(path));
    }
  }
}
for (const path of [
  join(web, "src"),
  join(web, "include"),
  join(core, "include"),
  join(core, "src/geometry"),
  join(core, "src/product"),
  join(core, "vendor/meshoptimizer")
])
  await collect(path);
for (const path of [
  join(core, "src/Hash.cpp"),
  join(core, "src/OegPackCodec.cpp"),
  join(core, "src/GeometryCookRecipe.cpp"),
  join(web, "CMakeLists.txt"),
  join(core, "geometry-layout-v4.json"),
  fileURLToPath(import.meta.url)
]) {
  inputs[path.slice(root.length).replaceAll("\\", "/")] = hash(await readFile(path));
}
for (const [build, subdirectory, profile] of [
  ["build-wasm", "", "portable-single"],
  ["build-wasm-threads", "threads", "isolated-pthreads"]
]) {
  const result = spawnSync("cmake", ["--build", join(web, build), "-j4"], {
    stdio: "inherit",
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`${profile} build failed`);
  const cache = await readFile(join(web, build, "CMakeCache.txt"), "utf8");
  const toolchain = cache.match(/^CMAKE_TOOLCHAIN_FILE:[^=]+=(.+)$/m)?.[1].trim();
  if (!toolchain) throw new Error("Cannot identify the actual Emscripten toolchain");
  const compiler = spawnSync(join(toolchain, "../../../../em++.exe"), ["--version"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (compiler.status !== 0) throw new Error(compiler.error?.message ?? compiler.stderr);
  const out = join(root, "OEngine/src/assets/web-cook/wasm/vendor", subdirectory);
  await mkdir(out, { recursive: true });
  const hashes = {};
  for (const extension of ["mjs", "wasm"]) {
    const name = `oengine-web-geometry-cooker.${extension}`;
    await copyFile(join(web, build, name), join(out, name));
    hashes[name] = hash(await readFile(join(out, name)));
  }
  await writeFile(
    join(out, "source.json"),
    JSON.stringify(
      {
        abiVersion: 7,
        geometryMajor: 4,
        profile,
        compiler: compiler.stdout.trim(),
        inputs,
        cmakeCacheSha256: hash(await readFile(join(web, build, "CMakeCache.txt"))),
        hashes
      },
      null,
      2
    ) + "\n"
  );
  console.log(`${profile}: copied paired ABI7 JS/WASM with source/build hashes`);
}
