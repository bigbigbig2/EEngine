import assert from "node:assert/strict";
import test from "node:test";

const { WebCookClient } = await import("../.test-dist/assets/web-cook/WebCookClient.js");

class FakeWorker {
  listeners = new Map();
  sent = [];
  terminated = false;
  addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
  postMessage(message, transfer = []) { this.sent.push({ message, transfer }); }
  terminate() { this.terminated = true; }
}

function options(worker) {
  return {
    worker,
    sessionId: "client-session",
    sessionGeneration: 7,
    budgets: {
      maxConcurrentWorkers: 1,
      maxSourceBytes: 1024 * 1024,
      maxWasmBytes: 2 * 1024 * 1024,
      maxOutputBytes: 2 * 262144,
      maxQueuedEvents: 4
    },
    initialOutputPageCredits: 2
  };
}

test("Web Cook client opens a bounded session in protocol order", () => {
  const worker = new FakeWorker();
  const client = new WebCookClient(options(worker));
  client.open("https://assets.test/scene.glb");
  assert.deepEqual(worker.sent.map(({ message }) => message.type), ["CreateSession", "GrantOutputCredits", "OpenSource"]);
  assert.equal(worker.sent[1].message.blockCount, 2);
  assert.equal(worker.sent[1].message.bytes, 2 * 262144);
  assert.equal(client.state, "open");
  client.setSourcePriority("asset-0", 3.5, 2);
  client.requestPages(new Uint8Array(32).fill(5), 0, new Uint32Array([1, 2]), 9);
  assert.deepEqual(worker.sent.slice(3).map(({ message }) => message.type), ["SetSourcePriority", "RequestPages"]);
  assert.deepEqual([...worker.sent[4].message.pageIds], [1, 2]);
  client.dispose();
  assert.equal(worker.sent.at(-1).message.type, "DisposeSession");
  assert.equal(worker.terminated, true);
  assert.equal(client.state, "disposed");
});

test("Web Cook client rejects invalid page identity before crossing the Worker boundary", () => {
  const worker = new FakeWorker();
  const client = new WebCookClient(options(worker));
  client.open("scene.glb");
  assert.throws(() => client.requestPages(new Uint8Array(31), 0, new Uint32Array([0]), 1), /identity\/priority/);
  assert.equal(worker.sent.length, 3);
  client.cancel();
  assert.equal(client.state, "cancelled");
  assert.equal(worker.terminated, true);
});
