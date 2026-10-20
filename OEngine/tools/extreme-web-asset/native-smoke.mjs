import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { nativeAvifArguments, qualityAnchors } from "./native-profiles.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = join(root, ".local/extreme-web-asset");
const buildBytes = await readFile(join(directory, "native-build.json"));
const build = JSON.parse(buildBytes);
const output = join(directory, "smoke");
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encoder = join(root, build.binaries["avifenc.exe"].path);
const decoder = join(root, build.binaries["avifdec.exe"].path);
for (const binary of Object.values(build.binaries)) {
  assert.equal(hash(await readFile(join(root, binary.path))), binary.sha256);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length);
  header.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), bytes])));
  return Buffer.concat([header, bytes, tail]);
}
// Deterministic scalar/data/alpha ramp; generated PNG has no implicit ICC/Exif metadata.
const header = Buffer.alloc(13);
header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6;
const pixels = Buffer.alloc(64 * (1 + 64 * 4));
for (let y = 0; y < 64; y++) {
  for (let x = 0; x < 64; x++) {
    const at = y * 257 + 1 + x * 4;
    pixels[at] = Math.round(x * 255 / 63);
    pixels[at + 1] = Math.round(y * 255 / 63);
    pixels[at + 2] = (x * 17 + y * 31) & 255;
    pixels[at + 3] = Math.round((x + y) * 255 / 126);
  }
}
const input = join(output, "ramp.png");
await writeFile(input, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
const rows = [];
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { argv: [command, ...args], status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message };
}
try {
  for (const quality of Object.values(qualityAnchors)) {
    const common = ["-q", String(quality), "-s", "4", "-c", "aom", "-d", "10"];
    const profiles = [
      ["donor-color", [...common, "-a", "tune=iq"]],
      ["donor-normal-orm", [...common, "-a", "tune=ssim", "--cicp", "1/8/0"]],
      ["donor-scalar", [...common, "-a", "tune=ssim", "--yuv", "400"]],
      ...["color-rgb", "color-rgba", "normal-xy", "data-rgb", "moment-xyz", "scalar-r"].map((semantic) =>
        [`local-${semantic}`, nativeAvifArguments(semantic, quality)]),
    ];
    for (const [name, options] of profiles) {
      const file = join(output, `${name}-q${quality}.avif`);
      const encode = run(encoder, [...options, "-j", "2", input, file]);
      rows.push({ name, quality, encode });
      assert.equal(encode.status, 0, JSON.stringify(encode));
      const info = run(decoder, ["--info", file]);
      assert.equal(info.status, 0, JSON.stringify(info));
      const decode = run(decoder, [file, join(output, `${name}-q${quality}.png`)]);
      assert.equal(decode.status, 0, JSON.stringify(decode));
      const metadata = info.stdout + info.stderr;
      assert.match(metadata, /Bit Depth\s*:\s*10/);
      if (["local-normal-xy", "local-data-rgb", "local-moment-xyz", "donor-normal-orm"].includes(name)) {
        assert.match(metadata, /Transfer Char\.\s*:\s*8/);
        assert.match(metadata, /Matrix Coeffs\.\s*:\s*0/);
        assert.match(metadata, /Format\s*:\s*YUV444/);
      }
      if (name === "donor-scalar" || name === "local-scalar-r") assert.match(metadata, /Format\s*:\s*YUV400/);
      Object.assign(rows.at(-1), { info, decode, bytes: (await readFile(file)).length, sha256: hash(await readFile(file)) });
      console.log(`${name} Q${quality}: native encode/decode and metadata PASS`);
    }
  }
  const invalid = run(encoder, ["-q", "80", "-s", "4", "-c", "aom", "-d", "10", "-a", "tune=not-a-valid-metric", input, join(output, "invalid.avif")]);
  assert.notEqual(invalid.status, 0, "Invalid codec option must not be silently ignored");
  rows.push({ name: "invalid-tune-rejected", encode: invalid });
  await writeFile(join(directory, "native-smoke.json"), JSON.stringify({ scope: "Native configuration smoke only; no browser/GPU quality or performance qualification",
    buildSha256: hash(buildBytes), inputSha256: hash(await readFile(input)), rows }, null, 2) + "\n");
  if (process.argv.includes("--snapshot")) {
    const sources = JSON.parse(await readFile(join(directory, "sources.json"), "utf8"));
    const snapshot = {
      scope: "E0 pinned native tool and source preparation; no runtime adoption or browser/GPU/performance qualification",
      baseRevision: "1f856ea0",
      nativeBuildSha256: hash(buildBytes),
      recipeSha256: build.recipeSha256,
      sourceManifestSha256: build.sourceManifestSha256,
      compiler: build.compiler, cmake: build.cmake, nasm: build.nasm, perl: build.perl,
      binaries: build.binaries,
      sourceTrees: Object.fromEntries(Object.entries(build.sources).map(([name, source]) => [name, {
        revision: source.revision, trackedTreeSha256: source.trackedTreeSha256, license: source.license,
      }])),
      sparkFiles: build.sources.spark.files,
      legalPages: sources.legalPages,
      notices: build.notices,
      nativeSmokeSha256: hash(await readFile(join(directory, "native-smoke.json"))),
      smoke: { successCases: rows.filter((row) => row.encode.status === 0).length, invalidOptionsRejected: 1 },
      authorization: { sparkProduction: "not recorded; no shader copied to production",
        gltfTexNotice: "MIT declaration only; no standalone notice at pinned revision" },
    };
    await writeFile(new URL("./e0-baseline.json", import.meta.url), JSON.stringify(snapshot, null, 2) + "\n");
  }
} catch (error) {
  await writeFile(join(output, `failure-${Date.now()}.json`), JSON.stringify({ rows, error: error.message }, null, 2) + "\n");
  throw error;
}
