import test from "node:test";
import assert from "node:assert/strict";
import { formalFailureReasons } from "../formal-result.mjs";

test("formal policy cannot pass with an evidence gate error", () => {
  const reasons = formalFailureReasons({
    runGroupEvidence: { gateEligible: true, errors: [] },
    browserErrors: [],
    provenanceErrors: [],
    gateErrors: ["run 0/base: gpu-counter-missing"],
    migrationGates: { surfaceAbi: { status: "required" } },
    requireSurfaceAbiGate: true
  });
  assert.match(reasons.join("\n"), /BenchmarkEvidenceGate/);
});

test("formal policy accepts only a clean independent run group", () => {
  assert.deepEqual(formalFailureReasons({
    runGroupEvidence: { gateEligible: true, errors: [] },
    browserErrors: [],
    provenanceErrors: [],
    gateErrors: [],
    migrationGates: { surfaceAbi: { status: "required" } },
    requireSurfaceAbiGate: true
  }), []);
});

test("formal policy rejects an unclosed SurfaceLite migration gate", () => {
  const reasons = formalFailureReasons({
    runGroupEvidence: { gateEligible: true, errors: [] },
    browserErrors: [],
    provenanceErrors: [],
    gateErrors: [],
    migrationGates: {
      surfaceAbi: { status: "insufficient-evidence", reason: "requires 3 independent runs" }
    },
    requireSurfaceAbiGate: true
  });
  assert.match(reasons.join("\n"), /SurfaceAbiGate/);
});
