import assert from "node:assert/strict";
import test from "node:test";

const { resolveWebCookRuntimeProfile } = await import("../../.test-dist/assets/web-cook/WebCookWorkerFactory.js");

test("auto never claims pthread support on an unisolated page", () => {
  // Node has no crossOriginIsolated, so auto must never select the pthread cooker.
  const capability = resolveWebCookRuntimeProfile("auto");
  assert.equal(capability.requested, "auto");
  assert.notEqual(capability.selected, "isolated-pthreads");
  assert.equal(typeof capability.hardwareConcurrency, "number");
  if (capability.hardwareConcurrency >= 4) {
    assert.equal(capability.selected, "portable-pool");
    assert.equal(capability.fallbackReason, "cross-origin-isolation-unavailable", "a pool on an unisolated page must be labelled, not passed off as pthread");
  } else {
    assert.equal(capability.selected, "portable-single");
  }
});

test("an explicit pthread request falls back with a reason on an unisolated page", () => {
  const capability = resolveWebCookRuntimeProfile("isolated-pthreads");
  assert.equal(capability.selected, "portable-single");
  assert.equal(capability.fallbackReason, "cross-origin-isolation-required");
});

test("concrete profiles resolve to themselves without a fallback reason", () => {
  assert.equal(resolveWebCookRuntimeProfile("portable-single").selected, "portable-single");
  assert.equal(resolveWebCookRuntimeProfile("portable-single").fallbackReason, undefined);
  const pool = resolveWebCookRuntimeProfile("portable-pool");
  assert.equal(pool.selected, "portable-pool");
  assert.equal(pool.fallbackReason, undefined);
});
