import assert from "node:assert/strict";
import test from "node:test";

const { WebCookWorkerTransport } = await import("../.test-dist/assets/web-cook/WebCookWorkerTransport.js");

class FakeWorker {
  listeners = new Map(); sent = []; terminated = false;
  addEventListener(type, listener) { const values = this.listeners.get(type) ?? []; values.push(listener); this.listeners.set(type, values); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
  postMessage(message, transfer = []) { this.sent.push({ message, transfer }); }
  terminate() { this.terminated = true; }
  emit(type, value) { for (const listener of this.listeners.get(type) ?? []) listener(type === "message" ? { data: value } : {}); }
}

test("Worker transport filters generations and forwards explicit transfer ownership", async () => {
  const worker = new FakeWorker(); const transport = new WebCookWorkerTransport(worker, "cook", 3, 2);
  const command = { protocolVersion: 1, sessionId: "cook", sessionGeneration: 3, type: "OpenSource", source: {} }; const block = new ArrayBuffer(8);
  transport.send(command, [block]); assert.strictEqual(worker.sent[0].transfer[0], block);
  worker.emit("message", { protocolVersion: 1, sessionId: "cook", sessionGeneration: 2, type: "Progress", stage: "late", units: 0, bytes: 0, timings: {} });
  const iterator = transport[Symbol.asyncIterator](); const pending = iterator.next();
  worker.emit("message", { protocolVersion: 1, sessionId: "cook", sessionGeneration: 3, type: "Progress", stage: "cook", units: 1, bytes: 4, timings: {} });
  assert.equal((await pending).value.stage, "cook"); assert.equal(transport.evidence().droppedLateEvents, 1);
  transport.close(true); assert.equal((await iterator.next()).done, true); assert.equal(worker.terminated, true);
});
