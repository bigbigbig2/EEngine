/** One batch ledger for support, Geometry and Field proof. A slot is admitted
 * before detailed work; failed admission never changes value demand. This is a
 * local bounded protocol, not an upstream cache or proof algorithm transplant. */
export const SURFACE_PROOF_RECORD_WORDS = 8;
export const SURFACE_PROOF_RECORD_BYTES = SURFACE_PROOF_RECORD_WORDS * 4;
export const SURFACE_PROOF_KIND = Object.freeze({
  support: 0,
  geometry: 1,
  canonical: 2,
  screen: 3,
  provider: 4,
});
export const SURFACE_PROOF_STATE = Object.freeze({
  unknown: 0,
  publication: 1,
  point: 2,
  constantDomain: 3,
  boundedDomain: 4,
  pending: 5,
});
export const SURFACE_PROOF_MAX_NODES = 64;
export const SURFACE_PROOF_MAX_QUERIES = 4;
export const SURFACE_PROOF_MAX_VISITS = 32;
export const SURFACE_PROOF_MAX_LIGHTS = 8;

export function surfaceProofAdmissionWgsl(workspace: string): string {
  return /* wgsl */ `
fn surface_proof_reserve(requested: u32) -> vec2u {
  if requested == 0u { return vec2u(0u); }
  // Rank workgroup requests first, then reserve once. No lane-by-lane CAS
  // rejection while free slots remain; capacity and contention stay bounded.
  for (var attempt = 0u; attempt < 8u; attempt++) {
    let count = atomicLoad(&${workspace}.counters[120u]);
    if count >= SURFACE_PROOF_CAPACITY { break; }
    let accepted = min(requested, SURFACE_PROOF_CAPACITY - count);
    let claim = atomicCompareExchangeWeak(&${workspace}.counters[120u], count, count + accepted);
    if !claim.exchanged { continue; }
    if accepted < requested { atomicAdd(&${workspace}.counters[122u], requested - accepted); }
    return vec2u(count, accepted);
  }
  atomicAdd(&${workspace}.counters[122u], requested);
  return vec2u(0u);
}
fn surface_proof_admit(leaf: u32, kind: u32, field: u32, entry: u32) -> u32 {
  // Eight finite attempts. Contention is allowed to reject optional proof;
  // no claimed count is published beyond the shared R/2 record capacity.
  for (var attempt = 0u; attempt < 8u; attempt++) {
    let count = atomicLoad(&${workspace}.counters[120u]);
    if count >= SURFACE_PROOF_CAPACITY { break; }
    let claim = atomicCompareExchangeWeak(&${workspace}.counters[120u], count, count + 1u);
    if !claim.exchanged { continue; }
    ${workspace}.proof_requests[count] = array<u32,8>(leaf, kind, field, entry, 5u, 0u, 0u, 0u);
    return count;
  }
  atomicAdd(&${workspace}.counters[122u], 1u);
  return 0xffffffffu;
}
`;
}
