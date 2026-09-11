import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  KTX2_TRANSCODE_TARGET_FORMATS,
  validateAssetCodecTask,
  validateAssetCodecWorkerResult
} from "../.test-dist/assets/codec/AssetCodecTypes.js";
import { AssetWorkerPool } from "../.test-dist/assets/codec/AssetWorkerPool.js";
import {
  AssetCodecService,
  defaultAssetCodecWorkerCount
} from "../.test-dist/assets/codec/AssetCodecService.js";
import { planTextureDecode } from "../.test-dist/assets/codec/AssetCodecPlanner.js";
import {
  KTX_SOFTWARE_CODEC_ID,
  KTX_SOFTWARE_CODEC_REVISION,
  KTX_SOFTWARE_WASM_SHA256,
  createKtx2TranscodeTask,
  encodedTextureVariantFromKtx2Result
} from "../.test-dist/assets/codec/Ktx2BasisCodec.js";
import { transcodeKtx2Basis } from "../.test-dist/assets/codec/Ktx2BasisTranscoder.js";
import {
  openTextureAssetPackageV2,
  selectTextureAssetVariantV2,
  writeEncodedTextureAssetPackageV2
} from "../.test-dist/assets/TextureAssetPackage.js";

function task(overrides = {}) {
  return {
    taskId: 1,
    kind: "ktx2-transcode",
    priority: 0,
    estimatedPeakBytes: 16 * 1024 * 1024,
    sourceEncoding: "ktx2-uastc",
    semantic: "base-color-srgb",
    targetFormat: "bc7-rgba-unorm-srgb",
    input: new ArrayBuffer(1024),
    ...overrides
  };
}

