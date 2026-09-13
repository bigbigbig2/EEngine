import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(await readFile(resolve(root, "cases/artifact-schema.json"), "utf8"));

test("artifact schema freezes freshness, provenance, page, artifact, and gate ownership", () => {
  assert.equal(schema.$id, "oengine-validation-artifact-v1");
  assert.deepEqual(schema.properties.status.enum, ["passed", "failed", "unsupported"]);
  for (const field of ["runId", "nonce", "caseId", "workloadId", "registrySha256", "workloadSha256", "status", "provenance", "page", "events", "artifactManifest", "gate"]) {
    assert.ok(schema.required.includes(field), `missing required artifact field ${field}`);
  }
  for (const field of ["commit", "tree", "dirty", "hostBuildId", "browserExecutable", "browserExecutableSha256", "browserVersion", "userAgent", "startedAt", "completedAt"]) {
    assert.ok(schema.$defs.provenance.required.includes(field), `missing provenance field ${field}`);
  }
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.page.properties.navigationCount.const, 1);
  assert.equal(schema.$defs.page.properties.state.const, "disposed");
});
