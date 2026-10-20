import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { CookedAssetPreparation } from "../../.test-dist/assets/codec/CookedAssetPreparation.js";
import { cookImageTexture } from "../../.test-dist/assets/codec/ImageTextureCook.js";
import { imageTextureHash, writeImageTextureDirectory } from "../../.test-dist/assets/ImageTextureProduct.js";
import { ImageTextureSource } from "../../.test-dist/assets/ImageTextureSource.js";

class DedicatedWorker {
  constructor() {
    this.inner = new Worker(new URL("../helpers/cooked-worker-host.mjs", import.meta.url));
    this.inner.on("message", (data) => {
      if (!data.transferProof) this.onmessage?.({ data });
    });
    this.inner.on("error", (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(value, transfer) {
    this.inner.postMessage(value, transfer);
  }
  terminate() {
    void this.inner.terminate();
  }
}

async function fixture() {
  const payloads = new Map();
  const inputs = [];
  for (let size = 385; ; size = Math.max(1, Math.floor(size / 2))) {
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = (i * 31) & 255;
    inputs.push({ width: size, height: size, rgba });
    if (size === 1) break;
  }
  const { directory } = await cookImageTexture(
    {
      semantic: "data-rgb",
      quality: "high",
      mode: "virtual",
      mips: "provided",
      inputs,
      exactCoverage: inputs,
      exactMode: "virtual",
      cellSize: 128,
      addressU: "repeat",
      addressV: "repeat",
      toolHash: "a".repeat(64)
    },
    {
      encodeAvif: async () => new Uint8Array([1]),
      put: async (hash, bytes, kind) => {
        const uri = hash + (kind === "exact" ? ".bin" : ".avif");
        payloads.set("/" + uri, bytes);
        return uri;
      }
    }
  );
  return { directory, payloads };
}

test("source open, exact 16-owner transfer, aggregate admission, failure/cancel/retry and source retirement", async () => {
  const { directory, payloads } = await fixture();
  const bytes = writeImageTextureDirectory(directory);
  const identity = await imageTextureHash(bytes);
  payloads.set("/directory.json", bytes);
  let corrupt = false;
  let delay = false;
  let requests = 0;
  const server = createServer(async (request, response) => {
    const original = payloads.get(request.url);
    if (!original) {
      response.writeHead(404).end();
      return;
    }
    requests++;
    if (delay) await new Promise((resolve) => setTimeout(resolve, 100));
    const data = original.slice();
    if (corrupt && request.url.endsWith(".bin")) data[0] ^= 255;
    response.writeHead(200, { "content-length": data.byteLength });
    response.end(data);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/directory.json`;
  const preparation = new CookedAssetPreparation({
    maxWorkers: 2,
    createWorker: () => new DedicatedWorker()
  });
  let source;
  try {
    await assert.rejects(
      ImageTextureSource.open(url, "f".repeat(64), bytes.length, undefined, preparation),
      /SHA256/
    );
    assert.equal(preparation.evidence().sessions, 0);
    assert.equal(preparation.evidence().credit.used.total, 0);
    source = await ImageTextureSource.open(url, identity, bytes.length, undefined, preparation);
    const metadataBytes = preparation.evidence().imageDirectoryBytes;
    assert.ok(metadataBytes > source.pages.indexBytes);
    const page = source.pages.page(1, 0, 0, 0);
    assert.equal(page.owners.length, 16);
    let created = 0;
    const constrained = new CookedAssetPreparation({
      maxWorkers: 1,
      maxEncodedBytes: 20000,
      createWorker: () => {
        created++;
        return new DedicatedWorker();
      }
    });
    const constrainedSession = constrained.openSession();
    try {
      const before = requests;
      await assert.rejects(
        constrained.readImageItems(constrainedSession, source.directory, page.owners, url),
        /credit capacity/
      );
      assert.equal(created, 0, "impossible aggregate rejected before creating a Worker");
      assert.equal(requests, before, "impossible aggregate starts no partial IO");
      assert.equal(constrained.evidence().credit.used.total, 0);
    } finally {
      constrained.dispose();
    }
    const lease = await source.readPage(page);
    assert.equal(lease.length, 16);
    for (const item of lease) {
      assert.equal(item.result.representation, "exact-bytes");
      assert.deepEqual(new Uint8Array(item.result.bytes), payloads.get("/" + item.item.uri));
    }
    const held = preparation.evidence().credit.used.ready;
    assert.equal(held, page.decodedBytes * 2);
    lease[0].close();
    lease[0].close();
    assert.equal(preparation.evidence().credit.used.ready, held - lease[0].item.decodedBytes * 2);
    for (const item of lease) item.close();
    assert.equal(preparation.evidence().credit.used.total, 0);

    corrupt = true;
    await assert.rejects(source.readPage(page));
    assert.equal(preparation.evidence().credit.used.total, 0);
    corrupt = false;
    delay = true;
    const cancel = new AbortController();
    const pending = source.readPage(page, cancel.signal);
    setTimeout(() => cancel.abort(new Error("deliberate batch cancellation")), 20);
    await assert.rejects(pending);
    assert.equal(preparation.evidence().credit.used.total, 0);
    delay = false;
    const retry = await source.readPage(page);
    assert.equal(retry.length, 16);
    source.close();
    assert.equal(preparation.evidence().credit.used.total, 0);
    assert.equal(preparation.evidence().imageDirectoryBytes, 0);
    for (const item of retry)
      assert.equal(item.result.bytes.byteLength, 0, "source close detaches ready buffers");
    await assert.rejects(source.readPage(page), /closed/);

    source = await ImageTextureSource.open(url, identity, bytes.length, undefined, preparation);
    assert.throws(() => source.readPage(page), /another immutable source/);
    const fresh = source.pages.page(1, 0, 0, 0);
    const deduplicated = await source.read([fresh.owners[0], fresh.owners[0]]);
    assert.equal(deduplicated.length, 1);
    deduplicated[0].close();
    source.close();
    assert.equal(preparation.evidence().sessions, 0);
    assert.equal(preparation.evidence().credit.used.total, 0);
    assert.ok(requests > 16);
  } finally {
    source?.close();
    preparation.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
