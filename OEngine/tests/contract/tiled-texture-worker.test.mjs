import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { makeTiledFixture } from "../helpers/tiled-texture-fixture.mjs";
import { CookedAssetPreparation } from "../../.test-dist/assets/codec/CookedAssetPreparation.js";
import { tiledTextureBootstrapPayloads } from "../../.test-dist/assets/TiledTextureProduct.js";

class DedicatedWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  detached = [];
  registrations = [];
  registrationBytes = [];
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
    if (message.registration) {
      this.registrations.push(message.registrationKey);
      this.registrationBytes.push(JSON.stringify(message.registration).length);
    }
    this.inner.postMessage(message, transfer);
  }
  terminate() {
    void this.inner.terminate();
  }
  crash() {
    this.inner.postMessage({ crash: true });
  }
}
const waitUntil = async (predicate) => {
  const until = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > until) throw new Error("VT Worker observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("real VT Worker opens directory only, batches authenticated tiles, owns ready/cache bytes, cancels and retries", async () => {
  const f = await makeTiledFixture();
  let mode = "range";
  let delayed = false;
  let requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, range: request.headers.range });
    if (delayed) await new Promise((resolve) => setTimeout(resolve, 150));
    if (request.url === "/texture.vtdirectory") {
      response.writeHead(200, { "content-length": f.bytes.byteLength });
      response.end(f.bytes);
    } else if (request.url.startsWith("/shards/")) {
      const p = f.directory.metadata.payloads.find((p) => "/" + p.shard === request.url);
      if (!p) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-length": p.byteLength });
      response.end(f.payloads[p.id]);
    } else if (mode === "no-range") {
      response.writeHead(200, { "content-length": f.pack.byteLength });
      response.end(f.pack);
    } else {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? "");
      assert.ok(match);
      const start = Number(match[1]),
        end = Number(match[2]);
      let bytes = f.pack.slice(start, end + 1);
      if (mode === "hash") bytes[0] ^= 1;
      if (mode === "truncated") bytes = bytes.subarray(0, bytes.length - 1);
      response.writeHead(206, {
        "content-length": mode === "truncated" ? bytes.length : end - start + 1,
        "content-range": `bytes ${start}-${end}/${f.pack.byteLength + (mode === "version" ? 1 : 0)}`
      });
      response.end(bytes);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/texture.vtdirectory`;
  const workers = [];
  const preparation = new CookedAssetPreparation({
    maxWorkers: 1,
    maxTileCacheBytes: 24 * 1024,
    createWorker: () => {
      const w = new DedicatedWorker();
      workers.push(w);
      return w;
    }
  });
  const session = preparation.openSession();
  const openDirectory = () =>
    preparation.readTiledDirectory(session, url, f.directory.identity, f.bytes.length);
  try {
    const directory = await openDirectory();
    assert.deepEqual(
      requests.map((r) => r.url),
      ["/texture.vtdirectory"],
      "opening metadata must not fetch fine or tail payloads"
    );
    assert.equal(await openDirectory(), directory);
    const tailIds = tiledTextureBootstrapPayloads(directory);
    const tail = await preparation.readTiledPayloads(session, directory, tailIds);
    assert.deepEqual(new Uint8Array(tail.payloads[0].bytes), f.payloads[tailIds[0]]);
    assert.equal(preparation.evidence().credit.used.ready, 10368);
    assert.equal(tail.payloads[0].bytes.byteLength, 10368);
    tail.release();
    tail.release();
    assert.equal(tail.payloads[0].bytes.byteLength, 0, "released caller views detach");
    assert.equal(preparation.evidence().credit.used.total, 0);
    assert.equal(preparation.evidence().tiled.cache.bytes, 10368);
    const beforeCache = requests.length;
    const cached = await preparation.readTiledPayloads(session, directory, tailIds);
    assert.equal(requests.length, beforeCache, "exclusive cache take does not do IO");
    cached.release();

    const consumed = await preparation.readTiledPayloads(session, directory, tailIds);
    const consumedBytes = structuredClone(consumed.payloads[0].bytes, {
      transfer: [consumed.payloads[0].bytes]
    });
    consumed.release();
    assert.deepEqual(new Uint8Array(consumedBytes), f.payloads[tailIds[0]]);
    assert.equal(
      preparation.evidence().credit.used.total,
      0,
      "transferred consumer storage also releases credit"
    );

    const batch = await preparation.readTiledPayloads(session, directory, [2, 0, 1, 1]);
    assert.deepEqual(
      batch.payloads.map((p) => p.id),
      [2, 0, 1]
    );
    batch.payloads.forEach((p) => assert.deepEqual(new Uint8Array(p.bytes), f.payloads[p.id]));
    batch.release();
    const io = preparation.evidence().tiled;
    assert.ok(io.hashedPayloadBytes > 0);
    assert.ok(io.fetchedBytes >= io.hashedPayloadBytes);
    assert.equal(io.overfetchBytes, io.fetchedBytes - io.hashedPayloadBytes);
    assert.ok(preparation.evidence().tiled.cache.bytes <= 24 * 1024);
    assert.equal(workers[0].registrations.length, 1, "compact identity registered once per Worker");
    assert.ok(workers[0].registrationBytes[0] < 1024, "full page directory is never cloned to every Worker");
    await waitUntil(() => workers[0].detached.flat().length > 0);
    assert.ok(workers[0].detached.flat().every((n) => n === 0));

    // Use uncached IDs, and cancel session after each failure to exercise cleanup.
    for (const [failureMode, pattern] of [
      ["hash", /hash/],
      ["version", /version|Content-Range/],
      ["truncated", /length|reserved/]
    ]) {
      mode = failureMode;
      await assert.rejects(preparation.readTiledPayloads(session, directory, [3]), pattern);
      assert.equal(preparation.evidence().credit.used.total, 0);
    }
    mode = "no-range";
    assert.equal(preparation.evidence().tiled.failedTasks, 3);
    const fallbackStart = requests.length;
    const shards = await preparation.readTiledPayloads(session, directory, [3]);
    assert.deepEqual(new Uint8Array(shards.payloads[0].bytes), f.payloads[3]);
    assert.ok(requests.slice(fallbackStart).some((r) => r.url.startsWith("/shards/")));
    shards.release();

    mode = "range";
    delayed = true;
    const controller = new AbortController();
    const start = requests.length;
    const cancelled = preparation.readTiledPayloads(session, directory, [4], controller.signal);
    await waitUntil(() => requests.length > start);
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(preparation.evidence().credit.used.total, 0);
    delayed = false;
    const retry = await preparation.readTiledPayloads(session, directory, [4]);
    retry.release();
    assert.equal(workers.length, 2);
    assert.equal(workers[1].registrations.length, 1);

    delayed = true;
    const crashStart = requests.length;
    const crashed = preparation.readTiledPayloads(session, directory, [5]);
    await waitUntil(() => requests.length > crashStart);
    workers[1].crash();
    await assert.rejects(crashed, /deliberate Worker crash/);
    delayed = false;
    const recovered = await preparation.readTiledPayloads(session, directory, [5]);
    preparation.releaseTiledDirectory(session, directory);
    preparation.releaseTiledDirectory(session, directory);
    assert.equal(recovered.payloads[0].bytes.byteLength, 0);
    await assert.rejects(preparation.readTiledPayloads(session, directory, [0]), /registered/);
    const reopened = await openDirectory();
    assert.notEqual(reopened, directory);
    const finalLease = await preparation.readTiledPayloads(session, reopened, [0]);
    preparation.closeSession(session);
    assert.equal(finalLease.payloads[0].bytes.byteLength, 0);
    assert.equal(preparation.evidence().credit.used.total, 0);
    assert.equal(preparation.evidence().tiled.metadataBytes, 0);
    await assert.rejects(preparation.readTiledPayloads(session, directory, [0]), /closed/);
    const next = preparation.openSession();
    await assert.rejects(preparation.readTiledPayloads(next, directory, [0]), /registered/);
    preparation.closeSession(next);

    // Close after synchronous admission but before the async lease continuation.
    const racedSession = preparation.openSession();
    const racedDirectory = await preparation.readTiledDirectory(
      racedSession,
      url,
      f.directory.identity,
      f.bytes.length
    );
    const raced = preparation.readTiledPayloads(racedSession, racedDirectory, [0]);
    preparation.closeSession(racedSession);
    await assert.rejects(raced, { name: "AbortError" });
    assert.equal(preparation.evidence().credit.used.total, 0);
    assert.equal(preparation.evidence().credit.used.ready, 0);
    assert.equal(preparation.evidence().tiled.metadataBytes, 0);
  } finally {
    preparation.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
