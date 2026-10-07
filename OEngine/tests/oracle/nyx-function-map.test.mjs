import assert from "node:assert/strict";
import test from "node:test";
import { auditNyxFunctionMap } from "../../tools/validate-nyx-function-map.mjs";

test("Nyx source hashes, function map, GPU semantic evidence and oracle status are machine-checked", async () => {
  const report = await auditNyxFunctionMap();
  assert.equal(report.sourceFiles.length, 7);
  assert.equal(report.mappings.length, 11);
  assert.equal(report.gpu.length, 6);
  assert.ok(
    report.mappings.every(
      (mapping) =>
        mapping.sourceLines.length === mapping.sourceSymbols && mapping.sourceLines.every((line) => line > 1)
    )
  );
  assert.ok(report.mappings.every((mapping) => mapping.nyxTokens > 0));
  assert.deepEqual(
    report.mappings
      .filter((mapping) => mapping.status === "pending-native-adoption")
      .map((mapping) => mapping.id),
    ["vbuffer-build-vertex", "vbuffer-mesh-main", "vbuffer-pixel-main"]
  );
  assert.ok(
    report.gpu
      .filter((mapping) => mapping.id.startsWith("vbuffer-"))
      .every((mapping) => mapping.adoptionStatus === "pending-native-adoption")
  );
  assert.equal(report.externalAlgorithmComplete, false);
  assert.equal(report.referenceHarness.status, "verified-source-harnesses");
  assert.equal(report.referenceHarness.notExternalAlgorithmComplete, true);
});
