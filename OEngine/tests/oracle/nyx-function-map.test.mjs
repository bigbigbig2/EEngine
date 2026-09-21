import assert from "node:assert/strict";
import test from "node:test";
import { auditNyxFunctionMap } from "../tools/validate-nyx-function-map.mjs";

test("Nyx source hashes, function map, GPU semantic evidence and oracle status are machine-checked", async () => {
  const report = await auditNyxFunctionMap();
  assert.equal(report.sourceFiles.length, 7);
  assert.equal(report.mappings.length, 10);
  assert.equal(report.gpu.length, 6);
  assert.ok(report.mappings.every(mapping => mapping.sourceLines.length === mapping.sourceSymbols && mapping.sourceLines.every(line => line > 1)));
  assert.ok(report.mappings.every(mapping => mapping.nyxTokens > 0));
  assert.equal(report.externalAlgorithmComplete, true);
  assert.equal(report.referenceHarness.status, "verified-source-harnesses");
  assert.equal(report.referenceHarness.notExternalAlgorithmComplete, false);
});
