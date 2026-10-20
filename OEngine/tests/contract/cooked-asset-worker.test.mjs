import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { textureProduct } from "../fixtures/texture-product.mjs";
import { CookedAssetPreparation } from "../../.test-dist/assets/codec/CookedAssetPreparation.js";
import { cookedGeometrySpans } from "../../.test-dist/assets/codec/CookedAssetProtocol.js";
import {
  releasePreparedPage,
  preparedResidentPage,
} from "../../.test-dist/assets/geometry-product/GeometryProductResidentAttributes.js";
import {
  saveTextureProduct,
  importCookedTextureReceipt,
  assertValidatedTextureProduct,
} from "../../.test-dist/assets/TextureProduct.js";
import { isPageIntegrityPreverifiedV1 } from "../../.test-dist/assets/geometry-product/GeometryProductV1.js";
import { VirtualGeometryResidency } from "../../.test-dist/gpu/VirtualGeometryResidency.js";
import { CookedAssetCredit } from "../../.test-dist/assets/codec/CookedAssetCredit.js";

globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8 };

function device() {
  return {
    limits: {
      maxBufferSize: 256 * 1024 * 1024,
      maxStorageBufferBindingSize: 256 * 1024 * 1024,
      maxStorageBuffersPerShaderStage: 16,
    },
    createBuffer(descriptor) {
      return { ...descriptor, destroy() {} };
    },
    queue: { writeBuffer() {}, async onSubmittedWorkDone() {} },
  };
}

