import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compilerProbe } from "./native-compiler.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const basis = resolve(process.env.BASIS_SOURCE ?? resolve(root, ".local/texture-design-basis"));
const output = resolve(root, ".local/image-resample-build/image-resample.exe");
const revision = "99f52d63aa6799cbdaecfe977111dc5ec3b31d47";
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `exit ${result.status}`);
  return result.stdout.trim();
}
if (run("git", ["rev-parse", "HEAD"], basis) !== revision || run("git", ["diff", "HEAD", "--name-only"], basis)) {
  throw new Error("Canonical resampler requires the clean pinned Basis source");
}
const probe = compilerProbe();
if (!probe.usable) throw new Error(probe.reason);
const sources = [
  resolve(root, "OEngine/tools/texture-codec/CanonicalResample.cpp"),
  resolve(root, "OEngine/tools/texture-codec/CanonicalResampleNative.cpp"),
  ...["basisu_resampler.cpp", "basisu_resample_filters.cpp"].map((name) => resolve(basis, "encoder", name))
];
await mkdir(dirname(output), { recursive: true });
run(probe.compiler, [
  "-std=c++17", "-O2", "-DNDEBUG", "-ffp-contract=off",
  ...(process.platform === "win32" ? ["-static"] : []),
  `-I${basis}/encoder`, ...sources, "-o", output
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = {};
for (const path of sources) inputs[path] = hash(await readFile(path));
await writeFile(output + ".json", JSON.stringify({
  revision, compiler: probe.compiler, recipe: "canonical-tent-no-bc",
  binaryHash: hash(await readFile(output)), inputs
}, null, 2) + "\n");
console.log(output);
