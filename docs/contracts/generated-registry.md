---
id: generated-registry
kind: contract
status: frozen
owners: 
  - platform
  - virtual-assets
version: 1
consumers: 
  - validation/src/runner
  - validation/src/shared/registry.mjs
invariants: 
  - generated output is deterministic
  - case identity and route are unique
validation: 
  - node tools/vibe.mjs registry
  - validation registry validator
---
# Generated Registry

The registry is a projection, not a design source. `node tools/vibe.mjs registry` reads project domains/claims/checks, automatic case manifests under `validation/cases/`, explicit lab manifests under `validation/labs/`, profile/workload YAML, and authoritative document/source metadata, then validates the host contract before writing `validation/registry.generated.json`.

The output is deterministic. Changes to a case manifest therefore affect the runner through one explicit generation step and one content hash.
