import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { root, out, hash, json } from "./common.mjs";

await mkdir(join(out, "geometry"), { recursive: true });
const create = (await import(pathToFileURL(join(out, "geometry.mjs")))).default;
const wasm = await create({ wasmBinary: await readFile(join(out, "geometry.wasm")) });
const boundsPointer = wasm._malloc(24);
function exponent(min, max, low, bits) {
  new Float32Array(wasm.HEAPU8.buffer, boundsPointer, 6).set([...min, ...max]);
  return wasm._u0_exponent(boundsPointer, low, bits);
}
const align = (n, a = 16) => Math.ceil(n / a) * a;
const floatBits = new DataView(new ArrayBuffer(4));
function bits(v) { floatBits.setFloat32(0, v, true); return floatBits.getUint32(0, true); }
function exactExponent(v) {
  const u = bits(v) & 0x7fffffff;
  if (!u) return 128;
  let mantissa = (u & 0x7fffff) | (u >= 0x800000 ? 0x800000 : 0);
  let e = u >= 0x800000 ? (u >>> 23) - 127 - 23 : -149;
  while (!(mantissa & 1)) { mantissa >>>= 1; e++; }
  return e;
}
function roundAway(x) { return Math.sign(x) * Math.floor(Math.abs(x) + 0.5); }
async function compress(bytes, codec, stride = 4) {
  const p = wasm._malloc(bytes.length), q = wasm._malloc(bytes.length * 2 + 16384), r = wasm._malloc(bytes.length);
  assert.ok(p && q && r);
  try {
    wasm.HEAPU8.set(bytes, p);
    const start = performance.now();
    const size = wasm._u0_compress(codec, p, bytes.length, q, bytes.length * 2 + 16384, stride);
    assert.ok(size > 0);
    const encodeMs = performance.now() - start;
    const times = [];
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      assert.equal(wasm._u0_decompress(codec, q, size, r, bytes.length, stride), 1);
      if (i >= 2) times.push(performance.now() - t);
    }
    assert.deepEqual(Buffer.from(wasm.HEAPU8.subarray(r, r + bytes.length)), Buffer.from(bytes));
    return { size, encodeMs, nodeWasmDecodeMs: times.sort((a, b) => a - b), encoded: Buffer.from(wasm.HEAPU8.subarray(q, q + size)) };
  } finally { wasm._free(r); wasm._free(q); wasm._free(p); }
}
const paths = [
  join(root, "examples/modules/hello-hdr-gltf/assets/cooked/scene.oescene"),
  join(root, "examples/integrated/dungeon-warkarma-texture-compression/assets/cooked/scene.oescene"),
  join(root, ".local/models/bistro-cooked/scene.oescene")
];
const result = [], gpuCases = [], streamCases = [];
// Read-only research for older local fixtures; never imported by production.
function inspectV30(file) {
  const u32 = (at) => file.readUInt32LE(at), u64 = (at) => Number(file.readBigUInt64LE(at));
  assert.equal(file.toString("ascii", 0, 7), "OEGPACK");
  assert.equal(u32(8), 3); assert.equal(u32(12), 0);
  const assets = Array.from({ length: u32(40) }, (_, i) => { const at = u64(72) + i * 128; return { groupBegin: u32(at + 88), groupCount: u32(at + 92) }; });
  const groups = Array.from({ length: u32(52) }, (_, i) => { const at = u64(96) + i * 16; return { pageId: u32(at), offsetInDecodedPage: u32(at + 4), payloadBytes: u32(at + 8) }; });
  const pageDirectory = Array.from({ length: u32(56) }, (_, i) => { const at = u64(104) + i * 64; return { at: u64(at), size: u32(at + 8), decoded: u32(at + 12), codec: u32(at + 24) }; });
  const vertexFormats = Array.from({ length: u32(60) }, (_, i) => {
    const at = u64(112) + i * 16;
    assert.equal(file[at + 10], 1, "Research sample must use F32 positions");
    return { strideBytes: file.readUInt16LE(at), positionOffset: file[at + 4], normalOffset: file[at + 5], tangentOffset: file[at + 6], uv0Offset: file[at + 7], uv1Offset: file[at + 8], colorOffset: file[at + 9] };
  });
  return { assets, groups, pages: pageDirectory, vertexFormats, async readPage(id) {
    const p = pageDirectory[id], encoded = file.subarray(p.at, p.at + p.size);
    if (!p.codec) { assert.equal(p.size, p.decoded); return { bytes: Uint8Array.from(encoded) }; }
    assert.equal(p.codec, 1);
    const a = wasm._malloc(p.size), b = wasm._malloc(p.decoded);
    try { wasm.HEAPU8.set(encoded, a); assert.equal(wasm._u0_decompress(0, a, p.size, b, p.decoded, 4), 1); return { bytes: wasm.HEAPU8.slice(b, b + p.decoded) }; }
    finally { wasm._free(b); wasm._free(a); }
  } };
}
for (const scenePath of paths) {
  const scene = await json(scenePath), label = scenePath.includes("hello") ? "hello" : scenePath.includes("dungeon") ? "dungeon" : "bistro";
  // Full hello/Dungeon; a bounded first pack of the existing four-pack Bistro scene.
  const selected = label === "bistro" ? scene.packs.slice(0, 1) : scene.packs;
  const report = { label, selectedPacks: selected.length, totalPacks: scene.packs.length, packs: [], meshlets: 0, vertices: 0, domains: 0, exactDomains: 0, compact16: 0, compact24: 0, exact: 0,
    oldGroupBytes: 0, newGroupBytes: 0, oldPositionBytes: 0, newPositionBytes: 0, anchorBytes: 0, signedZero: 0, subnormal: 0, tangentNonSign: 0, lods: {}, sharedAcrossMaterial: 0, sharedAcrossLod: 0, transports: [] };
  report.maxOldGroupBytes = 0; report.maxNewGroupBytes = 0;
  for (const entry of selected) {
    const path = join(dirname(scenePath), entry.uri), file = await readFile(path);
    const pack = inspectV30(file);
    report.packs.push({ path, bytes: file.length, sha256: hash(file), assets: pack.assets.length, pages: pack.pages.length });
    const pages = new Map();
    async function page(id) { if (!pages.has(id)) pages.set(id, (await pack.readPage(id)).bytes); return pages.get(id); }
    // Conservative pack-wide welding also includes material-split assets and every LOD.
    {
      const meshlets = [], groups = [], parent = [];
      const find = (i) => parent[i] === i ? i : parent[i] = find(parent[i]);
      const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
      const positions = new Map();
      for (let groupId = 0; groupId < pack.groups.length; groupId++) {
        const location = pack.groups[groupId], bytes = await page(location.pageId), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), base = location.offsetInDecodedPage;
        const group = decodeHistoricalGroup(view, base), format = pack.vertexFormats[group.vertexFormatId];
        const groupData = { groupId, header: group, format, meshlets: [], base, bytes };
        groups.push(groupData);
        report.oldGroupBytes += group.payloadBytes;
        report.maxOldGroupBytes = Math.max(report.maxOldGroupBytes, group.payloadBytes);
        for (let m = 0; m < group.meshletCount; m++) {
          const header = decodeHistoricalMeshlet(view, base + group.meshletHeaderOffset + m * 48);
          const id = meshlets.length; parent.push(id);
          const vertices = [], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
          for (let v = 0; v < header.vertexCount; v++) {
            const at = base + header.vertexByteOffset + v * format.strideBytes;
            const p = [0, 1, 2].map((c) => view.getFloat32(at + format.positionOffset + c * 4, true));
            const key = p.map(bits).join(":");
            const other = positions.get(key);
            if (other !== undefined) {
              union(id, other.id);
              report.sharedAcrossMaterial += Number(other.material !== header.materialId);
              report.sharedAcrossLod += Number(other.lod !== group.lodLevel);
            } else positions.set(key, { id, material: header.materialId, lod: group.lodLevel });
            for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], p[c]); max[c] = Math.max(max[c], p[c]); }
            const attributes = Buffer.from(bytes.subarray(at, at + format.strideBytes));
            if (format.tangentOffset !== 255) {
              const sign = view.getInt16(at + format.tangentOffset + 4, true);
              if (sign !== -32767 && sign !== 32767) report.tangentNonSign++;
              assert.ok(sign === -32767 || sign === 32767, "Non-sign tangent requires an exact-width field, not a sign bit");
            }
            vertices.push({ p, attributes });
          }
          const item = { id, header, vertices, min, max, format, lod: group.lodLevel, triangles: Buffer.from(bytes.subarray(base + header.triangleByteOffset, base + header.triangleByteOffset + header.triangleCount * 3)) };
          meshlets.push(item); groupData.meshlets.push(item);
          report.lods[group.lodLevel] = (report.lods[group.lodLevel] ?? 0) + 1;
        }
      }
      const domains = new Map();
      for (const m of meshlets) {
        const key = find(m.id);
        if (!domains.has(key)) domains.set(key, []);
        domains.get(key).push(m);
      }
      report.domains += domains.size;
      for (const domain of domains.values()) {
        let e = 128, special = false;
        for (const m of domain) for (const { p } of m.vertices) for (const value of p) {
          e = Math.min(e, exactExponent(value));
          if (Object.is(value, -0)) { report.signedZero++; special = true; }
          if (value !== 0 && Math.abs(value) < 2 ** -126) { report.subnormal++; special = true; }
          if (!Number.isFinite(value)) throw new Error("Nonfinite source");
        }
        if (e === 128) e = 0;
        let chosen = e;
        if (e < -126 || e > 127) special = true;
        if (!special) for (const m of domain) chosen = Math.max(chosen, exponent(m.min, m.max, e, 24));
        if (chosen !== e) special = true;
        if (!special) for (const m of domain) for (const { p } of m.vertices) for (const value of p) {
          const q = roundAway(value / 2 ** e);
          if (Math.abs(q) > 8388607 || !Object.is(Math.fround(Math.fround(q) * 2 ** e), value)) special = true;
        }
        report.exactDomains += Number(special);
        for (const m of domain) {
          m.e = e; m.mode = 0;
          if (!special) {
            m.anchor = m.min.map((v) => roundAway(v / 2 ** e));
            const range = Math.max(...m.max.map((v, c) => roundAway(v / 2 ** e) - m.anchor[c]));
            m.mode = range <= 65535 ? 16 : range <= 16777215 ? 24 : 0;
          }
          report.meshlets++; report.vertices += m.vertices.length;
          report[m.mode === 16 ? "compact16" : m.mode === 24 ? "compact24" : "exact"] += m.vertices.length;
        }
      }
      for (const group of groups) {
        // Derive attribute/sign starts from count + finite format; no per-meshlet offset inflation.
        const sections = [], metadata = Buffer.alloc(64 + group.meshlets.length * 48), substreams = [];
        sections.push(metadata);
        metadata.set(group.bytes.subarray(group.base, group.base + 64));
        for (let i = 0; i < group.meshlets.length; i++) metadata.set(group.bytes.subarray(group.base + group.header.meshletHeaderOffset + i * 48, group.base + group.header.meshletHeaderOffset + (i + 1) * 48), 64 + i * 48);
        let cursor = metadata.length, meshletIndex = 0;
        for (const m of group.meshlets) {
          const position = Buffer.alloc(m.vertices.length * (m.mode === 16 ? 6 : m.mode === 24 ? 9 : 12));
          for (let v = 0; v < m.vertices.length; v++) for (let c = 0; c < 3; c++) {
            const value = m.vertices[v].p[c];
            if (!m.mode) position.writeFloatLE(value, v * 12 + c * 4);
            else {
              const delta = roundAway(value / 2 ** m.e) - m.anchor[c];
              position.writeUIntLE(delta, v * (m.mode === 16 ? 6 : 9) + c * (m.mode === 16 ? 2 : 3), m.mode === 16 ? 2 : 3);
              if (gpuCases.length < 4096 || gpuCases.length < 8192 && m.mode === 24) gpuCases.push({ mode: m.mode, anchor: m.anchor[c], delta, exponent: m.e, expected: bits(value) });
            }
            if (!m.mode) assert.equal(position.readUInt32LE(v * 12 + c * 4), bits(value));
            if (!m.mode && gpuCases.length < 2048) gpuCases.push({ mode: 0, expected: bits(value), anchor: 0, delta: bits(value), exponent: 0 });
          }
          const attrs = [];
          for (const [field, width] of [["normalOffset", 4], ["tangentOffset", 4], ["uv0Offset", 4], ["uv1Offset", 4], ["colorOffset", 4]]) {
            if (m.format[field] !== 255) for (const v of m.vertices) attrs.push(v.attributes.subarray(m.format[field], m.format[field] + width));
          }
          const sign = m.format.tangentOffset === 255 ? Buffer.alloc(0) : Buffer.alloc(Math.ceil(m.vertices.length / 8));
          for (let v = 0; v < m.vertices.length && sign.length; v++) if (m.vertices[v].attributes.readInt16LE(m.format.tangentOffset + 4) < 0) sign[v >> 3] |= 1 << (v & 7);
          const anchor = m.mode ? Buffer.alloc(16) : Buffer.alloc(0);
          if (m.mode) { for (let c = 0; c < 3; c++) anchor.writeInt32LE(m.anchor[c], c * 4); anchor.writeInt32LE(m.e, 12); }
          report.oldPositionBytes += m.vertices.length * 12; report.newPositionBytes += position.length; report.anchorBytes += anchor.length;
          const record = 64 + meshletIndex++ * 48;
          metadata.writeUInt32LE(cursor + align(anchor.length, 4), record + 8);
          metadata.writeUInt32LE(cursor + align(anchor.length, 4) + align(m.triangles.length, 4), record + 4);
          for (const part of [anchor, m.triangles, position, Buffer.concat(attrs), sign]) { sections.push(part); cursor += align(part.length, 4); if (part.length % 4) sections.push(Buffer.alloc(align(part.length, 4) - part.length)); }
          substreams.push({ position, attrs: Buffer.concat(attrs), triangles: m.triangles, sign, anchor });
        }
        const payload = Buffer.concat(sections);
        metadata.writeUInt32LE(payload.length, 60);
        payload.set(metadata, 0);
        report.newGroupBytes += align(payload.length);
        report.maxNewGroupBytes = Math.max(report.maxNewGroupBytes, align(payload.length));
        assert.ok(align(payload.length) <= 256 * 1024, "Group exceeds the selected page capacity");
        if (report.transports.length < 8 && payload.length >= 1024) {
          const transport = { groupId: group.groupId, inputBytes: payload.length, inputHash: hash(payload), codecs: [] };
          await writeFile(join(out, `geometry/${label}-${transport.groupId}.raw`), payload);
          for (const [codec, name] of [[0, "lz4"], [1, "zstd9"], [2, "meshopt-stride4-control"]]) {
            const value = await compress(payload, codec);
            const { encoded, ...stats } = value;
            const file = `geometry/${label}-${transport.groupId}-${name}.bin`;
            await writeFile(join(out, file), encoded);
            transport.codecs.push({ name, ...stats });
            streamCases.push({ file, raw: `geometry/${label}-${transport.groupId}.raw`, inputBytes: payload.length, codec, stride: 4, hash: hash(payload) });
            if (codec === 2) {
              const nested = await compress(encoded, 1);
              transport.meshoptZstdBytes = nested.size;
            }
          }
          // Real semantic substreams, preserving corner order via IndexSequence.
          const parts = [metadata];
          for (const s of substreams) {
            const pos = (await compress(s.position, 2, 12)).encoded;
            const attrs = (await compress(s.attrs, 2, 4)).encoded;
            const indices = Buffer.alloc(s.triangles.length * 4);
            for (let i = 0; i < s.triangles.length; i++) indices.writeUInt32LE(s.triangles[i], i * 4);
            const index = (await compress(indices, 3, 4)).encoded;
            // Explicit per-meshlet segment directory, 5 lengths + decoded counts.
            const directory = Buffer.alloc(32);
            [pos.length, attrs.length, index.length, s.sign.length, s.anchor.length, s.position.length, s.attrs.length, s.triangles.length].forEach((v, i) => directory.writeUInt32LE(v, i * 4));
            parts.push(directory, pos, attrs, index, s.sign, s.anchor);
          }
          const streams = Buffer.concat(parts);
          transport.meshoptSubstreamsBytes = streams.length;
          transport.meshoptSubstreamsZstdBytes = (await compress(streams, 1)).size;
          report.transports.push(transport);
        }
      }
    }
  }
  result.push(report);
  console.log(JSON.stringify({ ...report, transports: report.transports.map((v) => ({ inputBytes: v.inputBytes, sizes: v.codecs.map((c) => [c.name, c.size]), nested: v.meshoptZstdBytes })) }));
}
// Explicit integer/tie/range/exact special cases, independently generated from the asset scan.
for (const [anchor, delta, e] of [[-8388607, 0, -10], [-65535, 65535, -16], [100, 65535, 5], [-8388607, 16777214, -10], [0, 1, -126]])
  gpuCases.push({ mode: delta <= 65535 ? 16 : 24, anchor, delta, exponent: e, expected: bits(Math.fround(Math.fround(anchor + delta) * 2 ** e)) });
