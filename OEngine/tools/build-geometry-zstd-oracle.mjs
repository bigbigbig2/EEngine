import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { compilerProbe } from "./native-compiler.mjs";
import { geometryZstdSources } from "./build-geometry-zstd.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = join(root, ".local/extreme-web-asset/e4-zstd");
await mkdir(out, { recursive: true });
const core = join(root, "OEngine/tools/oengine-asset-core");
const donor = await geometryZstdSources();
const compiler = compilerProbe();
assert.ok(compiler.usable, compiler.reason);
const executable = join(out, "oracle.exe");
for (const [command, args] of [
  [
    compiler.compiler,
    [
      "-std=c++20",
      "-O2",
      "-DZSTD_LEGACY_SUPPORT=0",
      "-DZSTD_DISABLE_ASM=1",
      `-I${join(core, "include")}`,
      `-I${donor.include}`,
      join(core, "tests/GeometryZstdTest.cpp"),
      ...donor.files,
      "-o",
      executable
    ]
  ],
  [executable, [out]]
]) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
}
// Exercise the actual production TS loader, hash check, WASM wrapper and full decoder.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => new Response(await readFile(fileURLToPath(url)));
try {
  const { decodeGeometryZstd, geometryZstdMemoryBytes } =
    await import("../.test-dist/assets/codec/GeometryZstd.js");
  const input = await readFile(join(out, "decoded.bin"));
  for (const name of ["selected.zst", "level9.zst", "level15.zst", "level19.zst"]) {
    assert.deepEqual(
      await decodeGeometryZstd(await readFile(join(out, name)), 262144),
      new Uint8Array(input)
    );
  }
  for (const name of [
    "trailing.zst",
    "concatenated.zst",
    "checksum.zst",
    "unknown-size.zst",
    "no-checksum.zst"
  ]) {
    await assert.rejects(decodeGeometryZstd(await readFile(join(out, name)), 262144), /rejected/);
  }
  const valid = await readFile(join(out, "selected.zst"));
  for (const length of [1, 5, valid.length - 1]) {
    await assert.rejects(decodeGeometryZstd(valid.subarray(0, length), 262144), /rejected/);
  }
  await assert.rejects(decodeGeometryZstd(valid, 262143), /extent/);
  await assert.rejects(decodeGeometryZstd(new Uint8Array(262145), 262144), /extent/);
  assert.equal(geometryZstdMemoryBytes(), 4 * 1024 * 1024);
  console.log(
    "E4 Zstd: four exact roundtrips, ten invalid extents/frames rejected, raw selection and fixed 4MiB heap passed"
  );
} finally {
  globalThis.fetch = originalFetch;
}
