export function formalFailureReasons({
  runGroupEvidence,
  browserErrors,
  provenanceErrors,
  gateErrors,
  migrationGates,
  requireSurfaceAbiGate = false
}) {
  const failures = [];
  if (!runGroupEvidence.gateEligible) {
    failures.push(`independent runs: ${JSON.stringify(runGroupEvidence.errors)}`);
  }
  if (browserErrors.length > 0) failures.push(`browser errors: ${browserErrors.join(" | ")}`);
  if (provenanceErrors.length > 0) failures.push(`stale provenance: ${provenanceErrors.join(" | ")}`);
  if (gateErrors.length > 0) failures.push(`BenchmarkEvidenceGate: ${gateErrors.join(" | ")}`);
  if (requireSurfaceAbiGate && migrationGates?.surfaceAbi?.status !== "required") {
    failures.push(`SurfaceAbiGate: ${JSON.stringify(migrationGates?.surfaceAbi ?? null)}`);
  }
  return failures;
}
