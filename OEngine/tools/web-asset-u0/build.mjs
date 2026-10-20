import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const glue = fileURLToPath(new URL("./", import.meta.url));
const source = resolve(process.env.U0_BASIS_SOURCE ?? join(root, ".local/web-asset-u0-basis-source"));
const out = join(root, ".local/web-asset-u0");
const revision = "1706f948a2f0992d7a6dc2a909f35690b508571c";
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command}: ${result.error ?? result.stdout + result.stderr}`);
  return result.stdout;
}
if (run("git", ["rev-parse", "HEAD"], source).trim() !== revision) throw new Error("Basis revision mismatch");
if (run("git", ["diff", "HEAD", "--name-only"], source).trim()) throw new Error("Modified Basis source");
await mkdir(out, { recursive: true });
const mode = process.argv[2] ?? "all";
if (mode === "all" || mode === "native") {
  run("cmake", ["-S", glue, "-B", join(out, "native"), `-DBASIS_SOURCE=${source}`, "-DCMAKE_BUILD_TYPE=Release"]);
  console.log(run("cmake", ["--build", join(out, "native"), "--config", "Release", "--target", "xubc7-probe", "-j", "4"]));
  const digest = (b) => createHash("sha256").update(b).digest("hex");
  await writeFile(join(out, "native-build.json"), JSON.stringify({ revision,
    executableHash: digest(await readFile(join(out, "native/Release/xubc7-probe.exe"))),
    encodeSourceHash: digest(await readFile(join(glue, "Xubc7Encode.cpp"))),
    decoderSourceHash: digest(await readFile(join(glue, "Xubc7Probe.cpp"))),
    recipe: "CMake Release; BC7E scalar6; perceptual per semantic; single stripe; RDO off; self validation" }, null, 2) + "\n");
}
if (mode === "all" || mode === "wasm" || mode === "geometry") {
  const sdk = resolve(process.env.EMSDK ?? join(root, ".local/toolchains/emsdk"));
  const python = process.env.EMSDK_PYTHON ?? join(sdk, "python/3.13.3_64bit/python.exe");
  const empp = join(sdk, "upstream/emscripten/em++.py");
  // Keep UASTC's BC7 optimal-endpoint tables and all BC pack tables; omit unrelated HDR/ASTC init.
  const transcoder = join(out, "transcoder-u0.cpp");
  await writeFile(transcoder, '#include <cstddef>\nextern "C" size_t u0_zstd_decompress(void*, size_t, const void*, size_t);\n' +
    (await readFile(join(source, "transcoder/basisu_transcoder.cpp"), "utf8")).replace(/^\uFEFF/, "") +
    "\nnamespace basist { extern \"C\" void u0_bc_init() { uastc_init(); transcoder_init_bc7_mode5(); bc7f::init(); bc7u::init_weight_quant(); } }\n");
  // The decoder still executes every selected algorithm stage. Patch only allocation failure behavior.
  const originalDecoder = await readFile(join(source, "transcoder/basisu_xbc7_decoder.inl"), "utf8");
  const patches = [
    ["m_log_blks.resize(m_num_blocks_x, m_num_blocks_y);", "if (!m_log_blks.try_resize(m_num_blocks_x, m_num_blocks_y)) return false;"],
    ["m_seek.resize((uint32_t)cBlobStripeSeekTable, m_num_stripes + 1);", "if (!m_seek.try_resize((uint32_t)cBlobStripeSeekTable, m_num_stripes + 1)) return false;"],
    ["ZSTD_decompress(pDst, e.uncomp_size, pBytes + e.data_ofs, e.stored_size)", "u0_zstd_decompress(pDst, e.uncomp_size, pBytes + e.data_ofs, e.stored_size)"]
  ];
  let boundedDecoder = originalDecoder;
  for (const [before, after] of patches) {
    if (boundedDecoder.split(before).length !== 2) throw new Error("Decoder patch location changed");
    boundedDecoder = boundedDecoder.replace(before, after);
  }
  await writeFile(join(out, "basisu_xbc7_decoder.inl"), boundedDecoder);
  if (mode !== "geometry") run(python, [empp, "-std=c++20", "-O2", "-DNDEBUG", "-DBASISU_SUPPORT_SSE=0", "-DBASISD_SUPPORT_KTX2_ZSTD=1",
    "-fno-strict-aliasing", "-ffp-contract=off", `-I${source}/transcoder`, `-I${source}/zstd`,
    join(glue, "Xubc7Probe.cpp"), transcoder, join(source, "zstd/zstd.c"),
    "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=web,worker,node", "-sALLOW_MEMORY_GROWTH=0",
    "-sINITIAL_MEMORY=16777216", "-sSTACK_SIZE=1048576", "-sABORTING_MALLOC=0",
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_u0_preflight','_u0_decode','_u0_logical_block_bytes']",
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']", "-o", join(out, "xubc7.mjs")]);
  const meshopt = join(root, "OEngine/tools/oengine-asset-core/vendor/meshoptimizer");
  const nyx = resolve(process.env.NYX_SOURCE_DIR ?? "D:/Nyx-main");
  const lz4 = join(nyx, "MiniEngine/ThirdParty/lz4");
  run(python, [empp, "-std=c++20", "-O2", "-DNDEBUG", `-I${meshopt}`, `-I${lz4}`, `-I${source}/zstd`,
    join(glue, "GeometryProbe.cpp"), ...["quantization.cpp", "vertexcodec.cpp", "indexcodec.cpp", "allocator.cpp"].map((n) => join(meshopt, n)),
    join(lz4, "lz4.c"), join(source, "zstd/zstd.c"), "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=web,worker,node",
    "-sALLOW_MEMORY_GROWTH=0", "-sINITIAL_MEMORY=16777216", "-sSTACK_SIZE=1048576", "-sABORTING_MALLOC=0",
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_u0_exponent','_u0_compress','_u0_decompress']", "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']",
    "-o", join(out, "geometry.mjs")]);
  const hash = (b) => createHash("sha256").update(b).digest("hex");
  const inputs = {};
  for (const name of ["Xubc7Probe.cpp", "Xubc7Encode.cpp", "GeometryProbe.cpp", "CMakeLists.txt", "build.mjs"])
    inputs[name] = hash(await readFile(join(glue, name)));
  await writeFile(join(out, "build.json"), JSON.stringify({ revision, emscripten: run(python, [empp, "--version"]).split("\n")[0],
    memoryBytes: 16777216, growth: false, maxDimension: 512, maxStripes: 1, inputs,
    wasmHash: hash(await readFile(join(out, "xubc7.wasm"))), glueHash: hash(await readFile(join(out, "xubc7.mjs"))),
    geometryWasmHash: hash(await readFile(join(out, "geometry.wasm"))), meshoptRevision: "9e1f07b159d3cb777f1c67ed31fc11fd117986f4",
    lz4Hash: hash(await readFile(join(lz4, "lz4.c"))), decoderPatch: patches,
    originalDecoderHash: hash(originalDecoder), boundedDecoderHash: hash(boundedDecoder), transcoderHash: hash(await readFile(transcoder)),
    wasmBytes: (await readFile(join(out, "xubc7.wasm"))).length }, null, 2) + "\n");
}
