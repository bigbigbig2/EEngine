import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compilerProbe } from "./native-compiler.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const basis = resolve(process.env.BASIS_SOURCE ?? resolve(root, ".local/texture-design-basis"));
const output = resolve(root, ".local/t4-1-codec-build/bc-reference.exe");
const revision = "99f52d63aa6799cbdaecfe977111dc5ec3b31d47";
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `exit ${result.status}`);
  return result.stdout;
};
if (run("git", ["rev-parse", "HEAD"], basis).trim() !== revision) throw new Error("Basis revision mismatch");
if (run("git", ["diff", "HEAD", "--name-only"], basis).trim()) throw new Error("Basis source modified");
const probe = compilerProbe();
if (!probe.usable) throw new Error(probe.reason);
const glue = resolve(root, "OEngine/tools/texture-codec");
const sources = [
  resolve(glue, "BcCodec.cpp"),
  resolve(glue, "BcReference.cpp"),
  ...[
    "basisu_bc7e_scalar.cpp",
    "basisu_bc15_spmd.cpp",
    "basisu_resampler.cpp",
    "basisu_resample_filters.cpp"
  ].map((name) => resolve(basis, "encoder", name)),
  resolve(basis, "transcoder/basisu_transcoder.cpp")
];
await mkdir(resolve(root, ".local/t4-1-codec-build"), { recursive: true });
run(probe.compiler, [
  "-std=c++17",
  "-O2",
  "-DNDEBUG",
  "-DBASISU_SUPPORT_SSE=0",
  "-DBASISD_SUPPORT_KTX2_ZSTD=0",
  "-fno-strict-aliasing",
  "-ffp-contract=off",
  "-include",
  resolve(glue, "BcMath.h"),
  `-I${basis}/encoder`,
  `-I${basis}/transcoder`,
  ...sources,
  "-o",
  output
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = {};
for (const path of [...sources, resolve(glue, "BcMath.h")]) inputs[path] = hash(await readFile(path));
await writeFile(
  output + ".json",
  JSON.stringify(
    {
      revision,
      compiler: probe.compiler,
      recipe: "bc7e-scalar-6-bc4-hq",
      binaryHash: hash(await readFile(output)),
      inputs
    },
    null,
    2
  ) + "\n"
);
console.log(output);
