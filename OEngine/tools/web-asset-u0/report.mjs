import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { root, out, json, hash } from "./common.mjs";

const texture = await json(join(out, "texture-results.json"));
const geometry = await json(join(out, "geometry-results.json"));
const browser = await json(join(out, "browser-result.json"));
assert.equal(browser.status, "passed");
assert.deepEqual(browser.gpuErrors, []);
assert.deepEqual(browser.scopedGpuErrors, []);
assert.deepEqual(browser.pageErrors, []);
for (const [name, expected] of Object.entries(browser.summary.fixtureHashes)) assert.equal(hash(await readFile(join(out, name))), expected);
const sizeModel = [];
for (const source of texture.sources) for (const tile of [144, 256, 512]) {
  const rows = texture.rows.filter((r) => r.name.startsWith(`${source.name}-resident${tile}-`));
  const payload = rows.reduce((s, r) => s + r.streamBytes, 0);
  const directory = 128 + 64 * rows.length;
  const coalescedRanges = Math.ceil(payload / (256 * 1024));
  sizeModel.push({ source: source.name, tile, slices: rows.length, payload, baselineZstd: rows.reduce((s, r) => s + r.baselineZstdBytes, 0),
    directoryModelBytes: directory, oneRangePerSliceModel: payload + directory + rows.length * 1024,
    contiguousRangeLowerModel: payload + directory + coalescedRanges * 1024 });
}
const totals = geometry.result.map((r) => ({ ...r, packs: r.packs.map((p) => ({ ...p, path: relative(root, p.path).replaceAll("\\", "/") })),
  transports: r.transports.map((t) => ({ ...t, codecs: t.codecs.map(({ nodeWasmDecodeMs, ...c }) => c) })),
  transportTotals: { input: r.transports.reduce((s, t) => s + t.inputBytes, 0),
    ...Object.fromEntries(["lz4", "zstd9", "meshopt-stride4-control"].map((name) => [name, r.transports.reduce((s, t) => s + t.codecs.find((c) => c.name === name).size, 0)])),
    substreams: r.transports.reduce((s, t) => s + t.meshoptSubstreamsBytes, 0),
    substreamsZstd: r.transports.reduce((s, t) => s + t.meshoptSubstreamsZstdBytes, 0) } }));
const identity = {};
for (const name of ["texture-results.json", "geometry-results.json", "browser-result.json", "build.json", "native-build.json"]) identity[name] = hash(await readFile(join(out, name)));
const tools = {};
for (const name of ["common.mjs", "build.mjs", "texture.mjs", "geometry.mjs", "worker.mjs", "browser.mjs", "report.mjs", "Xubc7Encode.cpp", "Xubc7Probe.cpp", "GeometryProbe.cpp", "CMakeLists.txt"])
  tools[name] = hash(await readFile(new URL(name, import.meta.url)));
const build = await json(join(out, "build.json"));
for (const [name, digest] of Object.entries(build.inputs)) assert.equal(tools[name], digest, `Stale native/WASM build input: ${name}`);
const snapshot = { scope: "U0 reference-only, not production adoption, full-scene compression, renderer correctness or performance qualification",
  baseRevision: "5f3f41533e25901cbbd1da9c9ae751c64bc0a9c9", identity, tools,
  build, nativeBuild: await json(join(out, "native-build.json")),
  sparkShaderHash: hash(await readFile(join(root, ".local/texture-design-spark/src/shaders/spark_bc7_rgba.wgsl"))),
  baselineBuild: await json(join(root, ".local/t4-1-codec-build/bc-reference.exe.json")),
  baselineBinaryHash: texture.baselineHash, sources: texture.sources.map((s) => ({ ...s, provenance: { ...s.provenance, path: relative(root, s.provenance.path).replaceAll("\\", "/") } })),
  sizeModelAssumptions: "All mips of finite crops. 128B header + 64B/slice directory and 1024B/HTTP response modeled, NOT measured protocol/HTTP bytes. Contiguous payload in <=256KiB ranges is an optimistic lower model; per-slice requests an uncoalesced model. No RTT, bandwidth or full-scene extrapolation.",
  sizeModel, seams: texture.seams, tails: texture.tails, bc4: texture.bc4, coverage: texture.coverage,
  q100DeltaMax: texture.rows.filter((r) => r.q === 100).reduce((m, r) => m.map((v, c) => Math.max(v, r.deltaFromBaseline.max[c])), [0, 0, 0, 0]),
  sampleQuality: texture.samples.map((s) => ({ id: s.id, quality: s.quality, baselineQuality: s.baselineQuality, deltaFromBaseline: s.deltaFromBaseline })),
  sampleManifest: texture.rows.map((r) => ({ id: r.id, width: r.width, height: r.height, q: r.q, semantic: r.semantic,
    rgba: r.rgbaHash, stream: r.streamHash, native: r.nativeHash, bytes: r.streamBytes })),
  geometry: totals, gpu: { status: browser.status, adapter: browser.adapter, device: browser.device, chrome: browser.chrome.version,
    environment: browser.environment, buildIdentity: browser.buildIdentity, oracleSha256: browser.oracleSha256, summary: browser.summary } };
await writeFile(new URL("./results.json", import.meta.url), JSON.stringify(snapshot, null, 2) + "\n");
console.log(JSON.stringify({ textureRows: texture.rows.length, sizeModel, geometry: totals.map((r) => ({ label: r.label, vertices: r.vertices,
  old: r.oldGroupBytes, new: r.newGroupBytes, maxOld: r.maxOldGroupBytes, maxNew: r.maxNewGroupBytes, transport: r.transportTotals })) }, null, 2));
