import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { zstdCompressSync, constants } from "node:zlib";
import assert from "node:assert/strict";
import { root, out, hash, run, glbDirectory, readRange, metrics } from "./common.mjs";
import createBc from "../../.test-dist/assets/codec/vendor/pc-texture/basis_bc.js";

const require = createRequire(join(root, ".local/offline-cook-deps/package.json"));
const sharp = require("sharp");
const native = join(out, "native/Release/xubc7-probe.exe");
const baseline = join(root, ".local/t4-1-codec-build/bc-reference.exe");
const folder = join(out, "texture");
const encoderHash = hash(await readFile(native));
const baselineHash = hash(await readFile(baseline));
await mkdir(folder, { recursive: true });
const bc = await createBc({ wasmBinary: await readFile(join(root, "OEngine/src/assets/codec/vendor/pc-texture/basis_bc.wasm")) });
const zstd = (bytes) => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 19 } });
function resample(bytes, w, h, dw, dh, srgb, normal) {
  const p = bc._malloc(bytes.length), q = bc._malloc(dw * dh * 4);
  try {
    bc.HEAPU8.set(bytes, p);
    assert.equal(bc._bc_resample(p, w, h, q, dw, dh, Number(srgb), Number(normal)), 1);
    return Buffer.from(bc.HEAPU8.subarray(q, q + dw * dh * 4));
  } finally { bc._free(q); bc._free(p); }
}
function region(bytes, w, h, x, y, dw, dh, wrap = "clamp") {
  function address(v, n) {
    if (wrap === "clamp") return Math.max(0, Math.min(n - 1, v));
    const t = ((v % (wrap === "repeat" ? n : n * 2)) + (wrap === "repeat" ? n : n * 2)) % (wrap === "repeat" ? n : n * 2);
    return wrap === "mirror" && t >= n ? 2 * n - 1 - t : t;
  }
  const result = Buffer.alloc(dw * dh * 4);
  for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
    const p = (address(y + j, h) * w + address(x + i, w)) * 4;
    bytes.copy(result, (j * dw + i) * 4, p, p + 4);
  }
  return result;
}
async function source(path, role, name, size, materialName) {
  const { document: gltf, binOffset } = await glbDirectory(path);
  const material = materialName ? gltf.materials.find((m) => m.name === materialName) : gltf.materials.find((m) => role === "normal" ? m.normalTexture : role === "orm" ? m.pbrMetallicRoughness?.metallicRoughnessTexture : m.pbrMetallicRoughness?.baseColorTexture);
  const index = role === "normal" ? material.normalTexture.index : role === "orm" ? material.pbrMetallicRoughness.metallicRoughnessTexture.index : material.pbrMetallicRoughness.baseColorTexture.index;
  const image = gltf.images[gltf.textures[index].source ?? gltf.textures[index].extensions?.EXT_texture_webp?.source];
  const view = gltf.bufferViews[image.bufferView];
  const encoded = await readRange(path, binOffset + (view.byteOffset ?? 0), view.byteLength);
  const { data, info } = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = Math.min(size, info.width), h = Math.min(size, info.height);
  return { name, role, semantic: role === "normal" ? "normal-linear" : role === "orm" ? "orm-linear" : "base-color-srgb",
    width: w, height: h, bytes: region(data, info.width, info.height, 0, 0, w, h),
    provenance: { path, material: material.name, image: image.bufferView, encodedSha256: hash(encoded), originalWidth: info.width, originalHeight: info.height, crop: [0, 0, w, h] } };
}
const hello = join(root, "examples/modules/hello-hdr-gltf/assets/venice_mask.glb");
const dungeon = join(root, "examples/demos/14-integrated/dungeon-warkarma-texture-compression/assets/dungeon_warkarma.glb");
const bistro = join(root, ".local/models/BistroExterior_static_fixed_occlusion.glb");
const sources = [];
for (const role of ["color", "normal", "orm"]) sources.push(await source(hello, role, `hello-${role}`, 512));
sources.push(await source(dungeon, "orm", "dungeon-orm", 256));
sources.push(await source(bistro, "color", "bistro-color", 256, "Pavement_Cobblestone_02"));
const rows = [], samples = [], mips = new Map();
let serial = 0;
async function encode(bytes, w, h, semantic, name, q = 100, keep = false) {
  const id = `${String(serial++).padStart(4, "0")}-${name}-q${q}`;
  const input = join(folder, `${id}.rgba`), stream = join(folder, `${id}.xubc7`), output = join(folder, `${id}.bc7`);
  await writeFile(input, bytes);
  // Reuse an unchanged isolated sample after a tool-only interruption, not production assets.
  const timingFile = join(folder, `${id}.encode.json`);
  let encoded;
  try {
    const previous = JSON.parse(await readFile(timingFile, "utf8"));
    if (previous.rgbaHash === hash(bytes) && previous.encoderHash === encoderHash &&
        previous.width === w && previous.height === h && previous.semantic === semantic && previous.q === q &&
        previous.streamHash === hash(await readFile(stream)) && previous.nativeHash === hash(await readFile(output))) encoded = previous.result;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!encoded) {
    encoded = JSON.parse(run(native, [w, h, Number(semantic === "base-color-srgb"), q, input, stream, output]).trim().split("\n").at(-1));
    await writeFile(timingFile, JSON.stringify({ rgbaHash: hash(bytes), encoderHash, width: w, height: h, semantic, q,
      streamHash: hash(await readFile(stream)), nativeHash: hash(await readFile(output)), result: encoded }));
  }
  const nativeBytes = await readFile(output);
  const baselineFile = join(folder, `${id}.baseline.bc7`);
  run(baseline, ["encode", w, h, 7, Number(semantic === "base-color-srgb"), input, baselineFile]);
  const old = await readFile(baselineFile);
  const decoded = join(folder, `${id}.decoded.rgba`), oldDecoded = join(folder, `${id}.baseline.rgba`);
  run(baseline, ["decode", w, h, 7, 0, output, decoded]);
  run(baseline, ["decode", w, h, 7, 0, baselineFile, oldDecoded]);
  const pixels = await readFile(decoded), oldPixels = await readFile(oldDecoded);
  const row = { id, name, width: w, height: h, semantic, q, rgbaHash: hash(bytes), streamHash: hash(await readFile(stream)), nativeHash: hash(nativeBytes), ...encoded,
    baselineBytes: old.length, baselineZstdBytes: zstd(old).length, xubcNativeZstdBytes: zstd(nativeBytes).length,
    quality: metrics(bytes, pixels, semantic), baselineQuality: metrics(bytes, oldPixels, semantic), deltaFromBaseline: metrics(oldPixels, pixels, semantic) };
  rows.push(row);
  if (keep) {
    await sharp(bytes, { raw: { width: w, height: h, channels: 4 } }).webp({ lossless: true, effort: 6 }).toFile(join(folder, `${id}.webp`));
    if (semantic === "base-color-srgb") await sharp(bytes, { raw: { width: w, height: h, channels: 4 } }).avif({ quality: 90, effort: 6, chromaSubsampling: "4:4:4" }).toFile(join(folder, `${id}.avif`));
    samples.push({ ...row, stem: `/.local/web-asset-u0/texture/${id}`, expectedDecodedHash: hash(pixels), decodedFile: `${id}.decoded.rgba` });
  }
  console.log(JSON.stringify({ id, bytes: row.streamBytes, baselineZstd: row.baselineZstdBytes, ms: row.encodeMs }));
  return { row, pixels, blocks: nativeBytes };
}
for (const s of sources) {
  const chain = [{ bytes: s.bytes, width: s.width, height: s.height }];
  while (chain.at(-1).width > 1 || chain.at(-1).height > 1) {
    const p = chain.at(-1), w = Math.max(1, p.width >> 1), h = Math.max(1, p.height >> 1);
    chain.push({ bytes: resample(p.bytes, p.width, p.height, w, h, s.role === "color", s.role === "normal"), width: w, height: h });
  }
  mips.set(s.name, chain);
  for (const tile of [144, 256, 512]) {
    for (let level = 0; level < chain.length; level++) {
      const p = chain[level];
      for (let y = 0; y < p.height; y += tile) for (let x = 0; x < p.width; x += tile) {
        const w = Math.min(tile, p.width - x), h = Math.min(tile, p.height - y);
        await encode(region(p.bytes, p.width, p.height, x, y, w, h), w, h, s.semantic, `${s.name}-resident${tile}-m${level}-${x}-${y}`, 100,
          tile === 256 && (level === 1 || level === chain.length - 1) || level === 0 && x === 0 && y === 0);
      }
    }
  }
}
const seams = [];
for (const s of sources.slice(0, 3)) {
  for (const wrap of ["clamp", "repeat", "mirror"]) {
    // NPOT domain, two neighboring fine pages and a four-way corner.
    const w = 251, h = 249, pixels = region(s.bytes, s.width, s.height, 0, 0, w, h);
    for (const q of s.role === "color" ? [100, 90, 75] : [100]) {
      const pages = [];
      for (const [x, y] of [[0, 0], [128, 0], [0, 128], [128, 128]])
        pages.push(await encode(region(pixels, w, h, x - 8, y - 8, 144, 144, wrap), 144, 144, s.semantic, `${s.name}-vt-${wrap}-${x}-${y}`, q, wrap === "repeat" && x === 0 && y === 0));
      let mismatched = 0, maxDelta = 0;
      for (const [a, b, vertical] of [[0, 1, false], [0, 2, true], [2, 3, false], [1, 3, true]]) {
        for (let j = 0; j < 144; j++) for (let i = 0; i < 16; i++) for (let c = 0; c < 4; c++) {
          const pa = vertical ? ((128 + i) * 144 + j) * 4 + c : (j * 144 + 128 + i) * 4 + c;
          const pb = vertical ? (i * 144 + j) * 4 + c : (j * 144 + i) * 4 + c;
          const d = Math.abs(pages[a].pixels[pa] - pages[b].pixels[pb]);
          mismatched += Number(d !== 0); maxDelta = Math.max(maxDelta, d);
        }
      }
      seams.push({ semantic: s.semantic, wrap, q, mismatched, maxDelta });
    }
  }
}
const tails = [];
for (const s of sources.slice(0, 3)) await encode(region(s.bytes, s.width, s.height, 3, 7, 251, 249), 251, 249, s.semantic, `${s.name}-npot`, 100, true);
for (const s of sources.slice(0, 3)) {
  const p = mips.get(s.name)[3]; // 64x64: native tail profile, matching fine base encoder.
  const tail = await encode(p.bytes, p.width, p.height, s.semantic, `${s.name}-tail-native`, 100, true);
  assert.deepEqual(tail.row.deltaFromBaseline.max, [0, 0, 0, 0]);
  tails.push({ semantic: s.semantic, mip: 3, width: p.width, height: p.height, nativeHash: tail.row.nativeHash, baselineExact: true });
}
// Small tail profile uses the same base encode; BC4 and exact coverage remain separate.
const scalar = sources[2], scalarBytes = region(scalar.bytes, scalar.width, scalar.height, 0, 0, 144, 144);
const scalarInput = join(folder, "scalar.rgba"), scalarOutput = join(folder, "scalar.bc4");
await writeFile(scalarInput, scalarBytes);
run(baseline, ["encode", 144, 144, 4, 0, scalarInput, scalarOutput, 0]);
run(baseline, ["decode", 144, 144, 4, 0, scalarOutput, join(folder, "scalar.decoded.rgba")]);
const scalarBlocks = await readFile(scalarOutput), coverage = Buffer.from(Array.from({ length: 143 * 137 }, (_, i) => i * 37 & 255));
await writeFile(join(folder, "coverage.r8"), coverage);
await writeFile(join(folder, "scalar.bc4.zst"), zstd(scalarBlocks));
await writeFile(join(folder, "coverage.r8.zst"), zstd(coverage));
await writeFile(join(out, "texture-results.json"), JSON.stringify({ node: process.version, encoderHash, baselineHash, sharp: sharp.versions, sources: sources.map(({ bytes, ...s }) => ({ ...s, rgbaHash: hash(bytes) })),
  rows, seams, tails, samples, bc4: { bytes: scalarBlocks.length, hash: hash(scalarBlocks), zstdBytes: zstd(scalarBlocks).length },
  coverage: { bytes: coverage.length, hash: hash(coverage), zstdBytes: zstd(coverage).length },
  note: "Finite canonical crops; all mips per crop. Not a full scene size or performance qualification. Independent tile encode, current baseline encoded from identical RGBA." }, null, 2) + "\n");
