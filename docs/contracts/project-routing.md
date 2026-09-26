---
id: project-routing
kind: contract
status: frozen
owners:
  - platform
version: 4
consumers:
  - tools/vibe.mjs
  - AGENTS.md
invariants:
  - every routed code path has one primary owner
  - daily navigation is independent of acceptance metadata
validation:
  - node tools/vibe.mjs context <path>
  - node --check tools/vibe.mjs
---
# Project Routing

`project/domains/*.yaml` owns path-to-domain routing. The highest specificity match is the primary owner; ties are reported as ambiguous. The `currentDocs` list points to current source facts under `docs/domains/`. The active Next design and execution plan are separate navigation entries, not current implementation facts.

The daily `node tools/vibe.mjs context <path>` command parses only domain and active workstream YAML. It does not load checks, claims, cases, the generated registry, evidence, or the final acceptance runner. A missing or stale acceptance artifact therefore cannot stop coding.

`node tools/vibe.mjs verify --module` is an explicit large-module close check: engine typecheck, build and optional named targeted tests. It does not infer tests from every changed path and does not create evidence. `node tools/vibe.mjs verify --full` loads the acceptance model for final integration. `context --claims`, `--cases` and `--all`, plus `registry`, `evidence`, `case`, `status` and `doctor`, also explicitly enter that separate model.

`checks/` and `project/claims/` describe formal checks and declarations for acceptance. They do not grant or withhold permission to implement the current module. Unknown runners, case policies and evidence freshness are checked only when the final acceptance model is invoked.
