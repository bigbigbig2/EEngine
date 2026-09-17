import assert from "node:assert/strict";
import test from "node:test";

const { WebCookSessionProtocol, WEB_COOK_PAGE_BYTES, WEB_COOK_PROTOCOL_VERSION } = await import("../.test-dist/assets/web-cook/protocol/CookSessionProtocol.js");

const header = { protocolVersion: WEB_COOK_PROTOCOL_VERSION, sessionId: "s1", sessionGeneration: 3 };
const budgets = { maxConcurrentWorkers: 1, maxSourceBytes: 1024, maxWasmBytes: 1024, maxOutputBytes: WEB_COOK_PAGE_BYTES, maxQueuedEvents: 4 };

test("CookSession protocol enforces generation, state and output credits", () => {
  const session = new WebCookSessionProtocol("s1", 3);
  session.accept({ ...header, type: "CreateSession", runtimeProfile: "portable-single", recipe: {}, budgets });
  session.accept({ ...header, type: "OpenSource", source: { kind: "glb-range" } });
  session.accept({ ...header, type: "GrantOutputCredits", blockCount: 1, bytes: WEB_COOK_PAGE_BYTES });
  assert.throws(() => session.accept({ ...header, type: "GrantOutputCredits", blockCount: 1, bytes: WEB_COOK_PAGE_BYTES }), /budget/i);
  const bytes = new ArrayBuffer(WEB_COOK_PAGE_BYTES);
  assert.equal(session.emit({ ...header, type: "PageReady", productId: new Uint8Array(32), revision: 0, pageId: 0, decodedHash128: new Uint8Array(16), bytes }), true);
  assert.equal(session.evidence().outstandingOutputBlocks, 1);
  assert.equal(session.emit({ ...header, type: "PageReady", productId: new Uint8Array(32), revision: 0, pageId: 1, decodedHash128: new Uint8Array(16), bytes }), false);
  assert.throws(() => session.returnOutputCredits(2, WEB_COOK_PAGE_BYTES * 2), /outstanding/i);
  session.returnOutputCredits(1, WEB_COOK_PAGE_BYTES);
  assert.throws(() => session.returnOutputCredits(1, WEB_COOK_PAGE_BYTES), /outstanding/i);
  assert.equal(session.evidence().outstandingOutputBlocks, 0);
  assert.equal(session.drain(1).length, 1);
  assert.throws(() => session.accept({ ...header, sessionGeneration: 2, type: "OpenSource", source: {} }), /stale/i);
  session.accept({ ...header, type: "CancelScope", scope: "asset" });
  assert.equal(session.emit({ ...header, type: "Progress", stage: "late", units: 1, bytes: 0, timings: {} }), false);
  assert.equal(session.evidence().state, "cancelled");
});
