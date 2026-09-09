export function formalFailureReasons({
  runGroupEvidence,
  browserErrors,
  provenanceErrors,
  gateErrors
}) {
  const failures = [];
  if (!runGroupEvidence.gateEligible) {
    failures.push(`independent runs: ${JSON.stringify(runGroupEvidence.errors)}`);
  }
  if (browserErrors.length > 0) failures.push(`browser errors: ${browserErrors.join(" | ")}`);
  if (provenanceErrors.length > 0) failures.push(`stale provenance: ${provenanceErrors.join(" | ")}`);
  if (gateErrors.length > 0) failures.push(`BenchmarkEvidenceGate: ${gateErrors.join(" | ")}`);
  return failures;
}
