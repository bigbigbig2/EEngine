---
id: validation-case
kind: contract
status: frozen
owners: 
  - platform
version: 3
consumers: 
  - validation/src/runner
  - validation/cases/*/case.yaml
  - validation/labs/*/case.yaml
invariants: 
  - case owns its evidence role and optional claim coverage
  - artifacts and evidence are declared
validation: 
  - registry validation
  - case protocol self-test
---
# Validation Case

Each `validation/cases/<id>/case.yaml` owns the case identity, primary domain, decision, route, workload/profile, artifact kinds, changed paths, durable claim coverage, and classification. Claim manifests separately decide whether that reverse coverage is required, alternative, or diagnostic. Explicit observation labs use the same shape under `validation/labs/<id>/` and set `lab: true` with `automatic: false`:

```yaml
domain: virtual-assets
evidenceRole: promotion | diagnostic
caseKind: component | production | internal-candidate | orchestration
kind: contract | oracle | guard | gpu | perf | unit
level: L0 | L1 | L2 | L3 | L4
decision: ADR-0016
sourceCase: glb-web-product # optional parameterized case sharing one page entry
covers:
  - virtual-assets.product-consumer
harness: protocol | gpu | production | observer
```

The case manifest is the source. `validation/registry.generated.json` is a deterministic runner input and is never hand edited. Claims and checks are the proof routing source; the registry preserves the canonical case fields and adds only runner identity and generated metadata.

`promotion` cases must have non-empty `covers`, appear in at least one claim promotion policy when used for promotion, be automatic and non-lab, and meet that claim's assurance level. A promotion case may still be diagnostic for a different covered claim through that claim's policy. `diagnostic` cases may use an empty `covers` list and cannot appear in any promotion policy or publish accepted evidence. Labs are always diagnostic. L4 cases are formal performance cases only: `kind: perf` with profile `formal-1080p`. A diagnostic `case --run` does not execute repository preflight and records an empty receipt list. Explicit `--accept` execution performs or safely reuses a full verification preflight and publishes its passed check receipts in artifact schema v2.
