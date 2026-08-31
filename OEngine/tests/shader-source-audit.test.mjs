import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("shader source audit reaches runtime pipeline owners deterministically", () => {
  const output = execFileSync(
    process.execPath,
    ["tools/audit-shader-sources.mjs"],
    { cwd: root, encoding: "utf8" }
  );
  const report = JSON.parse(output);
  const committedReport = JSON.parse(readFileSync(
    path.join(root, "benchmarks/shader-source-audit.json"),
    "utf8"
  ));
  assert.deepEqual(committedReport, report);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.generatedBy, "tools/audit-shader-sources.mjs");
  assert.equal(report.shaderCount, report.entries.length);
  assert.equal(new Set(report.entries.map((entry) => entry.shader)).size, 71);
  assert.deepEqual(report.summary, {
    "authored-live": 61,
    dead: 5,
    unknown: 5
  });

  for (const entry of report.entries) {
    if (entry.classification === "dead") {
      assert.equal(entry.deletionCandidate, true);
      assert.deepEqual(entry.pipelineOwners, []);
    } else {
      assert.equal(entry.deletionCandidate, false);
      assert.ok(entry.pipelineOwners.length > 0, entry.shader);
    }
  }

  const visibilityOracle = report.entries.find(
    (entry) => entry.shader ===
      "src/shaders/oracle_visibility_work_generation.ts"
  );
  assert.deepEqual(visibilityOracle.pipelineOwners, [
    "src/gpu/MeshletDrawList.ts"
  ]);
});
