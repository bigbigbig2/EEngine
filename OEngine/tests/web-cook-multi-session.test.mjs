import assert from "node:assert/strict";
import test from "node:test";

const { WebCookBudgetLedger } = await import("../.test-dist/assets/web-cook/WebCookBudget.js");
const { WebCookClient } = await import("../.test-dist/assets/web-cook/WebCookClient.js");

const PAGE_BYTES = 262144;

class FakeWorker {
  constructor() { this.listeners = new Map(); this.sent = []; this.terminated = false; }
  addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
  postMessage(message, transfer = []) { this.sent.push({ message, transfer }); }
  terminate() { this.terminated = true; }
  emitMessage(data) { for (const listener of this.listeners.get("message") ?? []) listener({ data }); }
}

function options(worker, sessionId, ledger, priority = 0) {
  return {
    worker,
    sessionId,
    sessionGeneration: 1,
    budgets: {
      maxConcurrentWorkers: 1,
      maxSourceBytes: 2048,
      maxWasmBytes: 4096,
      maxOutputBytes: PAGE_BYTES,
      maxQueuedEvents: 2
    },
    initialOutputPageCredits: 1,
    ledger,
    priority
  };
}

function catalog(sourceBytes) {
  return {
    schemaVersion: 1,
    primitiveCount: 0,
    sourceBytes,
    sourceTransferMode: "range",
    sourceIdentityHash: new Uint8Array(32),
    scenes: [], instances: [], primitives: [], textures: [], images: []
  };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(message);
}

test("multi-session Web Cook pressure stays within shared source/WASM/output caps", async () => {
  const ledger = new WebCookBudgetLedger({
    maxActiveSessions: 2,
    maxOutputBytes: 2 * PAGE_BYTES,
    maxSourceBytes: 4096,
    maxWasmBytes: 8192
  });
  const workers = Array.from({ length: 4 }, () => new FakeWorker());
  const clients = workers.map((worker, index) => new WebCookClient(options(worker, `pressure-${index}`, ledger, index === 3 ? 2 : 0)));
  clients.forEach((client, index) => { client.open(`scene-${index}.glb`); void client.revisions(); });

  await waitUntil(() => workers[0].sent.some(({ message }) => message.type === "OpenSource") && workers[1].sent.some(({ message }) => message.type === "OpenSource"), "first two sessions were not admitted");
  assert.equal(ledger.evidence().activeSessions, 2);
  assert.equal(ledger.evidence().waitingSessions, 2);
  assert.equal(ledger.evidence().backpressureEvents, 2);

  workers[0].emitMessage({ protocolVersion: 1, sessionId: "pressure-0", sessionGeneration: 1, type: "SceneCatalogReady", catalog: catalog(1024) });
  workers[1].emitMessage({ protocolVersion: 1, sessionId: "pressure-1", sessionGeneration: 1, type: "SceneCatalogReady", catalog: catalog(1024) });
  await new Promise(resolve => setImmediate(resolve));
  let evidence = ledger.evidence();
  assert.equal(evidence.sourceBytes, 2048);
  assert.equal(evidence.wasmBytes, 8192);
  assert.equal(evidence.outputBytes, 2 * PAGE_BYTES);
  assert.ok(evidence.peakSourceBytes <= ledger.limits.maxSourceBytes);
  assert.ok(evidence.peakWasmBytes <= ledger.limits.maxWasmBytes);
  assert.ok(evidence.peakOutputBytes <= ledger.limits.maxOutputBytes);

  // Cancelling one active session admits the highest-priority waiter first.
  clients[0].cancel("pressure-cancel");
  await waitUntil(() => workers[3].sent.some(({ message }) => message.type === "OpenSource"), "priority waiter was not admitted after cancellation");
  assert.equal(ledger.evidence().activeSessions, 2);
  assert.equal(ledger.evidence().waitingSessions, 1);
  workers[3].emitMessage({ protocolVersion: 1, sessionId: "pressure-3", sessionGeneration: 1, type: "SceneCatalogReady", catalog: catalog(1024) });
  await new Promise(resolve => setImmediate(resolve));
  evidence = ledger.evidence();
  assert.equal(evidence.sourceBytes, 2048);
  assert.equal(evidence.wasmBytes, 8192);
  assert.ok(evidence.admissions >= 3);

  clients.forEach(client => client.dispose());
  for (let attempt = 0; attempt < 100 && (ledger.evidence().activeSessions !== 0 || ledger.evidence().waitingSessions !== 0); attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual({ active: ledger.evidence().activeSessions, waiting: ledger.evidence().waitingSessions }, { active: 0, waiting: 0 }, JSON.stringify(ledger.evidence()));
  evidence = ledger.evidence();
  assert.deepEqual({ source: evidence.sourceBytes, wasm: evidence.wasmBytes, output: evidence.outputBytes }, { source: 0, wasm: 0, output: 0 });
  assert.ok(evidence.admissions >= 4, "all sessions either ran or were safely admitted and released");
});
