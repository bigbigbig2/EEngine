import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PcTexturePreparation } from "../../.test-dist/assets/codec/PcTexturePreparation.js";
import createBasis from "../../src/assets/codec/vendor/pc-texture/basis_bc.js";
import createKtx from "../../src/assets/codec/vendor/pc-texture/ktx_pc.js";
import {
  cookPcTextureRgba,
  importPcTextureKtx,
  decodePcTextureMip,
  encodePcTextureMip,
  resamplePcTexture,
  estimatePcTextureCookBytes
} from "../../.test-dist/assets/codec/PcTextureCook.js";
import {
  validateTextureProduct,
  saveTextureProduct,
  openTextureProduct,
  PC_TEXTURE_WASM_LIMIT
} from "../../.test-dist/assets/TextureProduct.js";
const vendor = new URL("../../src/assets/codec/vendor/pc-texture/", import.meta.url);
const source = JSON.parse(await readFile(new URL("source.json", vendor), "utf8"));
const binary = async (name) => new Uint8Array(await readFile(new URL(name, vendor)));
const bcBinary = await binary("basis_bc.wasm"),
  ktxBinary = await binary("ktx_pc.wasm");
assert.equal(createHash("sha256").update(bcBinary).digest("hex"), source.hashes["basis_bc.wasm"]);
const codecs = {
  basis: await createBasis({ wasmBinary: bcBinary.buffer }),
  ktx: await createKtx({ wasmBinary: ktxBinary.buffer }),
  basisHash: source.hashes["basis_bc.wasm"],
  ktxHash: source.hashes["ktx_pc.wasm"]
};
function image(w, h) {
  const a = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      a.set(
        [(x * 13 + y * 3) % 256, (x * 3 + y * 11) % 256, (x * 7 + y * 5) % 256, (x + y) % 2 ? 127 : 128],
        i
      );
    }
  return a;
}
const options = { semantic: "base-color-srgb", sourceUri: "test://authored" };
test("schema3 NPOT whole-domain full tails, exact coverage, disk/in-memory same contract", async () => {
  const result = await cookPcTextureRgba(codecs, image(257, 129), 257, 129, { ...options, exactAlpha: true });
  const p = result.product;
  assert.deepEqual([p.metadata.storageWidth, p.metadata.storageHeight], [260, 132]);
  assert.deepEqual(p.metadata.uvScaleBias, [1, 1, 0, 0]);
  assert.equal(p.metadata.planes[0].mips[1].width, 130);
  assert.equal(p.metadata.planes[0].mips.at(-1).width, 1);
  const encoded = await saveTextureProduct(p),
    opened = await openTextureProduct(encoded);
  assert.equal(opened.identity, p.identity);
  for (const [id, bytes] of p.chunks) assert.deepEqual(opened.chunks.get(id), bytes);
  const base = resamplePcTexture(codecs.basis, image(257, 129), 257, 129, 260, 132, true, false);
  assert.deepEqual(
    p.chunks.get("coverage-mip-0"),
    Uint8Array.from({ length: 260 * 132 }, (_, i) => base[i * 4 + 3])
  );
  assert.equal(p.evidence.runtimeMipPasses, 0);
  assert.equal(p.evidence.actualDecodedPeakBytes, null);
  await assert.rejects(validateTextureProduct({ ...p.metadata, schemaVersion: 2 }, p.chunks), /recook/);
  await assert.rejects(validateTextureProduct({ ...p.metadata, unknown: true }, p.chunks), /unknown/);
  await assert.rejects(validateTextureProduct({ ...p.metadata, storageWidth: 257 }, p.chunks), /domain/);
  const bad = new Map(p.chunks);
  bad.set("color-mip-0", new Uint8Array(bad.get("color-mip-0").length));
  await assert.rejects(validateTextureProduct(p.metadata, bad), /checksum/);
  const corrupt = encoded.slice(0);
  new Uint8Array(corrupt)[corrupt.byteLength - 17] ^= 1;
  await assert.rejects(openTextureProduct(corrupt));
});
test("scalar source channel, semantic identity, provided signed non-unit normal mips", async () => {
  const rgba = image(8, 8);
  const r = await cookPcTextureRgba(codecs, rgba, 8, 8, {
    semantic: "occlusion-linear",
    channel: 1,
    sourceUri: "test://scalar"
  });
  assert.equal(r.product.metadata.planes[0].format, "bc4-r-unorm");
  assert.equal(r.product.metadata.channel, 1);
  const bc = r.product.chunks.get("scalar-mip-0"),
    decoded = decodePcTextureMip(codecs.basis, bc, 8, 8, 4);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(decoded[i * 4] - rgba[i * 4 + 1]) <= 16);
  const mips = [
    new Uint8Array(4 * 4 * 4).fill(32),
    new Uint8Array(2 * 2 * 4).fill(64),
    new Uint8Array(4).fill(96)
  ];
  const n = await cookPcTextureRgba(
    codecs,
    rgba,
    8,
    8,
    { semantic: "normal-linear", sourceUri: "test://normal" },
    mips
  );
  assert.equal(n.product.metadata.recipe.filter, "provided");
  assert.equal(n.product.metadata.planes[0].format, "bc7-rgba-unorm");
  const data = decodePcTextureMip(codecs.basis, n.product.chunks.get("color-mip-1"), 4, 4, 7);
  assert.ok(data[2] < 128, "signed negative Z preserved");
  assert.ok(
    Math.hypot(...Array.from(data.slice(0, 3), (v) => (v / 255) * 2 - 1)) > 1.1,
    "no positive Z reconstruction/normalization of supplied mip"
  );
  const same = await cookPcTextureRgba(
    codecs,
    rgba,
    8,
    8,
    { semantic: "normal-linear", sourceUri: "test://different-material-sampler-uv" },
    mips
  );
  assert.equal(same.product.identity, n.product.identity, "sampler/URI/UV not payload identity");
  const changed = mips.map((m) => m.slice());
  changed[0][2] = 160;
  const other = await cookPcTextureRgba(
    codecs,
    rgba,
    8,
    8,
    { semantic: "normal-linear", sourceUri: "test://normal" },
    changed
  );
  assert.notEqual(other.product.identity, n.product.identity, "provided mip changes invalidate identity");
  assert.notEqual(n.product.identity, r.product.identity);
  assert.ok(estimatePcTextureCookBytes(4096, 4096, "normal-linear", false) <= PC_TEXTURE_WASM_LIMIT);
  assert.throws(() => estimatePcTextureCookBytes(16384, 16384, "normal-linear", false), /memory|budget/);
});
test("provided NPOT normal mips retain signed/non-unit XYZ in canonical storage and added tails", async () => {
  for (const [w, h] of [
    [33, 17],
    [3, 3]
  ]) {
    const provided = [];
    for (let level = 1; level <= Math.floor(Math.log2(Math.max(w, h))); level++) {
      provided.push(new Uint8Array(Math.max(1, w >> level) * Math.max(1, h >> level) * 4).fill(32));
    }
    const { product } = await cookPcTextureRgba(
      codecs,
      new Uint8Array(w * h * 4).fill(32),
      w,
      h,
      { semantic: "normal-linear", sourceUri: "test://provided-NPOT" },
      provided
    );
    assert.equal(product.metadata.recipe.filter, "provided");
    for (const mip of product.metadata.planes[0].mips) {
      const decoded = decodePcTextureMip(
        codecs.basis,
        product.chunks.get(mip.chunkId),
        mip.width,
        mip.height,
        7
      );
      assert.deepEqual([...decoded.slice(0, 3)], [32, 32, 32]);
      assert.ok(Math.hypot(...Array.from(decoded.slice(0, 3), (v) => (v / 255) * 2 - 1)) > 1.1);
    }
    assert.equal((await openTextureProduct(await saveTextureProduct(product))).identity, product.identity);
  }
});