class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  posted = [];
  terminated = false;

  postMessage(message, transfer = []) {
    this.posted.push({ message, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  result(value) {
    this.onmessage?.({ data: value });
  }

  fail(message = "worker failed") {
    this.onerror?.({ message, preventDefault() {} });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("asset codec task contract rejects invalid or unavailable protocol values", () => {
  assert.doesNotThrow(() => validateAssetCodecTask(task()));
  assert.ok(KTX2_TRANSCODE_TARGET_FORMATS.includes("bc7-rgba-unorm-srgb"));
  assert.throws(() => validateAssetCodecTask(task({ taskId: -1 })), /taskId/);
  assert.throws(() => validateAssetCodecTask(task({ priority: 3 })), /priority/);
  assert.throws(() => validateAssetCodecTask(task({ estimatedPeakBytes: 0 })), /estimatedPeakBytes/);
  assert.throws(() => validateAssetCodecTask(task({ kind: "draco-decode" })), /not enabled/);
  assert.throws(() => validateAssetCodecTask(task({ targetFormat: "r32float" })), /target/);
  assert.throws(() => validateAssetCodecWorkerResult({
    taskId: 1,
    ok: true,
    sourceEncoding: "ktx2-uastc",
    targetFormat: "bc7-rgba-unorm-srgb",
    mips: [{
      level: 0,
      logicalWidth: 4,
      logicalHeight: 4,
      physicalWidth: 4,
      physicalHeight: 4,
      payload: new ArrayBuffer(8)
    }],
    evidence: {
      queueWaitMs: 0,
      workerMs: 1,
      wallMs: 1,
      inputBytes: 1024,
      outputBytes: 8,
      estimatedPeakBytes: 2048,
      codecId: "fixture",
      codecRevision: "1",
      codecBinaryHash: "a".repeat(64)
    }
  }), /payload length/);
});

test("bounded pool preserves priority, FIFO, concurrency, memory, and transfer lists", async () => {
  const workers = [];
  const pool = new AssetWorkerPool({
    maxWorkers: 2,
    maxInFlightEstimatedBytes: 100,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }
  });
  const buffer0 = new ArrayBuffer(1);
  const first = pool.submit({ request: { id: 0 }, transfer: [buffer0], estimatedPeakBytes: 60, priority: 0 });
  const low = pool.submit({ request: { id: 1 }, transfer: [], estimatedPeakBytes: 60, priority: 1 });
  const high = pool.submit({ request: { id: 2 }, transfer: [], estimatedPeakBytes: 40, priority: 0 });
  await tick();
  assert.equal(workers.length, 2);
  assert.deepEqual(workers.map((worker) => worker.posted[0].message.id), [0, 2]);
  assert.strictEqual(workers[0].posted[0].transfer[0], buffer0);
  assert.equal(pool.evidence().activeWorkers, 2);
  assert.equal(pool.evidence().peakInFlightEstimatedBytes, 100);
  workers[1].result("high");
  assert.equal(await high, "high");
  assert.equal(workers[1].posted.length, 1, "60-byte FIFO head stays queued while 60 bytes remain active");
  workers[0].result("first");
  assert.equal(await first, "first");
  assert.equal(workers[0].posted[1].message.id, 1);
  workers[0].result("low");
  assert.equal(await low, "low");
  assert.equal(pool.evidence().inFlightEstimatedBytes, 0);
  pool.dispose();
  assert.ok(workers.every((worker) => worker.terminated));
});

test("pool releases reservations after errors, replaces a failed worker, and cancels work", async () => {
  const workers = [];
  const pool = new AssetWorkerPool({
    maxWorkers: 1,
    maxInFlightEstimatedBytes: 100,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }
  });
  const failed = pool.submit({ request: { id: 1 }, transfer: [], estimatedPeakBytes: 80, priority: 0 });
  await tick();
  workers[0].fail();
  await assert.rejects(failed, /worker failed/);
  assert.equal(pool.evidence().inFlightEstimatedBytes, 0);
  const controller = new AbortController();
  const cancelled = pool.submit({
    request: { id: 2 },
    transfer: [],
    estimatedPeakBytes: 80,
    priority: 0,
    signal: controller.signal
  });
  await tick();
  assert.equal(workers.length, 2);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(pool.evidence().inFlightEstimatedBytes, 0);
  pool.dispose();
});

test("pool dispose rejects queued and active tasks idempotently", async () => {
  const worker = new FakeWorker();
  const pool = new AssetWorkerPool({
    maxWorkers: 1,
    maxInFlightEstimatedBytes: 64,
    createWorker: () => worker
  });
  const active = pool.submit({ request: 1, transfer: [], estimatedPeakBytes: 64, priority: 0 });
  const queued = pool.submit({ request: 2, transfer: [], estimatedPeakBytes: 64, priority: 0 });
  await tick();
  pool.dispose();
  pool.dispose();
  await assert.rejects(active, /disposed/);
  await assert.rejects(queued, /disposed/);
  assert.equal(worker.terminated, true);
});

test("codec service is lazy, bounded by hardware concurrency, and publishes stable evidence", async () => {
  assert.equal(defaultAssetCodecWorkerCount(1), 1);
  assert.equal(defaultAssetCodecWorkerCount(8), 4);
  assert.equal(defaultAssetCodecWorkerCount(128), 4);
  let creates = 0;
  let worker;
  const service = new AssetCodecService({
    hardwareConcurrency: 6,
    createWorker: () => {
      creates++;
      worker = new FakeWorker();
      return worker;
    },
    now: (() => { let value = 0; return () => ++value; })()
  });
  assert.equal(service.maxWorkers, 3);
  assert.equal(creates, 0);
  const input = task({ estimatedPeakBytes: 2048 });
  const promise = service.submit(input);
  await tick();
  assert.equal(creates, 1);
  assert.strictEqual(worker.posted[0].transfer[0], input.input);
  worker.result({
    type: "result",
    result: {
      taskId: input.taskId,
      ok: true,
      sourceEncoding: input.sourceEncoding,
      targetFormat: input.targetFormat,
      mips: [{
        level: 0,
        logicalWidth: 4,
        logicalHeight: 4,
        physicalWidth: 4,
        physicalHeight: 4,
        payload: new ArrayBuffer(16)
      }],
      evidence: {
        queueWaitMs: 2,
        workerMs: 3,
        wallMs: 5,
        inputBytes: 1024,
        outputBytes: 16,
        estimatedPeakBytes: 2048,
        codecId: "fixture",
        codecRevision: "1",
        codecBinaryHash: "a".repeat(64)
      }
    }
  });
  const result = await promise;
  assert.equal(result.evidence.codecId, "fixture");
  assert.deepEqual(service.evidence(), {
    schemaVersion: 2,
    tasksQueued: 1,
    tasksCompleted: 1,
    tasksFailed: 0,
    tasksCancelled: 0,
    activeWorkers: 0,
    peakActiveWorkers: 1,
    queuedTasks: 0,
    inFlightEstimatedBytes: 0,
    peakInFlightEstimatedBytes: 2048,
    queueWaitMs: 2,
    workerMs: 3,
    wallMs: 5,
    inputBytes: 1024,
    outputBytes: 16,
    transferBytes: 1040,
    workerFailures: 0,
    directPathCount: 0,
    workerPathCount: 1,
    uncompressedPathCount: 0,
    codecIdentities: [{
      codecId: "fixture",
      codecRevision: "1",
      codecBinaryHash: "a".repeat(64),
      completedTaskCount: 1
    }]
  });
  service.destroy();
  service.destroy();
});

test("texture planner selects direct, worker, then explicitly declared fallback", () => {
  const capabilities = {
    enabledFeatures: new Set(["texture-compression-bc"]),
    transcoderTargets: new Set(["bc7-rgba-unorm-srgb", "bc5-rg-unorm", "bc4-r-unorm"])
  };
  assert.deepEqual(planTextureDecode({
    semantic: "base-color-srgb",
    variants: [
      { variantId: "direct", encoding: "gpu-native", format: "bc3-rgba-unorm-srgb" },
      { variantId: "source", encoding: "ktx2-uastc" },
      { variantId: "fallback", encoding: "rgba8" }
    ],
    capabilities,
    allowUncompressedFallback: true
  }), { mode: "direct", variantId: "direct", targetFormat: "bc3-rgba-unorm-srgb" });
  assert.deepEqual(planTextureDecode({
    semantic: "normal-linear",
    variants: [{ variantId: "source", encoding: "ktx2-uastc" }, { variantId: "fallback", encoding: "rgba8" }],
    capabilities,
    allowUncompressedFallback: true
  }), { mode: "worker-transcode", variantId: "source", sourceEncoding: "ktx2-uastc", targetFormat: "bc5-rg-unorm" });
  assert.deepEqual(planTextureDecode({
    semantic: "base-color-srgb",
    variants: [{ variantId: "fallback", encoding: "rgba8" }],
    capabilities: { enabledFeatures: new Set(), transcoderTargets: new Set() },
    allowUncompressedFallback: true
  }), { mode: "uncompressed", variantId: "fallback", targetFormat: "rgba8unorm-srgb" });
  assert.throws(() => planTextureDecode({
    semantic: "base-color-srgb",
    variants: [{ variantId: "fallback", encoding: "rgba8" }],
    capabilities: { enabledFeatures: new Set(), transcoderTargets: new Set() },
    allowUncompressedFallback: false
  }), /no declared variant/);
});

test("pinned Khronos libktx WASM transcodes the deterministic UASTC fixture to BC7", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "oengine-ktx-test-"));
  try {
    const cjs = join(temporary, "libktx_read.cjs");
    const wrapper = await readFile(
      new URL("../src/assets/codec/vendor/ktx-software-4.4.2/libktx_read.js", import.meta.url),
      "utf8"
    );
    await writeFile(cjs, wrapper.replace("export default createKtxReadModule;", ""));
    const require = createRequire(import.meta.url);
    const createKtxReadModule = require(cjs);
    const wasm = await readFile(new URL(
      "../src/assets/codec/vendor/ktx-software-4.4.2/libktx_read.wasm",
      import.meta.url
    ));
    const module = await createKtxReadModule({
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
      print() {},
      printErr() {}
    });
    const fixture = await readFile(new URL(
      "./fixtures/texture-codec/luminance-alpha-32x32-uastc.ktx2",
      import.meta.url
    ));
    const input = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
    const codecTask = createKtx2TranscodeTask({
      taskId: 77,
      kind: "ktx2-transcode",
      priority: 0,
      sourceEncoding: "ktx2-uastc",
      semantic: "base-color-srgb",
      targetFormat: "bc7-rgba-unorm-srgb",
      input
    });
    const result = transcodeKtx2Basis(module, codecTask, {
      codecId: KTX_SOFTWARE_CODEC_ID,
      codecRevision: KTX_SOFTWARE_CODEC_REVISION,
      codecBinaryHash: KTX_SOFTWARE_WASM_SHA256
    });
    assert.equal(result.ok, true);
    assert.equal(result.mips.length, 1);
    assert.equal(result.mips[0].logicalWidth, 32);
    assert.equal(result.mips[0].logicalHeight, 32);
    assert.equal(result.mips[0].payload.byteLength, 32 / 4 * (32 / 4) * 16);
    assert.equal(result.evidence.codecId, KTX_SOFTWARE_CODEC_ID);
    assert.equal(result.evidence.codecBinaryHash, KTX_SOFTWARE_WASM_SHA256);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("pinned ETC1S mip chain normalizes into the ordinary encoded package contract", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "oengine-ktx-package-test-"));
  try {
    const cjs = join(temporary, "libktx_read.cjs");
    const wrapper = await readFile(
      new URL("../src/assets/codec/vendor/ktx-software-4.4.2/libktx_read.js", import.meta.url),
      "utf8"
    );
    await writeFile(cjs, wrapper.replace("export default createKtxReadModule;", ""));
    const createKtxReadModule = createRequire(import.meta.url)(cjs);
    const wasm = await readFile(new URL(
      "../src/assets/codec/vendor/ktx-software-4.4.2/libktx_read.wasm",
      import.meta.url
    ));
    const module = await createKtxReadModule({
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
      print() {},
      printErr() {}
    });
    const fixture = await readFile(new URL(
      "./fixtures/texture-codec/rgba-64x64-mipmap-etc1s.ktx2",
      import.meta.url
    ));
    const input = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
    const result = transcodeKtx2Basis(module, createKtx2TranscodeTask({
      taskId: 78,
      kind: "ktx2-transcode",
      priority: 0,
      sourceEncoding: "ktx2-etc1s",
      semantic: "base-color-srgb",
      targetFormat: "bc7-rgba-unorm-srgb",
      input
    }), {
      codecId: KTX_SOFTWARE_CODEC_ID,
      codecRevision: KTX_SOFTWARE_CODEC_REVISION,
      codecBinaryHash: KTX_SOFTWARE_WASM_SHA256
    });
    assert.equal(result.mips.length, 7);
    const packageBytes = await writeEncodedTextureAssetPackageV2({
      width: 64,
      height: 64,
      semantic: "base-color-srgb",
      sourceUri: "fixture://rgba-64x64-mipmap-etc1s.ktx2",
      sourceByteLength: fixture.byteLength,
      sourceContentHash: "267b18c4badb42fb9739ef42b5e5cd9c2d95872e55ae298a82000fb402c33958"
    }, [encodedTextureVariantFromKtx2Result(result, "base-color-srgb")]);
    const asset = await openTextureAssetPackageV2(packageBytes);
    const selected = selectTextureAssetVariantV2(asset, new Set(["texture-compression-bc"]));
    assert.equal(selected.profile, "worker-transcoded");
    assert.equal(selected.format, "bc7-rgba-unorm-srgb");
    assert.equal(selected.mips.length, 7);
    assert.equal(selected.codecBinaryHash, KTX_SOFTWARE_WASM_SHA256);
    assert.equal(asset.evidence.sourceBytes, fixture.byteLength);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