for (const value of [-0, 0, Math.fround(2 ** -149), Math.fround(3.4028234663852886e38), -1.5]) gpuCases.push({ mode: 0, anchor: 0, delta: bits(value), exponent: 0, expected: bits(value) });
assert.equal(roundAway(-1.5), -2); assert.equal(roundAway(1.5), 2);
const boundaryBytes = Buffer.alloc(256 * 1024);
let seed = 0x12345678;
for (let i = 0; i < boundaryBytes.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; boundaryBytes[i] = seed & 255; }
await writeFile(join(out, "texture/boundary.raw"), boundaryBytes);
await writeFile(join(out, "texture/boundary.zst"), (await compress(boundaryBytes, 1)).encoded);
await writeFile(join(out, "geometry-results.json"), JSON.stringify({ result, gpuCases, streamCases, boundary: { hash: hash(boundaryBytes), bytes: boundaryBytes.length },
  precision: "source-exact; union welded positions across material, assets and all LOD within each selected pack; compact eligibility is conservative, no lossy profile authorized", node: process.version }, null, 2) + "\n");
wasm._free(boundsPointer);

// Isolated historical U0 layout reader; never an E4 production decoder.
function decodeHistoricalGroup(v, at) { return { meshletCount: v.getUint16(at+44,true), lodLevel:v.getUint8(at+46), vertexFormatId:v.getUint8(at+47), meshletHeaderOffset:v.getUint32(at+48,true), payloadBytes:v.getUint32(at+60,true) }; }
function decodeHistoricalMeshlet(v, at) { return { vertexCount:v.getUint16(at,true), triangleCount:v.getUint16(at+2,true), vertexByteOffset:v.getUint32(at+4,true), triangleByteOffset:v.getUint32(at+8,true), refineGroupId:v.getUint32(at+12,true), materialId:v.getUint32(at+16,true) }; }
