---
id: validation-case
kind: contract
status: frozen
owners: 
  - platform
version: 4
consumers: 
  - validation/src/runner
  - validation/cases/*/case.yaml
  - validation/labs/*/case.yaml
invariants: 
  - case owns its identity and scenario classification
  - required artifacts are declared
validation: 
  - registry validation
  - case protocol self-test
state: current
verifies:
  - validation/src/shared/registry.mjs
  - validation/src/runner/run-case.mjs
  - validation/cases
---
# Validation Case

Each `validation/cases/<id>/case.yaml` owns its identity, primary domain, decision, route, workload/profile, artifact kinds, changed paths and classification. Observation labs use the same runtime shape under `validation/labs/<id>/` with lab=true and automatic=false.

The current manifest includes caseKind, kind, level and harness. These are classifications, not proof that a particular algorithm or assurance scope ran. claim covers/evidenceRole and promotion policy are retired.

Case YAML is the source. `validation/registry.generated.json` is a generated runner projection of cases/profiles/workloads; it must not be hand edited. The shared validator checks structure, unique identity, artifact declarations, timeout bounds and exact error allowlists.

Run one selected case using `node validation/src/runner/run-case.mjs <case-id>`. It publishes diagnostic schema-v3 output with engine content identity and cannot promote claims; `--accept` is rejected. Required artifacts, page outcome, fresh identity, aggregated errors and disposal still apply. Raw v2 history is not revalidated or promoted under the current protocol.

A case must state what current producer/consumer it exercises and why its expected output is independent. Neither kind/level nor fixture pass counts establish production correctness or performance.
