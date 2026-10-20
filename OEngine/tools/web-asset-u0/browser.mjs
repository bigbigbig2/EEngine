import assert from "node:assert/strict";
const base = "/.local/web-asset-u0/";
const sha = async (b) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((v) => v.toString(16).padStart(2, "0")).join("");
const bytes = async (url) => {
  const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer());
};
const json = async (url) => JSON.parse(new TextDecoder().decode(await bytes(url)));
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const stats = (times) => { const v = times.toSorted((a, b) => a - b); return { count: v.length, p50: v[Math.floor(v.length * .5)], p95: v[Math.min(v.length - 1, Math.floor(v.length * .95))] }; };
function workerClient() {
  const worker = new Worker("/OEngine/tools/web-asset-u0/worker.mjs", { type: "module" });
  const tasks = new Map(); let id = 0;
  worker.onmessage = ({ data }) => { const p = tasks.get(data.id); tasks.delete(data.id); data.error ? p.reject(new Error(data.error.message)) : p.resolve(data); };
  worker.onerror = (event) => { for (const p of tasks.values()) p.reject(new Error(event.message)); tasks.clear(); };
  return { async call(data) {
    return new Promise((resolve, reject) => { const key = id++; tasks.set(key, { resolve, reject }); worker.postMessage({ ...data, id: key }); });
  }, close() { worker.terminate(); } };
}

async function readBuffer(device, encoder, buffer, size) {
  const readback = device.createBuffer({ size: Math.ceil(size / 4) * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyBufferToBuffer(buffer, 0, readback, 0, readback.size);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const result = new Uint8Array(readback.getMappedRange()).slice(0, size);
  readback.unmap(); readback.destroy(); return result;
}
async function consumeBc(device, pipeline, blocks, width, height, format = "bc7-rgba-unorm") {
  const scalar = format === "r8unorm";
  const w = scalar ? width : Math.ceil(width / 4) * 4, h = scalar ? height : Math.ceil(height / 4) * 4;
  const texture = device.createTexture({ size: [w, h, 2], format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
  device.queue.writeTexture({ texture, origin: [0, 0, 1] }, blocks, { bytesPerRow: scalar ? w : w / 4 * (format === "bc4-r-unorm" ? 8 : 16), rowsPerImage: scalar ? h : h / 4 }, [w, h, 1]);
  const output = device.createBuffer({ size: w * h * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView({ dimension: "2d", baseArrayLayer: 1, arrayLayerCount: 1 }) }, { binding: 1, resource: { buffer: output } }] });
  const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8)); pass.end();
  const result = await readBuffer(device, encoder, output, output.size);
  texture.destroy(); output.destroy();
  const cropped = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) cropped.set(result.subarray(y * w * 4, (y * w + width) * 4), y * width * 4);
  return cropped;
}
function imageMetrics(a, b) {
  let sum = 0, max = 0; const channels = [0, 0, 0, 0], maxima = [0, 0, 0, 0];
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (i % 4 < 3) { sum += d * d; max = Math.max(max, d); } channels[i % 4] += d * d; maxima[i % 4] = Math.max(maxima[i % 4], d); }
  return { rgbMse: sum / (a.length / 4 * 3), maxRgb: max, psnr: sum ? 10 * Math.log10(255 ** 2 * a.length / 4 * 3 / sum) : null, mse: channels.map((x) => x / (a.length / 4)), maxima };
}
async function geometryGpu(device, cases) {
  // Byte-addressed U16/U24 reads, not pre-unpacked u32 deltas.
  const data = new Uint32Array(cases.length * 8), expected = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i], offset = i * 32;
    data.set([c.mode, c.anchor >>> 0, 0, c.exponent >>> 0, 0, 0, 0, 0], i * 8);
    const view = new DataView(data.buffer);
    const byteOffset = offset + 17; // deliberately crosses u32 words for U24.
    data[i * 8 + 2] = byteOffset;
    if (!c.mode) view.setUint32(offset + 16, c.expected, true);
    else { view.setUint8(byteOffset, c.delta & 255); view.setUint8(byteOffset + 1, c.delta >>> 8 & 255); if (c.mode === 24) view.setUint8(byteOffset + 2, c.delta >>> 16 & 255); }
    expected.push(c.expected);
  }
  const shader = device.createShaderModule({ code: `
@group(0) @binding(0) var<storage,read> src: array<u32>;
@group(0) @binding(1) var<storage,read_write> dst: array<u32>;
fn byteAt(offset:u32)->u32 { return (src[offset>>2u] >> ((offset&3u)*8u))&255u; }
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x; if(i>=arrayLength(&dst)){return;} let at=i*8u; let mode=src[at];
  if(mode==0u){dst[i]=src[at+4u];return;}
  let offset=src[at+2u]; var d=byteAt(offset)|(byteAt(offset+1u)<<8u);
  if(mode==24u){d=d|(byteAt(offset+2u)<<16u);}
  let q=bitcast<i32>(src[at+1u])+i32(d);
  let e=bitcast<i32>(src[at+3u]); let scale=bitcast<f32>(u32(e+127)<<23u);
  dst[i]=bitcast<u32>(f32(q)*scale);
}` });
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module: shader, entryPoint: "main" } });
  const input = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(input, 0, data);
  const output = device.createBuffer({ size: expected.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] })); pass.dispatchWorkgroups(Math.ceil(cases.length / 64)); pass.end();
  const actual = new Uint32Array((await readBuffer(device, encoder, output, output.size)).buffer);
  for (let i = 0; i < expected.length; i++) assert.equal(actual[i], expected[i], `geometry ${i}`);
  input.destroy(); output.destroy(); return { cases: cases.length, modes: [...new Set(cases.map((c) => c.mode))], exactBits: true };
}

