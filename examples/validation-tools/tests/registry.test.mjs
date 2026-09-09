import test from "node:test";
import assert from "node:assert/strict";
import { VALIDATION_CASES, validationCase } from "../cases.mjs";

test("registry is the unique source of valid case ids and routes", () => {
  const ids = VALIDATION_CASES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of VALIDATION_CASES) {
    assert.equal(validationCase(entry.id), entry);
    assert.equal(entry.route, `/validation/${entry.fixture}/`);
    assert.ok(entry.domains.length > 0);
    assert.equal(entry.requirements.localChrome, true);
    assert.equal(entry.requirements.webgpu, true);
  }
});

