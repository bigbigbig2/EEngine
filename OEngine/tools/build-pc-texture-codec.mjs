import { spawnSync } from "node:child_process";
import { mkdir, copyFile, readFile, writeFile, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const basis = resolve(process.env.BASIS_SOURCE ?? join(root, ".local/texture-design-basis"));
const ktx = resolve(process.env.KTX_SOURCE ?? join(root, ".local/texture-codec-ktx-4.4.2"));
const emsdk = resolve(process.env.EMSDK ?? "D:/Devtool/emsdk");
const cmake =
  process.env.CMAKE ??
  "D:/Devtool/vcpkg-master/downloads/tools/cmake-3.25.1-windows/cmake-3.25.1-windows-i386/bin/cmake.exe";
const make = process.env.NINJA ?? join(root, ".local/texture-toolchain/ninja.exe");
const out = join(root, "OEngine/src/assets/codec/vendor/pc-texture");
const build = join(root, ".local/t4-1-codec-build");
const glue = join(root, "OEngine/tools/texture-codec");
const mode = process.argv[2] ?? "all";
const pins = {
  basis: "99f52d63aa6799cbdaecfe977111dc5ec3b31d47",
  ktx: "4d6fc70eaf62ad0558e63e8d97eb9766118327a6"
};
for (const [name, source] of [
  ["basis", basis],
  ["ktx", ktx]
]) {
  if (run("git", ["rev-parse", "HEAD"], source).trim() !== pins[name])
    throw new Error(`${name} revision mismatch`);
  if (run("git", ["diff", "HEAD", "--name-only"], source).trim())
    throw new Error(`${name} tracked source modified`);
}
await mkdir(out, { recursive: true });
await mkdir(build, { recursive: true });
const basisSources = [
  join(glue, "BcCodec.cpp"),
  ...[
    "basisu_bc7e_scalar.cpp",
    "basisu_bc15_spmd.cpp",
    "basisu_resampler.cpp",
    "basisu_resample_filters.cpp"
  ].map((n) => join(basis, "encoder", n)),
  join(basis, "transcoder/basisu_transcoder.cpp")
];
const shared = [
  "-std=c++17",
  "-O2",
  "-DNDEBUG",
  "-DBASISU_SUPPORT_SSE=0",
  "-DBASISD_SUPPORT_KTX2_ZSTD=0",
  "-fno-strict-aliasing",
  "-ffp-contract=off",
  "-ffunction-sections",
  "-fdata-sections",
  `-I${basis}/encoder`,
  `-I${basis}/transcoder`
];
if (mode === "all" || mode === "basis") {
  run(join(emsdk, "upstream/emscripten/em++.exe"), [
    ...shared,
    ...basisSources,
    "-o",
    join(out, "basis_bc.js"),
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sEXPORT_NAME=createBasisBcModule",
    "-sENVIRONMENT=web,worker,node",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sMAXIMUM_MEMORY=167772160",
    "-sABORTING_MALLOC=0",
    "-sINITIAL_MEMORY=16777216",
    "-sSTACK_SIZE=1048576",
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_bc_encode','_bc_decode','_bc_resample']",
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']"
  ]);
}
if (mode === "all" || mode === "basis" || mode === "reference") {
  // The upstream port expects float math overloads available globally on MSVC.
  // Match that lookup under MinGW as well as Emscripten's libc++ headers.
  const nativeFlags = [
    "--target=x86_64-w64-windows-gnu",
    "--sysroot=D:/Devtool/mingw64",
    "-isystem",
    "D:/Devtool/mingw64/lib/gcc/x86_64-w64-mingw32/8.1.0/include/c++",
    "-isystem",
    "D:/Devtool/mingw64/lib/gcc/x86_64-w64-mingw32/8.1.0/include/c++/x86_64-w64-mingw32",
    "-isystem",
    "D:/Devtool/mingw64/x86_64-w64-mingw32/include",
    "-LD:/Devtool/mingw64/lib/gcc/x86_64-w64-mingw32/8.1.0",
    "--ld-path=D:/Devtool/mingw64/bin/ld.exe",
    "-D__STDC_FORMAT_MACROS",
    "-include",
    "inttypes.h"
  ];
  run(process.env.CXX ?? join(emsdk, "upstream/bin/clang++.exe"), [
    ...nativeFlags,
    ...shared,
    "-include",
    join(glue, "BcMath.h"),
    ...basisSources,
    join(glue, "BcReference.cpp"),
    "-o",
    join(build, "bc-reference.exe")
  ]);
}
if (mode === "all" || mode === "ktx") {
  run(cmake, [
    "-S",
    glue,
    "-B",
    join(build, "ktx-ninja"),
    "-G",
    "Ninja",
    `-DCMAKE_MAKE_PROGRAM=${make}`,
    `-DCMAKE_TOOLCHAIN_FILE=${emsdk}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake`,
    `-DKTX_SOURCE=${ktx}`,
    "-DCMAKE_BUILD_TYPE=Release"
  ]);
  run(cmake, ["--build", join(build, "ktx-ninja"), "--target", "ktx_pc", "-j", "4"]);
  for (const extension of ["js", "wasm"])
    await copyFile(join(build, "ktx-ninja", `ktx_pc.${extension}`), join(out, `ktx_pc.${extension}`));
}
for (const [src, dest] of [
  [join(basis, "LICENSE"), "BASIS-LICENSE"],
  [join(basis, "NOTICE"), "BASIS-NOTICE"],
  [join(ktx, "LICENSE.md"), "KTX-LICENSE"]
])
  await copyFile(src, join(out, dest));
await cp(join(ktx, "LICENSES"), join(out, "KTX-LICENSES"), { recursive: true });
const hashes = {};
for (const name of ["basis_bc.js", "basis_bc.wasm", "ktx_pc.js", "ktx_pc.wasm"]) {
  try {
    hashes[name] = createHash("sha256")
      .update(await readFile(join(out, name)))
      .digest("hex");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
const glueHashes = {};
for (const name of ["BcCodec.cpp", "BcReference.cpp", "BcMath.h", "KtxRead.cpp", "CMakeLists.txt"]) {
  glueHashes[name] = createHash("sha256")
    .update(await readFile(join(glue, name)))
    .digest("hex");
}
await writeFile(
  join(out, "source.json"),
  JSON.stringify(
    {
      pins,
      emscripten: run(join(emsdk, "upstream/emscripten/emcc.exe"), ["--version"]).split("\n")[0],
      recipe: "OEngine/tools/build-pc-texture-codec.mjs",
      memoryMaximumPerModule: { basis: 167772160, ktx: 100663296 },
      memoryMaximumPerWorker: 268435456,
      quality: "bc7e_scalar slowest/quality6; perceptual sRGB, linear uniform; BC4 scalar high_quality",
      modifications:
        "Upstream unchanged. EEngine C ABI block extraction/resampling and read-only KTX embind metadata/load/error ownership. Native MinGW compiler shim selects the upstream port's expected float sqrt/floor overloads.",
      glueHashes,
      hashes
    },
    null,
    2
  ) + "\n"
);
function run(command, args, cwd = root) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  if (r.status !== 0) throw new Error(`${command}: ${r.error?.message ?? r.stderr}\n${r.stdout}`);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.stdout;
}
