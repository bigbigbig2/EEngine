import assert from "node:assert/strict";
import test from "node:test";

const { WebCookWorkerPool } = await import("../.test-dist/assets/web-cook/WebCookWorkerPool.js");

class FakeWorker {
  constructor(name) { this.name = name; this.listeners = new Map(); this.sent = []; this.terminated = false; }
  addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
  postMessage(message, transfer = []) { if (this.terminated) throw new Error("terminated"); this.sent.push({ message, transfer }); }
  terminate() { this.terminated = true; }
  emit(type, event = new Event(type)) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  emitMessage(data) { this.emit("message", { data }); }
}

function header(sessionId, sessionGeneration, type, extra = {}) {
  return { protocolVersion: 1, sessionId, sessionGeneration, type, ...extra };
}

test("portable-pool pins a session generation and recovers a crashed slot", () => {
  const workers = [];
  const pool = new WebCookWorkerPool({ maxWorkers: 2, createWorker: () => { const worker = new FakeWorker(`worker-${workers.length}`); workers.push(worker); return worker; } });
  const events = [];
  pool.addEventListener("message", event => events.push(event.data));

  pool.postMessage(header("a", 1, "CreateSession", { runtimeProfile: "portable-pool", recipe: {}, budgets: {} }));
  pool.postMessage(header("b", 1, "CreateSession", { runtimeProfile: "portable-pool", recipe: {}, budgets: {} }));
  pool.postMessage(header("a", 1, "OpenSource", { source: { url: "a.glb" } }));
  pool.postMessage(header("b", 1, "OpenSource", { source: { url: "b.glb" } }));
  assert.deepEqual(workers[0].sent.map(({ message }) => message.sessionId), ["a", "a"]);
  assert.deepEqual(workers[1].sent.map(({ message }) => message.sessionId), ["b", "b"]);

  workers[0].emit("error");
  assert.equal(events.at(-1).type, "FatalSessionFailure");
  assert.equal(events.at(-1).sessionId, "a");
  assert.equal(pool.evidence().invalidatedSessions, 1);
  assert.equal(pool.evidence().liveWorkers, 2, "a crashed slot is replaced for future generations");
  assert.throws(() => pool.postMessage(header("a", 1, "RequestPages", { productId: new Uint8Array(32), revision: 0, pageIds: new Uint32Array([0]), priority: 0 })), /invalidated/);

  pool.postMessage(header("b", 1, "SetSourcePriority", { assetKey: "b", score: 1, cameraHintRevision: 0 }));
  pool.postMessage(header("c", 1, "CreateSession", { runtimeProfile: "portable-pool", recipe: {}, budgets: {} }));
  assert.equal(workers[2].sent[0].message.sessionId, "c", "replacement worker receives the next generation");

  pool.terminate();
  assert.equal(pool.evidence().closed, true);
  assert.throws(() => pool.postMessage(header("d", 1, "CreateSession", { runtimeProfile: "portable-pool", recipe: {}, budgets: {} })), /closed/);
});

test("portable-pool isolates messageerror to the owning generation", () => {
  const workers = [];
  const pool = new WebCookWorkerPool({ maxWorkers: 2, createWorker: () => { const worker = new FakeWorker(`worker-${workers.length}`); workers.push(worker); return worker; } });
  const events = [];
  pool.addEventListener("message", event => events.push(event.data));
  pool.postMessage(header("first", 4, "CreateSession", { runtimeProfile: "portable-pool", recipe: {}, budgets: {} }));
  pool.postMessage(header("second", 8, "CreateSession", { runtimeProfile: "portable-pool", recipe: {}, budgets: {} }));
  workers[0].emit("messageerror");
  assert.deepEqual(events.map(event => [event.sessionId, event.sessionGeneration, event.code]), [["first", 4, "worker-messageerror"]]);
  assert.doesNotThrow(() => pool.postMessage(header("second", 8, "CancelScope", { scope: "session" })));
  pool.terminate();
});