// Real isolated JS realm and actual transferable ownership. Only browser event
// names are adapted; the production Worker entry and kernels are unchanged.
class DedicatedWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  detached = [];
  registrations = [];
  constructor() {
    this.inner = new Worker(new URL("../helpers/cooked-worker-host.mjs", import.meta.url));
    this.inner.on("message", (data) => {
      if (data.transferProof) this.detached.push(data.detached);
      else this.onmessage?.({ data });
    });
    this.inner.on("error", (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
    this.inner.on("messageerror", () => this.onmessageerror?.());
  }
  postMessage(message, transfer) {
    if (message.registration) this.registrations.push(message.session);
    this.inner.postMessage(message, transfer);
  }
  terminate() {
    void this.inner.terminate();
  }
  crash() {
    this.inner.postMessage({ crash: true });
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function fixture() {
  const f = await streamingProductFixture(2);
  const pages = await Promise.all([0, 1].map((id) => f.source.readPage(id)));
  const payload = new Uint8Array(2 * 262144);
  pages.forEach((page, id) => payload.set(new Uint8Array(page.bytes), id * 262144));
  const directories = pages.map((page, id) => ({
    compressedFileOffset: BigInt(id * 262144),
    compressedBytes: 262144,
    decodedBytes: 262144,
    codec: 0,
    firstGroup: id,
    groupCount: 1,
    compressedChecksum: crc32(new Uint8Array(page.bytes)),
    decodedContentHash128: "00".repeat(16),
  }));
  const registration = {
    descriptor: f.descriptor,
    pages: directories,
    groups: [0, 1].map((pageId) => ({ pageId, offsetInDecodedPage: 0, payloadBytes: 176, meshletCount: 1 })),
    formats: [{ strideBytes: 16 }],
    init: {},
    verifyPageSha256: true,
  };
  return { payload, registration };
}

const waitUntil = async (predicate) => {
  const until = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > until) throw Error("Worker observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("Cooked Worker batch validates, transfers, cancels, re-registers and releases bounded results", async () => {
  const f = await fixture();
  const product = await textureProduct();
  const texture = new Uint8Array(await saveTextureProduct(product));
  let bytes = f.payload,
    delayed = false,
    requests = [];
  const server = createServer(async (request, response) => {
    const data = request.url === "/texture" ? texture : bytes;
    if (request.method === "HEAD") {
      response.writeHead(200, { "content-length": data.length });
      response.end();
      return;
    }
    requests.push(request.headers.range ?? "texture");
    if (delayed) await new Promise((resolve) => setTimeout(resolve, 200));
    if (request.headers.range) {
      const match = /bytes=(\d+)-(\d+)/u.exec(request.headers.range);
      const start = Number(match[1]),
        end = Number(match[2]);
      response.writeHead(206, {
        "content-range": "bytes " + start + "-" + end + "/" + data.length,
        "content-length": end - start + 1,
      });
      response.end(data.subarray(start, end + 1));
    } else {
      response.writeHead(200, { "content-length": data.length });
      response.end(data);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  const workers = [];
  const preparation = new CookedAssetPreparation({
    maxWorkers: 1,
    createWorker: () => {
      const worker = new DedicatedWorker();
      workers.push(worker);
      return worker;
    },
  });
  const session = preparation.openSession();
  const registration = { ...f.registration, url: url + "/geometry" };
  try {
    const pages = await preparation.readGeometry(session, registration, [1, 0]);
    assert.deepEqual(
      pages.map((page) => page.pageId),
      [1, 0],
    );
    assert.equal(requests.length, 1, "adjacent pages share one HTTP range");
    assert.ok(pages.every(isPageIntegrityPreverifiedV1));
    assert.equal(preparedResidentPage(pages[0]).triangleCount, 1);
    assert.equal(preparation.evidence().credit.used.ready, 4 * 262144);
    pages.forEach(releasePreparedPage);
    assert.equal(preparation.evidence().credit.used.total, 0);
    const imported = await preparation.readTexture(session, url + "/texture", product.identity);
    assertValidatedTextureProduct(imported);
    await assert.rejects(
      importCookedTextureReceipt({ ok: true, kind: "texture", product: imported }, imported.identity),
      /assigned asset Worker/,
    );
    await waitUntil(() => workers[0].detached.length >= 2);
    assert.ok(
      workers[0].detached.flat().every((length) => length === 0),
      "sender buffers really detach",
    );
    assert.equal(workers[0].registrations.length, 1);

    // Deterministic transport, layout and resident numeric failures each keep
    // their original validation owner, including with decoded SHA disabled.
    for (const [offset, value, pattern, updateCrc] of [
      [200, 1, /checksum/, false],
      [48, 0, /offset|section|header/, true],
      [116, 0x7f800000, /nonfinite/, true],
    ]) {
      bytes = f.payload.slice();
      new DataView(bytes.buffer).setUint32(offset, value, true);
      const corrupt = structuredClone(registration);
      if (updateCrc) corrupt.pages[0].compressedChecksum = crc32(bytes.subarray(0, 262144));
      corrupt.verifyPageSha256 = false;
      const badSession = preparation.openSession();
      await assert.rejects(preparation.readGeometry(badSession, corrupt, [0]), pattern);
      preparation.closeSession(badSession);
      assert.equal(preparation.evidence().credit.used.total, 0);
    }
    bytes = f.payload;
    texture[texture.length - 1] ^= 1;
    await assert.rejects(
      preparation.readTexture(session, url + "/texture", product.identity),
      /checksum|hash|integrity/i,
    );
    texture[texture.length - 1] ^= 1;

    delayed = true;
    const controller = new AbortController();
    const count = requests.length;
    const cancelled = preparation.readGeometry(session, registration, [0], controller.signal);
    await waitUntil(() => requests.length > count);
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(preparation.evidence().credit.used.total, 0);
    delayed = false;
    const afterCancel = await preparation.readGeometry(session, registration, [0]);
    afterCancel.forEach(releasePreparedPage);
    assert.equal(workers.length, 2);
    assert.equal(workers[1].registrations.length, 1, "replacement Worker receives the descriptor again");

    delayed = true;
    const beforeCrash = requests.length;
    const crashed = preparation.readGeometry(session, registration, [1]);
    await waitUntil(() => requests.length > beforeCrash);
    workers[1].crash();
    await assert.rejects(crashed, /deliberate Worker crash/);
    delayed = false;
    const recovered = await preparation.readGeometry(session, registration, [1]);
    recovered.forEach(releasePreparedPage);
    assert.equal(workers[2].registrations.length, 1);
    assert.equal(preparation.evidence().credit.used.total, 0);
    assert.equal(preparation.evidence().activeWorkers, 0);
    const source = {
      descriptor: registration.descriptor,
      readPages: (ids) => preparation.readGeometry(session, registration, ids),
      readPage: async (id) => (await preparation.readGeometry(session, registration, [id]))[0],
      release: () => preparation.closeSession(session),
    };
    const owner = await VirtualGeometryResidency.create(device(), source, 9, 0, undefined, {
      configuredCapacityBytes: 2 * 1024 * 1024,
    });
    assert.equal(preparation.evidence().credit.used.total, 0, "bootstrap consumes the ready lease");
    const checkpoint = owner.checkpointForDeviceLoss();
    const replay = await VirtualGeometryResidency.create(device(), checkpoint, 10, 0, undefined, {
      configuredCapacityBytes: 2 * 1024 * 1024,
    });
    assert.ok(replay.pageLocation(0), "device-independent Worker source replays into the replacement device");
    replay.destroy();
    assert.equal(preparation.evidence().sessions, 0);
    const releasedSession = preparation.openSession();
    const discarded = await preparation.readGeometry(releasedSession, registration, [1]);
    assert.ok(preparation.evidence().credit.used.ready > 0);
    preparation.closeSession(releasedSession);
    assert.equal(
      preparation.evidence().credit.used.total,
      0,
      "source release revokes outstanding ready credit",
    );
    discarded.forEach(releasePreparedPage);
    preparation.closeSession(session);
    await assert.rejects(preparation.readGeometry(session, registration, [0]), /closed/);
  } finally {
    preparation.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Worker creation failure is explicit and releases Cooked task credit", async () => {
  const { registration } = await fixture();
  const preparation = new CookedAssetPreparation({
    createWorker() {
      throw new Error("Dedicated Worker unavailable");
    },
  });
  try {
    const session = preparation.openSession();
    await assert.rejects(
      preparation.readGeometry(session, { ...registration, url: "http://unused/" }, [0]),
      /Dedicated Worker unavailable/,
    );
    assert.equal(preparation.evidence().credit.used.total, 0);
    assert.equal(preparation.evidence().inFlightEstimatedBytes, 0);
  } finally {
    preparation.dispose();
  }
});

test("a delivered result with the wrong session epoch cannot gain a prepared-page brand", async () => {
  const { registration } = await fixture();
  const preparation = new CookedAssetPreparation({
    createWorker: () => ({
      onmessage: null,
      postMessage(task) {
        if (task.forget) {
          return;
        }
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              version: task.version,
              session: task.session,
              epoch: task.epoch + 1,
              task: task.task,
              ok: true,
              decoderMemoryBytes: 0,
              kind: "geometry",
              pages: [],
              encodedBytes: 0,
              ioMs: 0,
              busyMs: 0,
            },
          }),
        );
      },
      terminate() {},
    }),
  });
  try {
    const session = preparation.openSession();
    await assert.rejects(
      preparation.readGeometry(session, { ...registration, url: "http://unused/" }, [0]),
      /protocol\/session\/task epoch mismatch/,
    );
    assert.equal(preparation.evidence().credit.used.total, 0);
  } finally {
    preparation.dispose();
  }
});

test("range coalescing preserves its caller-selected domain and encoded bound", async () => {
  const { registration } = await fixture();
  assert.equal(cookedGeometrySpans(registration.pages, [0, 1]).length, 1);
  assert.deepEqual(cookedGeometrySpans(registration.pages, [1])[0].pageIds, [1]);
  assert.equal(cookedGeometrySpans(registration.pages, [0, 1], 262144).length, 2);
  assert.throws(() => cookedGeometrySpans(registration.pages, [3]), /directory/);
});

test("returned ready storage blocks new admission until consumption or cancellation", async () => {
  const credit = new CookedAssetCredit({ total: 256, encoded: 32, ready: 64 });
  const signal = new AbortController().signal;
  const first = await credit.acquire({ total: 100, encoded: 16, ready: 64 }, 0, signal);
  first({ total: 64, encoded: 0, ready: 64 });
  let admitted = false;
  const second = credit.acquire({ total: 80, encoded: 16, ready: 16 }, 1, signal).then((release) => {
    admitted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(admitted, false, "Worker completion alone does not free ready storage");
  first();
  const releaseSecond = await second;
  const controller = new AbortController();
  const cancelled = credit.acquire({ total: 256, encoded: 0, ready: 0 }, 2, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  releaseSecond();
  const large = await credit.acquire({ total: 256, encoded: 0, ready: 0 }, 2, signal);
  assert.equal(credit.evidence().used.total, 256, "one full-size texture eventually gets its entire credit");
  large();
  assert.deepEqual(credit.evidence().used, { total: 0, encoded: 0, ready: 0 });
});