test("libktx metadata admission, ETC1S full chain, UASTC missing mips recook, real Zstd", async () => {
  for (const [name, count] of [
    ["rgba-64x64-mipmap-etc1s.ktx2", 7],
    ["luminance-alpha-32x32-uastc.ktx2", 6]
  ]) {
    const input = new Uint8Array(
      await readFile(new URL(`../fixtures/texture-codec/${name}`, import.meta.url))
    );
    const result = await importPcTextureKtx(codecs, input, options);
    assert.equal(result.product.metadata.planes[0].mips.length, count);
    assert.equal(result.product.metadata.planes[0].format, "bc7-rgba-unorm-srgb");
  }
  const zstd = new Uint8Array(
    await readFile(new URL("../fixtures/texture-codec/uastc-zstd.ktx2", import.meta.url))
  );
  const result = await importPcTextureKtx(codecs, zstd, options);
  assert.ok(result.product.evidence.ownedPayloadBytes > 0);
  const invalid = zstd.slice(0, 80);
  await assert.rejects(importPcTextureKtx(codecs, invalid, options), /KTX/);
  const shaped = zstd.slice();
  new DataView(shaped.buffer).setUint32(36, 6, true);
  await assert.rejects(importPcTextureKtx(codecs, shaped, options), /KTX/);
});
test("native independent quality6 encoder matches WASM; upstream CPU decode", async () => {
  const root = new URL("../../../.local/t4-1-codec-build/", import.meta.url);
  await mkdir(root, { recursive: true });
  const rgba = image(32, 32),
    input = new URL("reference.rgba", root),
    output = new URL("reference.bc", root);
  await writeFile(input, rgba);
  const exe = new URL("bc-reference.exe", root);
  const { fileURLToPath } = await import("node:url");
  const run = spawnSync(
    fileURLToPath(exe),
    ["encode", "32", "32", "7", "1", fileURLToPath(input), fileURLToPath(output)],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    new Uint8Array(await readFile(output)),
    encodePcTextureMip(codecs.basis, rgba, 32, 32, 7, true, 0)
  );
});