export async function runWebAssetU0(device) {
  const texture = await json(base + "texture-results.json"), geometry = await json(base + "geometry-results.json"), build = await json(base + "build.json");
  const client = workerClient(), report = { worker: {}, texture: [], images: [], negative: [], geometry: {}, geometryTransport: [], scalar: [], zstdNegative: [] };
  report.fixtureHashes = {};
  for (const name of ["texture-results.json", "geometry-results.json", "build.json"]) report.fixtureHashes[name] = await sha(await bytes(base + name));
  const module = device.createShaderModule({ code: `
@group(0) @binding(0) var t:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> out:array<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
let dim=textureDimensions(t);if(id.x>=${512}u||id.y>=dim.y){return;}
// The output covers physical block dimensions; the host crops logical NPOT texels.
let height=dim.y; let w=arrayLength(&out)/height; if(id.x>=w){return;}
let p=vec4u(round(clamp(textureLoad(t,vec2i(id.xy),0),vec4f(0),vec4f(1))*255.0));
out[id.y*w+id.x]=p.r|(p.g<<8u)|(p.b<<16u)|(p.a<<24u);}` });
  // NPOT samples use a block-padded physical texture without requiring unaligned BC features.
  const consumePipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
  try {
    report.worker = await client.call({ kind: "init" });
    assert.equal(report.worker.wasmHash, build.wasmHash);
    for (const sample of texture.samples) {
      const encoded = await bytes(`${sample.stem}.xubc7`), raw = await bytes(`${sample.stem}.bc7`);
      const result = await client.call({ kind: "decode", bytes: encoded.buffer, width: sample.width, height: sample.height, iterations: 14 });
      assert.equal(result.status, 1); assert.equal(await sha(result.bytes), sample.nativeHash); assert.equal(result.memoryBytes, build.memoryBytes);
      const consumed = await consumeBc(device, consumePipeline, new Uint8Array(result.bytes), sample.width, sample.height);
      assert.ok(equal(consumed, await bytes(`${sample.stem}.decoded.rgba`)), sample.id + " BC7 GPU decode");
      report.texture.push({ id: sample.id, width: sample.width, height: sample.height, streamBytes: encoded.length, firstDecodeMs: result.times[0], warm: stats(result.times.slice(2)), nativeHash: await sha(raw) });
    }
    const exemplar = texture.samples.find((s) => s.width === 144 && s.height === 144), stream = await bytes(exemplar.stem + ".xubc7");
    const invalidCommands = new Uint8Array([0xb7, 2, 0, 7, 144, 0, 144, 0, 100, 0, 1, 1, 0x90, 0x0a,
      ...new Uint8Array(1296).fill(255), 0x6a]);
    const negatives = [
      ["empty", new Uint8Array(), 144, 144], ["bad-marker", Uint8Array.of(0, 0, 0), 144, 144],
      ["truncated", stream.slice(0, -1), 144, 144], ["trailing", new Uint8Array([...stream, 0]), 144, 144],
      ["dimension-mismatch", stream, 140, 144], ["oversized-domain", stream, 516, 144],
      ["tiny-truncated", Uint8Array.of(0xb8, 1, 1), 4, 4], ["tiny-trailing", new Uint8Array([0xb8, 1, 1, ...new Uint8Array(17)]), 4, 4],
      ["oversized-varint", Uint8Array.of(0xb7, 1, 0x81, 0xff, 0xff, 0xff, 0xff, 0x7f, 1, 0), 144, 144],
      ["blob-bomb", Uint8Array.of(0xb7, 1, 0x81, 0xff, 0xff, 0xff, 0x7f, 1, 0), 144, 144],
      ["forbidden-seek-stream", Uint8Array.of(0xb7, 1, 26, 1, 0, 0), 144, 144],
      ["duplicate-id", Uint8Array.of(0xb7, 2, 0, 1, 0, 0, 1, 0, 0), 144, 144],
      ["invalid-commands", invalidCommands, 144, 144],
      ["compressed-header", Uint8Array.of(0xb7, 1, 128, 7, 1, 0, 0x6a), 144, 144],
      ["huge-declared-header", Uint8Array.of(0xb7, 1, 0, 7, 255, 255, 255, 255, 100, 0, 1, 0x6a), 144, 144],
    ];
    for (const [name, encoded, w, h] of negatives) {
      const value = await client.call({ bytes: encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), width: w, height: h });
      assert.equal(value.status, 0, name); report.negative.push({ name, rejected: true });
    }
    // Same instance must remain usable after failures.
    const retry = await client.call({ bytes: stream.buffer, width: 144, height: 144 }); assert.equal(retry.status, 1);
    report.worker.retryAfterMalformed = true;
    const oom = await client.call({ bytes: stream.buffer, width: 144, height: 144, forceLowMemory: true }); assert.equal(oom.status, 0);
    assert.equal((await client.call({ bytes: stream.buffer, width: 144, height: 144 })).status, 1);
    report.worker.oomRejectedAndRecovered = true;
    report.geometry = await geometryGpu(device, geometry.gpuCases);
    const { default: createGeometry } = await import(base + "geometry.mjs");
    const geometryBinary = await bytes(base + "geometry.wasm");
    assert.equal(await sha(geometryBinary), build.geometryWasmHash);
    const gw = await createGeometry({ wasmBinary: geometryBinary });
    for (const c of geometry.streamCases) {
      const encoded = await bytes(base + c.file), p = gw._malloc(encoded.length), q = gw._malloc(c.inputBytes);
      try {
        gw.HEAPU8.set(encoded, p); const times = [];
        for (let i = 0; i < 12; i++) { const t = performance.now(); assert.equal(gw._u0_decompress(c.codec, p, encoded.length, q, c.inputBytes, c.stride), 1); if (i >= 2) times.push(performance.now() - t); }
        assert.equal(await sha(gw.HEAPU8.slice(q, q + c.inputBytes)), c.hash);
        report.geometryTransport.push({ file: c.file, decoded: c.inputBytes, encoded: encoded.length, warm: stats(times) });
      } finally { gw._free(q); gw._free(p); }
      if (c.codec === 1) {
        const value = await client.call({ kind: "zstd", bytes: encoded.buffer, outputSize: c.inputBytes, iterations: 12, batch: 32 });
        assert.equal(value.status, 1); assert.equal(await sha(value.bytes), c.hash); assert.equal(value.memoryBytes, 16777216);
        report.geometryTransport.at(-1).workerBatch32 = stats(value.times.slice(2));
      }
    }
    for (const [name, rawFile, encodedFile, expected] of [["bc4", "scalar.bc4", "scalar.bc4.zst", texture.bc4], ["coverage", "coverage.r8", "coverage.r8.zst", texture.coverage],
      ["max-page", "boundary.raw", "boundary.zst", geometry.boundary]]) {
      const encoded = await bytes(base + "texture/" + encodedFile), raw = await bytes(base + "texture/" + rawFile);
      const value = await client.call({ kind: "zstd", bytes: encoded.buffer, outputSize: raw.length });
      assert.equal(value.status, 1); assert.equal(await sha(value.bytes), expected.hash);
      report.scalar.push({ name, exact: true, bytes: raw.length, encodedBytes: encoded.length });
      if (name === "coverage") {
        const consumed = await consumeBc(device, consumePipeline, new Uint8Array(value.bytes), 143, 137, "r8unorm");
        for (let i = 0; i < raw.length; i++) assert.equal(consumed[i * 4], raw[i], "R8 GPU exact coverage");
        report.scalar.at(-1).gpuExact = true;
      }
      if (name === "bc4") {
        const consumed = await consumeBc(device, consumePipeline, new Uint8Array(value.bytes), 144, 144, "bc4-r-unorm");
        // Report the analytic palette difference; acceptance compares identical original/final GPU blocks.
        const expectedPixels = new Uint8Array(144 * 144 * 4);
        for (let block = 0; block < raw.length / 8; block++) {
          const at = block * 8, a = raw[at], b = raw[at + 1], palette = [a, b];
          if (a > b) for (let j = 1; j <= 6; j++) palette.push(((7 - j) * a + j * b) / 7);
          else { for (let j = 1; j <= 4; j++) palette.push(((5 - j) * a + j * b) / 5); palette.push(0, 255); }
          let indices = 0n;
          for (let j = 0; j < 6; j++) indices |= BigInt(raw[at + 2 + j]) << BigInt(j * 8);
          for (let p = 0; p < 16; p++) {
            const x = block % 36 * 4 + p % 4, y = Math.floor(block / 36) * 4 + Math.floor(p / 4);
            expectedPixels[(y * 144 + x) * 4] = Math.round(palette[Number(indices >> BigInt(p * 3) & 7n)]);
            expectedPixels[(y * 144 + x) * 4 + 3] = 255;
          }
        }
        report.scalar.at(-1).analyticPaletteDelta = imageMetrics(expectedPixels, consumed);
        const baselinePixels = await consumeBc(device, consumePipeline, raw, 144, 144, "bc4-r-unorm");
        assert.ok(equal(consumed, baselinePixels), "BC4 original versus reconstructed GPU samples");
        report.scalar.at(-1).gpuExact = true;
      }
      if (name === "max-page") for (const [label, input, size] of [["truncated", encoded.slice(0, -1), raw.length],
        ["concatenated", new Uint8Array([...encoded, ...encoded]), raw.length], ["wrong-output", encoded, raw.length - 1],
        ["oversized-output", encoded, raw.length + 1]]) {
        assert.equal((await client.call({ kind: "zstd", bytes: input.buffer, outputSize: size })).status, 0);
        report.zstdNegative.push(label);
      }
    }
    // Use the original pinned shader, unchanged, in an evaluation-only recorder.
    const shaderText = new TextDecoder().decode(await bytes("/.local/texture-design-spark/src/shaders/spark_bc7_rgba.wgsl"));
    const started = performance.now();
    const sparkPipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module: device.createShaderModule({ code: shaderText }), entryPoint: "main" } });
    report.sparkPipelineMs = performance.now() - started;
    const selected = texture.samples.filter((s) => s.name.includes("-vt-repeat-0-0") && s.q === 100);
    for (const sample of selected) for (const extension of sample.semantic === "base-color-srgb" ? ["webp", "avif"] : ["webp"]) {
      const encoded = await bytes(`${sample.stem}.${extension}`), canonical = await bytes(sample.stem + ".rgba");
      const imageStart = performance.now();
      const bitmap = await createImageBitmap(new Blob([encoded], { type: extension === "avif" ? "image/avif" : "image/webp" }), { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "none" });
      const decodeMs = performance.now() - imageStart;
      assert.equal(bitmap.width, sample.width); assert.equal(bitmap.height, sample.height);
      const input = device.createTexture({ size: [sample.width, sample.height], format: "rgba8unorm", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
      const pitch = Math.ceil(sample.width / 4 * 16 / 256) * 256, blockRows = sample.height / 4;
      const output = device.createBuffer({ size: pitch * blockRows, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
      const bind = device.createBindGroup({ layout: sparkPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: input.createView() }, { binding: 1, resource: sampler }, { binding: 2, resource: { buffer: output } }] });
      const times = []; let packed;
      try {
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: input, premultipliedAlpha: false, colorSpace: "srgb" }, [sample.width, sample.height]);
        for (let i = 0; i < 8; i++) {
          const t = performance.now(), encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(sparkPipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(sample.width / 4 / 16), Math.ceil(sample.height / 4 / 8)); pass.end();
          device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone(); if (i >= 2) times.push(performance.now() - t);
        }
        const raw = await readBuffer(device, device.createCommandEncoder(), output, output.size);
        packed = new Uint8Array(sample.width / 4 * blockRows * 16);
        for (let y = 0; y < blockRows; y++) packed.set(raw.subarray(y * pitch, y * pitch + sample.width / 4 * 16), y * sample.width / 4 * 16);
        const consumed = await consumeBc(device, consumePipeline, packed, sample.width, sample.height);
        let normalAngular = null;
        if (sample.semantic === "normal-linear") {
          let sum = 0, maximum = 0;
          for (let i = 0; i < canonical.length; i += 4) {
            const a = [0, 1, 2].map((c) => canonical[i + c] / 127.5 - 1), b = [0, 1, 2].map((c) => consumed[i + c] / 127.5 - 1);
            const angle = Math.acos(Math.max(-1, Math.min(1, a.reduce((s, x, c) => s + x * b[c], 0) / (Math.hypot(...a) * Math.hypot(...b))))) * 180 / Math.PI;
            sum += angle; maximum = Math.max(maximum, angle);
          }
          normalAngular = { mean: sum / (canonical.length / 4), maximum };
        }
        report.images.push({ id: sample.id, extension, networkBytes: encoded.length, decodeMs, encodeSubmitCompletion: stats(times), quality: imageMetrics(canonical, consumed), normalAngular, vsXubc: imageMetrics(await bytes(sample.stem + ".decoded.rgba"), consumed), packedHash: await sha(packed), outputScratch: output.size, inputBytes: sample.width * sample.height * 4 });
      } finally { bitmap.close(); input.destroy(); output.destroy(); }
    }
    return report;
  } finally { client.close(); }
}
