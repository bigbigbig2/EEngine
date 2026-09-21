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

Each `validation/cases/<id>/case.yaml` owns the case identity, primary domain, decision, route, workload/profile, artifact kinds, changed paths, durable claim coverage, and classification. Explicit observation labs use the same shape under `validation/labs/<id>/` and set `lab: true` with `automatic: false`:

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
