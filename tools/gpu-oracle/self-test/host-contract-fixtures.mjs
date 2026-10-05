// Fixture oracles for tools/gpu-oracle/self-test/host-contract-check.mjs.
//
// These exist only to exercise the host page's pass/fail reporting contract in
// Node with a stub device. They are never registered as real oracles.

import assert from "node:assert/strict";

export async function passFixture() {
  return { marker: 42, note: "host contract fixture: deterministic pass" };
}

export async function throwFixture() {
  assert.deepEqual([1, 2, 3], [1, 2, 4], "deliberate contract fixture failure");
  return { marker: "unreachable" };
}
