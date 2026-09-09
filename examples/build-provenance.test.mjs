import test from "node:test";
import assert from "node:assert/strict";
import * as provenance from "./build-provenance.mjs";

test("runner rejects a dev server whose embedded git state is stale", () => {
  const compare = provenance.compareGitBuildProvenance;
  const result = typeof compare === "function"
      ? compare(
        { commit: "abc", dirty: true, dirtyReasons: [" M source.ts"], contentHash: "new" },
        { commit: "abc", dirty: false, dirtyReasons: [], contentHash: "old" }
      )
    : null;
  assert.deepEqual(result, [
    "build-dirty-state-mismatch",
    "build-content-hash-mismatch",
    "build-dirty-reasons-mismatch"
  ]);
});
