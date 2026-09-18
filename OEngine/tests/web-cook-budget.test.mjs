import assert from "node:assert/strict";
import test from "node:test";

const { WebCookBudgetLedger } = await import("../.test-dist/assets/web-cook/WebCookBudget.js");

const limits = { maxActiveSessions: 1, maxOutputBytes: 1024, maxSourceBytes: 4096, maxWasmBytes: 8192 };

test("ledger admits up to the session cap and resumes the highest priority, oldest waiter", async () => {
  const ledger = new WebCookBudgetLedger(limits);
  const first = await ledger.acquireSession("a");
  const second = ledger.acquireSession("b", 0);
  const third = ledger.acquireSession("c", 1);
  const fourth = ledger.acquireSession("d", 0);
  assert.equal(ledger.evidence().activeSessions, 1);
  assert.equal(ledger.evidence().waitingSessions, 3);
  assert.equal(ledger.evidence().backpressureEvents, 3);

  first.release();
  const grantedThird = await third;
  assert.equal(grantedThird.sessionId, "c", "higher priority is admitted first");

  grantedThird.release();
  const grantedSecond = await second;
  assert.equal(grantedSecond.sessionId, "b", "equal priority falls back to arrival age");

  grantedSecond.release();
  const grantedFourth = await fourth;
  assert.equal(grantedFourth.sessionId, "d");
  grantedFourth.release();
  assert.equal(ledger.evidence().activeSessions, 0);
  assert.equal(ledger.evidence().admissions, 4);
});

test("ledger enforces global byte caps and tracks high-water marks", async () => {
  const ledger = new WebCookBudgetLedger(limits);
  const lease = await ledger.acquireSession("bytes");
  assert.equal(ledger.reserve(lease, "output", 512), true);
  assert.equal(ledger.reserve(lease, "output", 512), true);
  assert.equal(ledger.reserve(lease, "output", 1), false, "over-cap reservation is rejected");
  assert.equal(ledger.evidence().rejectedReservations, 1);
  assert.equal(ledger.evidence().outputBytes, 1024);
  assert.equal(ledger.evidence().peakOutputBytes, 1024);
  ledger.release(lease, "output", 512);
  assert.equal(ledger.reserve(lease, "output", 512), true);
  assert.equal(ledger.reserve(lease, "source", 4096), true);
  assert.equal(ledger.reserve(lease, "wasm", 8192), true);
  lease.release();
  assert.equal(ledger.evidence().outputBytes, 0);
  assert.equal(ledger.evidence().sourceBytes, 0);
  assert.equal(ledger.evidence().wasmBytes, 0);
});

test("ledger releases per-kind bytes when a session ends", async () => {
  const ledger = new WebCookBudgetLedger(limits);
  const lease = await ledger.acquireSession("cleanup");
  ledger.reserve(lease, "output", 256);
  ledger.reserve(lease, "source", 128);
  lease.release();
  const next = await ledger.acquireSession("next");
  assert.equal(ledger.reserve(next, "output", 1024), true, "released bytes are reusable");
  next.release();
});

test("ledger cancels aborted waiters without admitting them", async () => {
  const ledger = new WebCookBudgetLedger(limits);
  const first = await ledger.acquireSession("first");
  const abort = new AbortController();
  const pending = ledger.acquireSession("aborted", 5, abort.signal);
  abort.abort(new Error("give-up"));
  await assert.rejects(() => pending, /give-up/);
  assert.equal(ledger.evidence().cancelledWaiters, 1);
  first.release();
  assert.equal(ledger.evidence().activeSessions, 0);
  assert.equal(ledger.evidence().admissions, 1);
});
