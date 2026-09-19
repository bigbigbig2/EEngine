import assert from "node:assert/strict";
import test from "node:test";

const { WebCookClient } = await import("../.test-dist/assets/web-cook/WebCookClient.js");
const { WebCookRuntimeAsset } = await import("../.test-dist/assets/web-cook/WebCookRuntimeAsset.js");
const { createWebCookWorker, resolveWebCookRuntimeProfile } = await import("../.test-dist/assets/web-cook/WebCookWorkerFactory.js");

class FakeWorker {
  listeners = new Map();
  sent = [];
  terminated = false;
  addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
  postMessage(message, transfer = []) { this.sent.push({ message, transfer }); }
  terminate() { this.terminated = true; }
  emitMessage(data) { for (const listener of this.listeners.get("message") ?? []) listener({ data }); }
}

test("Web Cook Worker factory sends an explicit real-module bootstrap", () => {
  const worker = new FakeWorker();
  const created = createWebCookWorker({
    wasmModuleUrl: "https://assets.test/oengine-web-geometry-cooker.mjs",
    maxCanonicalInputBytes: 1024,
    maxDecodedProductBytes: 262144,
    createWorker: url => { assert.match(url.href, /WebCookWorkerEntrypoint\.ts$/u); return worker; }
  });
  assert.equal(created, worker);
  assert.deepEqual(worker.sent, [{
    message: {
      type: "InitializeWebCookWorker",
      wasmModuleUrl: "https://assets.test/oengine-web-geometry-cooker.mjs",
      maxCanonicalInputBytes: 1024,
      maxDecodedProductBytes: 262144
    },
    transfer: []
  }]);
});

test("Web Cook Worker factory forwards an explicitly emitted wasm binary URL", () => {
  const worker = new FakeWorker();
  createWebCookWorker({
    wasmModuleUrl: "https://assets.test/oengine-web-geometry-cooker-abc.mjs",
    wasmBinaryUrl: "https://assets.test/oengine-web-geometry-cooker-def.wasm",
    maxCanonicalInputBytes: 1024,
    maxDecodedProductBytes: 262144,
    createWorker: () => worker
  });
  assert.equal(worker.sent[0].message.wasmBinaryUrl, "https://assets.test/oengine-web-geometry-cooker-def.wasm");
});

test("isolated-pthreads capability reports an explicit portable fallback when isolation is absent", () => {
  const capability = resolveWebCookRuntimeProfile("isolated-pthreads");
  assert.equal(capability.requested, "isolated-pthreads");
  assert.equal(capability.selected, "portable-single");
  assert.equal(capability.fallbackReason, "cross-origin-isolation-required");
});

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

test("Web Cook runtime asset exposes Product ownership without GPU ownership", () => {
  const worker = new FakeWorker();
  const asset = WebCookRuntimeAsset.open("https://assets.test/runtime.glb", options(worker));
  assert.equal(asset.url, "https://assets.test/runtime.glb");
  assert.equal(asset.state, "open");
  assert.equal(typeof asset.revisions, "function");
  assert.equal(asset.evidence().provider.offeredRevisions, 0);
  asset.dispose();
  assert.equal(asset.state, "disposed");
  assert.equal(worker.terminated, true);
});

test("Web Cook client accounts source and WASM reservations and releases all owners on cancel", async () => {
  const { WebCookBudgetLedger } = await import("../.test-dist/assets/web-cook/WebCookBudget.js");
  const worker = new FakeWorker();
  const ledger = new WebCookBudgetLedger({ maxActiveSessions: 1, maxOutputBytes: 2 * 262144, maxSourceBytes: 4096, maxWasmBytes: 2 * 1024 * 1024 });
  const client = new WebCookClient({ ...options(worker), ledger });
  client.open("scene.glb");
  await new Promise(resolve => setImmediate(resolve));
  const revisions = client.revisions();
  worker.emitMessage({
    protocolVersion: 1,
    sessionId: "client-session",
    sessionGeneration: 7,
    type: "SceneCatalogReady",
    catalog: { schemaVersion: 1, primitiveCount: 1, sourceBytes: 2048, sourceTransferMode: "range", sourceIdentityHash: new Uint8Array(32), scenes: [], instances: [], primitives: [], textures: [], images: [] }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ledger.evidence().sourceBytes, 2048);
  assert.equal(ledger.evidence().wasmBytes, options(worker).budgets.maxWasmBytes);
  assert.equal(ledger.evidence().outputBytes, 2 * 262144);
  client.cancel();
  assert.deepEqual({ source: ledger.evidence().sourceBytes, wasm: ledger.evidence().wasmBytes, output: ledger.evidence().outputBytes, active: ledger.evidence().activeSessions }, { source: 0, wasm: 0, output: 0, active: 0 });
  await revisions[Symbol.asyncIterator]().next().catch(() => undefined);
});

test("Web Cook client fails closed when catalog source reservation exceeds the page budget", async () => {
  const { WebCookBudgetLedger } = await import("../.test-dist/assets/web-cook/WebCookBudget.js");
  const worker = new FakeWorker();
  const ledger = new WebCookBudgetLedger({ maxActiveSessions: 1, maxOutputBytes: 2 * 262144, maxSourceBytes: 1024, maxWasmBytes: 2 * 1024 * 1024 });
  const client = new WebCookClient({ ...options(worker), ledger });
  client.open("scene.glb");
  await new Promise(resolve => setImmediate(resolve));
  void client.revisions();
  worker.emitMessage({ protocolVersion: 1, sessionId: "client-session", sessionGeneration: 7, type: "SceneCatalogReady", catalog: { sourceBytes: 2048 } });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.state, "failed");
  assert.equal(ledger.evidence().sourceBytes, 0);
  assert.equal(ledger.evidence().wasmBytes, 0);
  assert.equal(ledger.evidence().outputBytes, 0);
  assert.equal(ledger.evidence().activeSessions, 0);
});
