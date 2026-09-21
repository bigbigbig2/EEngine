---
id: shading
kind: domain
owner: shading
contracts: 
  - claims-and-evidence
claims: 
  - shading.one-eval
  - shading.pipeline-pruning
---
# Shading

Shading owns material identity, one complete evaluation per opaque hit, direct lighting integration, and typed output products for temporal and post features. It is one configurable renderer pipeline; feature selection prunes unused products and passes.

Texture and output dependencies are part of pipeline identity. Diagnostics variants may validate ownership and counters, but production variants do not perform per-pixel ownership atomics or synchronous readback.

The long term decision is ADR-0013 and the external algorithm ledger is `docs/porting/shading.md`. Durable claims are `shading.one-eval` and `shading.pipeline-pruning`; case and check links are in `project/claims/shading.yaml`.
