---
id: platform
kind: domain
owner: platform
contracts: 
  - project-routing
  - generated-registry
  - validation-case
  - browser-harness
  - claims-and-evidence
claims: 
  - platform.capability
  - platform.evidence
  - platform.routing
---
# Platform

Platform owns WebGPU 2026 Desktop capability negotiation, the browser validation host, machine project routing, and evidence freshness. It does not own renderer algorithms or example applications.

The only accepted runtime capability is the negotiated device record. Required features and limits are checked before opaque resources are created; unsupported is explicit and never masks a correctness failure. Browser evidence records revision, registry/workload identity, capability, errors, lifecycle, and artifacts.

The durable claims are `platform.capability`, `platform.evidence`, and `platform.routing`. Use `node tools/vibe.mjs context <path>` to resolve the relevant domain, claims, cases, and checks before editing.

## Current Production Path

`GraphicsContext` negotiates adapter features and limits before renderer resources exist. Project changes route through `project/domains`, checks execute through registered runners, case manifests generate the browser registry, and schema-v2 artifacts are compacted into evidence only after a full verification preflight.

## Owner Boundaries And Failure

Platform owns negotiation, routing, host protocol, check receipts, registry generation, and evidence freshness. It does not own rendering algorithms or case-specific assertions. Unknown runners, ambiguous owners, stale identity, missing receipts, browser errors, dirty accepted runs, and unsafe empty-index rebuilds fail closed.

## Main Entrypoints And Proof

The main code entrypoints are `OEngine/src/gpu/GraphicsContext.ts`, `tools/vibe.mjs`, `tools/vibe-lib.mjs`, `tools/check-runners.mjs`, and `validation/src/runner/run-case.mjs`. Promotion policy lives in `project/claims/platform.yaml`; protocol and WebGPU component cases provide runtime proof, while the observer lab is diagnostic only.