for (const [w, h] of [
  [1024, 1024],
  [2048, 2048],
  [4096, 4096],
  [257, 129]
])
  test(`native canonical reference precedes WASM: full mip BC7/BC4 ${w}x${h}`, async () => {
    const root = new URL("../../../.local/t4-1-codec-build/", import.meta.url);
    const input = new URL(`canonical-${w}.rgba`, root),
      output = new URL(`canonical-${w}.output`, root);
    const exe = fileURLToPath(new URL("bc-reference.exe", root));
    const records = [];
    for (const semantic of ["base-color-srgb", "normal-linear", "orm-linear", "occlusion-linear"]) {
      const rgba = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          rgba.set(
            semantic === "normal-linear"
              ? [80 + (x % 32), 90 + (y % 32), x % 64 < 32 ? 45 : 200, 255]
              : [
                  40 + ((x >> 4) % 128),
                  60 + ((y >> 4) % 128),
                  100 + (((x + y) >> 4) % 128),
                  (x + y) % 2 ? 127 : 128
                ],
            (y * w + x) * 4
          );
        }
      }
      const srgb = semantic === "base-color-srgb",
        normal = semantic === "normal-linear";
      const format = semantic === "occlusion-linear" ? 4 : 7,
        channel = format === 4 ? 1 : 0;
      const sw = Math.ceil(w / 4) * 4,
        sh = Math.ceil(h / 4) * 4;
      let pixels = rgba,
        previousWidth = w,
        previousHeight = h;
      const references = [];
      for (let level = 0; level <= Math.floor(Math.log2(Math.max(sw, sh))); level++) {
        const mw = Math.max(1, sw >> level),
          mh = Math.max(1, sh >> level);
        await writeFile(input, pixels);
        if (mw !== previousWidth || mh !== previousHeight) {
          const result = spawnSync(
            exe,
            [
              "resample",
              previousWidth,
              previousHeight,
              mw,
              mh,
              Number(srgb),
              Number(normal),
              fileURLToPath(input),
              fileURLToPath(output)
            ].map(String),
            { encoding: "utf8", windowsHide: true }
          );
          assert.equal(result.status, 0, result.stderr);
          pixels = new Uint8Array(await readFile(output));
          await writeFile(input, pixels);
        }
        const result = spawnSync(
          exe,
          ["encode", mw, mh, format, Number(srgb), fileURLToPath(input), fileURLToPath(output), channel].map(
            String
          ),
          { encoding: "utf8", windowsHide: true }
        );
        assert.equal(result.status, 0, result.stderr);
        references.push(
          createHash("sha256")
            .update(await readFile(output))
            .digest("hex")
        );
        previousWidth = mw;
        previousHeight = mh;
      }
      // Reference hashes are frozen before the candidate is produced.
      const reference = Object.freeze([...references]);
      const { product, evidence } = await cookPcTextureRgba(codecs, rgba, w, h, {
        semantic,
        channel,
        sourceUri: "test://canonical-native"
      });
      records.push({
        w,
        h,
        semantic,
        reference,
        candidateMipHashes: product.metadata.planes[0].mips.map((m) => m.hash),
        candidate: product.identity,
        wasmLinearHighWaterBytes: evidence.wasmLinearHighWaterBytes
      });
      await writeFile(new URL(`reference-records-${w}.json`, root), JSON.stringify(records, null, 2));
      assert.deepEqual(records.at(-1).candidateMipHashes, reference, `${w}x${h} ${semantic}`);
      assert.ok(evidence.wasmLinearHighWaterBytes <= PC_TEXTURE_WASM_LIMIT);
    }
  });

class CookWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  posted = [];
  terminated = false;
  postMessage(task) {
    this.posted.push(task);
  }
  terminate() {
    this.terminated = true;
  }
  result(value) {
    this.onmessage?.({ data: value });
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
async function assigned(worker) {
  for (let i = 0; i < 1000 && worker.posted.length === 0; i++) {
    await tick();
  }
  assert.ok(worker.posted.length > 0, "Worker task assigned");
}
test("preparation init failure, invalid result, queued/assigned cancellation, retry and dispose", async () => {
  const workers = [];
  let first = true;
  const service = new PcTexturePreparation({
    createWorker: async () => {
      if (first) {
        first = false;
        throw new Error("init failed");
      }
      const worker = new CookWorker();
      workers.push(worker);
      return worker;
    }
  });
  const submit = (signal) => service.cookRgba(image(8, 8).buffer, 8, 8, options, signal);
  const firstTask = submit();
  for (let i = 0; i < 1000 && workers.length === 0; i++) {
    await tick();
  }
  await assigned(workers[0]);
  const task = workers[0].posted[0];
  const cooked = await cookPcTextureRgba(codecs, new Uint8Array(task.input), 8, 8, task.options);
  workers[0].result({
    ok: true,
    taskId: task.taskId,
    metadata: { ...cooked.product.metadata, channel: 1 },
    chunks: cooked.product.chunks,
    evidence: cooked.evidence
  });
  await assert.rejects(firstTask, /identity/);
  assert.equal(service.evidence().workerFailures, 1);
  const activeAbort = new AbortController(),
    queuedAbort = new AbortController();
  const active = submit(activeAbort.signal),
    queued = submit(queuedAbort.signal);
  const activeCheck = assert.rejects(active, { name: "AbortError" });
  const queuedCheck = assert.rejects(queued, { name: "AbortError" });
  for (let i = 0; i < 1000 && service.evidence().queuedTasks === 0; i++) {
    await tick();
  }
  queuedAbort.abort();
  activeAbort.abort();
  await Promise.all([activeCheck, queuedCheck]);
  const staleCallback = workers[0].onmessage;
  const retry = submit();
  for (let i = 0; i < 1000 && workers.length < 2; i++) {
    await tick();
  }
  await assigned(workers[1]);
  staleCallback?.({ data: { ok: true, ...cooked.product, taskId: task.taskId } });
  const retryTask = workers[1].posted[0];
  const result = await cookPcTextureRgba(codecs, new Uint8Array(retryTask.input), 8, 8, retryTask.options);
  workers[1].result({
    ok: true,
    taskId: retryTask.taskId,
    metadata: result.product.metadata,
    chunks: result.product.chunks,
    evidence: result.evidence
  });
  assert.equal((await retry).product.identity, result.product.identity);
  const pending = submit();
  const rejection = assert.rejects(pending, /disposed/);
  await tick();
  service.dispose();
  await rejection;
  const evidence = service.evidence();
  assert.equal(evidence.activeWorkers, 0);
  assert.equal(evidence.queuedTasks, 0);
  assert.equal(evidence.inFlightEstimatedBytes, 0);
});

test("native byte-domain checks precede pointer reads; overflow is explicit", () => {
  assert.throws(() => encodePcTextureMip(codecs.basis, new Uint8Array(1), 4, 4, 7, false, 0), /byte domain/);
  assert.throws(() => decodePcTextureMip(codecs.basis, new Uint8Array(7), 4, 4, 4), /bytes/);
  assert.throws(
    () => resamplePcTexture(codecs.basis, image(4, 4), 4, 4, 16384, 16384, false, false),
    /budget/
  );
});
