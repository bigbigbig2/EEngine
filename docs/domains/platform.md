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
