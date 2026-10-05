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
state: current
verifies:
  - tools/vibe-lib.mjs
  - tools/vibe-acceptance.mjs
  - validation/src/shared/registry.mjs
---
# Generated Registry

The registry is a projection, not a design source. `node tools/vibe.mjs registry --write` validates and projects cases/labs/profiles/workloads into the runtime file. `registry --check` (also the default) compares canonical bytes without writing. The retired claim layer is not an input. The runner consumes this file; case configuration remains in YAML.

The output is deterministic. Changes to a case manifest therefore affect the runner through one explicit generation step and one content hash.

doctor and prevalidate:registry perform the same read-only comparison; full checks never repair a stale registry before reporting it. A mismatch requires reviewing source inputs and explicitly writing. Registry structure is validated once through the shared runtime validator; cross-file routing/path relationships remain project checks.
