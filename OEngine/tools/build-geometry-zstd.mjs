import { readFile, writeFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vendor = join(root, "OEngine/tools/oengine-asset-core/vendor/zstd");
export async function geometryZstdSources(encode = true) {
  const manifest = JSON.parse(await readFile(join(vendor, "source.json")));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (hash(await readFile(join(vendor, name))) !== expected)
      throw new Error("Zstd source changed: " + name);
  }
  const files = [];
  for (const directory of encode ? ["common", "compress", "decompress"] : ["common", "decompress"]) {
    for (const name of (await readdir(join(vendor, "lib", directory))).sort()) {
      if (name.endsWith(".c")) files.push(join(vendor, "lib", directory, name));
    }
  }
  return { files, include: join(vendor, "lib"), revision: manifest.revision };
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const source = await geometryZstdSources(false);
  const sdk = resolve(process.env.EMSDK ?? join(root, ".local/toolchains/emsdk"));
  process.env.EMSDK_PYTHON ??= join(sdk, "python/3.13.3_64bit/python.exe");
  process.env.EM_CONFIG ??= join(sdk, ".emscripten");
  const compiler = join(sdk, "upstream/emscripten/emcc.exe");
  const out = join(root, "OEngine/src/assets/codec/vendor/geometry-zstd");
  const glue = join(root, "OEngine/tools/oengine-asset-core/src/GeometryZstdDecoder.c");
  await mkdir(out, { recursive: true });
  const args = [
    "-O3",
    "-DNDEBUG",
    "-DZSTD_LEGACY_SUPPORT=0",
    "-DZSTD_DISABLE_ASM=1",
    `-I${source.include}`,
    glue,
    ...source.files,
    "-o",
    join(out, "geometry_zstd.js"),
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sENVIRONMENT=web,worker,node",
    "-sALLOW_MEMORY_GROWTH=0",
    "-sINITIAL_MEMORY=4194304",
    "-sSTACK_SIZE=1048576",
    "-sABORTING_MALLOC=0",
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_geometry_zstd_decode']",
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']"
  ];
  const result = spawnSync(compiler, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stdout + result.stderr);
  await copyFile(join(vendor, "LICENSE"), join(out, "LICENSE"));
  const hashes = {};
  for (const name of ["geometry_zstd.js", "geometry_zstd.wasm"])
    hashes[name] = hash(await readFile(join(out, name)));
  await writeFile(
    join(out, "source.json"),
    JSON.stringify(
      {
        revision: source.revision,
        license: "BSD-3-Clause",
        recipe: "OEngine/tools/build-geometry-zstd.mjs",
        buildScriptHash: hash(await readFile(fileURLToPath(import.meta.url))),
        compiler: spawnSync(compiler, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim(),
        args,
        glueHash: hash(await readFile(glue)),
        memoryBytes: 4194304,
        profile: "one checksummed frame, no dictionary, exactly 256KiB, window <=256KiB",
        hashes
      },
      null,
      2
    ) + "\n"
  );
  console.log(JSON.stringify({ out, hashes }));
}
