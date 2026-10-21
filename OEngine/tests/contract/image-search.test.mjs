import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidatesFor,
  selectImageCandidate,
  searchIdentity,
  stableJson
} from "../../tools/extreme-web-asset/search.mjs";
import { ImageSearchCache } from "../../tools/extreme-web-asset/search-cache.mjs";
import { imageRanges } from "../../tools/extreme-web-asset/delivery.mjs";
import { fetchImageRange } from "../../.test-dist/assets/codec/ImageTextureDelivery.js";
import { createServer } from "node:http";
import { ImageQualityMetrics } from "../../tools/extreme-web-asset/metrics.mjs";

const hash = "a".repeat(64);
function evaluation(error = 0.1, hard = true) {
  return {
    representation: "gpu-final",
    identity: hash,
    inputHash: hash,
    hardSemantics: hard,
    metrics: {
      channelR: error,
      channelG: error,
      channelB: error,
      channelRMean: error,
      channelGMean: error,
      channelBMean: error,
      channelRP95: error,
      channelGP95: error,
      channelBP95: error,
      materialError: error,
      materialErrorMean: error,
      boundaryMax: error
    }
  };
}

test("finite exhaustive image search keeps donor, rejects smaller bad outputs and handles nonmonotonic candidates", async () => {
  assert.equal(candidatesFor("high").length, 20);
  assert.equal(candidatesFor("extreme", true).length, 60);
  let calls = 0;
  const report = await selectImageCandidate({
    quality: "high",
    semantic: "data-rgb",
    evaluate: async (candidate, index) => {
      calls++;
      return {
        encodeMs: 1,
        deliveryBytes: index === 8 ? 10 : index === 9 ? 1 : 100,
        evaluation: evaluation(index === 9 ? 0.2 : 0.1)
      };
    }
  });
  assert.equal(calls, 20);
  assert.equal(report.selected.deliveryBytes, 10);
  assert.equal(report.rows[9].accepted, false);
  await assert.rejects(
    selectImageCandidate({
      quality: "high",
      semantic: "data-rgb",
      evaluate: async () => ({
        encodeMs: 1,
        deliveryBytes: 10,
        evaluation: evaluation(0.1, false)
      })
    }),
    /hard semantics/
  );
});

test("search cache binds full environment, rejects corrupt receipts and bounds entries", async () => {
  const identity = Object.fromEntries(
    ["canonical", "recipe", "encoder", "argv", "target", "evaluator", "metrics", "device"].map((key) => [
      key,
      hash
    ])
  );
  const first = searchIdentity(identity);
  assert.notEqual(first, searchIdentity({ ...identity, device: "b".repeat(64) }));
  assert.throws(() => searchIdentity({ ...identity, metrics: "missing" }));
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  const path = await mkdtemp(join(tmpdir(), "eengine-image-search-"));
  try {
    const cache = new ImageSearchCache(path, 1024);
    const key = cache.key(first, { quality: 80 });
    assert.equal(await cache.read(key), null);
    await cache.write(key, evaluation());
    assert.deepEqual(await cache.read(key), evaluation());
    const file = JSON.parse(await readFile(cache.path(key)));
    file.value.hardSemantics = false;
    await writeFile(cache.path(key), JSON.stringify(file));
    await assert.rejects(cache.read(key), /checksum/);
    assert.throws(() => cache.path("../outside"));
    await assert.rejects(cache.write(key, "x".repeat(2000)), /capacity/);
  } finally {
    // Node-created private temporary directory, not a computed workspace target.
    if (!path.startsWith(join(tmpdir(), "eengine-image-search-")))
      throw new Error("Unexpected temporary path");
    await rm(path, { recursive: true });
  }
});

test("range coalescing respects urgency, stable object, byte/gap/overfetch bounds", () => {
  const item = (id, offset, bytes, priority = 1) => ({
    id,
    offset: String(offset),
    bytes,
    priority,
    uri: "pack.bin",
    objectBytes: "1000"
  });
  const ranges = imageRanges([item(0, 0, 100), item(1, 104, 100), item(2, 208, 100, 0)], {
    maxBytes: 256,
    maxGapBytes: 8,
    maxOverfetchRatio: 0.1
  });
  assert.equal(ranges.length, 2);
  const fine = ranges.find((range) => range.priority === 1);
  assert.equal(fine.fetchedBytes, 204);
  assert.equal(fine.overfetchBytes, 4);
  assert.equal(imageRanges([item(0, 0, 10), item(1, 20, 10)], { maxOverfetchRatio: 0.1 }).length, 2);
});

test("material/normal metric diagnostics retain complete pixels and exact direction", () => {
  const values = new Float32Array(28 * 8 * 8).fill(0.5);
  for (let at = 0; at < values.length; at += 28) values[at + 2] = 1;
  const metrics = new ImageQualityMetrics("normal-xy");
  metrics.add(values, values, { width: 8, height: 8 });
  assert.deepEqual(metrics.vector(), {
    materialError: 0,
    materialErrorMean: 0,
    boundaryMax: 0,
    angleP50: 0,
    angleP95: 0,
    angleP99: 0,
    angleMax: 0
  });
});

test("shared range fetch validates extent before Worker input; abort and overrun reject", async () => {
  let mode = "valid";
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.range, "bytes=0-203");
    if (mode === "delay") await new Promise((resolve) => setTimeout(resolve, 100));
    response.writeHead(206, { "content-range": mode === "bad" ? "bytes 1-204/1000" : "bytes 0-203/1000" });
    response.end(new Uint8Array(mode === "overrun" ? 205 : 204));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const [range] = imageRanges(
    [0, 1].map((id) => ({
      id,
      uri: "pack",
      offset: String(id * 104),
      bytes: 100,
      objectBytes: "1000",
      priority: 1
    }))
  );
  try {
    assert.equal((await fetchImageRange(range, url, new AbortController().signal)).length, 204);
    mode = "bad";
    await assert.rejects(fetchImageRange(range, url, new AbortController().signal), /extent/);
    mode = "overrun";
    await assert.rejects(fetchImageRange(range, url, new AbortController().signal), /reservation/);
    mode = "delay";
    await assert.rejects(fetchImageRange(range, url, AbortSignal.timeout(10)), /abort|timeout/i);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
