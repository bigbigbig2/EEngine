import test from "node:test";
import assert from "node:assert/strict";
import { AssetReadBudget, loadAssetBatch } from "../../.test-dist/assets/AssetLoadBatch.js";

test("batch failure cancels siblings, waits for late success and releases every completed asset", async () => {
  const discarded = [];
  let siblingAborted = false;
  await assert.rejects(
    loadAssetBatch(
      [0, 1, 2, 3],
      3,
      new AbortController().signal,
      async (id, _index, signal) => {
        if (id === 0) return { id };
        if (id === 1) {
          await new Promise((resolve) => setImmediate(resolve));
          throw new Error("injected asset failure");
        }
        await new Promise((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              siblingAborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { id };
      },
      (value) => discarded.push(value.id),
    ),
    /injected asset failure/,
  );
  assert.equal(siblingAborted, true);
  assert.deepEqual(discarded.sort(), [0, 2, 3]);
});

test("transport byte credits remain held through parsing and abort releases queued readers", async () => {
  const budget = new AssetReadBudget(16);
  const controller = new AbortController();
  let finish;
  let parsing = 0;
  const response = () => new Response(new Uint8Array(8), { headers: { "content-length": "8" } });
  const first = budget.read(response(), controller.signal, async () => {
    parsing++;
    await new Promise((resolve) => {
      finish = resolve;
    });
    return 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = budget.read(response(), controller.signal, async () => {
    parsing++;
    return 2;
  });
  const rejected = assert.rejects(second, /cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parsing, 1);
  controller.abort(new Error("cancelled"));
  finish();
  assert.equal(await first, 1);
  await rejected;
  assert.equal(await budget.read(response(), new AbortController().signal, async () => 3), 3);
});

test("transport checks declared and unknown-length payload bounds", async () => {
  const budget = new AssetReadBudget(16);
  await assert.rejects(
    budget.read(new Response(new Uint8Array(9)), new AbortController().signal, async () => 0),
    /byte domain/,
  );
  await assert.rejects(
    budget.read(
      new Response(new Uint8Array(9), { headers: { "content-length": "9" } }),
      new AbortController().signal,
      async () => 0,
    ),
    /byte budget/,
  );
});

test("a locked response body cannot leak transport byte credits", async () => {
  const budget = new AssetReadBudget(16);
  const response = new Response(new Uint8Array(8), { headers: { "content-length": "8" } });
  const reader = response.body.getReader();
  await assert.rejects(
    budget.read(response, new AbortController().signal, async () => 0),
    /locked/i,
  );
  reader.releaseLock();
  assert.equal(await budget.read(response, new AbortController().signal, async () => 1), 1);
});

test("encoded response lengths do not describe the decompressed Fetch body", async () => {
  const budget = new AssetReadBudget(16);
  const response = new Response(new Uint8Array(8), {
    headers: { "content-length": "1", "content-encoding": "gzip" },
  });
  assert.equal(
    await budget.read(response, new AbortController().signal, async (bytes) => bytes.byteLength),
    8,
  );
});
