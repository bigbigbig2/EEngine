---
id: validation-case
kind: contract
status: frozen
owners: 
  - platform
version: 1
consumers: 
  - validation/src/runner
  - validation/cases/*/case.yaml
  - validation/labs/*/case.yaml
invariants: 
  - case owns its claim coverage
  - artifacts and evidence are declared
validation: 
  - registry validation
  - case protocol self-test
---
# Validation Case

Each `validation/cases/<id>/case.yaml` owns the case identity, primary domain, decision, route, workload/profile, artifact kinds, changed paths, durable claim coverage, and classification. Claim manifests separately decide whether that reverse coverage is required, alternative, or diagnostic. Explicit observation labs use the same shape under `validation/labs/<id>/` and set `lab: true` with `automatic: false`:

```yaml
domain: virtual-assets
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

Promotion cases must be automatic, non-lab, and at least the claim's assurance level. L4 cases are formal performance cases only: `kind: perf` with profile `formal-1080p`. Browser execution performs a full verification preflight and publishes its passed check receipts in artifact schema v2.
